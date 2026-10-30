// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { fault, binding, minor, chinaDay, month, shiftMonth, monthRange, monthEnd, token, label, timestamp, record, recordKey } = require('./model.cjs');
const { KUAISHOU_PAGE, collectKuaishouRevenue } = require('./kuaishou.cjs');
const { WECHAT_REVENUE_PAGE, collectWechatRevenue } = require('./wechat-channels.cjs');

const REVENUE_PAGES = Object.freeze({
  bilibili: 'https://member.bilibili.com/platform/allowance/incomeCenter/pc',
  douyin: 'https://creator.douyin.com/creator-micro/revenue/center',
  kuaishou: KUAISHOU_PAGE, wechat_channels: WECHAT_REVENUE_PAGE
});
const endpoints = {
  bilibili: {
    identity: '/x/web-interface/nav',
    config: '/x/earnings/show_conf', summary: '/x/earnings/up/index/income',
    trend: '/x/earnings/up/income/trend', monthly: '/x/earnings/up/index/income/judge'
  },
  douyin: {
    categories: '/aweme/v1/creator/income/category/auth/', summary: '/aweme/v1/creator/income/category/summary/',
    detail: '/aweme/v1/creator/income/category/detail/'
  }
};
function requestFor(platform, kind, params = {}) {
  const path = Object.hasOwn(endpoints, platform) && Object.hasOwn(endpoints[platform], kind) ? endpoints[platform][kind] : null;
  if (!path) throw fault('REVENUE_UNSUPPORTED_ENDPOINT');
  const query = {};
  if (platform === 'bilibili') {
    if (kind === 'trend') query.days = '30';
    if (kind === 'monthly') query.current_month = month(params.month).replace('-', '');
  } else {
    query.income_type = '0'; // Only the signed-in personal account, never an agency talent ID.
    if (kind !== 'categories') {
      if (params.categoryId !== '' && params.categoryId !== undefined) token(params.categoryId);
      query.category_id = params.categoryId || '';
    }
    if (kind === 'detail') query.history_day_count = '30';
  }
  const url = new URL(path, platform === 'bilibili' ? 'https://api.bilibili.com' : 'https://creator.douyin.com');
  url.search = new URLSearchParams(query).toString();
  return { url: url.href, source: platform + '.' + kind };
}
function unwrap(platform, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fault('REVENUE_SCHEMA_CHANGED');
  const code = platform === 'bilibili' ? body.code : body.status_code;
  if (code === undefined) throw fault('REVENUE_SCHEMA_CHANGED');
  if (platform === 'bilibili' && code === -101) throw fault('LOGIN_REQUIRED');
  if (code !== 0) throw fault('REVENUE_PLATFORM_REJECTED');
  return platform === 'bilibili' ? body.data : body;
}
function array(value, limit = 366) {
  if (!Array.isArray(value) || value.length > limit) throw fault('REVENUE_SCHEMA_CHANGED');
  return value;
}
function biliCategory(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100000) throw fault('REVENUE_SCHEMA_CHANGED');
  return 'enum:' + value;
}
function reportMonth(value) {
  const text = String(value);
  return month(/^\d{6}$/.test(text) ? text.slice(0, 4) + '-' + text.slice(4) : text);
}
function categoryKind(name) {
  if (/直播|live/i.test(name)) return 'live';
  if (/创作激励|创作者激励|视频激励/.test(name)) return 'video_incentive';
  return 'other';
}
function unique(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = recordKey(row), old = map.get(key);
    if (old && JSON.stringify(old) !== JSON.stringify(row)) throw fault('CONFLICTING_REVENUE_PERIOD');
    map.set(key, row);
  }
  return [...map.values()];
}

