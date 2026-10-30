// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
// Entirely invented data. Field names/cent units follow the public mobile bill UI;
// transaction-type IDs and example category labels are not a verified platform enum.
const ACCOUNT_ID = 'c'.repeat(64), FETCHED_AT = '2026-10-30T04:00:00.000Z';
function syntheticDouyinWalletResponse(descriptor, { earliest = '2026-06', pageSize = 2, empty = false, missing = false } = {}) {
  const url = new URL(descriptor.url), selected = url.searchParams.get('start_time'), page = Number(url.searchParams.get('page'));
  if (url.pathname !== '/webcast/wallet_api/get_billing_list/' || !/^20\d{4}$/.test(selected) || page < 1) throw new Error('Unexpected synthetic wallet request');
  const month = selected.slice(0, 4) + '-' + selected.slice(4);
  const rows = [
    { type: 1, money: '1200', sign: 1, title: '直播收入' },
    { type: 2, money: '345', sign: 1, title: '视频激励收益' },
    { type: 3, money: '500', sign: 0, title: '提现', withdraw_status: 1 },
    { type: 4, money: '100', sign: 1, title: '退款', refund_status: 1 }
  ].map((row, i) => ({ ...row, order_id: 'synthetic-order-' + selected + '-' + i, account_type: 1, source_app: 'synthetic',
    txn_time: Math.floor(Date.parse(month + '-01T00:00:00+08:00') / 1000) + 3600 - i,
    balance: '999999999', description: 'synthetic-private-description', event_title: row.title }));
  const slice = empty ? [] : rows.slice((page - 1) * pageSize, page * pageSize);
  return { status_code: 0, data: { end_time: earliest.replace('-', ''), has_more: !empty && page * pageSize < rows.length,
    billing_types: { 1: '直播收入', 2: '视频激励收益', 3: '提现', 4: '退款' },
    bill_list: missing ? [] : [{ period: selected, income: empty ? '0' : '1645', outcome: empty ? '0' : '500', bills: slice }] } };
}
module.exports = { ACCOUNT_ID, FETCHED_AT, syntheticDouyinWalletResponse };
