// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { fault, month, monthEnd, minor, timestamp, chinaDay, label, record } = require('./model.cjs');
const WALLET_SCOPE = 'douyin.wallet_cashflow';
const INCOME_SCOPE = 'douyin.wallet_income';
const kinds = new Set(['live', 'video_incentive', 'creator_unsplit', 'other', 'withdrawal', 'refund', 'transfer', 'unknown']);
function unsigned(value) {
  const result = minor(value); if (result.startsWith('-')) throw fault('INVALID_WALLET_AMOUNT'); return result;
}
function walletStatement(value) {
  if (!value || value.scope !== WALLET_SCOPE || value.paginationComplete !== true || value.reconciled !== true ||
    typeof value.calendarComplete !== 'boolean' || !Array.isArray(value.transactions) || value.transactions.length > 2000) throw fault('INVALID_WALLET_STATEMENT');
  const selected = month(value.month), fetchedAt = timestamp(value.fetchedAt);
  const now = Math.floor(Date.parse(fetchedAt) / 1000), current = chinaDay(now).slice(0, 7);
  if (selected > current || value.calendarComplete !== (selected < current)) throw fault('INVALID_WALLET_STATEMENT');
  const seen = new Set(); let incoming = 0n, outgoing = 0n;
  const transactions = value.transactions.map(item => {
    if (!item || !/^[a-f0-9]{64}$/.test(item.id) || seen.has(item.id) || !Number.isSafeInteger(item.time) || item.time > now ||
      !['in', 'out', 'neutral'].includes(item.direction) || !kinds.has(item.kind) || !/^\d{1,12}$/.test(item.type)) throw fault('INVALID_WALLET_TRANSACTION');
    seen.add(item.id);
    const date = chinaDay(item.time), amountMinor = unsigned(item.amountMinor);
    if (date.slice(0, 7) !== selected || item.direction === 'neutral' && amountMinor !== '0') throw fault('INVALID_WALLET_TRANSACTION');
    if (item.direction === 'in') incoming += BigInt(amountMinor);
    if (item.direction === 'out') outgoing += BigInt(amountMinor);
    return { id: item.id, time: item.time, date, type: item.type, direction: item.direction, amountMinor,
      kind: item.kind, categoryName: label(item.categoryName), classification: 'platform_label' };
  }).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  const reportedIncomeMinor = unsigned(value.reportedIncomeMinor), reportedOutcomeMinor = unsigned(value.reportedOutcomeMinor);
  if (String(incoming) !== reportedIncomeMinor || String(outgoing) !== reportedOutcomeMinor) throw fault('REVENUE_WALLET_RECONCILIATION_FAILED');
  return { scope: WALLET_SCOPE, month: selected, fetchedAt, timeBasis: 'posting_time', currency: 'CNY',
    paginationComplete: true, calendarComplete: value.calendarComplete, reconciled: true, reportedIncomeMinor, reportedOutcomeMinor, transactions };
}
function walletRecords(statement) {
  const unknown = statement.transactions.some(r => r.direction === 'in' && ['unknown', 'creator_unsplit'].includes(r.kind) && r.amountMinor !== '0');
  const add = (scope, categoryId, name, amount, covered) => record({ scope, categoryId, categoryName: name, period: 'month',
    start: statement.month + '-01', end: monthEnd(statement.month), amountMinor: amount,
    complete: covered && statement.calendarComplete, provisional: true, source: 'wallet' }, statement.fetchedAt);
  const result = [add(WALLET_SCOPE, 'total', '钱包入账合计（资金流水口径）', statement.reportedIncomeMinor, true)];
  for (const [kind, name] of [['live', '钱包直播入账'], ['video_incentive', '钱包视频激励入账']]) {
    const matching = statement.transactions.filter(r => r.direction === 'in' && r.kind === kind);
    if (matching.length) result.push(add(INCOME_SCOPE, kind, name, String(matching.reduce((sum, r) => sum + BigInt(r.amountMinor), 0n)), !unknown));
  }
  return result;
}
module.exports = { WALLET_SCOPE, INCOME_SCOPE, walletStatement, walletRecords, unsigned };