// request is the host's authenticated, bounded read transport. No cookie,
// signing key, arbitrary URL or third-party collection service is required.
async function collectCreatorRevenue({ platform, accountId, identityKind, ownUserId, request, readWallet, fromMonth, toMonth,
  fetchedAt = new Date().toISOString(), maxCategories = 24 } = {}) {
  binding(platform, accountId); timestamp(fetchedAt);
  if (platform === 'kuaishou') return collectKuaishouRevenue({ accountId, identityKind, ownUserId, request, fromMonth, toMonth, fetchedAt });
  if (platform === 'wechat_channels') return collectWechatRevenue({ accountId, identityKind, request, readWallet, fromMonth, toMonth, fetchedAt });
  if (typeof request !== 'function' || !Number.isInteger(maxCategories) || maxCategories < 1 || maxCategories > 32) throw new TypeError('Invalid revenue transport/options');
  const today = chinaDay(Math.floor(Date.parse(fetchedAt) / 1000)), current = today.slice(0, 7);
  fromMonth ||= shiftMonth(current, -6); toMonth ||= current;
  const requestedMonths = monthRange(fromMonth, toMonth);
  const records = [], metrics = [], categories = new Map(), issues = [];
  function category(id, name, parentId) {
    token(id); const title = label(name) || id;
    categories.set(id, { id, name: title, kind: id === 'total' ? 'total' : categoryKind(title), ...(parentId ? { parentId } : {}) });
    return title;
  }
  category('total', '创作者收益中心汇总');
  function add(row) { return record({ source: 'creator_center', complete: true, provisional: true, ...row }, fetchedAt); }
  const fatalCodes = new Set(['ACCOUNT_CHANGED', 'PLATFORM_ACCOUNT_CHANGED', 'LOGIN_REQUIRED', 'VERIFICATION_REQUIRED', 'LOGIN_CANCELLED', 'REVENUE_DISPOSED', 'UNTRUSTED_PAGE', 'PAGE_CHANGED']);
  async function read(kind, params, parse) {
    try {
      const data = unwrap(platform, await request(requestFor(platform, kind, params)));
      // Parse into temporary rows before applying so malformed endpoints cannot
      // leave a half-accepted financial statement.
      const value = parse(data);
      if (value?.records) records.push(...unique(value.records));
      if (value?.metrics) metrics.push(...value.metrics);
      return value;
    } catch (error) {
      if (fatalCodes.has(error.code)) throw error;
      const code = ['REVENUE_PLATFORM_REJECTED', 'REVENUE_NETWORK_ERROR', 'REVENUE_RESPONSE_TOO_LARGE', 'REVENUE_REQUEST_TIMEOUT', 'REVENUE_HTTP_ERROR', 'REVENUE_MONTH_UNAVAILABLE', 'REVENUE_MONTH_MISMATCH', 'CONFLICTING_REVENUE_PERIOD'].includes(error.code) ? error.code : 'REVENUE_SCHEMA_CHANGED';
      issues.push({ code, source: platform + '.' + kind, ...(params?.month ? { month: params.month } : {}), ...(params?.categoryId ? { categoryId: params.categoryId } : {}) });
      return null;
    }
  }
  if (platform === 'bilibili') {
    await read('config', {}, data => {
      for (const item of array(data?.incomes, 100)) category(biliCategory(item.enum), item.title);
      return {};
    });
    await read('summary', {}, data => {
      if (!data?.summary || !data.date) throw fault('REVENUE_SCHEMA_CHANGED');
      const asOf = chinaDay(data.date.datex), rows = [];
      const amounts = [{ id: 'total', value: data.summary }, ...array(data.detail, 100).map(value => ({ id: biliCategory(value.enum), value }))];
      for (const { id, value } of amounts) {
        if (value.extra_info?.is_black) continue;
        for (const [field, period] of [['daily_amt', 'previous_day'], ['thirty_days_amt', 'rolling_30_days'], ['annual_amt', 'rolling_year']]) {
          // annual_amt is explicitly the past year, NOT lifetime revenue.
          if (value[field] == null || value.extra_info?.['is_cm_fire_mcn_' + ({ daily_amt: 'daily', thirty_days_amt: 'thirty_days', annual_amt: 'annual' }[field])]) continue;
          if (field === 'daily_amt' && ![1, 99].includes(value.state)) continue;
          rows.push({ scope: 'bilibili.overview', categoryId: id, metric: 'income', period, amountMinor: minor(value[field]), currency: 'CNY', asOf, provisional: true });
        }
      }
      return { metrics: rows };
    });
    await read('trend', {}, data => ({ records: array(data?.data).map(item => {
      const date = chinaDay(item.date);
      if (date > today) throw fault('REVENUE_SCHEMA_CHANGED');
      return add({ scope: 'bilibili.trend', categoryId: 'total', categoryName: '收益趋势（平台所含项目）', period: 'day', start: date, end: date, amountMinor: minor(item.amt) });
    }) }));
    const oldest = shiftMonth(current, -6);
    for (const value of requestedMonths) {
      if (value < oldest || value >= current) {
        issues.push({ code: value >= current ? 'REVENUE_MONTH_NOT_PUBLISHED' : 'REVENUE_HISTORY_OUTSIDE_WINDOW', source: 'bilibili.monthly', month: value });
        continue;
      }
      await read('monthly', { month: value }, data => {
        if (data?.is_normal_show !== true && data?.is_normal_show !== 1) throw fault('REVENUE_MONTH_UNAVAILABLE');
        if (reportMonth(data.income_market?.current_month) !== value) throw fault('REVENUE_MONTH_MISMATCH');
        const detail = array(data.income_structure?.current_month_detail, 100);
        const period = { scope: 'bilibili.monthly', period: 'month', start: value + '-01', end: monthEnd(value) };
        const result = [add({ ...period, categoryId: 'total', categoryName: '月度收益报告总额',
          amountMinor: minor(data.income_market.current_month_income), complete: !detail.some(item => (item.state !== undefined && item.state !== 99) || item.extra_info?.is_black) })];
        for (const item of detail) {
          if (item.state === 0 || item.extra_info?.is_black) continue;
          const id = biliCategory(item.enum);
          result.push(add({ ...period, categoryId: id, categoryName: categories.get(id)?.name || id,
            amountMinor: minor(item.amt), complete: item.state === undefined || item.state === 99 }));
        }
        return { records: result };
      });
    }
  } else {
    const auth = await read('categories', {}, data => {
      const items = [], seen = new Set();
      for (const top of array(data.optional_category_list, 100)) {
        token(top.category_id);
        const children = top.sub_category_list == null ? [] : array(top.sub_category_list, 100);
        if (children.length) category(top.category_id, top.name);
        for (const item of children.length ? children : [top]) {
          token(item.category_id);
          if (seen.has(item.category_id)) throw fault('REVENUE_SCHEMA_CHANGED');
          seen.add(item.category_id);
          category(item.category_id, item.name, children.length ? top.category_id : undefined);
          items.push({ id: item.category_id, status: item.status });
        }
      }
      return { items };
    });
    if ((auth?.items.length || 0) > maxCategories) issues.push({ code: 'REVENUE_CATEGORY_LIMIT', source: 'douyin.categories' });
    const targets = [{ id: '' }, ...(auth?.items || []).slice(0, maxCategories)];
    for (const target of targets) {
      const id = target.id || 'total', title = categories.get(id)?.name || id;
      if (target.id === 'video_paid') {
        issues.push({ code: 'REVENUE_CATEGORY_ENDPOINT_UNSUPPORTED', source: 'douyin.detail', categoryId: id }); continue;
      }
      await read('summary', { categoryId: target.id }, data => {
        const rows = [];
        for (const [field, period] of [['day1_income_summary', 'previous_day'], ['day7_income_summary', 'rolling_7_days'], ['day30_income_summary', 'rolling_30_days'], ['total_income_summary', 'lifetime']]) {
          const value = data[field];
          // The UI hides lifetime for the all-category and Xingtu tabs.
          if (period === 'lifetime' && ['', 'business_task_xingtu'].includes(target.id)) continue;
          if (!value || value.history_total_income == null || value.data_update_status === 0) continue;
          rows.push({ scope: 'douyin.category', categoryId: id, metric: 'income', period,
            amountMinor: minor(value.history_total_income), currency: 'CNY', provisional: true,
            updateStatus: value.data_update_status === 2 ? 'updated' : 'updating' });
        }
        if (!rows.length) throw fault('REVENUE_SCHEMA_CHANGED');
        return { metrics: rows };
      });
      await read('detail', { categoryId: target.id }, data => ({ records: array(data.income_item_list).map(item => {
        const date = chinaDay(item.timestamp);
        if (date > today) throw fault('REVENUE_SCHEMA_CHANGED');
        return add({ scope: 'douyin.category', categoryId: id, categoryName: title, period: 'day', start: date, end: date, amountMinor: minor(item.amount) });
      }) }));
    }
    issues.push({ code: 'REVENUE_HISTORY_RECENT_DAYS_ONLY', source: 'douyin.detail' });
    issues.push({ code: 'REVENUE_ANCHOR_NOT_REQUESTED', source: 'douyin.anchor' });
  }
  const result = unique(records);
  return { schemaVersion: 1, platform, accountId, ...(identityKind ? { identityKind: token(identityKind) } : {}), fetchedAt,
    currency: 'CNY', timeZone: 'Asia/Shanghai', source: 'creator_center',
    status: !result.length && !metrics.length ? 'unavailable' : issues.length ? 'partial' : 'ok',
    requestedMonths, records: result, metrics, categories: [...categories.values()], issues,
    historyComplete: false, adapterValidation: 'synthetic_only' };
}
module.exports = { REVENUE_PAGES, requestFor, collectCreatorRevenue };
