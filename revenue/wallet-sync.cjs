// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises'), path = require('node:path');
const { binding, fault, month, monthRange, shiftMonth, chinaDay, timestamp } = require('./model.cjs');
const { createRevenueLedger } = require('./ledger.cjs');
const locks = new Set();
const pausedCodes = new Set(['ACCOUNT_CHANGED', 'PLATFORM_ACCOUNT_CHANGED', 'LOGIN_REQUIRED', 'REVENUE_WALLET_SESSION_REQUIRED',
  'VERIFICATION_REQUIRED', 'REVENUE_DISPOSED', 'LOGIN_CANCELLED', 'REVENUE_SYNC_STOPPED']);
const reportedCodes = new Set([...pausedCodes, 'REVENUE_BUSY', 'REVENUE_STORAGE_ERROR', 'REVENUE_STORAGE_INVALID', 'REVENUE_STORAGE_LIMIT',
  'REVENUE_NETWORK_ERROR', 'REVENUE_HTTP_ERROR', 'REVENUE_REQUEST_TIMEOUT', 'REVENUE_COLLECTION_TIMEOUT', 'REVENUE_PLATFORM_REJECTED',
  'REVENUE_SCHEMA_CHANGED', 'REVENUE_PAGINATION_INCOMPLETE', 'REVENUE_WALLET_RECONCILIATION_FAILED', 'REVENUE_WALLET_SNAPSHOT_CHANGED',
  'REVENUE_RESPONSE_TOO_LARGE', 'REVENUE_HISTORY_OUTSIDE_WINDOW', 'REVENUE_MONTH_MISMATCH', 'REVENUE_DATE_OUTSIDE_RANGE',
  'CONFLICTING_REVENUE_TRANSACTION', 'PAGE_CHANGED', 'UNTRUSTED_PAGE']);
function safeCode(error) { return reportedCodes.has(error?.code) ? error.code : 'REVENUE_SCHEMA_CHANGED'; }
function syncBinding({ owner, accountId, identityKind = 'account-cookie-uid_tt' }) {
  binding('douyin', accountId);
  if (typeof owner !== 'string' || !owner || owner.length > 1000 || identityKind !== 'account-cookie-uid_tt') throw fault('INVALID_REVENUE_IDENTITY_KIND');
  return { ownerHash: createHash('sha256').update(owner).digest('hex'), accountId, identityKind };
}
function stateKey(value) {
  if (!value || !/^[a-f0-9]{64}$/.test(value.ownerHash) || !/^[a-f0-9]{64}$/.test(value.accountId) || value.identityKind !== 'account-cookie-uid_tt') throw fault('REVENUE_STORAGE_INVALID');
  return createHash('sha256').update(JSON.stringify([value.ownerHash, value.accountId, value.identityKind])).digest('hex');
}
function cleanState(value, bound) {
  stateKey(bound);
  if (!value || value.schemaVersion !== 1 || value.platform !== 'douyin' || value.source !== 'wallet' ||
    value.ownerHash !== bound.ownerHash || value.accountId !== bound.accountId || value.identityKind !== bound.identityKind ||
    !Array.isArray(value.checkedMonths) || value.checkedMonths.length > 1200) throw fault('REVENUE_STORAGE_INVALID');
  const updatedAt = timestamp(value.updatedAt), current = chinaDay(Math.floor(Date.parse(updatedAt) / 1000)).slice(0, 7);
  const ledger = createRevenueLedger({ platform: 'douyin', accountId: bound.accountId, state: value.ledger }).export();
  if (!value.ledger || ledger.records.some(row => row.source !== 'wallet') || ledger.metrics.length || ledger.nativeRecords.length || ledger.nativeMetrics.length) throw fault('REVENUE_STORAGE_INVALID');
  const seen = new Set(), statements = new Map((ledger.statements || []).map(row => [row.month, row]));
  const checkedMonths = value.checkedMonths.map(row => {
    if (!row || !['stored', 'no_data'].includes(row.status)) throw fault('REVENUE_STORAGE_INVALID');
    const selected = month(row.month), fetchedAt = timestamp(row.fetchedAt), statement = statements.get(selected);
    if (seen.has(selected) || selected > current || fetchedAt > updatedAt ||
      (row.status === 'stored' ? !statement || statement.fetchedAt !== fetchedAt : !!statement)) throw fault('REVENUE_STORAGE_INVALID');
    seen.add(selected); return { month: selected, status: row.status, fetchedAt };
  }).sort((a, b) => a.month.localeCompare(b.month));
  if ([...statements.keys()].some(selected => !seen.has(selected))) throw fault('REVENUE_STORAGE_INVALID');
  const earliestAvailableMonth = value.earliestAvailableMonth === undefined ? undefined : month(value.earliestAvailableMonth);
  if (earliestAvailableMonth && earliestAvailableMonth > current) throw fault('REVENUE_STORAGE_INVALID');
  return { schemaVersion: 1, platform: 'douyin', source: 'wallet', ...bound, updatedAt,
    ...(earliestAvailableMonth ? { earliestAvailableMonth } : {}), checkedMonths, ledger };
}

