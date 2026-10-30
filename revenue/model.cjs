// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';

const REVENUE_PLATFORMS = Object.freeze(['bilibili', 'douyin', 'kuaishou', 'wechat_channels']);
const fault = code => Object.assign(new Error(code), { code });
function minor(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw fault('INVALID_REVENUE_AMOUNT');
  if (!['string', 'number'].includes(typeof value) || !/^-?(?:0|[1-9]\d{0,17})$/.test(String(value))) throw fault('INVALID_REVENUE_AMOUNT');
  return String(BigInt(value));
}
function yuanToMinor(value) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(value)) throw fault('INVALID_REVENUE_AMOUNT');
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return minor(String((BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * (negative ? -1n : 1n)));
}
function day(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) throw fault('INVALID_REVENUE_DATE');
  const time = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw fault('INVALID_REVENUE_DATE');
  return value;
}
function month(value) {
  if (typeof value !== 'string' || !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(value)) throw fault('INVALID_REVENUE_MONTH');
  return value;
}
function chinaDay(seconds) {
  const n = typeof seconds === 'string' && /^\d{1,11}$/.test(seconds) ? Number(seconds) : seconds;
  if (!Number.isSafeInteger(n)) throw fault('INVALID_REVENUE_DATE');
  const time = new Date(n * 1000 + 8 * 3600000);
  if (!Number.isFinite(time.getTime())) throw fault('INVALID_REVENUE_DATE');
  return day(time.toISOString().slice(0, 10));
}
function shiftMonth(value, offset) {
  month(value);
  const date = new Date(value + '-01T00:00:00Z'); date.setUTCMonth(date.getUTCMonth() + offset);
  return month(date.toISOString().slice(0, 7));
}
function monthEnd(value) {
  month(value);
  const date = new Date(value + '-01T00:00:00Z'); date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}
function monthRange(from, to) {
  month(from); month(to);
  if (from > to) throw fault('INVALID_REVENUE_RANGE');
  const result = []; let current = from;
  while (current <= to) {
    if (result.length >= 1200) throw fault('INVALID_REVENUE_RANGE');
    result.push(current); if (current === to) break; current = shiftMonth(current, 1);
  }
  return result;
}
function token(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(value)) throw fault('INVALID_REVENUE_KEY');
  return value;
}
function label(value) { return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) : ''; }
function timestamp(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw fault('INVALID_REVENUE_TIMESTAMP');
  return value;
}
function binding(platform, accountId) {
  if (!REVENUE_PLATFORMS.includes(platform)) throw fault('REVENUE_UNSUPPORTED_PLATFORM');
  if (typeof accountId !== 'string' || !/^[a-f0-9]{64}$/.test(accountId)) throw fault('INVALID_REVENUE_ACCOUNT');
}
function record(row, fetchedAt) {
  if (!row || !['day', 'month'].includes(row.period) || !['creator_center', 'anchor_dashboard', 'live_settlement', 'wallet', 'statement_import'].includes(row.source) || typeof row.complete !== 'boolean') throw fault('INVALID_REVENUE_RECORD');
  if (row.currency !== undefined && row.currency !== 'CNY') throw fault('INVALID_REVENUE_CURRENCY');
  const start = day(row.start), end = day(row.end);
  if ((row.period === 'day' && start !== end) || (row.period === 'month' && (start.slice(8) !== '01' || end !== monthEnd(start.slice(0, 7))))) throw fault('INVALID_REVENUE_RECORD');
  return { scope: token(row.scope), categoryId: token(row.categoryId), categoryName: label(row.categoryName),
    period: row.period, start, end, amountMinor: minor(row.amountMinor), currency: 'CNY', complete: row.complete,
    provisional: row.provisional !== false, source: row.source, fetchedAt: timestamp(row.fetchedAt || fetchedAt) };
}
const recordKey = row => JSON.stringify([row.scope, row.categoryId, row.period, row.start]);
function metric(row, fetchedAt) {
  if (!row || row.metric !== 'income' || !['today', 'previous_day', 'rolling_7_days', 'rolling_30_days', 'rolling_year', 'lifetime'].includes(row.period)) throw fault('INVALID_REVENUE_METRIC');
  if (row.currency !== undefined && row.currency !== 'CNY') throw fault('INVALID_REVENUE_CURRENCY');
  if ((row.start === undefined) !== (row.end === undefined) || (row.start !== undefined && day(row.start) > day(row.end))) throw fault('INVALID_REVENUE_DATE');
  return { scope: token(row.scope), categoryId: token(row.categoryId), metric: 'income', period: row.period,
    amountMinor: minor(row.amountMinor), currency: 'CNY', provisional: row.provisional !== false,
    ...(row.asOf ? { asOf: day(row.asOf) } : {}),
    ...(row.start !== undefined ? { start: day(row.start), end: day(row.end) } : {}),
    ...(['updated', 'updating'].includes(row.updateStatus) ? { updateStatus: row.updateStatus } : {}), fetchedAt: timestamp(row.fetchedAt || fetchedAt) };
}
const metricKey = row => JSON.stringify([row.scope, row.categoryId, row.metric, row.period]);
function decimal(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw fault('INVALID_REVENUE_AMOUNT');
  if (!['string', 'number'].includes(typeof value) || !/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(String(value))) throw fault('INVALID_REVENUE_AMOUNT');
  const text = String(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return /^-0(?:\.0*)?$/.test(text) ? '0' : text;
}
function sumDecimal(values) {
  const total = values.reduce((sum, raw) => {
    const value = decimal(raw), [integer, fraction = ''] = value.replace(/^-/, '').split('.');
    return sum + (BigInt(integer) * 1000000n + BigInt(fraction.padEnd(6, '0'))) * (value.startsWith('-') ? -1n : 1n);
  }, 0n);
  const absolute = (total < 0n ? -total : total).toString().padStart(7, '0');
  return decimal((total < 0n ? '-' : '') + absolute.slice(0, -6) + '.' + absolute.slice(-6));
}
function nativeUnit(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N} ._%/-]{1,24}$/u.test(value) || !value.trim()) throw fault('REVENUE_UNIT_UNAVAILABLE');
  return value.trim();
}
function nativeRecord(row, fetchedAt) {
  if (!row || (row.currency !== undefined && row.currency !== null)) throw fault('INVALID_REVENUE_CURRENCY');
  const { amountMinor: ignoredAmount, currency: ignoredCurrency, ...common } = record({ ...row, amountMinor: '0', currency: 'CNY' }, fetchedAt);
  return { ...common, value: decimal(row.value), unit: nativeUnit(row.unit), currency: null };
}
function nativeMetric(row, fetchedAt) {
  if (!row || (row.currency !== undefined && row.currency !== null)) throw fault('INVALID_REVENUE_CURRENCY');
  const { amountMinor: ignoredAmount, currency: ignoredCurrency, ...common } = metric({ ...row, amountMinor: '0', currency: 'CNY' }, fetchedAt);
  return { ...common, categoryName: label(row.categoryName), value: decimal(row.value), unit: nativeUnit(row.unit), currency: null };
}
const nativeRecordKey = row => JSON.stringify([recordKey(row), row.unit]);
const nativeMetricKey = row => JSON.stringify([metricKey(row), row.unit]);
module.exports = { REVENUE_PLATFORMS, fault, minor, yuanToMinor, day, month, chinaDay, shiftMonth, monthEnd, monthRange, token, label, timestamp, binding, record, recordKey, metric, metricKey,
  decimal, sumDecimal, nativeUnit, nativeRecord, nativeMetric, nativeRecordKey, nativeMetricKey };
