'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { minor, yuanToMinor, day, chinaDay, monthRange } = require('../revenue/model.cjs');
const { collectCreatorRevenue, requestFor } = require('../revenue/adapters.cjs');
const { createRevenueLedger, importRevenueCsv, REVENUE_CSV_HEADER } = require('../core/index.cjs');
const { syntheticRevenueResponse, FETCHED_AT, ACCOUNT_ID } = require('../testing/revenue-fixtures.cjs');
const base = { platform: 'bilibili', accountId: ACCOUNT_ID, fetchedAt: FETCHED_AT };
const collect = (platform, mutate = value => value, extra = {}) => collectCreatorRevenue({ ...base, platform,
  fromMonth: '2026-09', toMonth: '2026-09', request: async descriptor => mutate(syntheticRevenueResponse(platform, descriptor), descriptor), ...extra });
const csv = (rows, extra = {}) => importRevenueCsv({ ...base, text: REVENUE_CSV_HEADER + '\n' + rows.join('\n'), ...extra });

test('money stays in exact cents; absent/rounded/unsafe numbers cannot become income', () => {
  assert.equal(minor('9007199254740993'), '9007199254740993');
  assert.equal(yuanToMinor('-0.01'), '-1'); assert.equal(yuanToMinor('0'), '0');
  for (const value of [null, undefined, '', '1.5', '1万', NaN, Infinity, 9007199254740992, true]) assert.throws(() => minor(value));
  for (const value of ['1.001', '1e2', '+1', 'NaN', ' 0', 0]) assert.throws(() => yuanToMinor(value));
});
test('calendar periods use Shanghai dates and reject invalid leap days or reversed ranges', () => {
  assert.equal(chinaDay(Date.parse('2026-09-30T16:00:00Z') / 1000), '2026-10-01');
  assert.equal(day('2024-02-29'), '2024-02-29'); assert.throws(() => day('2026-02-29'));
  assert.throws(() => monthRange('2026-02', '2026-01'));
  assert.deepEqual(monthRange('2025-12', '2026-02'), ['2025-12', '2026-01', '2026-02']);
});
test('Bilibili natural-month reports include video/live categories without summing totals twice', async () => {
  const snapshot = await collect('bilibili');
  assert.equal(snapshot.status, 'ok'); assert.equal(snapshot.records.length, 5);
  assert.equal(snapshot.categories.find(c => c.id === 'enum:6').kind, 'live');
  assert.equal(snapshot.categories.find(c => c.id === 'enum:1').kind, 'video_incentive');
  assert.equal(snapshot.metrics.find(m => m.period === 'rolling_year').amountMinor, '10000');
  assert.ok(!snapshot.metrics.some(m => m.period === 'lifetime' || m.metric === 'balance'));
  const ledger = createRevenueLedger(base); ledger.ingest(snapshot); ledger.ingest(snapshot);
  const rows = ledger.months({ scope: 'bilibili.monthly', fromMonth: '2026-08', toMonth: '2026-10' });
  assert.deepEqual(rows.map(r => r.coverage), ['missing', 'complete', 'missing']);
  assert.equal(rows[1].amountMinor, '2100'); assert.equal(rows[1].provisional, true);
  assert.equal(ledger.months({ scope: 'bilibili.trend' })[0].amountMinor, null);
  assert.equal(ledger.months({ scope: 'bilibili.trend' })[0].observedAmountMinor, '2100');
});
test('Bilibili month fallback, unavailable reports and updating parts are not complete historical totals', async () => {
  for (const [change, expected] of [
    [data => { data.income_market.current_month = '202608'; }, 'REVENUE_MONTH_MISMATCH'],
    [data => { data.is_normal_show = false; }, 'REVENUE_MONTH_UNAVAILABLE']
  ]) {
    const result = await collect('bilibili', (body, d) => { if (d.source.endsWith('.monthly')) change(body.data); return body; });
    assert.ok(result.issues.some(i => i.code === expected)); assert.ok(!result.records.some(r => r.period === 'month'));
  }
  const result = await collect('bilibili', (body, d) => { if (d.source.endsWith('.monthly')) body.data.income_structure.current_month_detail[1].state = 0; return body; });
  const ledger = createRevenueLedger(base); ledger.ingest(result);
  assert.equal(ledger.months({ scope: 'bilibili.monthly' })[0].coverage, 'partial');
  assert.ok(!result.records.some(r => r.categoryId === 'enum:6'));
  const outside = await collect('bilibili', undefined, { fromMonth: '2026-03', toMonth: '2026-10' });
  assert.ok(outside.issues.some(i => i.code === 'REVENUE_HISTORY_OUTSIDE_WINDOW'));
  assert.ok(outside.issues.some(i => i.code === 'REVENUE_MONTH_NOT_PUBLISHED'));
});
test('Douyin preserves zero, large cumulative cents and dynamic categories; balance is not income', async () => {
  const result = await collect('douyin');
  assert.equal(result.records.length, 6); assert.equal(result.records[0].amountMinor, '0');
  assert.equal(result.metrics.find(m => m.period === 'lifetime').amountMinor, '9007199254740993');
  assert.ok(!result.metrics.some(m => m.categoryId === 'total' && m.period === 'lifetime'));
  assert.ok(!result.metrics.some(m => m.metric === 'balance'));
  assert.equal(result.historyComplete, false);
  assert.ok(result.issues.some(i => i.code === 'REVENUE_HISTORY_RECENT_DAYS_ONLY'));
  assert.ok(result.issues.some(i => i.code === 'REVENUE_ANCHOR_NOT_REQUESTED'));
});
test('partial endpoint failure preserves other categories; malformed bodies are never zeros', async () => {
  const result = await collect('douyin', (body, d) => {
    if (new URL(d.url).searchParams.get('category_id') === 'synthetic_live') return { status_code: 123, secret: 'should-not-escape' };
    return body;
  });
  assert.equal(result.status, 'partial'); assert.equal(result.records.length, 4);
  assert.ok(!JSON.stringify(result).includes('should-not-escape'));
  const bad = await collect('bilibili', (body, d) => {
    if (d.source.endsWith('.trend')) body.data.data.push({ date: 0, amt: null }); return body;
  });
  assert.ok(!bad.records.some(r => r.scope === 'bilibili.trend'));
  assert.ok(bad.issues.some(i => i.code === 'REVENUE_SCHEMA_CHANGED'));
});
test('conflicting same-day responses fail the endpoint instead of double-counting', async () => {
  const result = await collect('douyin', (body, d) => {
    if (d.source.endsWith('.detail')) body.income_item_list.push({ ...body.income_item_list[0], amount: '9' }); return body;
  });
  assert.equal(result.records.length, 0); assert.ok(result.issues.some(i => i.code === 'CONFLICTING_REVENUE_PERIOD'));
});
test('request construction stays on official read-only endpoints and the personal account', () => {
  const url = new URL(requestFor('douyin', 'detail', { categoryId: 'creator_share', income_type: '1', talent_id: 'other-account' }).url);
  assert.equal(url.origin, 'https://creator.douyin.com'); assert.equal(url.searchParams.get('income_type'), '0');
  assert.equal(url.searchParams.get('history_day_count'), '30'); assert.equal(url.searchParams.has('talent_id'), false);
  assert.throws(() => requestFor('douyin', 'detail', { categoryId: 'https://evil.invalid' }));
  assert.throws(() => requestFor('bilibili', 'withdraw'));
  assert.throws(() => requestFor('bilibili', 'monthly', { month: '2026-13' }));
});
test('authorization failures abort collection; unsupported platforms are explicit', async () => {
  await assert.rejects(collect('bilibili', () => ({ code: -101 })), { code: 'LOGIN_REQUIRED' });
  await assert.rejects(collectCreatorRevenue({ ...base, platform: 'xiaohongshu', request: () => {} }), { code: 'REVENUE_UNSUPPORTED_PLATFORM' });
});
test('ledger upserts corrections, ignores old reads, isolates identities and commits imports atomically', () => {
  const ledger = createRevenueLedger(base);
  const original = csv(['month,2026-09,statement,total,合成总额,10.00']); ledger.ingest(original);
  ledger.ingest(csv(['month,2026-09,statement,total,合成总额,11.00'], { fetchedAt: '2026-10-30T05:00:00.000Z' }));
  ledger.ingest(original);
  assert.equal(ledger.months({ scope: 'statement' })[0].amountMinor, '1100');
  assert.throws(() => ledger.ingest({ ...original, accountId: 'b'.repeat(64) }), { code: 'REVENUE_ACCOUNT_MISMATCH' });
  assert.throws(() => ledger.ingest({ ...original, records: [original.records[0], { ...original.records[0], amountMinor: null }] }));
  assert.equal(ledger.export().records.length, 1);
  const restored = createRevenueLedger({ ...base, state: ledger.export() });
  assert.deepEqual(restored.export(), ledger.export());
});
test('full daily coverage, partial months, zero and monthly overrides have distinct meanings', () => {
  const ledger = createRevenueLedger(base);
  ledger.ingest(csv(Array.from({ length: 28 }, (_, i) => `day,2026-02-${String(i + 1).padStart(2, '0')},statement,total,合成总额,0`)));
  let row = ledger.months({ scope: 'statement' })[0]; assert.equal(row.coverage, 'complete'); assert.equal(row.amountMinor, '0');
  ledger.ingest(csv(['month,2026-02,statement,total,合成总额,-0.01']));
  row = ledger.months({ scope: 'statement' })[0]; assert.equal(row.amountMinor, '-1');
  ledger.ingest(csv(['day,2026-03-01,statement,total,合成总额,1.01']));
  row = ledger.months({ scope: 'statement' }).at(-1); assert.equal(row.amountMinor, null); assert.equal(row.observedAmountMinor, '101');
});
test('canonical statement CSV supports quoted names and rejects transactions disguised as duplicate periods', () => {
  const value = csv(['month,2026-09,statement,video,"合成, \"\"视频\"\"",12.30']);
  assert.equal(value.records[0].categoryName, '合成, "视频"'); assert.equal(value.records[0].amountMinor, '1230');
  assert.throws(() => csv(['month,2026-09,statement,total,合成,1', 'month,2026-09,statement,total,合成,2']), { code: 'DUPLICATE_REVENUE_PERIOD' });
  assert.throws(() => csv(['month,2026-09,statement,total,合成,1.001']));
  assert.throws(() => csv(['month,2026-09,statement,total,"unclosed,1']));
  assert.throws(() => csv(['day,2026-02-30,statement,total,合成,1']));
});

