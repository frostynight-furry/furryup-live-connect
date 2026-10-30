'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { collectCreatorRevenue } = require('../revenue/adapters.cjs');
const { kuaishouRequest } = require('../revenue/kuaishou.cjs');
const { walletHandoff, parseWechatWallet } = require('../revenue/wechat-channels.cjs');
const { createRevenueLedger, importRevenueCsv, REVENUE_CSV_HEADER } = require('../revenue/index.cjs');
const { KS_USER_ID, WX_AUTH_CODE, syntheticExtraRevenueResponse, syntheticWalletResponse } = require('../testing/revenue-extra-fixtures.cjs');
const base = { accountId: 'a'.repeat(64), fetchedAt: '2026-10-30T04:00:00.000Z', fromMonth: '2026-09', toMonth: '2026-09' };
const collect = (platform, mutate = x => x, extra = {}) => collectCreatorRevenue({ ...base, platform, ownUserId: KS_USER_ID,
  request: async d => mutate(syntheticExtraRevenueResponse(platform, d), d), readWallet: async () => syntheticWalletResponse(), ...extra });
const walletOptions = { fetchedAt: base.fetchedAt, requestedMonths: ['2026-09'] };

test('Kuaishou incentive settlement and live analysis stay separate with exact yuan conversion', async () => {
  const snapshot = await collect('kuaishou');
  assert.equal(snapshot.records.length, 31);
  const ledger = createRevenueLedger({ ...base, platform: 'kuaishou' }); ledger.ingest(snapshot);
  assert.equal(ledger.months({ scope: 'kuaishou.incentive_settlement', categoryId: 'video_incentive' })[0].amountMinor, '1234');
  assert.equal(ledger.months({ scope: 'kuaishou.live_trend', categoryId: 'live_gifts' })[0].amountMinor, '2929');
  assert.ok(snapshot.issues.some(i => i.code === 'REVENUE_LIVE_ANALYTICS_NOT_NET_SETTLEMENT'));
  assert.ok(!JSON.stringify(snapshot).includes(KS_USER_ID));
});
test('Kuaishou personal statements paginate atomically across distinct institutions', async () => {
  const pages = [];
  const result = await collect('kuaishou', (body, d) => {
    if (d.source.endsWith('.incentive')) {
      pages.push(d.body.page); body.data.totalCount = 2;
      body.data.list[0].govName = 'Synthetic ' + d.body.page;
    } return body;
  });
  assert.deepEqual(pages, [1, 2]); assert.equal(result.records.find(r => r.period === 'month').amountMinor, '2468');
});
test('repeated pages, changing totals and ambiguous institution rows never become a partial bill', async () => {
  for (const scenario of ['repeat', 'total-change', 'missing-key', 'empty-page']) {
    const result = await collect('kuaishou', (body, d) => {
      if (d.source.endsWith('.incentive')) {
        body.data.totalCount = scenario === 'total-change' && d.body.page === 2 ? 3 : 2;
        if (scenario === 'missing-key') delete body.data.list[0].govName;
        if (scenario === 'empty-page' && d.body.page === 2) body.data.list = [];
      } return body;
    });
    assert.ok(!result.records.some(r => r.period === 'month'), scenario);
    assert.ok(result.records.some(r => r.period === 'day'), scenario);
  }
});
test('Kuaishou verifies statement ownership, month and full dates', async () => {
  await assert.rejects(collect('kuaishou', (body, d) => {
    if (d.source.endsWith('.incentive')) body.data.list[0].userId = '999'; return body;
  }), { code: 'PLATFORM_ACCOUNT_CHANGED' });
  const result = await collect('kuaishou', (body, d) => {
    if (d.source.endsWith('.incentive')) body.data.list[0].settlementTime = '2026-08-01';
    if (d.source.endsWith('.live')) body.data.trending[0].dateTime = '09-01'; return body;
  });
  assert.equal(result.records.length, 0);
  assert.deepEqual(result.issues.slice(0, 2).map(i => i.code), ['REVENUE_MONTH_MISMATCH', 'REVENUE_DATE_UNAVAILABLE']);
});
test('Kuaishou uses own IDs, Shanghai inclusive date ranges and a maximum of 31 days', () => {
  const d = kuaishouRequest('live', { ownUserId: KS_USER_ID, start: '2026-07-01', end: '2026-07-31' });
  assert.equal(d.body.memberId, KS_USER_ID); assert.equal(d.body.dateType, ''); assert.deepEqual(d.body.dimensions, [9]);
  assert.equal(d.body.endTime - d.body.startTime + 1, 31 * 86400000);
  assert.equal(d.body.startTime, Date.parse('2026-06-30T16:00:00Z'));
  assert.throws(() => kuaishouRequest('live', { ownUserId: KS_USER_ID, start: '2026-07-01', end: '2026-08-01' }));
  assert.throws(() => kuaishouRequest('incentive', { ownUserId: 9007199254740992, month: '2026-09' }));
  assert.throws(() => kuaishouRequest('withdraw'));
});
test('current-day exclusion, missing dates and zero have different monthly coverage', async () => {
  const result = await collect('kuaishou', undefined, { fromMonth: '2026-10', toMonth: '2026-10' });
  assert.equal(result.records.length, 29); assert.equal(result.records.at(-1).start, '2026-10-29');
  assert.ok(result.issues.some(i => i.code === 'REVENUE_MONTH_NOT_PUBLISHED'));
  const partial = await collect('kuaishou', (body, d) => {
    if (d.source.endsWith('.live')) body.data.trending[1].receiveAmount = null; return body;
  });
  const ledger = createRevenueLedger({ ...base, platform: 'kuaishou' }); ledger.ingest(partial);
  const row = ledger.months({ scope: 'kuaishou.live_trend', categoryId: 'live_gifts' })[0];
  assert.equal(row.coverage, 'partial'); assert.equal(row.amountMinor, null); assert.equal(row.observedAmountMinor, '2828');
});
test('Kuaishou out-of-range dates, conflicting duplicate days and malformed money reject whole trends', async () => {
  for (const change of [
    rows => { rows[0].dateTime = '2026-08-31'; },
    rows => rows.push({ ...rows[0], receiveAmount: '9' }),
    rows => { rows[2].receiveAmount = '1.001'; }
  ]) {
    const result = await collect('kuaishou', (body, d) => { if (d.source.endsWith('.live')) change(body.data.trending); return body; });
    assert.ok(!result.records.some(r => r.period === 'day'));
    assert.ok(result.records.some(r => r.period === 'month'));
  }
});
test('Kuaishou history windows and batch limits avoid unbounded backfill or invented zero months', async () => {
  const empty = await collect('kuaishou', (body, d) => {
    if (d.source.endsWith('.incentive')) body.data = { list: [], totalCount: 0 };
    if (d.source.endsWith('.live')) body.data = { trending: [] }; return body;
  });
  assert.equal(empty.status, 'unavailable'); assert.equal(empty.records.length, 0);
  const early = await collect('kuaishou', () => { throw new Error('must not fetch'); }, { fromMonth: '2019-03', toMonth: '2019-03' });
  assert.equal(early.records.length, 0); assert.equal(early.issues.filter(i => i.code === 'REVENUE_HISTORY_OUTSIDE_WINDOW').length, 2);
  await assert.rejects(collect('kuaishou', undefined, { fromMonth: '2024-01', toMonth: '2026-01' }), { code: 'REVENUE_RANGE_TOO_LARGE' });
});
test('Channels monthly wallet revenue excludes balance and mobile eligibility cards', async () => {
  const result = await collect('wechat_channels');
  assert.equal(result.records.length, 2); assert.equal(result.records[0].amountMinor, '12345');
  assert.equal(result.records[1].amountMinor, '0'); assert.equal(result.metrics.length, 0);
  assert.ok(result.records.every(r => r.complete && r.provisional));
  assert.equal(result.availability[0].acquisition, 'mobile_page');
  assert.ok(result.issues.some(i => i.code === 'REVENUE_VIDEO_INCENTIVE_MOBILE_REQUIRED'));
  assert.ok(!JSON.stringify(result).includes(WX_AUTH_CODE)); assert.ok(!JSON.stringify(result).includes('99999999'));
});
test('Channels personal phone verification and missing handoff preserve explicit gaps', async () => {
  for (const scenario of ['phone', 'auth', 'settleType']) {
    let opened = false;
    const result = await collect('wechat_channels', (body, d) => {
      if (d.source.endsWith('.handoff')) {
        if (scenario === 'phone') delete body.data.cocertInfo.extInfo.maskPhone;
        if (scenario === 'auth') delete body.data.cocertInfo.wecoinAuthCode;
        if (scenario === 'settleType') body.data.cocertInfo.settleType = 99;
      } return body;
    }, { readWallet: async () => { opened = true; return syntheticWalletResponse(); } });
    assert.equal(opened, false); assert.equal(result.status, 'unavailable');
  }
});
test('Channels handoff only addresses the bound primary settlement account', async () => {
  const data = syntheticExtraRevenueResponse('wechat_channels', { url: 'https://channels.weixin.qq.com/getRelatedMainPart' }).data;
  const url = new URL(walletHandoff(data));
  assert.equal(url.origin, 'https://qy.webeans.weixin.qq.com');
  const query = new URLSearchParams(url.hash.split('?')[1]); assert.equal(query.get('busid'), '3'); assert.equal(query.get('account_type'), '1');
  data.cocertInfo.settleType = 1; assert.equal(new URLSearchParams(new URL(walletHandoff(data)).hash.split('?')[1]).get('account_type'), '2');
  const result = await collect('wechat_channels', (body, d) => { if (d.source.endsWith('.handoff')) body.data.studioInfos = [{ id: 'do-not-select' }]; return body; });
  assert.ok(result.issues.some(i => i.code === 'REVENUE_ADDITIONAL_SETTLEMENT_ACCOUNTS_NOT_INCLUDED'));
  assert.ok(!JSON.stringify(result).includes('do-not-select'));
});
test('Channels integer ten-thousandths of yuan reject sub-cent rounding and unsafe values', () => {
  for (const value of ['1234501', 9007199254740992, undefined, '', null]) {
    const body = syntheticWalletResponse(); body.data.settleList[0].totalIncome = value;
    assert.throws(() => parseWechatWallet(body, walletOptions));
  }
  const body = syntheticWalletResponse(); body.data.settleList[0].totalIncome = '-100';
  assert.equal(parseWechatWallet(body, walletOptions)[0].amountMinor, '-1');
});
test('Channels conflicting statements and unknown categories fail atomically instead of blending money', async () => {
  for (const change of [
    rows => rows.push({ ...rows[0] }),
    rows => { rows[1].businessId = 999; },
    rows => { rows[1].showTime = '2026/99'; }
  ]) {
    const result = await collect('wechat_channels', undefined, { readWallet: async () => { const body = syntheticWalletResponse(); change(body.data.settleList); return body; } });
    assert.equal(result.records.length, 0); assert.equal(result.status, 'unavailable');
  }
});
test('Channels wallet errors and empty lists cannot manufacture zero earnings', async () => {
  for (const body of [{ error: { code: -1000001 } }, { data: { settleList: [] } }, {}]) {
    const result = await collect('wechat_channels', undefined, { readWallet: async () => body });
    assert.equal(result.records.length, 0); assert.equal(result.status, 'unavailable');
  }
  await assert.rejects(collect('wechat_channels', undefined, { readWallet: async () => { throw Object.assign(new Error(), { code: 'PLATFORM_ACCOUNT_CHANGED' }); } }), { code: 'PLATFORM_ACCOUNT_CHANGED' });
});
test('Channels requested months filter old records and the current month remains provisional partial', () => {
  assert.equal(parseWechatWallet(syntheticWalletResponse('2026-08'), walletOptions).length, 0);
  const rows = parseWechatWallet(syntheticWalletResponse('2026-10'), { ...walletOptions, requestedMonths: ['2026-10'] });
  assert.ok(rows.every(r => !r.complete));
});
test('both new platforms persist monthly history, corrections and manual video incentive statements', async () => {
  for (const platform of ['kuaishou', 'wechat_channels']) {
    const snapshot = await collect(platform), ledger = createRevenueLedger({ ...base, platform });
    ledger.ingest(snapshot); ledger.ingest(snapshot);
    const text = REVENUE_CSV_HEADER + '\nmonth,2025-01,statement.video,video_incentive,Reconciled incentive,10.01';
    ledger.ingest(importRevenueCsv({ ...base, platform, text }));
    const restored = createRevenueLedger({ ...base, platform, state: JSON.parse(JSON.stringify(ledger.export())) });
    assert.deepEqual(restored.export(), ledger.export());
    assert.equal(restored.months({ scope: 'statement.video', categoryId: 'video_incentive' })[0].amountMinor, '1001');
    const monthly = restored.months({ scope: 'statement.video', categoryId: 'video_incentive', fromMonth: '2025-01', toMonth: '2025-02' });
    assert.deepEqual(monthly.map(r => r.coverage), ['complete', 'missing']);
    assert.throws(() => restored.ingest({ ...snapshot, accountId: 'b'.repeat(64) }), { code: 'REVENUE_ACCOUNT_MISMATCH' });
  }
});