// Each file contains normalized statements and checkpoints only. The host owns
// this directory (and its backup/encryption policy); Electron keeps login state.
function createRevenueFileStore({ directory } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('An absolute revenue storage directory is required');
  const fileFor = bound => path.join(directory, 'douyin-wallet-' + stateKey(bound) + '.json');
  return {
    async load(bound) {
      let handle;
      try {
        handle = await fs.open(fileFor(bound), 'r');
        if ((await handle.stat()).size > 24 * 1024 * 1024) throw fault('REVENUE_STORAGE_LIMIT');
        const text = await handle.readFile('utf8');
        if (Buffer.byteLength(text) > 24 * 1024 * 1024) throw fault('REVENUE_STORAGE_LIMIT');
        return cleanState(JSON.parse(text), bound);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw fault(error.code === 'REVENUE_STORAGE_LIMIT' ? error.code : 'REVENUE_STORAGE_INVALID');
      } finally { await handle?.close(); }
    },
    async save(bound, value) {
      const cleaned = cleanState(value, bound), body = JSON.stringify(cleaned), target = fileFor(bound);
      if (Buffer.byteLength(body) > 24 * 1024 * 1024) throw fault('REVENUE_STORAGE_LIMIT');
      const temporary = target + '.' + randomUUID() + '.tmp'; let handle;
      try {
        await fs.mkdir(directory, { recursive: true });
        handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(body); await handle.sync(); await handle.close(); handle = undefined;
        await fs.rename(temporary, target);
      } catch { throw fault('REVENUE_STORAGE_ERROR'); }
      finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
    }
  };
}

