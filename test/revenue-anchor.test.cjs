'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { collectDouyinAnchorRevenue, anchorRequest } = require('../revenue/douyin-anchor.cjs');
const { createRevenueLedger } = require('../revenue/index.cjs');
const { decimal, sumDecimal } = require('../revenue/model.cjs');
const { syntheticAnchorResponse, FETCHED_AT, ACCOUNT_ID } = require('../testing/revenue-fixtures.cjs');
const base = { platform: 'douyin', accountId: ACCOUNT_ID, fetchedAt: FETCHED_AT };
const collect = (mutate = body => body, options = {}, fixture = {}) => collectDouyinAnchorRevenue({ ...base, ...options,
  request: async descriptor => mutate(syntheticAnchorResponse(descriptor, fixture), descriptor) });
function edit(body, change) { const data = JSON.parse(body.data.data); change(data); body.data.data = JSON.stringify(data); return body; }

test('anchor queries use the server data-production date for 7/30-day ranges and current day for today', async () => {
  const requests = [], snapshot = await collect((body, descriptor) => { requests.push(new URL(descriptor.url)); return body; });
  const summaries = requests.filter(url => url.pathname.endsWith('/base_data'));
  assert.deepEqual(summaries.map(url => [url.searchParams.get('startDate'), url.searchParams.get('endDate')]), [
    ['2026-10-30', '2026-10-30'], ['2026-10-23', '2026-10-29'], ['2026-09-30', '2026-10-29']
  ]);
  assert.equal(snapshot.dataAsOf, '2026-10-29'); assert.equal(snapshot.nativeMetrics.length, 3);
  assert.equal(snapshot.records.length, 0); assert.equal(snapshot.metrics.length, 0);
  assert.equal(snapshot.currency, null);
  assert.ok(snapshot.nativeMetrics.every(row => row.unit === '音浪' && row.currency === null));
  assert.ok(snapshot.issues.some(i => i.code === 'REVENUE_NATIVE_UNIT_NOT_CNY'));
  assert.ok(requests.every(url => url.hostname === 'anchor.douyin.com' && url.searchParams.get('aid') === '477650'));
  assert.equal(requests.find(url => url.pathname.endsWith('/time_trend')).searchParams.get('field'), 'earnScore');
  assert.deepEqual(anchorRequest('status').headers, { 'x-appid': '3000', 'x-sub-web-id': '1116' });
});
test('rolling totals are not summed into month reports, today is partial and currency reports remain separate', async () => {
  const snapshot = await collect(), ledger = createRevenueLedger(base); ledger.ingest(snapshot); ledger.ingest(snapshot);
  assert.equal(ledger.nativeMetrics().length, 3);
  const row = ledger.nativeMonths({ scope: 'douyin.anchor', unit: '音浪', fromMonth: '2026-10', toMonth: '2026-10' })[0];
  assert.equal(row.coverage, 'partial'); assert.equal(row.value, null); assert.equal(row.observedValue, '35.5');
  assert.equal(row.coveredDays, 29); assert.equal(row.expectedDays, 31);
  assert.equal(ledger.months({ scope: 'douyin.anchor', categoryId: 'earnScore', fromMonth: '2026-10', toMonth: '2026-10' })[0].amountMinor, null);
  assert.equal(snapshot.nativeRecords.find(row => row.start === '2026-10-30').complete, false);
  assert.equal(snapshot.nativeRecords.find(row => row.start === '2026-10-01').value, '0');
});
test('continuous synchronization retains older days and completes a closed natural month without duplicate income', async () => {
  const ledger = createRevenueLedger(base), first = await collect(); ledger.ingest(first);
  const second = await collect(undefined, { fetchedAt: '2026-11-01T04:00:00.000Z' }, { asOf: '2026-10-31' });
  ledger.ingest(second); ledger.ingest(second); ledger.ingest(first);
  const row = ledger.nativeMonths({ scope: 'douyin.anchor', unit: '音浪', fromMonth: '2026-10', toMonth: '2026-10' })[0];
  assert.equal(row.coverage, 'complete'); assert.equal(row.value, '37.5'); assert.equal(row.coveredDays, 31);
  const restored = createRevenueLedger({ ...base, state: ledger.export() }); assert.deepEqual(restored.export(), ledger.export());
  assert.equal(restored.nativeMetrics().find(row => row.period === 'rolling_30_days').end, '2026-10-31');
});
test('only explicit yuan metadata enters CNY money storage, with exact decimal conversion', async () => {
  const snapshot = await collect(undefined, {}, { unit: '元' }), ledger = createRevenueLedger(base); ledger.ingest(snapshot);
  assert.equal(snapshot.nativeRecords.length, 0); assert.equal(snapshot.nativeMetrics.length, 0);
  assert.equal(snapshot.metrics.find(row => row.period === 'today').amountMinor, '50');
  assert.equal(snapshot.records.find(row => row.start === '2026-10-01').amountMinor, '0');
  assert.equal(ledger.metrics().find(row => row.period === 'rolling_7_days').start, '2026-10-23');
  assert.equal(ledger.months({ scope: 'douyin.anchor', categoryId: 'earnScore', fromMonth: '2026-10', toMonth: '2026-10' })[0].observedAmountMinor, '3550');
});
test('unit changes do not blend observations and unknown units never become CNY', async () => {
  const ledger = createRevenueLedger(base); ledger.ingest(await collect());
  ledger.ingest(await collect(undefined, { fetchedAt: '2026-10-30T05:00:00.000Z' }, { unit: '万音浪' }));
  assert.deepEqual(ledger.nativeSeries().map(row => row.unit).sort(), ['万音浪', '音浪']);
  assert.equal(ledger.export().records.length, 0);
  assert.equal(sumDecimal(['0.1', '0.2', '-0.01']), '0.29'); assert.equal(decimal('-0.000'), '0');
  for (const value of [null, '', '1.2万', 9007199254740992, '0.0000001']) assert.throws(() => decimal(value));
});
test('missing units, empty responses and pending components cannot manufacture zero income', async () => {
  for (const scenario of ['unit', 'empty', 'pending']) {
    const snapshot = await collect((body, descriptor) => descriptor.source.endsWith('.status') ? body : edit(body, data => {
      if (scenario === 'unit') data.meta = JSON.stringify({ field: [{ key: 'earnScore' }] });
      if (scenario === 'empty') data.data.series = [];
      if (scenario === 'pending') data.tip = { code: '1001' };
    }));
    assert.equal(snapshot.nativeMetrics.length, 0); assert.equal(snapshot.nativeRecords.length, 0); assert.equal(snapshot.status, 'unavailable');
  }
});
test('trend dates require an explicit year and must be in the requested range; malformed batches are atomic', async () => {
  for (const date of ['10-01', '13:00', '2026-08-01']) {
    const snapshot = await collect((body, descriptor) => descriptor.source.endsWith('.trend') ? edit(body, data => { data.data.series[0].date = date; }) : body);
    assert.equal(snapshot.nativeRecords.length, 1); // Only the separate today's observation remains.
    assert.ok(snapshot.issues.some(i => ['REVENUE_DATE_UNAVAILABLE', 'REVENUE_DATE_OUTSIDE_RANGE'].includes(i.code)));
  }
  const conflict = await collect((body, descriptor) => descriptor.source.endsWith('.trend') ? edit(body, data => {
    data.data.series.push({ ...data.data.series[0], earnScore: '999' });
  }) : body);
  assert.equal(conflict.nativeRecords.length, 1); assert.ok(conflict.issues.some(i => i.code === 'CONFLICTING_REVENUE_PERIOD'));
});
test('missing day points stay gaps, and a current-day trend never marks today complete', async () => {
  const snapshot = await collect((body, descriptor) => descriptor.source.endsWith('.trend') ? edit(body, data => { data.data.series[1].earnScore = null; }) : body);
  assert.ok(!snapshot.nativeRecords.some(row => row.start === '2026-10-01'));
  const current = await collect(undefined, {}, { asOf: '2026-10-30' });
  const today = current.nativeRecords.filter(row => row.start === '2026-10-30');
  assert.equal(today.length, 1); assert.equal(today[0].complete, false); assert.equal(today[0].value, '0.5');
});
test('no fabricated rolling ranges after status failure; authentication failures abort the acquisition', async () => {
  const requests = [];
  const snapshot = await collect((body, descriptor) => {
    requests.push(descriptor.source); return descriptor.source.endsWith('.status') ? { status_code: 99 } : body;
  });
  assert.equal(snapshot.dataAsOf, null); assert.equal(snapshot.nativeMetrics.length, 1); assert.equal(requests.length, 2);
  await assert.rejects(collect(() => ({ status_code: 98 })), { code: 'LOGIN_REQUIRED' });
  await assert.rejects(collect(() => ({ status_code: 20003 })), { code: 'LOGIN_REQUIRED' });
  await assert.rejects(collect(() => ({ status_code: 97 })), { code: 'VERIFICATION_REQUIRED' });
  assert.throws(() => anchorRequest('summary', { startDate: '2026-01-01', endDate: '2026-02-01' }), { code: 'INVALID_REVENUE_RANGE' });
  assert.throws(() => anchorRequest('withdraw'));
});
test('native and CNY ledger updates are atomic across corrupt rows and identities', async () => {
  const snapshot = await collect(), ledger = createRevenueLedger(base); ledger.ingest(snapshot); const before = ledger.export();
  assert.throws(() => ledger.ingest({ ...snapshot, accountId: 'b'.repeat(64) }), { code: 'REVENUE_ACCOUNT_MISMATCH' });
  assert.throws(() => ledger.ingest({ ...snapshot, nativeRecords: snapshot.nativeRecords.map(row => ({ ...row, value: null })) }));
  assert.throws(() => ledger.ingest({ ...snapshot, nativeMetrics: snapshot.nativeMetrics.map(row => ({ ...row, currency: 'CNY' })) }), { code: 'INVALID_REVENUE_CURRENCY' });
  assert.deepEqual(ledger.export(), before);
});
