// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { fault, binding, timestamp, month, monthRange, monthEnd, shiftMonth, chinaDay, label, minor, record } = require('./model.cjs');
const WECHAT_REVENUE_PAGE = 'https://channels.weixin.qq.com/platform/income';
const WECHAT_WALLET_ORIGIN = 'https://qy.webeans.weixin.qq.com';
const paths = { identity: 'auth/auth_data', catalog: 'income/get-my-finder-income-detail',
  handoff: 'svrkit/MmFinderAssistantLiveSvr/getRelatedMainPart' };
function wechatRequest(kind) {
  if (!Object.hasOwn(paths, kind)) throw fault('REVENUE_UNSUPPORTED_ENDPOINT');
  return { url: new URL('/cgi-bin/mmfinderassistant-bin/' + paths[kind], WECHAT_REVENUE_PAGE).href,
    method: 'POST', body: {}, transport: 'wechat_helper', source: 'wechat_channels.' + kind };
}
function unwrapWechat(body) {
  if (!body || typeof body.errCode !== 'number') throw fault('REVENUE_SCHEMA_CHANGED');
  if (body.errCode !== 0) throw fault('REVENUE_PLATFORM_REJECTED');
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw fault('REVENUE_SCHEMA_CHANGED');
  return body.data;
}
function walletHandoff(data) {
  // Studio/company choices are intentionally not inferred from another business account.
  const info = data.cocertInfo;
  if (!info || typeof info.wecoinAuthCode !== 'string' || !info.wecoinAuthCode || info.wecoinAuthCode.length > 4096) throw fault('REVENUE_WALLET_HANDOFF_UNAVAILABLE');
  if (![1, 2].includes(info.settleType)) throw fault('REVENUE_WALLET_HANDOFF_UNAVAILABLE');
  if (info.settleType === 2 && !info.extInfo?.maskPhone) throw fault('REVENUE_ADDITIONAL_VERIFICATION_REQUIRED');
  const query = new URLSearchParams({ busid: '3', authcode: info.wecoinAuthCode, account_type: info.settleType === 1 ? '2' : '1' });
  return WECHAT_WALLET_ORIGIN + '/#/login?' + query.toString();
}
function walletRequest() {
  return { url: WECHAT_WALLET_ORIGIN + '/api/platform/platformGetSettleListForFinderLive', method: 'POST', body: {}, source: 'wechat_channels.live_settlement' };
}
const businesses = { 1: ['live_gifts', '直播礼物', 'live'], 3: ['live_team', '付费组队', 'live'], 7: ['live_paid', '付费直播', 'live'],
  13: ['membership', '视频号会员', 'other'], 16: ['paid_course', '付费课程', 'other'], 18: ['paid_drama', '付费剧集', 'other'] };
