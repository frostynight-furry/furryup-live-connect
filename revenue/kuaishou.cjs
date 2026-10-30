// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { fault, binding, timestamp, day, month, monthEnd, monthRange, shiftMonth, chinaDay, decimal, yuanToMinor, minor, record } = require('./model.cjs');
const KUAISHOU_PAGE = 'https://cp.kuaishou.com/profile';
const paths = {
  identity: '/rest/v2/creator/pc/authority/account/current',
  incentive: '/rest/cp/cooperate/kx/org/member/bill',
  live: '/rest/cp/creator/analysis/live/pc/trending'
};
const midnight = value => Date.parse(day(value) + 'T00:00:00+08:00');
const fatal = new Set(['ACCOUNT_CHANGED', 'PLATFORM_ACCOUNT_CHANGED', 'LOGIN_REQUIRED', 'VERIFICATION_REQUIRED', 'LOGIN_CANCELLED', 'REVENUE_DISPOSED', 'UNTRUSTED_PAGE', 'PAGE_CHANGED']);
function selfId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw fault('INVALID_REVENUE_ACCOUNT');
  if (!/^[1-9]\d{0,19}$/.test(String(value))) throw fault('INVALID_REVENUE_ACCOUNT');
  return String(value);
}
function kuaishouRequest(kind, { ownUserId, month: selected, start, end, page = 1 } = {}) {
  if (!Object.hasOwn(paths, kind)) throw fault('REVENUE_UNSUPPORTED_ENDPOINT');
  let body = {};
  if (kind !== 'identity') ownUserId = selfId(ownUserId);
  if (kind === 'incentive') {
    month(selected);
    if (!Number.isInteger(page) || page < 1 || page > 20) throw fault('INVALID_REVENUE_RANGE');
    // Always filter to the server-authenticated owner, never an arbitrary member.
    body = { type: 2, userId: ownUserId, govId: 0, switchStatus: -1, settlementTime: midnight(selected + '-01'), page, count: 50, sort: 0 };
  }
  if (kind === 'live') {
    day(start); day(end);
    if (start > end || (midnight(end) - midnight(start)) / 86400000 >= 31) throw fault('INVALID_REVENUE_RANGE');
    body = { memberId: ownUserId, startTime: midnight(start), endTime: midnight(end) + 86400000 - 1,
      dateType: '', dimensions: [9] }; // The official date picker uses '' for a custom range.
  }
  return { url: new URL(paths[kind], KUAISHOU_PAGE).href, method: 'POST', body, transport: 'kuaishou_page', source: 'kuaishou.' + kind };
}
function unwrapKuaishou(body) {
  if (!body || typeof body.result !== 'number') throw fault('REVENUE_SCHEMA_CHANGED');
  if (body.result === 109) throw fault('LOGIN_REQUIRED');
  if (body.result !== 1) throw fault('REVENUE_PLATFORM_REJECTED');
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw fault('REVENUE_SCHEMA_CHANGED');
  return body.data;
}
function dateValue(value) {
  if (typeof value === 'string' && /^20\d{2}[-/]\d{2}[-/]\d{2}$/.test(value)) return day(value.replaceAll('/', '-'));
  if (Number.isSafeInteger(value) && value >= 946656000000 && value < 4102444800000) return chinaDay(Math.floor(value / 1000));
  throw fault('REVENUE_DATE_UNAVAILABLE');
}
async function collectKuaishouRevenue({ accountId, identityKind, ownUserId, request, fromMonth, toMonth, fetchedAt = new Date().toISOString() } = {}) {
  binding('kuaishou', accountId); timestamp(fetchedAt); selfId(ownUserId);
  if (typeof request !== 'function') throw new TypeError('Revenue transport is required');
  const today = chinaDay(Math.floor(Date.parse(fetchedAt) / 1000)), current = today.slice(0, 7);
  if ((fromMonth === undefined) !== (toMonth === undefined)) throw fault('INVALID_REVENUE_RANGE');
  const requestedMonths = monthRange(fromMonth || shiftMonth(current, -6), toMonth || current);
  // Long histories can be synchronized in bounded batches into the same ledger.
  if (requestedMonths.length > 24) throw fault('REVENUE_RANGE_TOO_LARGE');
  const records = [], issues = [];
  async function read(source, selected, collect) {
    try { records.push(...await collect()); }
    catch (error) {
      if (fatal.has(error.code)) throw error;
      const known = ['REVENUE_PLATFORM_REJECTED', 'REVENUE_NETWORK_ERROR', 'REVENUE_RESPONSE_TOO_LARGE', 'REVENUE_REQUEST_TIMEOUT', 'REVENUE_HTTP_ERROR', 'REVENUE_MONTH_UNAVAILABLE', 'REVENUE_MONTH_MISMATCH', 'REVENUE_DATE_UNAVAILABLE', 'REVENUE_DATE_OUTSIDE_RANGE', 'REVENUE_PAGINATION_INCOMPLETE', 'CONFLICTING_REVENUE_PERIOD'];
      issues.push({ code: known.includes(error.code) ? error.code : 'REVENUE_SCHEMA_CHANGED', source, month: selected });
    }
  }
  for (const selected of requestedMonths) {
    if (selected < '2019-08' || selected >= current) issues.push({ code: selected >= current ? 'REVENUE_MONTH_NOT_PUBLISHED' : 'REVENUE_HISTORY_OUTSIDE_WINDOW', source: 'kuaishou.incentive_settlement', month: selected });
    else await read('kuaishou.incentive_settlement', selected, async () => {
      const seen = new Set(); let total = null, consumed = 0, amount = 0n;
      for (let page = 1; page <= 20; page++) {
        const data = unwrapKuaishou(await request(kuaishouRequest('incentive', { ownUserId, month: selected, page })));
        if (!Array.isArray(data.list) || data.list.length > 50 || !Number.isSafeInteger(data.totalCount) || data.totalCount < 0 || data.totalCount > 1000) throw fault('REVENUE_SCHEMA_CHANGED');
        if (total !== null && total !== data.totalCount) throw fault('REVENUE_PAGINATION_INCOMPLETE');
        total = data.totalCount;
        if (total === 0 && data.list.length === 0) throw fault('REVENUE_MONTH_UNAVAILABLE');
        if (!data.list.length || consumed + data.list.length > total) throw fault('REVENUE_PAGINATION_INCOMPLETE');
        for (const item of data.list) {
          if (selfId(item.userId) !== selfId(ownUserId)) throw fault('PLATFORM_ACCOUNT_CHANGED');
          if (dateValue(item.settlementTime).slice(0, 7) !== selected) throw fault('REVENUE_MONTH_MISMATCH');
          // Do not sum ambiguous duplicate statements, including repeated pages.
          // Personal incentive rows need not expose a settlement ID. A single
          // row is unambiguous; multiple institution rows need distinct keys.
          const id = ['string', 'number'].includes(typeof item.settlementId) && /^[A-Za-z0-9_-]{1,100}$/.test(String(item.settlementId)) ? String(item.settlementId) : null;
          const institution = typeof item.govName === 'string' && item.govName.trim() && item.govName.length <= 200 ? item.govName.trim() : null;
          const key = id ? 'id:' + id : institution ? 'institution:' + institution : total === 1 ? 'single' : null;
          if (!key) throw fault('REVENUE_SCHEMA_CHANGED');
          if (seen.has(key)) throw fault('CONFLICTING_REVENUE_PERIOD'); seen.add(key);
          // The incentive member table uses the yuan formatter; Kuaijiedan uses a different unit.
          amount += BigInt(yuanToMinor(decimal(item.allAccount)));
        }
        consumed += data.list.length;
        if (consumed === total) return [record({ scope: 'kuaishou.incentive_settlement', categoryId: 'video_incentive',
          categoryName: '创作者激励结算金额', period: 'month', start: selected + '-01', end: monthEnd(selected),
          amountMinor: minor(String(amount)), complete: true, provisional: true, source: 'creator_center' }, fetchedAt)];
      }
      throw fault('REVENUE_PAGINATION_INCOMPLETE');
    });
    if (selected < '2019-04' || selected > current || (selected === current && today.endsWith('-01'))) {
      issues.push({ code: selected < '2019-04' ? 'REVENUE_HISTORY_OUTSIDE_WINDOW' : 'REVENUE_MONTH_NOT_PUBLISHED', source: 'kuaishou.live_trend', month: selected }); continue;
    }
    const start = selected + '-01', end = selected === current ? chinaDay(Math.floor(Date.parse(fetchedAt) / 1000) - 86400) : monthEnd(selected);
    await read('kuaishou.live_trend', selected, async () => {
      const data = unwrapKuaishou(await request(kuaishouRequest('live', { ownUserId, start, end })));
      if (!Array.isArray(data.trending) || data.trending.length > 31) throw fault('REVENUE_SCHEMA_CHANGED');
      const rows = new Map();
      for (const item of data.trending) {
        const date = dateValue(item.dateTime);
        if (date < start || date > end) throw fault('REVENUE_DATE_OUTSIDE_RANGE');
        if (item.receiveAmount === null || item.receiveAmount === undefined) continue;
        const row = record({ scope: 'kuaishou.live_trend', categoryId: 'live_gifts', categoryName: '直播送礼收入（平台分析口径）',
          period: 'day', start: date, end: date, amountMinor: yuanToMinor(decimal(item.receiveAmount)), complete: true,
          provisional: true, source: 'creator_center' }, fetchedAt);
        if (rows.has(date) && JSON.stringify(rows.get(date)) !== JSON.stringify(row)) throw fault('CONFLICTING_REVENUE_PERIOD');
        rows.set(date, row);
      }
      if (!rows.size) throw fault('REVENUE_MONTH_UNAVAILABLE');
      return [...rows.values()];
    });
  }
  issues.push({ code: 'REVENUE_LIVE_ANALYTICS_NOT_NET_SETTLEMENT', source: 'kuaishou.live_trend' },
    { code: 'REVENUE_INCENTIVE_PROGRAM_SCOPE_LIMITED', source: 'kuaishou.incentive_settlement' });
  return { schemaVersion: 1, platform: 'kuaishou', accountId, ...(identityKind ? { identityKind } : {}), fetchedAt,
    source: 'creator_center', currency: 'CNY', timeZone: 'Asia/Shanghai', requestedMonths, records, metrics: [],
    categories: [{ id: 'video_incentive', name: '创作者激励结算', kind: 'video_incentive' }, { id: 'live_gifts', name: '直播送礼收入', kind: 'live' }],
    issues, status: records.length ? 'partial' : 'unavailable', historyComplete: false, adapterValidation: 'synthetic_only' };
}
module.exports = { KUAISHOU_PAGE, kuaishouRequest, unwrapKuaishou, collectKuaishouRevenue };
