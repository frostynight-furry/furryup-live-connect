// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { createHash } = require('node:crypto');
const { fault, binding, timestamp, month, monthRange, shiftMonth, chinaDay, label } = require('./model.cjs');
const { WALLET_SCOPE, INCOME_SCOPE, walletStatement, walletRecords, unsigned } = require('./wallet-statement.cjs');
const WALLET_PAGE = 'https://creator.douyin.com/creator-micro/revenue/center';
const MOBILE_WALLET_PAGE = 'https://webcast.amemv.com/falcon/webcast_douyin/page/wallet/bill/index.html?bill_type=income';
const BILL_PATH = '/webcast/wallet_api/get_billing_list/';
function compactMonth(value) {
  if (typeof value !== 'string' || !/^20\d{2}(?:0[1-9]|1[0-2])$/.test(value)) throw fault('REVENUE_SCHEMA_CHANGED');
  return month(value.slice(0, 4) + '-' + value.slice(4));
}
function walletRequest({ month: selected, page = 1, cursor } = {}) {
  month(selected);
  if (!Number.isInteger(page) || page < 1 || page > 100 || !Number.isSafeInteger(cursor) || cursor < 946656000 || cursor >= 4102444800) throw fault('INVALID_REVENUE_RANGE');
  // These parameters come from the official mobile income-record page. The
  // same route responds on creator.douyin.com; authenticated reuse is experimental.
  const url = new URL(BILL_PATH, WALLET_PAGE);
  url.search = new URLSearchParams({ start_time: selected.replace('-', ''), last_max_time: String(cursor), page: String(page),
    count: '20', type: '0', need_summary: '1', is_income_record: '1' }).toString();
  return { url: url.href, source: 'douyin.wallet', method: 'GET' };
}
function unwrap(body) {
  if (!body || typeof body.status_code !== 'number') throw fault('REVENUE_SCHEMA_CHANGED');
  if (body.status_code === 20003) throw fault('REVENUE_WALLET_SESSION_REQUIRED');
  if (body.status_code !== 0) throw fault('REVENUE_PLATFORM_REJECTED');
  const data = body.data;
  if (!data || !Array.isArray(data.bill_list) || data.bill_list.length > 24 || ![true, false, 0, 1].includes(data.has_more) ||
    !data.billing_types || typeof data.billing_types !== 'object' || Array.isArray(data.billing_types) || Object.keys(data.billing_types).length > 200) throw fault('REVENUE_SCHEMA_CHANGED');
  return data;
}
function classify(names, withdrawal, refund) {
  if (withdrawal) return 'withdrawal';
  if (refund || names.some(s => /退款|退回|返还|退还|冲正|撤销/.test(s))) return 'refund';
  if (names.some(s => /提现|提取/.test(s))) return 'withdrawal';
  if (names.some(s => /转入|转出|转账|充值|兑换|红包/.test(s))) return 'transfer';
  // Only explicit category names qualify. Generic video income may include sales;
  // arbitrary transaction titles must not turn a cash movement into earnings.
  const live = names.some(s => /^(?:抖音)?(?:直播(?:礼物)?(?:收入|收益|分成)|(?:礼物|音浪)(?:收入|收益))$/.test(s));
  const video = names.some(s => /^(?:抖音)?(?:视频激励(?:收入|收益)?|创作者(?:广告分成|激励|伙伴计划)(?:收入|收益)?|中视频伙伴计划(?:收入|收益)?)$/.test(s));
  const mixed = names.some(s => /直播[\/／、和与].*创作|创作[\/／、和与].*直播/.test(s));
  if (mixed || live && video) return 'creator_unsplit';
  return live ? 'live' : video ? 'video_incentive' : 'unknown';
}
function transaction(item, types) {
  if (!item || ![0, 1, 2].includes(item.sign) || !Number.isSafeInteger(item.txn_time)) throw fault('REVENUE_SCHEMA_CHANGED');
  const idPart = value => {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw fault('REVENUE_SCHEMA_CHANGED');
    if (!['string', 'number'].includes(typeof value) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(String(value))) throw fault('REVENUE_SCHEMA_CHANGED');
    return String(value);
  };
  const type = idPart(item.type), order = idPart(item.order_id), accountType = idPart(item.account_type);
  if (!/^\d{1,12}$/.test(type)) throw fault('REVENUE_SCHEMA_CHANGED');
  const typeName = types[type];
  if (typeName !== undefined && typeof typeName !== 'string') throw fault('REVENUE_SCHEMA_CHANGED');
  for (const status of [item.withdraw_status, item.refund_status]) if (status !== undefined && (!Number.isInteger(status) || status < 0)) throw fault('REVENUE_SCHEMA_CHANGED');
  const source = item.source_app === undefined ? '' : idPart(item.source_app);
  const kind = classify([typeName, item.title, item.event_title].filter(x => typeof x === 'string').map(x => label(x)),
    !!item.withdraw_status, !!item.refund_status);
  return { id: createHash('sha256').update(JSON.stringify([type, order, accountType, source])).digest('hex'), time: item.txn_time,
    type, direction: ['out', 'in', 'neutral'][item.sign], amountMinor: unsigned(item.money), kind,
    // Titles/descriptions can include personal details. Persist only the platform's category label.
    categoryName: label(typeName) || '未提供交易类型', classification: 'platform_label' };
}
async function collectDouyinWalletRevenue({ accountId, identityKind, request, fromMonth, toMonth,
  fetchedAt = new Date().toISOString(), maxPagesPerMonth = 100 } = {}) {
  binding('douyin', accountId); timestamp(fetchedAt);
  if (typeof request !== 'function' || !Number.isInteger(maxPagesPerMonth) || maxPagesPerMonth < 1 || maxPagesPerMonth > 100) throw new TypeError('Invalid wallet transport/options');
  if ((fromMonth === undefined) !== (toMonth === undefined)) throw fault('INVALID_REVENUE_RANGE');
  const now = Math.floor(Date.parse(fetchedAt) / 1000), current = chinaDay(now).slice(0, 7);
  const requestedMonths = monthRange(fromMonth || shiftMonth(current, -6), toMonth || current);
  if (requestedMonths.length > 24) throw fault('REVENUE_RANGE_TOO_LARGE');
  const records = [], statements = [], issues = [], checkedMonths = [];
  let earliestAvailableMonth;
  const fatal = new Set(['ACCOUNT_CHANGED', 'PLATFORM_ACCOUNT_CHANGED', 'LOGIN_REQUIRED', 'REVENUE_WALLET_SESSION_REQUIRED', 'VERIFICATION_REQUIRED', 'LOGIN_CANCELLED', 'REVENUE_DISPOSED', 'UNTRUSTED_PAGE', 'PAGE_CHANGED',
    'REVENUE_MOBILE_BRIDGE_UNAVAILABLE', 'REVENUE_MOBILE_IDENTITY_UNAVAILABLE', 'REVENUE_MOBILE_DISCONNECTED', 'REVENUE_MOBILE_DEVICE_UNAVAILABLE', 'REVENUE_MOBILE_AUTHORIZATION_REQUIRED']);
  async function readMonth(selected) {
    const seen = new Map(); let cursor = now, summary, typesSignature, complete = false;
    for (let page = 1; page <= maxPagesPerMonth; page++) {
      const data = unwrap(await request(walletRequest({ month: selected, page, cursor })));
      const earliest = compactMonth(data.end_time);
      if (earliest > current || earliestAvailableMonth && earliest !== earliestAvailableMonth) throw fault('REVENUE_WALLET_SNAPSHOT_CHANGED');
      earliestAvailableMonth = earliest;
      if (selected < earliest) throw fault('REVENUE_HISTORY_OUTSIDE_WINDOW');
      const signature = JSON.stringify(Object.entries(data.billing_types).sort(([a], [b]) => a.localeCompare(b)));
      if (typesSignature && signature !== typesSignature) throw fault('REVENUE_WALLET_SNAPSHOT_CHANGED'); typesSignature = signature;
      let oldest, olderMonth = false, added = 0, count = 0, previousTime = cursor, previousMonth = selected;
      for (const group of data.bill_list) {
        const groupMonth = compactMonth(group.period);
        if (groupMonth > previousMonth || !Array.isArray(group.bills) || group.bills.length > 20) throw fault('REVENUE_MONTH_MISMATCH'); previousMonth = groupMonth;
        if (groupMonth < selected) { olderMonth = true; continue; }
        const totals = { income: unsigned(group.income), outcome: unsigned(group.outcome) };
        if (summary && (summary.income !== totals.income || summary.outcome !== totals.outcome)) throw fault('REVENUE_WALLET_SNAPSHOT_CHANGED'); summary = totals;
        for (const item of group.bills) {
          if (++count > 20) throw fault('REVENUE_SCHEMA_CHANGED');
          const row = transaction(item, data.billing_types);
          if (chinaDay(row.time).slice(0, 7) !== selected || row.time > previousTime || row.time > now) throw fault('REVENUE_DATE_OUTSIDE_RANGE');
          previousTime = row.time; oldest = row.time;
          const old = seen.get(row.id);
          if (old && JSON.stringify(old) !== JSON.stringify(row)) throw fault('CONFLICTING_REVENUE_TRANSACTION');
          if (!old) { seen.set(row.id, row); added++; }
        }
      }
      if (!data.has_more || olderMonth) { complete = true; break; }
      if (!added || oldest === undefined) throw fault('REVENUE_PAGINATION_INCOMPLETE');
      cursor = oldest;
    }
    if (!complete) throw fault('REVENUE_PAGINATION_INCOMPLETE');
    if (!summary) { checkedMonths.push({ month: selected, status: 'no_data' }); issues.push({ code: 'REVENUE_MONTH_UNAVAILABLE', source: 'douyin.wallet', month: selected }); return; }
    const statement = walletStatement({ scope: WALLET_SCOPE, month: selected, fetchedAt, transactions: [...seen.values()],
      reportedIncomeMinor: summary.income, reportedOutcomeMinor: summary.outcome, calendarComplete: selected < current,
      paginationComplete: true, reconciled: true });
    const unknown = statement.transactions.some(r => r.direction === 'in' && ['unknown', 'creator_unsplit'].includes(r.kind) && r.amountMinor !== '0');
    const pending = walletRecords(statement);
    if (unknown) issues.push({ code: 'REVENUE_WALLET_UNCLASSIFIED_INCOME', source: 'douyin.wallet', month: selected });
    statements.push(statement); records.push(...pending); checkedMonths.push({ month: selected, status: 'stored' });
  }
  for (const selected of requestedMonths) {
    if (selected > current) { issues.push({ code: 'REVENUE_MONTH_NOT_PUBLISHED', source: 'douyin.wallet', month: selected }); continue; }
    try { await readMonth(selected); }
    catch (error) {
      if (fatal.has(error.code)) throw error;
      const known = new Set(['REVENUE_PLATFORM_REJECTED', 'REVENUE_REQUEST_TIMEOUT', 'REVENUE_NETWORK_ERROR', 'REVENUE_HTTP_ERROR', 'REVENUE_RESPONSE_TOO_LARGE',
        'REVENUE_HISTORY_OUTSIDE_WINDOW', 'REVENUE_WALLET_SNAPSHOT_CHANGED', 'REVENUE_MONTH_MISMATCH', 'REVENUE_DATE_OUTSIDE_RANGE', 'CONFLICTING_REVENUE_TRANSACTION', 'REVENUE_PAGINATION_INCOMPLETE', 'REVENUE_WALLET_RECONCILIATION_FAILED']);
      issues.push({ code: known.has(error.code) ? error.code : 'REVENUE_SCHEMA_CHANGED', source: 'douyin.wallet', month: selected });
    }
  }
  issues.push({ code: 'REVENUE_WALLET_POSTING_TIME_BASIS', source: 'douyin.wallet' }, { code: 'REVENUE_WALLET_CATEGORY_LABEL_BASED', source: 'douyin.wallet' });
  return { schemaVersion: 1, platform: 'douyin', accountId, ...(identityKind ? { identityKind } : {}), fetchedAt,
    source: 'wallet', currency: 'CNY', timeZone: 'Asia/Shanghai', timeBasis: 'posting_time', requestedMonths, checkedMonths,
    ...(earliestAvailableMonth ? { earliestAvailableMonth } : {}), records, statements, metrics: [], issues,
    categories: [{ id: 'total', name: '钱包入账合计', kind: 'cashflow' }, { id: 'live', name: '直播入账', kind: 'live' }, { id: 'video_incentive', name: '视频激励入账', kind: 'video_incentive' }],
    status: records.length ? 'partial' : 'unavailable', historyComplete: false, adapterValidation: 'synthetic_only', sessionReuse: 'experimental_creator_origin' };
}
module.exports = { WALLET_PAGE, MOBILE_WALLET_PAGE, BILL_PATH, INCOME_SCOPE, walletRequest, collectDouyinWalletRevenue };