function createDouyinWalletSync({ owner, accountId, identityKind = 'account-cookie-uid_tt', getAccount, reader, store,
  fromMonth, batchMonths = 6, intervalMs = 6 * 3600000, backfillIntervalMs = 60000, historyRefreshMs = 30 * 86400000,
  now = Date.now, onStatus = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
  const bound = syncBinding({ owner, accountId, identityKind }), key = stateKey(bound);
  if (typeof getAccount !== 'function' || typeof reader?.lookup !== 'function' || typeof store?.load !== 'function' || typeof store?.save !== 'function' ||
    typeof now !== 'function' || typeof onStatus !== 'function' || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') throw new TypeError('Wallet reader, account guard and store are required');
  if (!Number.isInteger(batchMonths) || batchMonths < 1 || batchMonths > 24) throw new TypeError('Invalid monthly batch size');
  for (const n of [intervalMs, backfillIntervalMs]) if (!Number.isSafeInteger(n) || n < 1000 || n > 2147483647) throw new TypeError('Invalid sync interval');
  if (!Number.isSafeInteger(historyRefreshMs) || historyRefreshMs < intervalMs || historyRefreshMs > 365 * 86400000) throw new TypeError('Invalid history refresh interval');
  if (fromMonth !== undefined) month(fromMonth);
  let state, pending, pendingVersion, timer, enabled = false, disposed = false, generation = 0, failures = 0;
  let info = { state: 'idle', pendingMonths: null, storedMonths: 0, checkedMonths: 0, lastSuccessAt: null, lastErrorCode: null, nextRunAt: null };
  const publish = changes => { info = { ...info, ...changes }; try { onStatus({ ...info }); } catch { /* A UI callback cannot corrupt saved history. */ } };
  function guard(version) {
    if (disposed || version !== generation) throw fault('REVENUE_SYNC_STOPPED');
    const account = getAccount();
    if (!account || account.accountId !== owner || account.kind === 'signed-out') throw fault('ACCOUNT_CHANGED');
  }
  const currentMonth = () => chinaDay(Math.floor(now() / 1000)).slice(0, 7);
  function historyMonths(current) {
    if (!state?.earliestAvailableMonth) return [];
    const first = fromMonth && fromMonth > state.earliestAvailableMonth ? fromMonth : state.earliestAvailableMonth;
    return first > current ? [] : monthRange(first, current);
  }
  function progress() {
    const checked = new Set(state.checkedMonths.map(row => row.month));
    return { pendingMonths: state.earliestAvailableMonth ? historyMonths(currentMonth()).filter(m => !checked.has(m)).length : null,
      storedMonths: (state.ledger.statements || []).length, checkedMonths: checked.size,
      ...(state.earliestAvailableMonth ? { earliestAvailableMonth: state.earliestAvailableMonth } : {}) };
  }
  async function run(version, force) {
    guard(version);
    if (locks.has(key)) throw fault('REVENUE_BUSY'); locks.add(key);
    try {
      publish({ state: 'syncing', lastErrorCode: null, nextRunAt: null });
      let saved;
      try { saved = await store.load(bound); } catch (error) { throw fault(error.code === 'REVENUE_STORAGE_LIMIT' ? error.code : 'REVENUE_STORAGE_INVALID'); }
      guard(version);
      const stamp = new Date(now()).toISOString(), current = currentMonth();
      if (fromMonth && fromMonth > current) throw fault('REVENUE_HISTORY_OUTSIDE_WINDOW');
      state = saved ? cleanState(saved, bound) : { schemaVersion: 1, platform: 'douyin', source: 'wallet', ...bound, updatedAt: stamp,
        checkedMonths: [], ledger: createRevenueLedger({ platform: 'douyin', accountId }).export() };
      publish({ ...progress(), lastSuccessAt: state.checkedMonths.map(row => row.fetchedAt).sort().at(-1) || null });
      let problem; const attempted = new Set();
      for (let n = 0; n < batchMonths; n++) {
        guard(version);
        const checked = new Map(state.checkedMonths.map(row => [row.month, row]));
        const recent = [current, shiftMonth(current, -1), shiftMonth(current, -2)].filter(m =>
          (!state.earliestAvailableMonth || m >= state.earliestAvailableMonth) && (!fromMonth || m >= fromMonth) &&
          (force || !checked.has(m) || Date.parse(checked.get(m).fetchedAt) <= now() - intervalMs));
        const history = historyMonths(current).reverse();
        const candidates = [...(!state.earliestAvailableMonth ? [current] : []), ...recent,
          ...history.filter(m => !checked.has(m)), ...history.filter(m => checked.has(m) && Date.parse(checked.get(m).fetchedAt) <= now() - historyRefreshMs)];
        const selected = candidates.find(m => !attempted.has(m)); if (!selected) break; attempted.add(selected);
        try {
          const snapshot = await reader.lookup({ owner, platform: 'douyin', expectedIdentity: accountId, identityKind, source: 'wallet', fromMonth: selected, toMonth: selected });
          guard(version);
          if (!snapshot || snapshot.platform !== 'douyin' || snapshot.accountId !== accountId) throw fault('PLATFORM_ACCOUNT_CHANGED');
          if (snapshot.source !== 'wallet' || snapshot.requestedMonths?.length !== 1 || snapshot.requestedMonths[0] !== selected ||
            !Array.isArray(snapshot.checkedMonths) || !Array.isArray(snapshot.statements)) throw fault('REVENUE_SCHEMA_CHANGED');
          const fetchedAt = timestamp(snapshot.fetchedAt), earliest = month(snapshot.earliestAvailableMonth);
          if (fetchedAt > new Date(now() + 1000).toISOString() || earliest > current) throw fault('REVENUE_SCHEMA_CHANGED');
          const check = snapshot.checkedMonths[0];
          if (snapshot.checkedMonths.length !== 1 || check?.month !== selected || !['stored', 'no_data'].includes(check.status)) {
            const issue = snapshot.issues?.find(i => i.month === selected); throw fault(safeCode(issue));
          }
          const oldCheck = checked.get(selected);
          if (oldCheck && fetchedAt < oldCheck.fetchedAt) throw fault('REVENUE_WALLET_SNAPSHOT_CHANGED');
          if (check.status === 'no_data' && oldCheck?.status === 'stored') throw fault('REVENUE_WALLET_SNAPSHOT_CHANGED');
          if (check.status === 'stored' ? snapshot.statements.length !== 1 || snapshot.statements[0].month !== selected || snapshot.statements[0].fetchedAt !== fetchedAt : snapshot.statements.length || snapshot.records?.length) throw fault('REVENUE_SCHEMA_CHANGED');
          const ledger = createRevenueLedger({ platform: 'douyin', accountId, state: state.ledger }); ledger.ingest(snapshot);
          checked.set(selected, { month: selected, status: check.status, fetchedAt });
          const next = cleanState({ ...state, updatedAt: new Date(now()).toISOString(), earliestAvailableMonth: earliest,
            checkedMonths: [...checked.values()], ledger: ledger.export() }, bound);
          guard(version);
          try { await store.save(bound, next); } catch (error) { throw fault(error.code === 'REVENUE_STORAGE_LIMIT' ? error.code : 'REVENUE_STORAGE_ERROR'); }
          guard(version); state = next;
          publish({ ...progress(), lastSuccessAt: fetchedAt });
        } catch (error) {
          guard(version);
          const code = safeCode(error);
          if (pausedCodes.has(code) || ['REVENUE_STORAGE_ERROR', 'REVENUE_STORAGE_LIMIT'].includes(code)) throw fault(code);
          problem ||= code;
        }
      }
      publish(progress());
      if (problem) throw fault(problem);
      failures = 0; publish({ state: enabled ? 'waiting' : 'idle', lastErrorCode: null });
      return { ...info };
    } finally { locks.delete(key); }
  }
  function schedule() {
    if (!enabled || disposed) return;
    const delay = failures ? Math.min(intervalMs, backfillIntervalMs * 2 ** Math.min(failures - 1, 10)) : info.pendingMonths ? backfillIntervalMs : intervalMs;
    publish({ nextRunAt: new Date(now() + delay).toISOString() });
    timer = timers.setTimeout(() => { timer = undefined; launch(false).catch(() => {}); }, delay);
    timer?.unref?.();
  }
  function launch(force) {
    if (disposed) return Promise.reject(fault('REVENUE_SYNC_STOPPED'));
    if (pending) return pendingVersion === generation ? pending : pending.catch(() => {}).then(() => launch(force));
    if (timer !== undefined) timers.clearTimeout(timer); timer = undefined;
    const version = generation; pendingVersion = version;
    pending = run(version, force).catch(error => {
      const code = safeCode(error);
      if (version === generation && !disposed) {
        failures++;
        if (pausedCodes.has(code)) enabled = false;
        publish({ state: pausedCodes.has(code) ? 'needs_login' : 'error', lastErrorCode: code, nextRunAt: null });
      }
      throw fault(code);
    }).finally(() => { pending = undefined; if (version === generation) schedule(); });
    return pending;
  }
  return {
    syncNow: () => launch(true),
    start() { if (disposed) return Promise.reject(fault('REVENUE_SYNC_STOPPED')); enabled = true; return launch(false); },
    stop() { enabled = false; generation++; if (timer !== undefined) timers.clearTimeout(timer); timer = undefined; publish({ state: 'stopped', nextRunAt: null }); },
    dispose() { this.stop(); disposed = true; },
    status: () => ({ ...info }),
    export: () => state ? structuredClone(state.ledger) : createRevenueLedger({ platform: 'douyin', accountId }).export()
  };
}
module.exports = { createDouyinWalletSync, createRevenueFileStore };
