// Independently authored synthetic facts; no platform response or credential.
'use strict';
const { chinaDay } = require('../revenue/model.cjs');
const KS_USER_ID = '123456789';
const WX_FINDER = 'synthetic-own-finder';
const WX_AUTH_CODE = 'synthetic-handoff-not-a-real-credential';
function syntheticExtraRevenueResponse(platform, descriptor) {
  const path = new URL(descriptor.url).pathname;
  if (platform === 'kuaishou') {
    if (path.endsWith('/account/current')) return { result: 1, data: { logined: true, userId: KS_USER_ID } };
    if (path.endsWith('/member/bill')) return { result: 1, data: { totalCount: 1, list: [
      { userId: KS_USER_ID, settlementTime: descriptor.body.settlementTime, allAccount: '12.34', govName: 'Synthetic institution' }
    ] } };
    if (path.endsWith('/pc/trending')) {
      const trending = [];
      for (let ms = descriptor.body.startTime; ms <= descriptor.body.endTime; ms += 86400000)
        trending.push({ dateTime: chinaDay(Math.floor(ms / 1000)), receiveAmount: trending.length === 0 ? '0.00' : '1.01' });
      return { result: 1, data: { trending } };
    }
  }
  if (platform === 'wechat_channels') {
    if (path.endsWith('/auth_data')) return { errCode: 0, data: { finderUser: { finderUsername: WX_FINDER } } };
    if (path.endsWith('/get-my-finder-income-detail')) return { errCode: 0, data: { incomeDetails: [
      { permission: true, card: { title: 'Synthetic video incentive', wording: 'View on your phone' } }
    ] } };
    if (path.endsWith('/getRelatedMainPart')) return { errCode: 0, data: { cocertInfo: {
      wecoinAuthCode: WX_AUTH_CODE, settleType: 2, extInfo: { maskPhone: 'synthetic-masked-phone' },
      incomeItems: [{ wecoinBusinessId: 1, unaccountedIncome: '99999999' }]
    }, studioInfos: [] } };
  }
  throw new Error('Unexpected synthetic revenue request');
}
function syntheticWalletResponse(selected = '2026-09') {
  return { data: { settleList: [
    { showTime: selected.replace('-', '/'), businessId: 1, totalIncome: '1234500', status: 100 },
    { showTime: selected.replace('-', '/'), businessId: 7, totalIncome: '0', status: 2 }
  ] } };
}
module.exports = { KS_USER_ID, WX_FINDER, WX_AUTH_CODE, syntheticExtraRevenueResponse, syntheticWalletResponse };
