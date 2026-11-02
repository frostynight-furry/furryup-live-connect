'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { collectDouyinWalletRevenue, walletRequest, WALLET_PAGE, INCOME_SCOPE } = require('../revenue/douyin-wallet.cjs');
const { WALLET_SCOPE } = require('../revenue/wallet-statement.cjs');
const { createRevenueLedger } = require('../revenue/index.cjs');
const { ACCOUNT_ID, FETCHED_AT, syntheticDouyinWalletResponse } = require('../testing/revenue-wallet-fixtures.cjs');
const base = { platform: 'douyin', accountId: ACCOUNT_ID, fetchedAt: FETCHED_AT, fromMonth: '2026-09', toMonth: '2026-09' };
const collect = (mutate = body => body, options = {}, fixture = {}) => collectDouyinWalletRevenue({ ...base, ...options,
  request: async descriptor => mutate(syntheticDouyinWalletResponse(descriptor, fixture), descriptor) });
const checked = snapshot => assert.equal(snapshot.statements.length, 1);

test('wallet uses the fixed read route and official monthly/cursor parameters, with exact cents', async () => {
  const requests = [], snapshot = await collect((body, descriptor) => { requests.push(new URL(descriptor.url)); return body; }); checked(snapshot);
  assert.equal(requests.length, 2); assert.ok(requests.every(url => url.origin === new URL(WALLET_PAGE).origin));
  assert.deepEqual(Object.fromEntries(requests[0].searchParams), { start_time: '202609', last_max_time: String(Date.parse(FETCHED_AT) / 1000), page: '1', count: '20', type: '0', need_summary: '1', is_income_record: '1' });
  assert.equal(requests[1].searchParams.get('page'), '2');
  assert.equal(requests[1].searchParams.get('last_max_time'), String(snapshot.statements[0].transactions[1].time));
  assert.equal(snapshot.statements[0].reportedIncomeMinor, '1645'); assert.equal(snapshot.statements[0].reportedOutcomeMinor, '500');
  assert.equal(snapshot.records.find(r => r.categoryId === 'live').amountMinor, '1200');
  assert.equal(snapshot.records.find(r => r.categoryId === 'video_incentive').amountMinor, '345');
  assert.equal(snapshot.earliestAvailableMonth, '2026-06'); assert.equal(snapshot.timeBasis, 'posting_time');
  assert.equal(snapshot.sessionReuse, 'experimental_creator_origin'); assert.equal(snapshot.adapterValidation, 'synthetic_only');
  assert.equal(snapshot.historyComplete, false);
});
test('wallet excludes withdrawals, refunds and balances from earnings and never persists raw identity/title fields', async () => {
  const snapshot = await collect(), ledger = createRevenueLedger(base); ledger.ingest(snapshot);
  assert.equal(ledger.months({ scope: WALLET_SCOPE })[0].amountMinor, '1645');
  assert.equal(ledger.months({ scope: INCOME_SCOPE, categoryId: 'live' })[0].amountMinor, '1200');
  assert.equal(ledger.statements()[0].transactions.find(r => r.kind === 'refund').amountMinor, '100');
  for (const value of ['synthetic-order', 'synthetic-private-description', '999999999', 'order_id', 'withdraw_status', 'balance']) assert.ok(!JSON.stringify(ledger.export()).includes(value));
});
test('a closed month differs from current-month observations, even after complete pagination', async () => {
  const closed = await collect(), current = await collect(undefined, { fromMonth: '2026-10', toMonth: '2026-10' });
  assert.ok(closed.records.every(r => r.complete)); assert.ok(current.records.every(r => !r.complete));
  assert.equal(current.statements[0].paginationComplete, true); assert.equal(current.statements[0].calendarComplete, false);
  const ledger = createRevenueLedger(base); ledger.ingest(current);
  assert.equal(ledger.months({ scope: WALLET_SCOPE })[0].amountMinor, null);
  assert.equal(ledger.months({ scope: WALLET_SCOPE })[0].observedAmountMinor, '1645');
});
test('idempotent history reload and stale snapshots cannot overwrite newer verified statements', async () => {
  const first = await collect(), second = await collect(undefined, { fetchedAt: '2026-10-30T05:00:00.000Z' });
  const ledger = createRevenueLedger(base); ledger.ingest(first); ledger.ingest(first); ledger.ingest(second); ledger.ingest(first);
  assert.equal(ledger.statements()[0].fetchedAt, second.fetchedAt);
  assert.equal(ledger.statements()[0].transactions.length, 4);
  const restored = createRevenueLedger({ ...base, state: ledger.export() }); assert.deepEqual(restored.export(), ledger.export());
  const copy = restored.statements(); copy[0].transactions[0].amountMinor = '1'; assert.deepEqual(restored.export(), ledger.export());
});
test('reclassification replaces an entire month without leaving stale live/video totals', async () => {
  const first = await collect(), next = await collect(body => { body.data.billing_types[1] = '未识别'; for (const r of body.data.bill_list[0].bills) if (r.type === 1) r.title = r.event_title = '未识别'; return body; }, { fetchedAt: '2026-10-30T05:00:00.000Z' });
  const ledger = createRevenueLedger(base); ledger.ingest(first); ledger.ingest(next);
  assert.equal(ledger.months({ scope: INCOME_SCOPE, categoryId: 'live', fromMonth: '2026-09', toMonth: '2026-09' })[0].coverage, 'missing');
  assert.equal(ledger.months({ scope: INCOME_SCOPE, categoryId: 'video_incentive' })[0].coverage, 'partial');
  assert.equal(ledger.months({ scope: WALLET_SCOPE })[0].coverage, 'complete');
  assert.ok(next.issues.some(i => i.code === 'REVENUE_WALLET_UNCLASSIFIED_INCOME'));
});
test('combined creator/live income and generic video income never receive an invented split', async () => {
  for (const name of ['直播/创作收入', '视频收入', '非直播收入', '会员购买的视频激励收益']) {
    const snapshot = await collect(body => { body.data.billing_types[1] = name; for (const r of body.data.bill_list[0].bills) if (r.type === 1) r.title = r.event_title = name; return body; }); checked(snapshot);
    assert.ok(!snapshot.records.some(r => r.categoryId === 'live'));
    assert.equal(snapshot.records.find(r => r.categoryId === 'video_incentive').complete, false);
  }
});
test('a verified explicit zero month differs from no observed month or fallback to an older month', async () => {
  const zero = await collect(undefined, {}, { empty: true }); checked(zero); assert.equal(zero.records[0].amountMinor, '0');
  assert.equal(zero.records.length, 1); // No zero-valued category is fabricated.
  const missing = await collect(undefined, {}, { missing: true, empty: true }); assert.equal(missing.records.length, 0);
  assert.deepEqual(missing.checkedMonths, [{ month: '2026-09', status: 'no_data' }]);
  const fallback = await collect(body => { body.data.bill_list[0].period = '202608'; return body; });
  assert.equal(fallback.statements.length, 0); assert.equal(fallback.checkedMonths[0].status, 'no_data');
});
test('an older month boundary finishes pagination without assigning older money to the requested month', async () => {
  let calls = 0; const snapshot = await collect(body => { calls++; body.data.has_more = true; body.data.bill_list.push({ period: '202608', bills: [] }); return body; }, {}, { pageSize: 20 });
  checked(snapshot); assert.equal(calls, 1); assert.equal(snapshot.statements[0].transactions.length, 4);
});
test('page exhaustion, stalled cursors, changed headers and unreconciled summaries cannot produce a partial saved bill', async () => {
  for (const [mode, code] of [['limit', 'REVENUE_PAGINATION_INCOMPLETE'], ['summary', 'REVENUE_WALLET_SNAPSHOT_CHANGED'], ['types', 'REVENUE_WALLET_SNAPSHOT_CHANGED'], ['sum', 'REVENUE_WALLET_RECONCILIATION_FAILED'], ['stalled', 'REVENUE_PAGINATION_INCOMPLETE']]) {
    const snapshot = await collect((body, descriptor) => {
      const page = Number(new URL(descriptor.url).searchParams.get('page'));
      if (mode === 'summary' && page === 2) body.data.bill_list[0].income = '9999';
      if (mode === 'types' && page === 2) body.data.billing_types[1] = 'changed';
      if (mode === 'sum') body.data.bill_list[0].income = '9999';
      if (mode === 'stalled' && page === 2) { body.data.has_more = true; body.data.bill_list[0].bills = []; }
      return body;
    }, mode === 'limit' ? { maxPagesPerMonth: 1 } : {});
    assert.equal(snapshot.statements.length, 0, mode); assert.equal(snapshot.records.length, 0); assert.equal(snapshot.checkedMonths.length, 0);
    assert.ok(snapshot.issues.some(i => i.code === code), mode);
  }
});
test('same-second cursor boundaries deduplicate identical bills but reject conflicting versions', async () => {
  for (const conflict of [false, true]) {
    let previous;
    const snapshot = await collect((body, descriptor) => {
      if (new URL(descriptor.url).searchParams.get('page') === '1') previous = structuredClone(body.data.bill_list[0].bills.at(-1));
      else { if (conflict) previous.money = '999'; body.data.bill_list[0].bills.unshift(previous); }
      return body;
    });
    if (conflict) { assert.equal(snapshot.records.length, 0); assert.ok(snapshot.issues.some(i => i.code === 'CONFLICTING_REVENUE_TRANSACTION')); }
    else { checked(snapshot); assert.equal(snapshot.statements[0].transactions.length, 4); }
  }
});
test('unknown signs, unsafe cents/IDs, wrong months and nonzero neutral entries fail closed', async () => {
  for (const change of [r => { r.sign = 8; }, r => { r.money = Number.MAX_SAFE_INTEGER + 1; }, r => { r.order_id = Number.MAX_SAFE_INTEGER + 1; }, r => { r.txn_time -= 90 * 86400; }, r => { r.sign = 2; }, r => { r.money = '-1'; }]) {
    const snapshot = await collect(body => { change(body.data.bill_list[0].bills[0]); return body; });
    assert.equal(snapshot.records.length, 0); assert.equal(snapshot.statements.length, 0);
  }
});
test('wallet login and account/host changes abort acquisition; future/out-of-window months remain unknown', async () => {
  await assert.rejects(collect(() => ({ status_code: 20003 })), { code: 'REVENUE_WALLET_SESSION_REQUIRED' });
  await assert.rejects(collect(() => { throw Object.assign(new Error('synthetic'), { code: 'PLATFORM_ACCOUNT_CHANGED' }); }), { code: 'PLATFORM_ACCOUNT_CHANGED' });
  const old = await collect(undefined, { fromMonth: '2026-01', toMonth: '2026-01' }); assert.equal(old.checkedMonths.length, 0);
  assert.ok(old.issues.some(i => i.code === 'REVENUE_HISTORY_OUTSIDE_WINDOW'));
  let called = false; const future = await collect(body => { called = true; return body; }, { fromMonth: '2026-11', toMonth: '2026-11' });
  assert.equal(called, false); assert.equal(future.records.length, 0);
  await assert.rejects(collect(undefined, { fromMonth: '2020-01', toMonth: '2026-10' }), { code: 'REVENUE_RANGE_TOO_LARGE' });
  assert.throws(() => walletRequest({ month: '2026-09', cursor: 1, page: 1 }));
});
test('ledger enforces statement/projection agreement and atomicity across all sources and accounts', async () => {
  const snapshot = await collect(), ledger = createRevenueLedger(base); ledger.ingest(snapshot); const before = ledger.export();
  const bad = structuredClone(snapshot); bad.records[1].amountMinor = '999';
  assert.throws(() => ledger.ingest(bad), { code: 'INVALID_WALLET_PROJECTION' });
  assert.throws(() => ledger.ingest({ ...snapshot, statements: [] }), { code: 'INVALID_WALLET_PROJECTION' });
  assert.throws(() => ledger.ingest({ ...snapshot, accountId: 'd'.repeat(64) }), { code: 'REVENUE_ACCOUNT_MISMATCH' });
  const changed = await collect(body => { body.data.billing_types[1] = '礼物收益'; return body; });
  assert.throws(() => ledger.ingest(changed), { code: 'CONFLICTING_REVENUE_PERIOD' });
  assert.deepEqual(ledger.export(), before);
  assert.throws(() => createRevenueLedger({ platform: 'bilibili', accountId: ACCOUNT_ID }).ingest({ ...snapshot, platform: 'bilibili' }));
});
