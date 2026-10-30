// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
// Invented wire responses only. These are not captures or evidence that a real
// account has access to any category, including the synthetic live category.
const FETCHED_AT = '2026-10-30T04:00:00.000Z';
const ACCOUNT_ID = 'a'.repeat(64);
function syntheticRevenueResponse(platform, descriptor) {
  const url = new URL(descriptor.url), path = url.pathname;
  const seconds = Math.floor(Date.parse('2026-09-01T00:00:00+08:00') / 1000);
  if (platform === 'bilibili') {
    if (path.endsWith('/nav')) return { code: 0, data: { isLogin: true, mid: 123, uname: 'Synthetic creator' } };
    if (path.endsWith('/show_conf')) return { code: 0, data: { incomes: [{ enum: 1, title: '合成创作激励' }, { enum: 6, title: '合成直播' }] } };
    if (path.endsWith('/index/income')) return { code: 0, data: { date: { datex: seconds }, summary: { state: 99, daily_amt: 0, thirty_days_amt: 2100, annual_amt: 10000 }, detail: [{ enum: 1, state: 99, daily_amt: 0, thirty_days_amt: 1000, annual_amt: 5000 }] } };
    if (path.endsWith('/trend')) return { code: 0, data: { data: [{ date: seconds, amt: 0 }, { date: seconds + 86400, amt: 2100 }] } };
    if (path.endsWith('/judge')) return { code: 0, data: { is_normal_show: true,
      income_market: { current_month: url.searchParams.get('current_month'), current_month_income: 2100 },
      income_structure: { current_month_detail: [{ enum: 1, amt: 1000, state: 99 }, { enum: 6, amt: 1100, state: 99 }] } } };
  } else if (platform === 'douyin') {
    if (path.endsWith('/auth/')) return { status_code: 0, optional_category_list: [
      { category_id: 'creator_share', name: '合成创作激励', status: 0 },
      { category_id: 'synthetic_live', name: '合成直播', status: 0 }
    ] };
    if (path.endsWith('/summary/')) return { status_code: 0,
      day1_income_summary: { history_total_income: '0', data_update_status: 2 },
      day30_income_summary: { history_total_income: '1000', data_update_status: 2 },
      total_income_summary: { history_total_income: '9007199254740993', data_update_status: 2 }, total_balance: 999999 };
    if (path.endsWith('/detail/')) return { status_code: 0, income_item_list: [
      { timestamp: seconds, amount: '0', name: '合成收益' }, { timestamp: seconds + 86400, amount: '1000', name: '合成收益' }
    ] };
  }
  throw new Error('Unexpected synthetic endpoint');
}
function syntheticAnchorResponse(descriptor, { asOf = '2026-10-29', unit = '音浪' } = {}) {
  const url = new URL(descriptor.url), start = url.searchParams.get('startDate'), end = url.searchParams.get('endDate');
  let series;
  if (url.pathname.endsWith('/detail')) series = [{ dataDate: asOf }];
  else {
    const days = [];
    for (let t = Date.parse(start + 'T00:00:00Z'); t <= Date.parse(end + 'T00:00:00Z'); t += 86400000) {
      const date = new Date(t).toISOString().slice(0, 10); days.push({ date, earnScore: date.endsWith('-01') ? '0' : '1.25' });
    }
    if (url.pathname.endsWith('/base_data')) series = [{ earnScore: start === end ? '0.5' : String(days.reduce((sum, row) => sum + Number(row.earnScore), 0)) }];
    else if (url.pathname.endsWith('/time_trend')) series = days;
    else throw new Error('Unexpected synthetic anchor endpoint');
  }
  return { status_code: 0, data: { data: JSON.stringify({ code: 0, data: { series },
    meta: JSON.stringify({ field: [{ key: 'earnScore', title: '合成直播收益', unit }], categoryAxis: ['date'] }) }) } };
}
module.exports = { syntheticRevenueResponse, syntheticAnchorResponse, FETCHED_AT, ACCOUNT_ID };