test('stored rolling/lifetime metrics retain their own freshness and cannot relabel another currency', async () => {
  const snapshot = await collect('douyin'), ledger = createRevenueLedger({ ...base, platform: 'douyin' });
  ledger.ingest(snapshot); ledger.ingest(snapshot);
  assert.equal(ledger.metrics().find(m => m.period === 'lifetime').amountMinor, '9007199254740993');
  const state = ledger.export(); assert.equal(state.metrics[0].fetchedAt, FETCHED_AT);
  assert.throws(() => ledger.ingest({ ...snapshot, currency: 'USD' }), { code: 'INVALID_REVENUE_CURRENCY' });
  assert.throws(() => ledger.ingest({ ...snapshot, records: snapshot.records.map(r => ({ ...r, currency: 'USD' })) }), { code: 'INVALID_REVENUE_CURRENCY' });
  assert.deepEqual(ledger.export(), state);
  const restored = createRevenueLedger({ ...base, platform: 'douyin', state }); assert.deepEqual(restored.metrics(), ledger.metrics());
});
test('Douyin leaf discovery is bounded and does not query parent totals or unsupported paid-video endpoints', async () => {
  const requested = [];
  const snapshot = await collect('douyin', (body, descriptor) => {
    const u = new URL(descriptor.url); requested.push(u.searchParams.get('category_id'));
    if (descriptor.source.endsWith('.categories')) body.optional_category_list = [
      { category_id: 'synthetic_parent', name: '合成父项', sub_category_list: [
        { category_id: 'creator_share', name: '合成创作激励' }, { category_id: 'video_paid', name: '合成付费视频' }
      ] }, { category_id: 'synthetic_extra', name: '合成额外项' }
    ];
    return body;
  }, { maxCategories: 2 });
  assert.ok(!requested.includes('synthetic_parent')); assert.ok(!requested.includes('video_paid')); assert.ok(!requested.includes('synthetic_extra'));
  assert.ok(snapshot.issues.some(i => i.code === 'REVENUE_CATEGORY_LIMIT'));
  assert.ok(snapshot.issues.some(i => i.code === 'REVENUE_CATEGORY_ENDPOINT_UNSUPPORTED'));
  assert.equal(snapshot.categories.find(c => c.id === 'creator_share').parentId, 'synthetic_parent');
});
test('pending or unknown Bilibili states cannot mark a monthly total complete', async () => {
  const snapshot = await collect('bilibili', (body, descriptor) => {
    if (descriptor.source.endsWith('.monthly')) body.data.income_structure.current_month_detail[1].state = 42;
    return body;
  });
  assert.equal(snapshot.records.find(r => r.scope === 'bilibili.monthly' && r.categoryId === 'total').complete, false);
});
