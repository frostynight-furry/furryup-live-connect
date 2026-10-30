// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { fault, binding, record, recordKey, metric, metricKey, monthRange, monthEnd, token, timestamp, minor, yuanToMinor, month, day,
  nativeUnit, nativeRecord, nativeMetric, nativeRecordKey, nativeMetricKey, sumDecimal } = require('./model.cjs');
const { WALLET_SCOPE, INCOME_SCOPE, walletStatement, walletRecords } = require('./wallet-statement.cjs');
const walletScope = row => [WALLET_SCOPE, INCOME_SCOPE].includes(row.scope);

function mergeRows(current, incoming, keyFor) {
  const seen = new Set(), next = new Map(current);
  for (const row of incoming) {
    const key = keyFor(row), old = next.get(key);
    if (seen.has(key)) throw fault('DUPLICATE_REVENUE_PERIOD'); seen.add(key);
    if (!old || row.fetchedAt > old.fetchedAt) next.set(key, row);
    else if (row.fetchedAt === old.fetchedAt && JSON.stringify(row) !== JSON.stringify(old)) throw fault('CONFLICTING_REVENUE_PERIOD');
  }
  return next;
}
function summarizeMonths(selected, { fromMonth, toMonth }, describe) {
  const available = selected.map(row => row.start.slice(0, 7)).sort();
  if (!fromMonth && !toMonth && !available.length) return [];
  fromMonth ||= available[0]; toMonth ||= available.at(-1);
  return monthRange(fromMonth, toMonth).map(value => {
    const rows = selected.filter(row => row.start.startsWith(value + '-'));
    const monthly = rows.find(row => row.period === 'month');
    // Direct monthly observations replace daily observations for one series.
    const used = monthly ? [monthly] : rows.filter(row => row.period === 'day');
    const expectedDays = Number(monthEnd(value).slice(8));
    const coveredDays = monthly ? (monthly.complete ? expectedDays : null) : used.filter(row => row.complete).length;
    const complete = monthly ? monthly.complete : coveredDays === expectedDays;
    return { month: value, ...describe(used, complete), coverage: complete ? 'complete' : used.length ? 'partial' : 'missing',
      coveredDays, expectedDays, provisional: used.length ? used.some(row => row.provisional) : null,
      fetchedAt: used.length ? used.map(row => row.fetchedAt).sort().at(-1) : null };
  });
}

