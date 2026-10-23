'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { identifyProfile, exactCount, PROFILE_PLATFORMS } = require('../profiles/model')
const { createFollowerClient, xiaohongshuCount } = require('../profiles/client')
const { requestProfile } = require('../profiles/transport')
const { resolveProfile, requestBilibiliRedirect } = require('../profiles/resolver')
const time = '2026-10-23T08:00:00.000Z'
const xhs = '0123456789abcdef01234567'
const urls = {
  bilibili: 'https://space.bilibili.com/123', douyin: 'https://www.douyin.com/user/MS4wLjABsynthetic',
  kuaishou: 'https://www.kuaishou.com/profile/synthetic', wechat_channels: 'https://channels.weixin.qq.com/',
  xiaohongshu: 'https://www.xiaohongshu.com/user/profile/' + xhs
}
const html = (count, id = xhs) => '<script>window.__INITIAL_STATE__=' + JSON.stringify({ user: { userId: id,
  userPageData: { basicInfo: { nickname: 'synthetic only' }, interactions: [{ type: 'fans', count }] } } }) + '</script>'
function auth(profile) { return { ...profile, accessToken: 'synthetic-token', openId: 'synthetic-open-id', appId: 'synthetic-app', expiresAt: '2026-10-24T00:00:00.000Z' } }

