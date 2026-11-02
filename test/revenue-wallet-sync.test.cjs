'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const { createDouyinWalletSync, createRevenueFileStore } = require('../revenue/index.cjs');
const { collectDouyinWalletRevenue } = require('../revenue/douyin-wallet.cjs');
const { ACCOUNT_ID, FETCHED_AT, syntheticDouyinWalletResponse } = require('../testing/revenue-wallet-fixtures.cjs');
const fail = code => Object.assign(new Error('synthetic-private-error-must-not-be-logged'), { code });
function harness(options = {}) {
  let saved = null, clock = Date.parse(FETCHED_AT), currentOwner = 'synthetic-owner', mode = 'ok', wait;
  const calls = [], writes = [], events = [], scheduled = new Map(); let timerId = 0;
  const store = { load: async () => structuredClone(saved), save: async (_bound, value) => { if (mode === 'disk-fail') throw fail('EIO'); saved = structuredClone(value); writes.push(saved); } };
  const reader = { lookup: async input => {
    calls.push(input);
    if (wait) { const pending = wait; wait = undefined; await pending; }
    if (mode === 'login') throw fail('REVENUE_WALLET_SESSION_REQUIRED');
    if (mode === 'network') throw fail('REVENUE_NETWORK_ERROR');
    const result = await collectDouyinWalletRevenue({ ...input, accountId: input.expectedIdentity, fetchedAt: new Date(clock).toISOString(),
      request: async descriptor => syntheticDouyinWalletResponse(descriptor, { empty: mode === 'missing', missing: mode === 'missing' }) });
    if (mode === 'other-account') result.accountId = 'd'.repeat(64);
    if (mode === 'malformed') result.records[0].amountMinor = '99999';
    return result;
  } };
  const config = { owner: currentOwner, accountId: ACCOUNT_ID, getAccount: () => ({ accountId: currentOwner }), reader, store,
    now: () => clock, onStatus: state => events.push(state), timers: { setTimeout: (fn, ms) => { const id = ++timerId; scheduled.set(id, { fn, ms }); return id; }, clearTimeout: id => scheduled.delete(id) }, ...options };
  const make = extra => createDouyinWalletSync({ ...config, ...extra }), sync = make();
  return { sync, make, calls, writes, events, scheduled, config, saved: () => saved, mode: value => { mode = value; }, advance: ms => { clock += ms; },
    owner: value => { currentOwner = value; }, defer: () => { let resolve; wait = new Promise(done => { resolve = done; }); return resolve; },
    tick: async () => { const [id, value] = scheduled.entries().next().value; scheduled.delete(id); clock += value.ms; value.fn(); await new Promise(resolve => setImmediate(resolve)); } };
}
test('automatic sync prioritizes recent months, backfills in bounded batches and resumes persisted checkpoints', async () => {
  const h = harness({ batchMonths: 2 }); await h.sync.start();
  assert.deepEqual(h.calls.map(r => r.fromMonth), ['2026-10', '2026-09']);
  assert.equal(h.sync.status().pendingMonths, 3); assert.equal([...h.scheduled.values()][0].ms, 60000);
  h.sync.dispose(); const restarted = h.make(); await restarted.start();
  assert.deepEqual(h.calls.slice(2).map(r => r.fromMonth), ['2026-08', '2026-07']);
  await h.tick(); assert.equal(restarted.status().pendingMonths, 0); assert.equal(restarted.status().storedMonths, 5);
  assert.equal([...h.scheduled.values()][0].ms, 6 * 3600000);
  assert.equal(h.writes.length, 5); assert.ok(h.calls.every(r => r.source === 'wallet' && r.expectedIdentity === ACCOUNT_ID));
  restarted.dispose(); assert.equal(h.scheduled.size, 0);
});
test('manual refresh updates recent statements without adding duplicate transactions or rewriting untouched history', async () => {
  const h = harness(); await h.sync.syncNow(); const before = h.sync.export(); h.advance(1000); await h.sync.syncNow();
  assert.equal(h.sync.export().statements.length, 5); assert.equal(h.calls.length, 8);
  assert.deepEqual(h.sync.export().statements[0], before.statements[0]);
  assert.ok(h.sync.export().statements.every(s => s.transactions.length === 4)); assert.equal(h.scheduled.size, 0);
  const copy = h.sync.export(); copy.statements[0].transactions.length = 0; assert.equal(h.sync.export().statements[0].transactions.length, 4);
});
test('closed historical months are periodically revisited for late adjustments', async () => {
  const h = harness({ batchMonths: 24, intervalMs: 1000, backfillIntervalMs: 1000, historyRefreshMs: 3000 }); await h.sync.start();
  h.advance(4000); await h.sync.syncNow(); assert.equal(h.calls.length, 10); h.sync.dispose();
});
test('network failures retain history and use bounded backoff; successful retry clears the error', async () => {
  const h = harness(); await h.sync.start(); const before = h.sync.export(); h.mode('network');
  await assert.rejects(h.sync.syncNow(), { code: 'REVENUE_NETWORK_ERROR' }); assert.deepEqual(h.sync.export(), before);
  assert.equal([...h.scheduled.values()][0].ms, 60000); assert.equal(h.sync.status().state, 'error');
  await assert.rejects(h.sync.syncNow(), { code: 'REVENUE_NETWORK_ERROR' }); assert.equal([...h.scheduled.values()][0].ms, 120000);
  h.mode('ok'); h.advance(1000); await h.sync.syncNow(); assert.equal(h.sync.status().lastErrorCode, null); h.sync.dispose();
});
test('wallet-session failures pause background work until the host explicitly resumes after login', async () => {
  const h = harness(); h.mode('login'); await assert.rejects(h.sync.start(), { code: 'REVENUE_WALLET_SESSION_REQUIRED' });
  assert.equal(h.sync.status().state, 'needs_login'); assert.equal(h.scheduled.size, 0); assert.equal(h.writes.length, 0);
  h.mode('ok'); await h.sync.start(); assert.equal(h.sync.status().state, 'waiting'); h.sync.dispose();
});
test('host and platform identity changes prevent financial data from reaching storage', async () => {
  const h = harness(); h.mode('other-account'); await assert.rejects(h.sync.start(), { code: 'PLATFORM_ACCOUNT_CHANGED' });
  assert.equal(h.writes.length, 0); h.mode('ok'); const release = h.defer(), pending = h.sync.start();
  await new Promise(resolve => setImmediate(resolve)); h.owner('different-owner'); release();
  await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' }); assert.equal(h.writes.length, 0); h.sync.dispose();
});
test('concurrent calls coalesce, same-binding coordinators are locked, and stopping suppresses delayed saves', async () => {
  const h = harness(), release = h.defer(), one = h.sync.start(), two = h.sync.syncNow(); assert.equal(one, two);
  await new Promise(resolve => setImmediate(resolve)); const second = h.make(); await assert.rejects(second.syncNow(), { code: 'REVENUE_BUSY' });
  h.sync.stop(); release(); await assert.rejects(one, { code: 'REVENUE_SYNC_STOPPED' });
  assert.equal(h.writes.length, 0); assert.equal(h.sync.status().state, 'stopped');
  await second.syncNow(); assert.equal(second.export().statements.length, 5); second.dispose(); h.sync.dispose();
});
test('immediate stop and restart waits for the cancelled acquisition before launching another', async () => {
  const h = harness(), release = h.defer(), first = h.sync.start(); await new Promise(resolve => setImmediate(resolve));
  h.sync.stop(); const again = h.sync.start(); release(); await assert.rejects(first, { code: 'REVENUE_SYNC_STOPPED' });
  await again; assert.equal(h.writes.length, 5); assert.equal(h.sync.status().state, 'waiting'); h.sync.dispose();
});
test('failed disk writes and malformed wallet projections do not advance checkpoints', async () => {
  for (const mode of ['disk-fail', 'malformed']) {
    const h = harness(); h.mode(mode); await assert.rejects(h.sync.syncNow());
    assert.equal(h.saved(), null); assert.equal(h.sync.export().records.length, 0); assert.equal(h.sync.status().storedMonths, 0);
  }
});
test('no-data checkpoints are unknown, and cannot erase an already stored statement', async () => {
  const h = harness(); h.mode('missing'); await h.sync.syncNow();
  assert.equal(h.saved().checkedMonths.length, 5); assert.ok(h.saved().checkedMonths.every(r => r.status === 'no_data'));
  assert.equal(h.sync.export().records.length, 0); assert.equal(h.sync.status().storedMonths, 0);
  h.mode('ok'); h.advance(1000); await h.sync.syncNow(); const before = h.sync.export(); h.mode('missing'); h.advance(1000);
  await assert.rejects(h.sync.syncNow(), { code: 'REVENUE_WALLET_SNAPSHOT_CHANGED' }); assert.deepEqual(h.sync.export(), before);
});
test('callbacks expose only safe status and cannot interrupt successful persistence', async () => {
  const h = harness({ onStatus: () => { throw new Error('UI error'); } }); await h.sync.syncNow(); assert.equal(h.writes.length, 5);
  const second = harness(); second.mode('network'); await assert.rejects(second.sync.syncNow());
  assert.ok(!JSON.stringify(second.events).includes('synthetic-private-error')); assert.ok(!JSON.stringify(second.events).includes(ACCOUNT_ID));
});
test('file store writes atomic normalized history, separates owners and rejects corrupt/mismatched files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'liveconnect-wallet-store-'));
  const store = createRevenueFileStore({ directory }), h = harness({ store });
  await h.sync.syncNow(); const files = await fs.readdir(directory); assert.equal(files.length, 1); assert.ok(files[0].endsWith('.json'));
  const bound = { accountId: ACCOUNT_ID, identityKind: 'account-cookie-uid_tt', ownerHash: createHash('sha256').update('synthetic-owner').digest('hex') };
  const saved = await store.load(bound); assert.equal(saved.ledger.statements.length, 5);
  assert.ok(!(await fs.readFile(path.join(directory, files[0]), 'utf8')).includes('synthetic-order'));
  assert.equal(await store.load({ ...bound, ownerHash: 'e'.repeat(64) }), null);
  await assert.rejects(store.save(bound, { ...saved, accountId: 'd'.repeat(64) }), { code: 'REVENUE_STORAGE_INVALID' });
  assert.equal((await store.load(bound)).accountId, ACCOUNT_ID);
  const extra = { ...saved, rawResponse: 'synthetic-secret', Cookie: 'synthetic-secret' }; await store.save(bound, extra);
  assert.ok(!(await fs.readFile(path.join(directory, files[0]), 'utf8')).includes('synthetic-secret'));
  await fs.writeFile(path.join(directory, files[0]), '{corrupt');
  await assert.rejects(store.load(bound), { code: 'REVENUE_STORAGE_INVALID' });
  await fs.unlink(path.join(directory, files[0])); await fs.rmdir(directory);
});