// Host-owned persistence: export only normalized amounts/periods, never sessions
// or raw responses. Every ledger belongs to exactly one platform identity.
function createRevenueLedger({ platform, accountId, state } = {}) {
  binding(platform, accountId);
  let records = new Map(), metrics = new Map(), nativeRecords = new Map(), nativeMetrics = new Map(), statements = new Map();
  function ingest(snapshot) {
    if (snapshot?.schemaVersion !== 1 || snapshot.platform !== platform || snapshot.accountId !== accountId) throw fault('REVENUE_ACCOUNT_MISMATCH');
    if (snapshot.currency !== undefined && snapshot.currency !== 'CNY' && !(snapshot.currency === null && snapshot.records?.length === 0 && !snapshot.metrics?.length)) throw fault('INVALID_REVENUE_CURRENCY');
    if (!Array.isArray(snapshot.records) || snapshot.records.length > 50000) throw fault('INVALID_REVENUE_RECORD');
    const incoming = snapshot.records.map(row => record(row, snapshot.fetchedAt));
    if (snapshot.metrics !== undefined && (!Array.isArray(snapshot.metrics) || snapshot.metrics.length > 5000)) throw fault('INVALID_REVENUE_METRIC');
    const incomingMetrics = (snapshot.metrics || []).map(row => metric(row, snapshot.fetchedAt));
    for (const [key, limit] of [['nativeRecords', 50000], ['nativeMetrics', 5000]])
      if (snapshot[key] !== undefined && (!Array.isArray(snapshot[key]) || snapshot[key].length > limit)) throw fault('INVALID_REVENUE_RECORD');
    const incomingNative = (snapshot.nativeRecords || []).map(row => nativeRecord(row, snapshot.fetchedAt));
    const incomingNativeMetrics = (snapshot.nativeMetrics || []).map(row => nativeMetric(row, snapshot.fetchedAt));
    if (snapshot.statements !== undefined && (!Array.isArray(snapshot.statements) || snapshot.statements.length > 1200)) throw fault('INVALID_WALLET_STATEMENT');
    const incomingStatements = (snapshot.statements || []).map(walletStatement);
    const walletRows = incoming.filter(row => walletScope(row) || row.source === 'wallet');
    if ((incomingStatements.length || walletRows.length) && platform !== 'douyin') throw fault('REVENUE_ACCOUNT_MISMATCH');
    const projected = incomingStatements.flatMap(walletRecords), sortRows = rows => [...rows].sort((a, b) => recordKey(a).localeCompare(recordKey(b)));
    if (JSON.stringify(sortRows(walletRows)) !== JSON.stringify(sortRows(projected))) throw fault('INVALID_WALLET_PROJECTION');
    // A verified statement is one replaceable monthly observation. Removing its
    // old projections also removes a category that was subsequently reclassified.
    const nextStatements = mergeRows(statements, incomingStatements, row => row.month);
    const next = mergeRows(records, incoming.filter(row => !walletScope(row) && row.source !== 'wallet'), recordKey);
    for (const statement of incomingStatements) {
      const old = statements.get(statement.month);
      if (old && old.fetchedAt >= statement.fetchedAt) continue;
      for (const [key, row] of next) if (walletScope(row) && row.start.slice(0, 7) === statement.month) next.delete(key);
      for (const row of walletRecords(statement)) next.set(recordKey(row), row);
    }
    const nextMetrics = mergeRows(metrics, incomingMetrics, metricKey);
    const nextNative = mergeRows(nativeRecords, incomingNative, nativeRecordKey), nextNativeMetrics = mergeRows(nativeMetrics, incomingNativeMetrics, nativeMetricKey);
    if (next.size + nextNative.size > 50000 || nextMetrics.size + nextNativeMetrics.size > 5000 || nextStatements.size > 1200 ||
      [...nextStatements.values()].reduce((n, row) => n + row.transactions.length, 0) > 50000) throw fault('REVENUE_STORAGE_LIMIT');
    const transactionMonths = new Map();
    for (const statement of nextStatements.values()) for (const row of statement.transactions) {
      if (transactionMonths.has(row.id) && transactionMonths.get(row.id) !== statement.month) throw fault('CONFLICTING_REVENUE_TRANSACTION');
      transactionMonths.set(row.id, statement.month);
    }
    records = next; metrics = nextMetrics; nativeRecords = nextNative; nativeMetrics = nextNativeMetrics; statements = nextStatements;
    return incoming.length + incomingNative.length;
  }
  if (state) ingest(state);
  return {
    ingest,
    export() { return { schemaVersion: 1, platform, accountId, records: [...records.values()].sort((a, b) => recordKey(a).localeCompare(recordKey(b))).map(row => ({ ...row })), metrics: [...metrics.values()].map(row => ({ ...row })),
      nativeRecords: [...nativeRecords.values()].map(row => ({ ...row })), nativeMetrics: [...nativeMetrics.values()].map(row => ({ ...row })),
      ...(statements.size ? { statements: [...statements.values()].sort((a, b) => a.month.localeCompare(b.month)).map(row => structuredClone(row)) } : {}) }; },
    statements({ fromMonth, toMonth } = {}) {
      if (fromMonth) month(fromMonth); if (toMonth) month(toMonth);
      if (fromMonth && toMonth && fromMonth > toMonth) throw fault('INVALID_REVENUE_RANGE');
      return [...statements.values()].filter(row => (!fromMonth || row.month >= fromMonth) && (!toMonth || row.month <= toMonth))
        .sort((a, b) => a.month.localeCompare(b.month)).map(row => structuredClone(row));
    },
    metrics() { return [...metrics.values()].map(row => ({ ...row })); },
    nativeMetrics() { return [...nativeMetrics.values()].map(row => ({ ...row })); },
    nativeSeries() {
      return [...new Map([...nativeRecords.values()].map(row => [JSON.stringify([row.scope, row.categoryId, row.unit]),
        { scope: row.scope, categoryId: row.categoryId, categoryName: row.categoryName, unit: row.unit, currency: null }])).values()];
    },
    nativeMonths({ scope, categoryId = 'earnScore', unit, fromMonth, toMonth } = {}) {
      token(scope); token(categoryId); nativeUnit(unit);
      const selected = [...nativeRecords.values()].filter(row => row.scope === scope && row.categoryId === categoryId && row.unit === unit);
      return summarizeMonths(selected, { fromMonth, toMonth }, (used, complete) => {
        const observed = used.length ? sumDecimal(used.map(row => row.value)) : null;
        return { scope, categoryId, unit, currency: null, value: complete ? observed : null, observedValue: observed };
      });
    },
    series() {
      return [...new Map([...records.values()].map(row => [JSON.stringify([row.scope, row.categoryId]), { scope: row.scope, categoryId: row.categoryId, categoryName: row.categoryName, currency: 'CNY' }])).values()];
    },
    months({ scope, categoryId = 'total', fromMonth, toMonth } = {}) {
      token(scope); token(categoryId);
      const selected = [...records.values()].filter(row => row.scope === scope && row.categoryId === categoryId);
      return summarizeMonths(selected, { fromMonth, toMonth }, (used, complete) => {
        const observed = used.length ? minor(String(used.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n))) : null;
        return { scope, categoryId, currency: 'CNY', amountMinor: complete ? observed : null, observedAmountMinor: observed };
      });
    }
  };
}

