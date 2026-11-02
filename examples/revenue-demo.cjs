'use strict';
const { collectCreatorRevenue } = require('../revenue/adapters.cjs');
const { collectDouyinAnchorRevenue } = require('../revenue/douyin-anchor.cjs');
const { createRevenueLedger } = require('../revenue/index.cjs');
const { syntheticRevenueResponse, syntheticAnchorResponse, FETCHED_AT, ACCOUNT_ID } = require('../testing/revenue-fixtures.cjs');
const { KS_USER_ID, syntheticExtraRevenueResponse, syntheticWalletResponse } = require('../testing/revenue-extra-fixtures.cjs');
(async () => {
  for (const platform of ['bilibili', 'douyin', 'kuaishou', 'wechat_channels']) {
    const snapshot = await collectCreatorRevenue({ platform, accountId: ACCOUNT_ID, fetchedAt: FETCHED_AT,
      fromMonth: '2026-09', toMonth: '2026-09', ownUserId: KS_USER_ID, readWallet: async () => syntheticWalletResponse(),
      request: async descriptor => ['kuaishou', 'wechat_channels'].includes(platform) ? syntheticExtraRevenueResponse(platform, descriptor) : syntheticRevenueResponse(platform, descriptor) });
    const ledger = createRevenueLedger({ platform, accountId: ACCOUNT_ID }); ledger.ingest(snapshot);
    if (platform === 'douyin') ledger.ingest(await collectDouyinAnchorRevenue({ accountId: ACCOUNT_ID, fetchedAt: FETCHED_AT, request: async descriptor => syntheticAnchorResponse(descriptor) }));
    console.log(JSON.stringify({ synthetic: true, platform, issues: snapshot.issues,
      series: ledger.series().map(item => ({ ...item, months: ledger.months({ ...item, fromMonth: '2026-08', toMonth: '2026-10' }) })),
      nativeMetrics: ledger.nativeMetrics(), nativeMonths: platform === 'douyin' ? ledger.nativeMonths({ scope: 'douyin.anchor', unit: '音浪', fromMonth: '2026-09', toMonth: '2026-10' }) : [] }, null, 2));
  }
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