test('five profile platforms accept canonical homepages, keep IDs as strings and reject unsafe/ambiguous links', () => {
  assert.equal(PROFILE_PLATFORMS.length, 5)
  for (const platform of PROFILE_PLATFORMS) assert.equal(identifyProfile({ platform, profileUrl: urls[platform] }).platform, platform)
  assert.equal(identifyProfile('https://space.bilibili.com/9007199254740993?tracking=x#y').accountId, '9007199254740993')
  assert.equal(identifyProfile({ platform: 'wechat', profileUrl: urls.wechat_channels }).platform, 'wechat_channels')
  for (const url of ['http://space.bilibili.com/123', 'https://space.bilibili.com.evil.invalid/123', 'https://space.bilibili.com@127.0.0.1/123',
    'https://127.0.0.1/', 'https://space.bilibili.com:444/123', 'https://space.bilibili.com/123/../../settings',
    'https://www.xiaohongshu.com/explore/' + xhs, 'https://www.douyin.com/video/123', 'https://space.bilibili.com/%31%32%33',
    'https://space.bilibili.com\\@evil.invalid/123']) assert.throws(() => identifyProfile(url))
  assert.throws(() => identifyProfile('https://b23.tv/synthetic'), { code: 'FULL_PROFILE_URL_REQUIRED' })
  assert.throws(() => identifyProfile({ platform: 'douyin', profileUrl: urls.bilibili }), { code: 'PLATFORM_MISMATCH' })
})
test('only exact, bounded counts are accepted; missing is never zero', () => {
  assert.equal(exactCount(0), 0); assert.equal(exactCount('0'), 0); assert.equal(exactCount('123'), 123)
  for (const value of [undefined, null, '', false, true, {}, [], '1.2万', '123+', '1,234', -1, 1.1, Infinity, 10000000001]) assert.throws(() => exactCount(value))
})
test('Bilibili mobile and short links normalize without following arbitrary redirects', async () => {
  assert.equal(identifyProfile('https://m.bilibili.com/space/123?share=x').profileUrl, urls.bilibili)
  let calls = 0
  const redirect = async url => { calls++; assert.equal(url, 'https://b23.tv/abc123'); return 'https://m.bilibili.com/space/123?tracking=discard' }
  const result = await resolveProfile('https://b23.tv/abc123', redirect)
  assert.equal(result.profileUrl, urls.bilibili); assert.equal(calls, 1)
  for (const target of ['http://space.bilibili.com/123', 'https://127.0.0.1/', 'https://space.bilibili.com.evil.invalid/123',
    'https://space.bilibili.com@127.0.0.1/123', 'https://b23.tv/again', 'https://www.bilibili.com/video/BV123',
    'https://m.bilibili.com/space/123/../settings', 'https://m.bilibili.com:444/space/123']) {
    await assert.rejects(resolveProfile('https://b23.tv/abc123', async () => target), { code: 'UNSUPPORTED_PROFILE_URL' })
  }
  await assert.rejects(resolveProfile({ platform: 'douyin', profileUrl: 'https://b23.tv/abc123' }, redirect), { code: 'PLATFORM_MISMATCH' })
  for (const url of ['https://127.0.0.1/', 'https://b23.tv/a?redirect=evil', 'https://b23.tv:443/a']) await assert.rejects(requestBilibiliRedirect(url))
  assert.equal(calls, 1)
})
test('short-link lookup fetches the resolved account once and does no I/O when disabled', async () => {
  let calls = 0
  const options = { requestRedirect: async () => { calls++; return 'https://m.bilibili.com/space/123' },
    request: async () => ({ code: 0, data: { mid: 123, follower: 9 } }) }
  await assert.rejects(createFollowerClient(options).lookup('https://b23.tv/abc123'), { code: 'FULL_PROFILE_URL_REQUIRED' })
  assert.equal(calls, 0)
  const result = await createFollowerClient({ ...options, allowPublicBilibili: true }).lookup('https://b23.tv/abc123')
  assert.equal(result.profileUrl, urls.bilibili); assert.equal(result.followerCount, 9); assert.equal(calls, 1)
})
test('Bilibili fetch uses a fixed endpoint, validates returned identity and projects only the count', async () => {
  const calls = []
  const client = createFollowerClient({ allowPublicBilibili: true, now: () => time, request: async input => {
    calls.push(input); return { code: 0, data: { mid: 123, follower: 0, internal: 'not exported' } }
  } })
  const result = await client.lookup(urls.bilibili)
  assert.equal(result.status, 'ok'); assert.equal(result.followerCount, 0); assert.equal(result.source, 'public_api')
  assert.equal(calls[0].url, 'https://api.bilibili.com/x/relation/stat?vmid=123')
  assert.equal(JSON.stringify(result).includes('internal'), false)
  assert.equal((await client.lookup(urls.bilibili)).cached, true); assert.equal(calls.length, 1)
  const wrong = createFollowerClient({ allowPublicBilibili: true, request: async () => ({ code: 0, data: { mid: 456, follower: 123 } }) })
  assert.equal((await wrong.lookup(urls.bilibili)).status, 'unavailable')
})
test('official adapters require host-resolved, unexpired authorization bound to the account', async () => {
  let requests = 0
  for (const platform of ['douyin', 'kuaishou']) {
    const client = createFollowerClient({ now: () => time, request: async () => { requests++ } })
    assert.equal((await client.lookup({ profileUrl: urls[platform], accessToken: 'client-forged' })).status, 'authorization_required')
    const wrong = createFollowerClient({ now: () => time, resolveAuthorization: profile => ({ ...auth(profile), accountId: 'wrong' }), request: async () => { requests++ } })
    assert.equal((await wrong.lookup(urls[platform])).status, 'authorization_required')
    const expired = createFollowerClient({ now: () => time, resolveAuthorization: profile => ({ ...auth(profile), expiresAt: time }), request: async () => { requests++ } })
    assert.equal((await expired.lookup(urls[platform])).status, 'authorization_required')
  }
  assert.equal(requests, 0)
})
test('Douyin chooses latest dated total, preserving daily data date instead of claiming realtime', async () => {
  const client = createFollowerClient({ now: () => time, resolveAuthorization: auth, request: async input => {
    assert.equal(input.headers['access-token'], 'synthetic-token')
    assert.equal(new URL(input.url).searchParams.get('open_id'), 'synthetic-open-id')
    return { data: { error_code: 0, result_list: [{ date: '2026-10-22', total_fans: '20' }, { date: '2026-10-21', total_fans: '19' }] }, extra: { error_code: 0 } }
  } })
  const result = await client.lookup(urls.douyin)
  assert.equal(result.status, 'ok'); assert.equal(result.followerCount, 20)
  assert.equal(result.dataAsOf, '2026-10-21T16:00:00.000Z'); assert.equal(result.fetchedAt, time)
  assert.equal(JSON.stringify(result).includes('synthetic-token'), false)
})
test('Kuaishou reads fan and authorization is rechecked even for cached counts', async () => {
  let authorized = true, calls = 0
  const client = createFollowerClient({ now: () => time, resolveAuthorization: profile => authorized ? auth(profile) : null, request: async () => {
    calls++; return { result: 1, user_info: { fan: 34, name: 'private nickname' } }
  } })
  const result = await client.lookup(urls.kuaishou)
  assert.equal(result.followerCount, 34); assert.equal(result.source, 'official_api')
  authorized = false
  assert.equal((await client.lookup(urls.kuaishou)).status, 'authorization_required'); assert.equal(calls, 1)
})
test('Xiaohongshu reads exact public-page stats only for the requested account, without executing scripts', async () => {
  assert.equal(xiaohongshuCount(html(56), xhs), 56)
  assert.equal(xiaohongshuCount(html(0).replace('"nickname":"synthetic only"', '"nickname":"undefined } \\\"","unused":undefined'), xhs), 0)
  for (const body of [html('1.2万'), html(56, 'abcdef0123456789abcdef01'), '<html>请登录</html>',
    '<script>window.__INITIAL_STATE__={"user":process.exit(1)}</script>']) assert.throws(() => xiaohongshuCount(body, xhs))
  const client = createFollowerClient({ allowPublicXiaohongshu: true, request: async input => {
    assert.equal(input.url, urls.xiaohongshu); assert.equal(input.format, 'html'); assert.equal(input.headers, undefined)
    return html(56)
  } })
  assert.equal((await client.lookup(urls.xiaohongshu)).followerCount, 56)
})
test('Channels stays manual; public collection is opt-in and no credentials or errors leak', async () => {
  let calls = 0
  const client = createFollowerClient({ request: async () => { calls++; throw new Error('secret-token') } })
  assert.equal((await client.lookup(urls.wechat_channels)).status, 'manual_required')
  assert.equal((await client.lookup(urls.bilibili)).status, 'not_configured')
  assert.equal((await client.lookup(urls.xiaohongshu)).status, 'not_configured'); assert.equal(calls, 0)
  const failed = createFollowerClient({ allowPublicBilibili: true, request: async () => { throw new Error('secret-token') } })
  const result = await failed.lookup(urls.bilibili)
  assert.equal(result.followerCount, null); assert.equal(result.status, 'unavailable'); assert.equal(JSON.stringify(result).includes('secret-token'), false)
})
test('concurrent same-account requests share I/O; unrelated calls are bounded and failures cool down', async () => {
  let release, calls = 0
  const client = createFollowerClient({ allowPublicBilibili: true, now: () => time, request: async () => {
    calls++; return new Promise(resolve => { release = resolve })
  } })
  const first = client.lookup(urls.bilibili), second = client.lookup(urls.bilibili)
  assert.equal((await client.lookup('https://space.bilibili.com/456')).status, 'rate_limited')
  release({ code: 0, data: { mid: 123, follower: 12 } })
  assert.deepEqual(await first, await second); assert.equal(calls, 1)
})
test('network transport rejects arbitrary destinations and never follows upstream redirects', async t => {
  for (const url of ['http://api.bilibili.com/x/relation/stat', 'https://127.0.0.1/', 'https://api.bilibili.com/other',
    'https://api.bilibili.com@evil.invalid/x/relation/stat', 'https://open.kuaishou.com:444/openapi/user_info']) {
    await assert.rejects(requestProfile({ url }), { code: 'INVALID_ENDPOINT' })
  }
  const https = require('node:https'), { EventEmitter } = require('node:events')
  let calls = 0
  t.mock.method(https, 'get', (url, options, callback) => {
    calls++
    const req = new EventEmitter(); req.destroy = () => {}
    process.nextTick(() => {
      const res = new EventEmitter(); res.statusCode = 302; res.headers = { location: 'http://127.0.0.1/private' }; res.destroy = () => {}
      callback(res)
    })
    return req
  })
  await assert.rejects(requestProfile({ url: 'https://api.bilibili.com/x/relation/stat?vmid=123' }), { code: 'UPSTREAM_UNAVAILABLE' })
  assert.equal(calls, 1)
})
