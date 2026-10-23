'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http')
const { createBrowserServiceReader, serviceConfig, requestBrowserService } = require('../profiles/service-client')
const { createConfiguredFollowerClient } = require('../profiles/provider')
const { createWorker } = require('../browser-service/server')
const { createBrowserReader, allowRequest } = require('../browser-service/reader')
const { publicIPv4, resolveTarget } = require('../browser-service/egress')
const { identifyProfile, ProfileError } = require('../profiles/model')
const profile = identifyProfile('https://www.douyin.com/user/MS4wLjABsynthetic')
const token = 'synthetic_test_token_'.repeat(3), endpoint = 'https://browser.example.com/v1/douyin/followers'
const observedAt = '2026-10-23T08:00:00.000Z', time = Date.parse(observedAt)
const observation = { ...profile, followerCount: 8650, observedAt }

async function serve(t, readProfile, options = {}) {
  const server = createWorker({ token, readProfile, now: () => time, ...options })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const call = (body = { profileUrl: profile.profileUrl }, auth = token, path = '/v1/douyin/followers') => fetch('http://127.0.0.1:' + server.address().port + path, {
    method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' }, body: JSON.stringify(body)
  })
  return { call }
}
test('worker requires host authentication and canonical Douyin profile; never accepts arbitrary URLs or options', async t => {
  let calls = 0
  const { call } = await serve(t, async () => { calls++; return observation })
  assert.equal((await call(undefined, 'wrong')).status, 401)
  for (const body of [{ profileUrl: 'http://127.0.0.1' }, { profileUrl: 'https://v.douyin.com/synthetic/' },
    { profileUrl: profile.profileUrl + '?tracking=x' }, { profileUrl: profile.profileUrl, cookies: [] }, { profileUrl: 'https://space.bilibili.com/123' }]) {
    assert.equal((await call(body)).status, 400)
  }
  assert.equal(calls, 0)
  assert.equal((await call(undefined, token, '/arbitrary')).status, 404)
  assert.equal((await call()).status, 200); assert.equal(calls, 1)
})
test('worker coalesces concurrent reads, caches original observation time, limits other accounts and returns explicit DTOs', async t => {
  let done, calls = 0, started
  const start = new Promise(resolve => { started = resolve })
  const { call } = await serve(t, () => { calls++; started(); return new Promise(resolve => { done = resolve }) })
  const first = call(); await start
  const second = call()
  assert.equal((await call({ profileUrl: profile.profileUrl + 'other' })).status, 429)
  done({ ...observation, html: 'private', cookies: 'private' })
  const a = await (await first).json(), b = await (await second).json(), cached = await (await call()).json()
  assert.deepEqual(a, { ok: true, data: observation }); assert.deepEqual(a, b); assert.deepEqual(a, cached); assert.equal(calls, 1)
})
test('worker caches CAPTCHA failures without fake numbers and sanitizes raw errors', async t => {
  let calls = 0
  const { call } = await serve(t, () => { calls++; throw new ProfileError('BROWSER_INTERACTION_REQUIRED') })
  assert.deepEqual(await (await call()).json(), { ok: false, errorCode: 'BROWSER_INTERACTION_REQUIRED' })
  await call(); assert.equal(calls, 1)
  const other = await serve(t, () => { throw new Error('secret URL, cookie, stack') })
  assert.deepEqual(await (await other.call()).json(), { ok: false, errorCode: 'UPSTREAM_UNAVAILABLE' })
})
test('cloud adapter sends only profile URL and preserves cached observation time through follower client', async t => {
  const { call } = await serve(t, () => observation)
  const client = createConfiguredFollowerClient({ FUP_FOLLOWER_SYNC: 'enabled', FUP_FOLLOWER_DOUYIN_BROWSER: 'enabled',
    FUP_BROWSER_SERVICE_URL: endpoint, FUP_BROWSER_SERVICE_TOKEN: token }, {
    now: () => time + 10000,
    request: async request => {
      assert.equal(request.url, endpoint); assert.equal(request.token, token)
      assert.deepEqual(JSON.parse(request.body), { profileUrl: profile.profileUrl })
      return (await call(JSON.parse(request.body), request.token)).json()
    }
  })
  // Use current real clock for the top-level client, but test adapter separately at the fixed fixture time.
  const reader = createBrowserServiceReader({ endpoint, token, now: () => time + 10000, request: async request => {
    assert.deepEqual(JSON.parse(request.body), { profileUrl: profile.profileUrl })
    return (await call(JSON.parse(request.body), request.token)).json()
  } })
  assert.deepEqual(await reader(profile, { userId: 'private', tenantId: 'private' }), observation)
  assert.equal(client.capabilities().find(item => item.platform === 'douyin').mode, 'browser_experimental')
  const fresh = createConfiguredFollowerClient({ FUP_FOLLOWER_SYNC: 'enabled', FUP_FOLLOWER_DOUYIN_BROWSER: 'enabled',
    FUP_BROWSER_SERVICE_URL: endpoint, FUP_BROWSER_SERVICE_TOKEN: token }, { request: async () => ({ ok: true, data: { ...observation, observedAt: new Date(Date.now() - 1000).toISOString() } }) })
  const result = await fresh.lookup(profile)
  assert.equal(result.status, 'ok'); assert.equal(result.source, 'public_page'); assert.equal(result.followerCount, 8650)
  assert.equal(result.fetchedAt, result.dataAsOf)
})
test('bad cloud config fails closed, without breaking other functions or suggesting mandatory OAuth', async () => {
  assert.equal(createConfiguredFollowerClient({}), null)
  const client = createConfiguredFollowerClient({ FUP_FOLLOWER_SYNC: 'enabled', FUP_FOLLOWER_DOUYIN_BROWSER: 'enabled' })
  assert.equal((await client.lookup(profile)).status, 'not_configured')
  for (const url of ['http://browser.example.com/v1/douyin/followers', endpoint + '?x=y', endpoint + '#x', 'https://x:y@browser.example.com/v1/douyin/followers', 'https://127.0.0.1/v1/douyin/followers']) {
    assert.throws(() => serviceConfig(url, token))
  }
  assert.throws(() => serviceConfig(endpoint, ''))
})
test('cloud adapter rejects wrong identity, stale/future/rounded data, unknown errors and drops extra fields', async () => {
  for (const patch of [{ accountId: 'different' }, { profileUrl: profile.profileUrl + 'different' }, { followerCount: '8.6万' },
    { observedAt: '2026-10-23T07:57:00.000Z' }, { observedAt: '2026-10-23T08:00:01.000Z' }]) {
    await assert.rejects(createBrowserServiceReader({ endpoint, token, now: () => time,
      request: async () => ({ ok: true, data: { ...observation, ...patch } }) })(profile))
  }
  await assert.rejects(createBrowserServiceReader({ endpoint, token, request: async () => ({ ok: false, errorCode: 'secret' }) })(profile), { code: 'UPSTREAM_UNAVAILABLE' })
})
test('HTTPS service transport refuses redirects without forwarding credentials and bounds body size', async t => {
  const https = require('node:https'), { PassThrough } = require('node:stream'), { EventEmitter } = require('node:events')
  for (const [status, body, code] of [[302, '{}', 'UPSTREAM_UNAVAILABLE'], [200, 'x'.repeat(4097), 'INVALID_UPSTREAM_RESPONSE'], [429, '{}', 'RATE_LIMITED']]) {
    t.mock.method(https, 'request', (url, options, callback) => {
      assert.equal(url, endpoint); assert.equal(options.headers.authorization, 'Bearer ' + token)
      const request = new EventEmitter(); request.destroy = () => {}; request.end = () => {
        const response = new PassThrough(); response.statusCode = status; response.headers = { 'content-type': 'application/json', location: 'https://other.example.com/' }
        callback(response); response.end(body)
      }; return request
    })
    await assert.rejects(requestBrowserService({ url: endpoint, token, body: '{}' }), { code })
    t.mock.restoreAll()
  }
})
test('browser egress pins an allowed public IPv4 and denies metadata, private, mapped and attacker hosts', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.1.2', '192.168.1.2', '100.64.0.1', '0.0.0.0', '198.18.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(publicIPv4(ip), false, ip)
  assert.equal(publicIPv4('1.2.3.4'), true)
  assert.equal(await resolveTarget('www.douyin.com:443', async () => [{ address: '1.2.3.4' }]), '1.2.3.4')
  for (const authority of ['127.0.0.1:443', 'evil.example:443', 'www.douyin.com.evil.example:443', 'www.douyin.com:80']) await assert.rejects(resolveTarget(authority))
  await assert.rejects(resolveTarget('www.douyin.com:443', async () => [{ address: '1.2.3.4' }, { address: '127.0.0.1' }] ))
})
test('browser routing rejects another profile, login, subframes, arbitrary protocols and large media', () => {
  const frame = {}, page = { mainFrame: () => frame }
  const request = (url, type = 'document', subframe = false) => ({ url: () => url, resourceType: () => type, isNavigationRequest: () => type === 'document', frame: () => subframe ? {} : frame })
  assert.equal(allowRequest(request(profile.profileUrl), page, profile), true)
  for (const url of [profile.profileUrl + 'other', 'https://www.douyin.com/login', 'file:///etc/passwd', 'https://127.0.0.1/', 'https://www.douyin.com:444/']) assert.equal(allowRequest(request(url), page, profile), false)
  assert.equal(allowRequest(request(profile.profileUrl, 'document', true), page, profile), false)
  assert.equal(allowRequest(request('https://lf.douyinstatic.com/test.js', 'script'), page, profile), true)
  assert.equal(allowRequest(request('https://lf.douyinstatic.com/test.mp4', 'media'), page, profile), false)
})
test('browser deadline closes an in-progress context and returns no count', async () => {
  let closed = 0
  const context = { newPage: () => new Promise(() => {}), close: async () => { closed++ } }
  const reader = createBrowserReader({ newContext: async () => context }, { timeoutMs: 10 })
  await assert.rejects(reader(profile), { code: 'BROWSER_TIMEOUT' }); assert.ok(closed > 0)
})
