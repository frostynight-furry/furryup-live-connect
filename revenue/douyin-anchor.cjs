// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { fault, binding, timestamp, day, chinaDay, yuanToMinor, label, token, decimal, record, metric, nativeRecord, nativeMetric } = require('./model.cjs');
const ANCHOR_PAGE = 'https://anchor.douyin.com/anchor/dashboard/home';
const prefix = '/webcast/data/api/v1/component/lego/webcast_api/data/';
const paths = { status: 'common/data_produce_time/detail', summary: 'room/live/base_data', trend: 'room/live/time_trend' };
function anchorRequest(kind, { startDate, endDate } = {}) {
  if (!Object.hasOwn(paths, kind)) throw fault('REVENUE_UNSUPPORTED_ENDPOINT');
  const query = { aid: '477650' };
  if (kind === 'status') query.bizDataTag = 'anchor_platform_data_summary_status';
  else {
    day(startDate); day(endDate);
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1;
    if (days < 1 || days > 30) throw fault('INVALID_REVENUE_RANGE');
    query.startDate = startDate; query.endDate = endDate;
    if (kind === 'trend') query.field = 'earnScore';
  }
  const url = new URL(prefix + paths[kind], ANCHOR_PAGE); url.search = new URLSearchParams(query).toString();
  return { url: url.href, source: 'douyin.anchor.' + kind, headers: { 'x-appid': '3000', 'x-sub-web-id': '1116' } };
}
function component(body) {
  if (!body || typeof body !== 'object' || typeof body.status_code !== 'number') throw fault('REVENUE_SCHEMA_CHANGED');
  if ([98, 20003, 20011].includes(body.status_code)) throw fault('LOGIN_REQUIRED');
  if ([96, 97].includes(body.status_code)) throw fault('VERIFICATION_REQUIRED');
  if (body.status_code !== 0) throw fault('REVENUE_PLATFORM_REJECTED');
  // The official client unwraps data, then parses its data string. This is
  // deliberately not a recursive search through arbitrary response objects.
  if (typeof body.data?.data !== 'string' || body.data.data.length > 2 * 1024 * 1024) throw fault('REVENUE_SCHEMA_CHANGED');
  let value; try { value = JSON.parse(body.data.data); } catch { throw fault('REVENUE_SCHEMA_CHANGED'); }
  if (!value || typeof value !== 'object') throw fault('REVENUE_SCHEMA_CHANGED');
  if (value.code !== undefined && value.code !== 0 && value.code !== '0') throw fault('REVENUE_PLATFORM_REJECTED');
  if (['1001', '1002'].includes(String(value.tip?.code))) throw fault('REVENUE_DATA_NOT_READY');
  if (!Array.isArray(value.data?.series) || value.data.series.length > 1000) throw fault('REVENUE_SCHEMA_CHANGED');
  return value;
}
function metadata(data) {
  if (typeof data.meta !== 'string' || data.meta.length > 256 * 1024) throw fault('REVENUE_SCHEMA_CHANGED');
  let value; try { value = JSON.parse(data.meta); } catch { throw fault('REVENUE_SCHEMA_CHANGED'); }
  if (!Array.isArray(value?.field) || value.field.length > 200) throw fault('REVENUE_SCHEMA_CHANGED');
  return value;
}
function shiftDay(value, offset) { return day(new Date(Date.parse(day(value) + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10)); }
function axisDay(value) {
  if (typeof value !== 'string') throw fault('REVENUE_DATE_UNAVAILABLE');
  // Do not assign a year to MM-DD labels or treat an hourly chart as daily.
  const canonical = value.replaceAll('/', '-');
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(canonical)) throw fault('REVENUE_DATE_UNAVAILABLE');
  return day(canonical);
}
async function collectDouyinAnchorRevenue({ accountId, identityKind, request, fetchedAt = new Date().toISOString() } = {}) {
  binding('douyin', accountId); timestamp(fetchedAt);
  if (typeof request !== 'function') throw new TypeError('Revenue transport is required');
  const today = chinaDay(Math.floor(Date.parse(fetchedAt) / 1000)), records = [], metrics = [], nativeRecords = [], nativeMetrics = [], issues = [];
  let dataAsOf = null;
  const fatal = new Set(['ACCOUNT_CHANGED', 'PLATFORM_ACCOUNT_CHANGED', 'LOGIN_REQUIRED', 'VERIFICATION_REQUIRED', 'LOGIN_CANCELLED', 'REVENUE_DISPOSED', 'UNTRUSTED_PAGE', 'PAGE_CHANGED']);
  async function read(kind, range, parse) {
    try { return parse(component(await request(anchorRequest(kind, range)))); }
    catch (error) {
      if (fatal.has(error.code)) throw error;
      const known = ['REVENUE_NETWORK_ERROR', 'REVENUE_HTTP_ERROR', 'REVENUE_RESPONSE_TOO_LARGE', 'REVENUE_REQUEST_TIMEOUT', 'REVENUE_PLATFORM_REJECTED', 'REVENUE_DATA_NOT_READY', 'REVENUE_UNIT_UNAVAILABLE', 'REVENUE_DATE_UNAVAILABLE', 'REVENUE_DATE_OUTSIDE_RANGE', 'CONFLICTING_REVENUE_PERIOD'];
      issues.push({ code: known.includes(error.code) ? error.code : 'REVENUE_SCHEMA_CHANGED', source: 'douyin.anchor.' + kind,
        ...(range?.period ? { period: range.period } : {}) }); return null;
    }
  }
  function field(meta) {
    const values = meta.field.filter(item => item.key === 'earnScore');
    if (values.length !== 1 || typeof values[0].unit !== 'string' || !values[0].unit.trim()) throw fault('REVENUE_UNIT_UNAVAILABLE');
    return { name: label(values[0].title) || 'earnScore', unit: values[0].unit.trim() };
  }
  function observe(value, info, range, daily = false) {
    const raw = decimal(value), common = { scope: 'douyin.anchor', categoryId: 'earnScore', categoryName: info.name,
      start: range.startDate, end: range.endDate, period: daily ? 'day' : range.period,
      source: 'anchor_dashboard', complete: range.endDate < today, provisional: true, fetchedAt };
    if (['元', '人民币元', 'CNY'].includes(info.unit)) {
      const amountMinor = yuanToMinor(raw);
      return { kind: daily ? 'records' : 'metrics', value: daily ? record({ ...common, amountMinor }, fetchedAt) :
        metric({ ...common, metric: 'income', amountMinor, asOf: range.endDate }, fetchedAt) };
    }
    return { kind: daily ? 'nativeRecords' : 'nativeMetrics', value: daily ? nativeRecord({ ...common, value: raw, unit: info.unit }, fetchedAt) :
      nativeMetric({ ...common, metric: 'income', value: raw, unit: info.unit, asOf: range.endDate }, fetchedAt) };
  }
  const buckets = { records, metrics, nativeRecords, nativeMetrics };
  await read('status', {}, data => {
    if (data.data.series.length !== 1) throw fault('REVENUE_SCHEMA_CHANGED');
    const value = day(data.data.series[0].dataDate);
    if (value > today) throw fault('REVENUE_DATE_OUTSIDE_RANGE');
    dataAsOf = value;
  });
  const ranges = [{ period: 'today', startDate: today, endDate: today }];
  if (dataAsOf) ranges.push(
    { period: 'rolling_7_days', startDate: shiftDay(dataAsOf, -6), endDate: dataAsOf },
    { period: 'rolling_30_days', startDate: shiftDay(dataAsOf, -29), endDate: dataAsOf }
  );
  for (const range of ranges) await read('summary', range, data => {
    if (data.data.series.length !== 1) throw fault('REVENUE_SCHEMA_CHANGED');
    const info = field(metadata(data)), value = data.data.series[0].earnScore;
    const summary = observe(value, info, range); buckets[summary.kind].push(summary.value);
    // Today's running total can be retained, but never declares the day closed.
    if (range.period === 'today') { const daily = observe(value, info, range, true); buckets[daily.kind].push(daily.value); }
  });
  if (dataAsOf) await read('trend', ranges[2], data => {
    const meta = metadata(data), info = field(meta);
    const axis = Array.isArray(meta.categoryAxis) && meta.categoryAxis.length === 1 ? meta.categoryAxis[0] : null;
    if (typeof axis !== 'string') throw fault('REVENUE_DATE_UNAVAILABLE');
    token(axis); const rows = new Map();
    for (const item of data.data.series) {
      const date = axisDay(item[axis]);
      if (date < ranges[2].startDate || date > ranges[2].endDate) throw fault('REVENUE_DATE_OUTSIDE_RANGE');
      // A null chart point is a missing day, not a zero-earning day.
      if (item.earnScore === null || item.earnScore === undefined) continue;
      const value = observe(item.earnScore, info, { startDate: date, endDate: date }, true);
      const old = rows.get(date);
      if (old && JSON.stringify(old) !== JSON.stringify(value)) throw fault('CONFLICTING_REVENUE_PERIOD');
      rows.set(date, value);
    }
    // If the platform's completed-data date is today, keep the current-day
    // summary as the fresher running observation, with complete=false.
    for (const [date, row] of rows) if (date !== today) buckets[row.kind].push(row.value);
  });
  issues.push({ code: 'REVENUE_HISTORY_RECENT_DAYS_ONLY', source: 'douyin.anchor.trend' });
  if (nativeMetrics.length || nativeRecords.length) issues.push({ code: 'REVENUE_NATIVE_UNIT_NOT_CNY', source: 'douyin.anchor' });
  const hasData = records.length + metrics.length + nativeRecords.length + nativeMetrics.length > 0;
  return { schemaVersion: 1, platform: 'douyin', accountId, ...(identityKind ? { identityKind } : {}), fetchedAt,
    source: 'anchor_dashboard', currency: records.length || metrics.length ? 'CNY' : null, timeZone: 'Asia/Shanghai', dataAsOf,
    records, metrics, nativeRecords, nativeMetrics, issues, status: hasData ? 'partial' : 'unavailable',
    historyComplete: false, adapterValidation: 'synthetic_only' };
}
module.exports = { ANCHOR_PAGE, anchorRequest, collectDouyinAnchorRevenue };
