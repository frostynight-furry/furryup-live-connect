// Offline synthetic demo. Does not connect to any platform or read credentials.
'use strict';
const { createFollowerClient } = require('../profiles/index.cjs');
const client = createFollowerClient({
  allowPublicBilibili: true, allowPublicXiaohongshu: true,
  now: () => '2026-10-23T08:00:00.000Z',
  request: async ({ url }) => url.includes('api.bilibili.com')
    ? { code: 0, data: { mid: 123, follower: 12 } }
    : '<script>window.__INITIAL_STATE__={"user":{"userId":"0123456789abcdef01234567","userPageData":{"interactions":[{"type":"fans","count":34}]}}}</script>'
});
(async () => {
  for (const profileUrl of [
    'https://space.bilibili.com/123', 'https://www.douyin.com/user/MS4wLjABsynthetic',
    'https://www.kuaishou.com/profile/synthetic', 'https://channels.weixin.qq.com/',
    'https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567'
  ]) {
    const result = await client.lookup(profileUrl);
    console.log(JSON.stringify({ synthetic: true, platform: result.platform, status: result.status, followerCount: result.followerCount }));
  }
})().catch(() => { console.error('Synthetic profile demo failed'); process.exitCode = 1; });