// Canonical aggregate CSV, deliberately not an unverified importer for each
// platform's changing XLSX layouts. A row is one day/month, not one transaction.
const REVENUE_CSV_HEADER = 'period,date,scope,category_id,category_name,amount_yuan';
function csvRows(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) throw fault('INVALID_REVENUE_CSV');
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"' && field === '' && !closed) quoted = true;
    else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; closed = false;
      if (char !== ',') { if (char === '\r' && text[i + 1] === '\n') i++; rows.push(row); row = []; }
    } else { if (closed || char === '"') throw fault('INVALID_REVENUE_CSV'); field += char; }
    if (field.length > 1000 || row.length > 6 || rows.length > 10000) throw fault('INVALID_REVENUE_CSV');
  }
  if (quoted) throw fault('INVALID_REVENUE_CSV');
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  return rows;
}
function importRevenueCsv({ text, platform, accountId, fetchedAt = new Date().toISOString() } = {}) {
  binding(platform, accountId); timestamp(fetchedAt);
  const rows = csvRows(text);
  if (rows.shift()?.join(',') !== REVENUE_CSV_HEADER || rows.some(row => row.length !== 6)) throw fault('INVALID_REVENUE_CSV');
  const seen = new Set();
  const records = rows.map(([period, date, scope, categoryId, categoryName, amount]) => {
    const start = period === 'month' ? month(date) + '-01' : day(date);
    const row = record({ period, start, end: period === 'month' ? monthEnd(date) : start, scope, categoryId, categoryName,
      amountMinor: yuanToMinor(amount), source: 'statement_import', complete: true, provisional: true }, fetchedAt);
    const key = recordKey(row); if (seen.has(key)) throw fault('DUPLICATE_REVENUE_PERIOD'); seen.add(key); return row;
  });
  return { schemaVersion: 1, platform, accountId, fetchedAt, currency: 'CNY', timeZone: 'Asia/Shanghai', records };
}
module.exports = { createRevenueLedger, importRevenueCsv, REVENUE_CSV_HEADER };
