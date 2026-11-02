'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { createCreatorRevenueSync, createCreatorRevenueFileStore, createRevenueLedger, importRevenueCsv } = require('../revenue/index.cjs');
const { collectCreatorRevenue } = require('../revenue/adapters.cjs');
const { collectDouyinWalletRevenue } = require('../revenue/douyin-wallet.cjs');
const { collectDouyinAnchorRevenue } = require('../revenue/douyin-anchor.cjs');
const { syntheticRevenueResponse, syntheticAnchorResponse } = require('../testing/revenue-fixtures.cjs');
const { KS_USER_ID, syntheticExtraRevenueResponse, syntheticWalletResponse } = require('../testing/revenue-extra-fixtures.cjs');
const { syntheticDouyinWalletResponse } = require('../testing/revenue-wallet-fixtures.cjs');
const { syncBinding } = require('../revenue/creator-sync-state.cjs');
const ACCOUNT = 'a'.repeat(64), DATE = '2026-10-30T04:00:00.000Z';
const kinds = { bilibili: 'uid', douyin: 'account-cookie-uid_tt', kuaishou: 'user_id', wechat_channels: 'finder' };
const failure = code => Object.assign(new Error('private-error-content'), { code });
function harness(platform, options = {}) {
  let clock = Date.parse(DATE), actualOwner = 'synthetic-owner', defer;
  const calls = [], writes = [], states = new Map(), modes = new Map(), timers = new Map(), statuses = []; let counter = 0;
  const store = { load: async bound => structuredClone(states.get(JSON.stringify(bound)) || null),
    save: async (bound, value) => { if (modes.get('store') === 'fail') throw failure('EIO'); states.set(JSON.stringify(bound), structuredClone(value)); writes.push(structuredClone(value)); } };
  const reader = { lookup: async input => {
    calls.push(input); if (defer) { const pending = defer; defer = undefined; await pending; }
    const mode = modes.get(input.source);
    if (mode === 'login') throw failure(input.source === 'wallet' ? 'REVENUE_WALLET_SESSION_REQUIRED' : 'LOGIN_REQUIRED');
    if (mode === 'network') throw failure('REVENUE_NETWORK_ERROR');
    const params = { ...input, accountId: input.expectedIdentity, fetchedAt: new Date(clock).toISOString() };
    let snapshot;
    if (input.source === 'wallet') snapshot = await collectDouyinWalletRevenue({ ...params,
      request: async descriptor => syntheticDouyinWalletResponse(descriptor) });
    else if (input.source === 'anchor_dashboard') snapshot = await collectDouyinAnchorRevenue({ ...params,
      request: async descriptor => syntheticAnchorResponse(descriptor, { asOf: '2026-10-29' }) });
    else snapshot = await collectCreatorRevenue({ ...params, ownUserId: KS_USER_ID,
      request: async descriptor => ['bilibili', 'douyin'].includes(platform) ? syntheticRevenueResponse(platform, descriptor) : syntheticExtraRevenueResponse(platform, descriptor),
      readWallet: async () => syntheticWalletResponse('2026-09') });
    if (mode === 'account') snapshot.accountId = 'd'.repeat(64);
    if (mode === 'period') snapshot.requestedMonths = ['2020-01'];
    if (mode === 'empty') { snapshot.records = []; snapshot.metrics = []; snapshot.issues = []; }
    if (mode === 'malformed') snapshot.records[0].amountMinor = 'NaN';
    return snapshot;
  } };
  const config = { owner: 'synthetic-owner', platform, accountId: ACCOUNT, identityKind: kinds[platform], getAccount: () => ({ accountId: actualOwner }),
    reader, store, now: () => clock, fromMonth: '2026-06', onStatus: s => statuses.push(s),
    timers: { setTimeout: (fn, ms) => { const id = ++counter; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) }, ...options };
  const make = extra => createCreatorRevenueSync({ ...config, ...extra }), sync = make();
  return { sync, make, calls, writes, timers, modes, statuses, config, states, advance: ms => { clock += ms; }, owner: value => { actualOwner = value; },
    delay: () => { let resolve; defer = new Promise(r => { resolve = r; }); return resolve; },
    tick: async () => { const [id, value] = timers.entries().next().value; timers.delete(id); clock += value.ms; value.fn(); for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); } };
}
for (const platform of Object.keys(kinds)) test(platform + ': automatic source collection persists monthly history and idempotent refresh', async () => {
  const h = harness(platform); await h.sync.start();
  assert.ok(h.sync.export().records.length); assert.equal(h.sync.status().platform, platform); assert.ok(h.timers.size);
  const ledger = createRevenueLedger({ platform, accountId: ACCOUNT, state: h.sync.export() }); assert.ok(ledger.series().length);
  const count = h.sync.export().records.length; h.advance(1000); await h.sync.syncNow(); assert.equal(h.sync.export().records.length, count);
  assert.ok(h.calls.every(c => c.expectedIdentity === ACCOUNT && c.owner === 'synthetic-owner')); h.sync.dispose(); assert.equal(h.timers.size, 0);
});
test('one blocked Douyin wallet does not stop creator-center and anchor synchronization', async () => {
  const h = harness('douyin'); h.modes.set('wallet', 'login'); const result = await h.sync.start();
  assert.equal(result.state, 'partial'); const wallet = result.sources.find(s => s.source === 'wallet'); assert.equal(wallet.state, 'needs_login');
  assert.equal(wallet.lastErrorCode, 'REVENUE_WALLET_SESSION_REQUIRED'); assert.ok(h.sync.export().nativeRecords.length);
  const walletCalls = h.calls.filter(c => c.source === 'wallet').length; await h.tick();
  assert.equal(h.calls.filter(c => c.source === 'wallet').length, walletCalls);
  assert.ok(h.calls.filter(c => c.source === 'creator_center').length > 1);
  h.modes.delete('wallet'); await h.sync.syncNow({ sources: ['wallet'] }); assert.equal(h.sync.export().statements.length, 5); h.sync.dispose();
});
test('Kuaishou bounded historical batches resume from durable monthly checkpoints', async () => {
  const h = harness('kuaishou', { batchMonths: 2 }); await h.sync.start();
  assert.deepEqual(h.calls.map(c => c.fromMonth), ['2026-10', '2026-09']); assert.equal(h.sync.status().sources[0].pendingMonths, 3);
  await h.tick(); assert.deepEqual(h.calls.slice(2).map(c => c.fromMonth), ['2026-08', '2026-07']);
  h.sync.dispose(); const reloaded = h.make(); await reloaded.start();
  assert.equal(reloaded.status().sources[0].checkedMonths, 4); await h.tick();
  assert.equal(reloaded.status().sources[0].pendingMonths, 0); assert.equal(reloaded.status().sources[0].checkedMonths, 5); reloaded.dispose();
});
test('source-specific windows avoid querying inaccessible Bilibili months or inventing long Douyin trends', async () => {
  const bili = harness('bilibili', { fromMonth: '2020-01' }); await bili.sync.syncNow();
  assert.equal(bili.calls[0].fromMonth, '2026-04'); assert.equal(bili.calls.length, 1);
  const dy = harness('douyin', { fromMonth: '2020-01', sources: ['creator_center', 'anchor_dashboard'] }); await dy.sync.syncNow();
  assert.ok(dy.calls.every(c => c.fromMonth === '2026-09')); assert.equal(dy.calls.length, 2);
});
test('Channels retains an explicit mobile-incentive gap while automatically preserving live months', async () => {
  const h = harness('wechat_channels'); await h.sync.start();
  assert.ok(h.sync.status().sources[0].issues.some(i => i.code === 'REVENUE_VIDEO_INCENTIVE_MOBILE_REQUIRED'));
  assert.equal(h.sync.status().sources[0].state, 'partial');
  const before = h.sync.export(); h.modes.set('creator_center', 'login'); await h.sync.syncNow();
  assert.equal(h.sync.status().state, 'needs_login'); assert.equal(h.timers.size, 0); assert.deepEqual(h.sync.export(), before); h.sync.dispose();
});
test('initialLedger migrates previously saved history and manual imports without discarding older months', async () => {
  const ledger = createRevenueLedger({ platform: 'bilibili', accountId: ACCOUNT });
  ledger.ingest(importRevenueCsv({ platform: 'bilibili', accountId: ACCOUNT, fetchedAt: DATE,
    text: 'period,date,scope,category_id,category_name,amount_yuan\nmonth,2020-01,statement,total,Synthetic historical month,12.34' }));
  const h = harness('bilibili', { initialLedger: ledger.export() }); await h.sync.syncNow();
  assert.equal(h.sync.export().records.find(r => r.scope === 'statement').amountMinor, '1234');
  const second = h.make(); await second.syncNow(); assert.equal(second.export().records.filter(r => r.scope === 'statement').length, 1);
});
test('network backoff is per source and never erases previously saved amounts', async () => {
  const h = harness('douyin'); await h.sync.start(); const before = h.sync.export(); h.modes.set('wallet', 'network');
  h.advance(1000); await h.sync.syncNow({ sources: ['wallet'] }); assert.deepEqual(h.sync.export(), before);
  assert.equal(h.sync.status().sources.find(s => s.source === 'wallet').state, 'error'); assert.equal([...h.timers.values()][0].ms, 60000);
  await h.tick(); assert.equal([...h.timers.values()][0].ms, 120000);
  h.modes.delete('wallet'); await h.tick(); assert.notEqual(h.sync.status().sources.find(s => s.source === 'wallet').state, 'error'); h.sync.dispose();
});
test('host/platform switches abort all new writes and stop scheduling', async () => {
  const h = harness('douyin'); h.modes.set('creator_center', 'account'); await assert.rejects(h.sync.start(), { code: 'PLATFORM_ACCOUNT_CHANGED' });
  assert.equal(h.sync.export().records.length, 0); assert.equal(h.timers.size, 0);
  h.modes.delete('creator_center'); const release = h.delay(), pending = h.sync.start();
  await new Promise(r => setImmediate(r)); const writes = h.writes.length; h.owner('other-owner'); release();
  await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' }); assert.equal(h.writes.length, writes); h.sync.dispose();
});
test('malformed monetary batches and mismatched months preserve the last valid ledger', async () => {
  for (const mode of ['malformed', 'period']) {
    const h = harness('kuaishou'); await h.sync.syncNow(); const before = h.sync.export(); h.modes.set('creator_center', mode); h.advance(1000);
    await h.sync.syncNow(); assert.deepEqual(h.sync.export(), before); assert.equal(h.sync.status().sources[0].state, 'error');
  }
});
test('empty successful responses stay unavailable, not a complete zero month', async () => {
  const h = harness('bilibili'); h.modes.set('creator_center', 'empty'); await h.sync.start();
  assert.equal(h.sync.status().sources[0].state, 'unavailable'); assert.equal(h.sync.status().sources[0].lastSuccessAt, null);
  assert.equal(h.sync.export().records.length, 0); h.sync.dispose();
});
test('concurrent calls coalesce and a cancelled acquisition cannot save a delayed response', async () => {
  const h = harness('bilibili'), release = h.delay(), pending = h.sync.start(); assert.equal(pending, h.sync.syncNow());
  await new Promise(r => setImmediate(r)); const writes = h.writes.length, other = h.make();
  await assert.rejects(other.syncNow(), { code: 'REVENUE_BUSY' }); h.sync.stop(); release();
  await assert.rejects(pending, { code: 'REVENUE_SYNC_STOPPED' }); assert.equal(h.writes.length, writes);
  const { dispose } = h.sync; dispose(); await assert.rejects(h.sync.start(), { code: 'REVENUE_SYNC_STOPPED' }); other.dispose();
});
test('disk failure does not advance history or emit a successful source status', async () => {
  const h = harness('kuaishou'); await h.sync.syncNow(); const before = h.sync.export(); h.modes.set('store', 'fail');
  await assert.rejects(h.sync.start(), { code: 'REVENUE_STORAGE_ERROR' }); assert.deepEqual(h.sync.export(), before); assert.equal(h.timers.size, 0);
});
test('persisted states isolate platforms/owners, normalize stored data, and reject corrupt files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'creator-income-store-')), store = createCreatorRevenueFileStore({ directory });
  for (const platform of ['bilibili', 'wechat_channels']) { const h = harness(platform, { store }); await h.sync.syncNow(); }
  const files = await fs.readdir(directory); assert.equal(files.length, 2);
  const bound = syncBinding({ owner: 'synthetic-owner', platform: 'bilibili', accountId: ACCOUNT, identityKind: 'uid' });
  const saved = await store.load(bound); assert.ok(saved.ledger.records.length);
  assert.equal(await store.load({ ...bound, ownerHash: 'f'.repeat(64) }), null);
  await store.save(bound, { ...saved, Cookie: 'private-do-not-persist', rawResponse: 'private-do-not-persist' });
  const text = await Promise.all(files.map(file => fs.readFile(path.join(directory, file), 'utf8'))); assert.ok(text.every(t => !t.includes('private-do-not-persist')));
  await assert.rejects(store.save(bound, { ...saved, accountId: 'e'.repeat(64) }), { code: 'REVENUE_STORAGE_INVALID' });
  await assert.rejects(store.save(bound, { ...saved, sources: saved.sources.map(s => ({ ...s, retryMonth: '2099-01' })) }), { code: 'REVENUE_STORAGE_INVALID' });
  for (const file of files) { await fs.writeFile(path.join(directory, file), '{corrupt'); }
  await assert.rejects(store.load(bound), { code: 'REVENUE_STORAGE_INVALID' });
  for (const file of files) await fs.unlink(path.join(directory, file)); await fs.rmdir(directory);
});
