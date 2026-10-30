// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { fault, month, monthRange, shiftMonth, chinaDay, timestamp } = require('./model.cjs');
const { createRevenueLedger } = require('./ledger.cjs');
const { syncBinding, stateKey, cleanState, cleanIssues, safeCode, informative, unavailable, needsLogin, sourcesFor } = require('./creator-sync-state.cjs');
const active = new Set();
function createCreatorRevenueSync({ owner, platform, accountId, identityKind, deviceId, getAccount, reader, store, initialLedger,
  sources = sourcesFor(platform, identityKind), fromMonth, batchMonths = 6, intervalMs = 6 * 3600000, backfillIntervalMs = 60000,
  historyRefreshMs = 30 * 86400000, now = Date.now, onStatus = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
  const bound = syncBinding({ owner, platform, accountId, identityKind }), key = stateKey(bound);
  if (typeof getAccount !== 'function' || typeof reader?.lookup !== 'function' || typeof store?.load !== 'function' || typeof store?.save !== 'function' ||
    typeof now !== 'function' || typeof onStatus !== 'function' || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') throw new TypeError('Reader, store and owner guard are required');
  if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length || sources.some(s => !sourcesFor(platform, identityKind).includes(s))) throw fault('REVENUE_UNSUPPORTED_SOURCE');
  if ((deviceId !== undefined || identityKind === 'native_uid') && !/^[a-f0-9]{64}$/.test(deviceId || '')) throw fault('REVENUE_MOBILE_BINDING_REQUIRED');
  sources = [...sources];
  if (fromMonth !== undefined) month(fromMonth);
  if (!Number.isInteger(batchMonths) || batchMonths < 1 || batchMonths > 24) throw new TypeError('Invalid monthly batch');
  for (const ms of [intervalMs, backfillIntervalMs]) if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 2147483647) throw new TypeError('Invalid interval');
  if (!Number.isSafeInteger(historyRefreshMs) || historyRefreshMs < intervalMs || historyRefreshMs > 365 * 86400000) throw new TypeError('Invalid history refresh interval');
  const seed = initialLedger ? createRevenueLedger({ platform, accountId, state: initialLedger }).export() : undefined;
  let state, pending, pendingVersion, timer, enabled = false, disposed = false, generation = 0;
  let info = { platform, state: 'idle', nextRunAt: null, sources: [] };
  const current = () => chinaDay(Math.floor(now() / 1000)).slice(0, 7), iso = () => new Date(now()).toISOString();
  const emit = changes => { info = { ...info, ...changes }; try { onStatus(structuredClone(info)); } catch { /* UI errors cannot affect persistence. */ } };
  function guard(version) {
    if (disposed || version !== generation) throw fault('REVENUE_SYNC_STOPPED');
    const account = getAccount(); if (!account || account.accountId !== owner || account.kind === 'signed-out') throw fault('ACCOUNT_CHANGED');
  }
  function lower(source) {
    let first = platform === 'kuaishou' ? '2019-04' : source.source === 'wallet' ? source.earliestAvailableMonth : null;
    if (fromMonth && (!first || fromMonth > first)) first = fromMonth;
    return first;
  }
  const perMonth = source => platform === 'kuaishou' || source.source === 'wallet';
  function history(source) {
    const first = lower(source); return !first || first > current() ? [] : monthRange(first, current());
  }
  function pendingMonths(source) {
    if (!perMonth(source)) return null;
    if (source.source === 'wallet' && !source.earliestAvailableMonth) return null;
    const checked = new Set(source.months.map(r => r.month)); return history(source).filter(m => !checked.has(m)).length;
  }
  function publishState(changes = {}) {
    const selected = (state?.sources || []).filter(s => sources.includes(s.source));
    emit({ ...changes, sources: selected.map(s => ({ source: s.source, state: s.status, lastSuccessAt: s.lastSuccessAt || null,
      lastCheckedAt: s.lastCheckedAt || null, lastErrorCode: s.lastErrorCode || null, nextCheckAt: s.nextCheckAt || null,
      checkedMonths: s.months.length, pendingMonths: pendingMonths(s), issues: structuredClone(s.issues) })) });
  }
  function jobs(source, force) {
    if (!force && (source.status === 'needs_login' || source.nextCheckAt && source.nextCheckAt > iso())) return [];
    if (!perMonth(source)) {
      let first = platform === 'bilibili' ? shiftMonth(current(), -6) : platform === 'wechat_channels' ? '2000-01' : shiftMonth(current(), -1);
      if (fromMonth && fromMonth > first) first = fromMonth;
      return [{ fromMonth: first, toMonth: current() }];
    }
    const checked = new Map(source.months.map(r => [r.month, r])), first = lower(source);
    const recent = [current(), shiftMonth(current(), -1), shiftMonth(current(), -2)].filter(m => (!first || m >= first) &&
      (force || !checked.has(m) || Date.parse(checked.get(m).checkedAt) <= now() - intervalMs));
    const all = history(source).reverse(), missing = all.filter(m => !checked.has(m));
    const stale = all.filter(m => checked.has(m) && Date.parse(checked.get(m).checkedAt) <= now() - historyRefreshMs);
    const candidates = source.source === 'wallet' && !source.earliestAvailableMonth ? [current()] :
      [...(source.status === 'error' && source.retryMonth ? [source.retryMonth] : []), ...recent, ...missing, ...stale];
    return [...new Set(candidates)].slice(0, batchMonths).map(m => ({ fromMonth: m, toMonth: m }));
  }
  async function save(next, version) {
    guard(version); const normalized = cleanState({ ...next, updatedAt: iso() }, bound);
    try { await store.save(bound, normalized); } catch (error) { throw fault(error.code === 'REVENUE_STORAGE_LIMIT' ? error.code : 'REVENUE_STORAGE_ERROR'); }
    guard(version); state = normalized; publishState();
  }
  async function updateSource(next, ledger, version) {
    await save({ ...state, ledger, sources: state.sources.map(s => s.source === next.source ? next : s) }, version);
  }
  async function run(version, force, only) {
    guard(version); if (active.has(key)) throw fault('REVENUE_BUSY'); active.add(key);
    try {
      emit({ state: 'syncing', nextRunAt: null, lastErrorCode: null });
      let loaded; try { loaded = await store.load(bound); } catch (error) { throw fault(error.code === 'REVENUE_STORAGE_LIMIT' ? error.code : 'REVENUE_STORAGE_INVALID'); }
      guard(version); if (fromMonth && fromMonth > current()) throw fault('REVENUE_HISTORY_OUTSIDE_WINDOW');
      state = loaded ? cleanState(loaded, bound) : { schemaVersion: 2, kind: 'creator_revenue_sync', ...bound, updatedAt: iso(),
        ledger: createRevenueLedger({ platform, accountId, state: seed }).export(), sources: [] };
      // Migration is explicit and additive, including wallet statements and manual imports.
      if (seed && loaded) { const ledger = createRevenueLedger({ platform, accountId, state: state.ledger }); ledger.ingest(seed); state.ledger = ledger.export(); }
      for (const name of sources) if (!state.sources.some(s => s.source === name)) state.sources.push({ source: name, status: 'idle', failures: 0, months: [], issues: [] });
      await save(state, version);
      for (const name of only || sources) {
        guard(version); let source = state.sources.find(s => s.source === name), attempts = 0; const attempted = new Set();
        while (attempts < (perMonth(source) ? batchMonths : 1)) {
          const job = jobs(source, force).find(j => !attempted.has(j.fromMonth)); if (!job) break;
          attempts++; attempted.add(job.fromMonth);
          const attemptAt = iso(); let snapshot;
          try {
            snapshot = await reader.lookup({ owner, platform, expectedIdentity: accountId, identityKind, ...(deviceId ? { deviceId } : {}), source: name, ...job });
            guard(version);
            if (snapshot?.platform !== platform || snapshot?.accountId !== accountId) throw fault('PLATFORM_ACCOUNT_CHANGED');
            if (snapshot.source !== name || Date.parse(timestamp(snapshot.fetchedAt)) > now() || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.issues)) throw fault('REVENUE_SCHEMA_CHANGED');
            if (name !== 'anchor_dashboard' && JSON.stringify(snapshot.requestedMonths) !== JSON.stringify(monthRange(job.fromMonth, job.toMonth))) throw fault('REVENUE_MONTH_MISMATCH');
            const issues = cleanIssues(snapshot.issues), block = issues.find(i => needsLogin.has(i.code));
            const problem = issues.find(i => !informative.has(i.code) && !unavailable.has(i.code) && !needsLogin.has(i.code));
            const rows = [...snapshot.records, ...(snapshot.nativeRecords || [])];
            if (perMonth(source) && rows.some(row => row.start?.slice(0, 7) !== job.fromMonth)) throw fault('REVENUE_MONTH_MISMATCH');
            const hasData = rows.length + (snapshot.metrics?.length || 0) + (snapshot.nativeMetrics?.length || 0) > 0;
            const ledger = createRevenueLedger({ platform, accountId, state: state.ledger }); ledger.ingest(snapshot);
            let next = { ...source, lastAttemptAt: attemptAt, lastCheckedAt: snapshot.fetchedAt, issues,
              ...(hasData ? { lastSuccessAt: snapshot.fetchedAt } : {}), failures: problem ? Math.min(source.failures + 1, 1000) : 0,
              status: block && !hasData ? 'needs_login' : problem ? 'error' : hasData ? issues.length ? 'partial' : 'synced' : 'unavailable' };
            delete next.lastErrorCode;
            if (block || problem) next.lastErrorCode = (block || problem).code;
            delete next.retryMonth;
            if (problem && perMonth(source)) next.retryMonth = job.fromMonth;
            if (name === 'wallet') {
              if (snapshot.earliestAvailableMonth) next.earliestAvailableMonth = month(snapshot.earliestAvailableMonth);
              const check = snapshot.checkedMonths?.find(r => r.month === job.fromMonth);
              if (!problem && !block && (!check || !['stored', 'no_data'].includes(check.status))) throw fault('REVENUE_SCHEMA_CHANGED');
              if (check && (snapshot.checkedMonths.length !== 1 || (check.status === 'stored' ? snapshot.statements?.length !== 1 || snapshot.statements[0].month !== job.fromMonth : snapshot.statements?.length || snapshot.records.length))) throw fault('REVENUE_SCHEMA_CHANGED');
              if (check?.status === 'no_data' && source.months.some(r => r.month === job.fromMonth && r.outcome !== 'no_data')) throw fault('REVENUE_WALLET_SNAPSHOT_CHANGED');
            }
            if (perMonth(source) && !problem && !block) {
              const outcome = !rows.length ? 'no_data' : rows.every(r => r.complete) && !issues.some(i => unavailable.has(i.code)) ? 'observed' : 'partial';
              next.months = [...source.months.filter(r => r.month !== job.fromMonth), { month: job.fromMonth, checkedAt: snapshot.fetchedAt, outcome }];
            }
            if (next.status === 'needs_login') delete next.nextCheckAt;
            else next.nextCheckAt = new Date(now() + (problem ? Math.min(intervalMs, backfillIntervalMs * 2 ** Math.min(next.failures - 1, 10)) : intervalMs)).toISOString();
            // Continue this bounded batch without letting its persisted next-due time block subsequent months.
            await updateSource(next, ledger.export(), version); source = { ...next, nextCheckAt: undefined };
            if (block || problem) break;
          } catch (error) {
            guard(version); const code = safeCode(error);
            if (['ACCOUNT_CHANGED', 'PLATFORM_ACCOUNT_CHANGED', 'REVENUE_ACCOUNT_MISMATCH', 'REVENUE_STORAGE_ERROR', 'REVENUE_STORAGE_LIMIT'].includes(code)) throw fault(code);
            const failures = Math.min(source.failures + 1, 1000), paused = needsLogin.has(code) || code === 'REVENUE_DISPOSED';
            const next = { ...source, status: paused ? 'needs_login' : 'error', failures, lastErrorCode: code, lastAttemptAt: attemptAt, issues: [{ code }] };
            if (perMonth(source)) next.retryMonth = job.fromMonth;
            if (paused) delete next.nextCheckAt;
            else next.nextCheckAt = new Date(now() + Math.min(intervalMs, backfillIntervalMs * 2 ** Math.min(failures - 1, 10))).toISOString();
            await updateSource(next, state.ledger, version); source = next; break;
          }
        }
        const stored = state.sources.find(s => s.source === name);
        if (!attempts && stored.status !== 'needs_login' && (!stored.nextCheckAt || stored.nextCheckAt <= iso())) {
          await updateSource({ ...stored, nextCheckAt: new Date(now() + intervalMs).toISOString() }, state.ledger, version);
        }
        if (stored.status !== 'needs_login' && stored.status !== 'error' && pendingMonths(stored)) {
          await updateSource({ ...stored, nextCheckAt: new Date(now() + backfillIntervalMs).toISOString() }, state.ledger, version);
        }
      }
      const selected = state.sources.filter(s => sources.includes(s.source));
      publishState({ state: selected.every(s => s.status === 'needs_login') ? 'needs_login' : selected.some(s => ['needs_login', 'error', 'unavailable'].includes(s.status)) ? 'partial' : enabled ? 'waiting' : 'idle' });
      return structuredClone(info);
    } finally { active.delete(key); }
  }
  function schedule(version) {
    if (!enabled || disposed || version !== generation) return;
    const due = state?.sources.filter(s => sources.includes(s.source) && s.status !== 'needs_login').map(s => Date.parse(s.nextCheckAt || iso()));
    if (!due?.length) return;
    const delay = Math.max(1000, Math.min(...due) - now());
    emit({ nextRunAt: new Date(now() + delay).toISOString() });
    timer = timers.setTimeout(() => { timer = undefined; launch(false).catch(() => {}); }, delay); timer?.unref?.();
  }
  function launch(force, only) {
    if (disposed) return Promise.reject(fault('REVENUE_SYNC_STOPPED'));
    if (only && (!Array.isArray(only) || !only.length || new Set(only).size !== only.length || only.some(s => !sources.includes(s)))) return Promise.reject(fault('REVENUE_UNSUPPORTED_SOURCE'));
    if (pending) return pendingVersion === generation ? pending : pending.catch(() => {}).then(() => launch(force, only));
    if (timer !== undefined) timers.clearTimeout(timer); timer = undefined;
    const version = generation; pendingVersion = version;
    pending = run(version, force, only).catch(error => {
      if (version === generation) { enabled = false; emit({ state: 'error', lastErrorCode: safeCode(error), nextRunAt: null }); }
      throw fault(safeCode(error));
    }).finally(() => { pending = undefined; schedule(version); }); return pending;
  }
  const stop = () => { enabled = false; generation++; if (timer !== undefined) timers.clearTimeout(timer); timer = undefined; emit({ state: 'stopped', nextRunAt: null }); };
  return { start() { if (disposed) return Promise.reject(fault('REVENUE_SYNC_STOPPED')); enabled = true; return launch(true); },
    syncNow: options => launch(true, options?.sources), stop, dispose() { stop(); disposed = true; },
    status: () => structuredClone(info), export: () => state ? structuredClone(state.ledger) : createRevenueLedger({ platform, accountId, state: seed }).export() };
}
module.exports = { createCreatorRevenueSync };