function parseWechatWallet(body, { fetchedAt, requestedMonths }) {
  if (body?.error) throw fault([-2, -1000001].includes(body.error.code) ? 'REVENUE_WALLET_LOGIN_REQUIRED' : 'REVENUE_PLATFORM_REJECTED');
  const data = body?.data;
  if (!data || !Array.isArray(data.settleList) || data.settleList.length > 5000) throw fault('REVENUE_SCHEMA_CHANGED');
  if (data.baseResp && data.baseResp.errorCode !== 0) throw fault('REVENUE_PLATFORM_REJECTED');
  const rows = new Map(), current = chinaDay(Math.floor(Date.parse(fetchedAt) / 1000)).slice(0, 7);
  for (const item of data.settleList) {
    if (!Number.isInteger(item.businessId) || !Object.hasOwn(businesses, item.businessId)) throw fault('REVENUE_CATEGORY_ENDPOINT_UNSUPPORTED');
    const selected = month(typeof item.showTime === 'string' ? item.showTime.replace('/', '-') : undefined);
    if (!requestedMonths.includes(selected)) continue;
    const raw = BigInt(minor(item.totalIncome)); // Official formatter divides the integer by 10,000 yuan.
    if (raw % 100n) throw fault('REVENUE_SUBCENT_PRECISION');
    if (!Number.isInteger(item.status)) throw fault('REVENUE_SCHEMA_CHANGED');
    const [categoryId, categoryName] = businesses[item.businessId];
    const row = record({ scope: 'wechat_channels.live_settlement', categoryId, categoryName, period: 'month',
      start: selected + '-01', end: monthEnd(selected), amountMinor: minor(String(raw / 100n)),
      // Payment workflow status is not monthly data coverage or proof of payout.
      complete: selected < current, provisional: true, source: 'live_settlement' }, fetchedAt);
    const key = categoryId + ':' + selected;
    // No summing of an aggregate and a supplementary/duplicate bill without a verified contract.
    if (rows.has(key)) throw fault('CONFLICTING_REVENUE_PERIOD'); rows.set(key, row);
  }
  return [...rows.values()];
}
async function collectWechatRevenue({ accountId, identityKind, request, readWallet, fromMonth, toMonth, fetchedAt = new Date().toISOString() } = {}) {
  binding('wechat_channels', accountId); timestamp(fetchedAt);
  if (typeof request !== 'function') throw new TypeError('Revenue transport is required');
  if ((fromMonth === undefined) !== (toMonth === undefined)) throw fault('INVALID_REVENUE_RANGE');
  const current = chinaDay(Math.floor(Date.parse(fetchedAt) / 1000)).slice(0, 7);
  const requestedMonths = monthRange(fromMonth || shiftMonth(current, -6), toMonth || current);
  const records = [], issues = [], categories = [], availability = [];
  const fatal = new Set(['ACCOUNT_CHANGED', 'PLATFORM_ACCOUNT_CHANGED', 'LOGIN_REQUIRED', 'VERIFICATION_REQUIRED', 'LOGIN_CANCELLED', 'REVENUE_DISPOSED', 'UNTRUSTED_PAGE', 'PAGE_CHANGED']);
  async function read(source, operation) {
    try { return await operation(); }
    catch (error) {
      if (fatal.has(error.code)) throw error;
      const known = ['REVENUE_PLATFORM_REJECTED', 'REVENUE_NETWORK_ERROR', 'REVENUE_RESPONSE_TOO_LARGE', 'REVENUE_REQUEST_TIMEOUT', 'REVENUE_HTTP_ERROR', 'REVENUE_WALLET_HANDOFF_UNAVAILABLE', 'REVENUE_ADDITIONAL_VERIFICATION_REQUIRED', 'REVENUE_WALLET_LOGIN_REQUIRED', 'REVENUE_WALLET_TIMEOUT', 'REVENUE_CATEGORY_ENDPOINT_UNSUPPORTED', 'REVENUE_SUBCENT_PRECISION', 'CONFLICTING_REVENUE_PERIOD'];
      issues.push({ code: known.includes(error.code) ? error.code : 'REVENUE_SCHEMA_CHANGED', source }); return null;
    }
  }
  await read('wechat_channels.catalog', async () => {
    const data = unwrapWechat(await request(wechatRequest('catalog')));
    if (!Array.isArray(data.incomeDetails) || data.incomeDetails.length > 100) throw fault('REVENUE_SCHEMA_CHANGED');
    const pending = data.incomeDetails.map(item => {
      if (typeof item.permission !== 'boolean' || typeof item.card?.title !== 'string') throw fault('REVENUE_SCHEMA_CHANGED');
      return { name: label(item.card.title), enabled: item.permission, acquisition: 'mobile_page' };
    });
    availability.push(...pending);
  });
  // This desktop endpoint returns eligibility/cards and QR instructions, not revenue amounts.
  issues.push({ code: 'REVENUE_VIDEO_INCENTIVE_MOBILE_REQUIRED', source: 'wechat_channels.video_incentive' });
  await read('wechat_channels.live_settlement', async () => {
    const data = unwrapWechat(await request(wechatRequest('handoff'))), url = walletHandoff(data);
    if (typeof readWallet !== 'function') throw fault('REVENUE_WALLET_HANDOFF_UNAVAILABLE');
    const rows = parseWechatWallet(await readWallet(url, walletRequest()), { fetchedAt, requestedMonths });
    records.push(...rows);
    for (const [id, name, kind] of Object.values(businesses)) if (rows.some(row => row.categoryId === id)) categories.push({ id, name, kind });
    if (data.cocertInfo.settleType === 1) issues.push({ code: 'REVENUE_COMPANY_SETTLEMENT_SUBJECT_SCOPE', source: 'wechat_channels.live_settlement' });
    if (Array.isArray(data.studioInfos) && data.studioInfos.length) issues.push({ code: 'REVENUE_ADDITIONAL_SETTLEMENT_ACCOUNTS_NOT_INCLUDED', source: 'wechat_channels.live_settlement' });
  });
  issues.push({ code: 'REVENUE_HISTORY_PLATFORM_VISIBLE_ONLY', source: 'wechat_channels.live_settlement' });
  return { schemaVersion: 1, platform: 'wechat_channels', accountId, ...(identityKind ? { identityKind } : {}), fetchedAt,
    source: 'creator_center', currency: 'CNY', timeZone: 'Asia/Shanghai', requestedMonths, records, metrics: [], categories, availability,
    issues, status: records.length ? 'partial' : 'unavailable', historyComplete: false, adapterValidation: 'synthetic_only' };
}
module.exports = { WECHAT_REVENUE_PAGE, WECHAT_WALLET_ORIGIN, wechatRequest, unwrapWechat, walletHandoff, walletRequest, parseWechatWallet, collectWechatRevenue };
