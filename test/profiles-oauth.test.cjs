'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createProfileOAuth } = require('../profiles/oauth')
const binding = { appId: 'trusted-app', tenantId: 'synthetic-tenant', userId: 'synthetic-user' }
const startTime = Date.parse('2026-10-23T06:00:00.000Z')
function memory() {
  const rows = new Map(); let tail = Promise.resolve()
  return { rows, transaction(key, work) {
    const result = tail.then(() => { const out = work(structuredClone(rows.get(key))); rows.set(key, structuredClone(out.record)); return structuredClone(out.result) })
    tail = result.catch(() => {}); return result
  } }
}
function harness(platform = 'douyin', override) {
  const store = memory(), calls = []; let time = startTime
  const payload = refresh => platform === 'douyin' ? { data: { error_code: 0, access_token: refresh ? 'synthetic-access-2' : 'synthetic-access-1',
    refresh_token: refresh ? 'synthetic-refresh-2' : 'synthetic-refresh-1', open_id: 'synthetic-subject',
    scope: 'user_info,data.external.user', expires_in: 3600, refresh_expires_in: 7200 } } : { result: 1,
    access_token: refresh ? 'synthetic-access-2' : 'synthetic-access-1', refresh_token: refresh ? 'synthetic-refresh-2' : 'synthetic-refresh-1',
    ...(refresh ? {} : { open_id: 'synthetic-subject' }), scopes: ['user_info'], expires_in: 3600, refresh_token_expires_in: 7200 }
  const request = async input => {
    calls.push(input)
    if (override) { const answer = await override(input, payload); if (answer !== undefined) return answer }
    if (input.url.includes('/access_token')) return payload(false)
    if (input.url.includes('/refresh_token')) return payload(true)
    if (input.url.includes('/oauth/userinfo/')) return { err_no: 0, data: { error_code: 0, open_id: 'synthetic-subject', nickname: '合成测试账号', internal: 'must-not-leak' } }
    if (input.url.includes('/openapi/user_info')) return { result: 1, user_info: { name: '合成测试账号', fan: 31, internal: 'must-not-leak' } }
    return { data: { error_code: 0, result_list: [{ date: '2026-10-22', total_fans: 21 }] } }
  }
  const opts = { platform, clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'https://callback.example/oauth',
    encryptionKey: Buffer.alloc(32, 7), store, request, now: () => time }
  const client = createProfileOAuth(opts)
  const callback = auth => 'https://callback.example/oauth?' + new URLSearchParams({ state: new URL(auth.authorizationUrl).searchParams.get('state'), code: 'synthetic-code' })
  return { client, store, calls, opts, callback, advance: n => { time += n }, async authorize() {
    const auth = await client.begin(binding, 'test-request'); return client.complete(binding, callback(auth))
  } }
}
test('OAuth validates configuration, HTTPS callbacks and independent server encryption', () => {
  const h = harness()
  for (const patch of [{ encryptionKey: Buffer.alloc(31) }, { redirectUri: 'http://localhost/callback' },
    { redirectUri: 'https://callback.example/oauth?next=evil' }, { redirectUri: 'https://u:p@callback.example/' }, { platform: 'xiaohongshu' }]) {
    assert.throws(() => createProfileOAuth({ ...h.opts, ...patch }))
  }
})
test('begin is idempotent while pending and exposes only client ID, minimal scopes and random state', async () => {
  for (const platform of ['douyin', 'kuaishou']) {
    const h = harness(platform), result = await h.client.begin(binding, 'demo:request:1')
    assert.deepEqual(await h.client.begin(binding, 'demo:request:1'), result)
    const url = new URL(result.authorizationUrl)
    assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/)
    assert.equal(url.searchParams.get('scope'), platform === 'douyin' ? 'user_info,data.external.user' : 'user_info')
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false)
    assert.equal(JSON.stringify([...h.store.rows.values()]).includes(url.searchParams.get('state')), false)
    assert.equal(h.calls.length, 0)
  }
})
test('callbacks are bound to current app/user/tenant; a replay does not exchange twice or leak credentials', async () => {
  const h = harness(), auth = await h.client.begin(binding, 'test'), callback = h.callback(auth)
  for (const field of ['appId', 'tenantId', 'userId']) await assert.rejects(h.client.complete({ ...binding, [field]: 'different' }, callback), { code: 'OAUTH_STATE_MISMATCH' })
  assert.equal(h.calls.length, 0)
  const result = await h.client.complete(binding, callback)
  assert.equal(result.status, 'authorized'); assert.equal(result.profileBinding, 'unverified')
  assert.deepEqual(await h.client.complete(binding, callback), result)
  assert.equal(h.calls.length, 2)
  const serialized = JSON.stringify({ result, rows: [...h.store.rows.values()] })
  for (const secret of ['synthetic-access', 'synthetic-refresh', 'synthetic-subject', 'must-not-leak', 'synthetic-code', 'synthetic-secret']) assert.equal(serialized.includes(secret), false)
  const exchanged = h.calls[0]
  assert.equal(exchanged.method, 'POST'); assert.equal(exchanged.headers['Content-Type'], 'application/x-www-form-urlencoded')
  assert.equal(new URLSearchParams(exchanged.body).get('client_secret'), 'synthetic-secret')
  const observation = await h.client.lookup(binding)
  assert.equal(observation.followerCount, 21); assert.equal(observation.dataAsOf, '2026-10-21T16:00:00.000Z')
  assert.equal(observation.profileUrl, undefined); assert.equal(observation.openId, undefined)
})
test('callback destination, duplicates, expiry, cancellation and failed scope never authorize', async () => {
  const h = harness(), auth = await h.client.begin(binding, 'test'), callback = h.callback(auth)
  for (const bad of [callback.replace('callback.example', 'evil.example'), callback + '&code=second', callback + '#token', callback.replace('/oauth?', '/other?')]) {
    await assert.rejects(h.client.complete(binding, bad), { code: 'INVALID_CALLBACK' })
  }
  h.advance(600001)
  await assert.rejects(h.client.complete(binding, callback), { code: 'OAUTH_STATE_EXPIRED' }); assert.equal(h.calls.length, 0)
  const denied = harness(), denial = (denied.callback(await denied.client.begin(binding, 'test'))).replace('code=synthetic-code', 'error=access_denied')
  await assert.rejects(denied.client.complete(binding, denial), { code: 'OAUTH_DENIED' })
  await assert.rejects(denied.client.complete(binding, denial), { code: 'OAUTH_STATE_USED' })
  assert.equal(denied.calls.length, 0)
  const scopes = harness('douyin', (input, payload) => input.url.includes('/access_token') ? { data: { ...payload(false).data, scope: 'user_info' } } : undefined)
  await assert.rejects(scopes.authorize(), { code: 'OAUTH_SCOPE_REQUIRED' })
  assert.equal((await scopes.client.status(binding)).status, 'authorization_required')
})
test('refresh rotates Kuaishou credentials and preserves the original refresh expiry', async () => {
  const h = harness('kuaishou'); await h.authorize(); h.advance(3590 * 1000)
  assert.equal((await h.client.lookup(binding)).followerCount, 31)
  const refresh = h.calls.find(call => call.url.includes('/refresh_token'))
  assert.equal(new URL(refresh.url).searchParams.get('grant_type'), 'refresh_token')
  assert.equal(new URL(h.calls.at(-1).url).searchParams.get('access_token'), 'synthetic-access-2')
  h.advance(4000 * 1000)
  await assert.rejects(h.client.lookup(binding), { code: 'AUTHORIZATION_REQUIRED' })
})
test('only one worker can refresh, and disconnect prevents an in-flight refresh from restoring a grant', async () => {
  let release, started
  const gate = new Promise(resolve => { started = resolve })
  const h = harness('kuaishou', input => { if (input.url.includes('/refresh_token')) { started(); return new Promise(resolve => { release = resolve }) } })
  await h.authorize(); h.advance(3590 * 1000)
  const first = h.client.lookup(binding); await gate
  await assert.rejects(h.client.lookup(binding), { code: 'OAUTH_BUSY' })
  await h.client.disconnect(binding, (await h.client.status(binding)).revision)
  release({ result: 1, access_token: 'rotated-access', refresh_token: 'rotated-refresh', scopes: ['user_info'], expires_in: 3600, refresh_token_expires_in: 3600 })
  await assert.rejects(first, { code: 'AUTHORIZATION_REQUIRED' })
  assert.equal((await h.client.status(binding)).status, 'authorization_required')
})
test('unknown upstream outcomes are sanitized and require a fresh authorization', async () => {
  const h = harness('douyin', input => { if (input.url.includes('/refresh_token')) throw new Error('credential-secret URL') })
  await h.authorize(); h.advance(3590 * 1000)
  await assert.rejects(h.client.lookup(binding), { code: 'UPSTREAM_UNAVAILABLE', message: 'UPSTREAM_UNAVAILABLE' })
  await assert.rejects(h.client.lookup(binding), { code: 'AUTHORIZATION_REQUIRED' })
  assert.equal(h.calls.filter(call => call.url.includes('/refresh_token')).length, 1)
})
test('wrong official subject, ciphertext changes and disconnect during data lookup fail closed', async () => {
  const wrong = harness('douyin', input => input.url.includes('/oauth/userinfo/') ? { data: { error_code: 0, open_id: 'wrong', nickname: 'wrong' } } : undefined)
  await assert.rejects(wrong.authorize(), { code: 'AUTHORIZATION_REQUIRED' })
  const h = harness(); await h.authorize()
  const record = [...h.store.rows.values()][0]; record.grant = 'invalid-ciphertext'
  await assert.rejects(h.client.lookup(binding), { code: 'AUTHORIZATION_REQUIRED' })
  let concurrent
  concurrent = harness('douyin', async input => {
    if (input.url.includes('/user/fans/')) { await concurrent.client.disconnect(binding, (await concurrent.client.status(binding)).revision); return { data: { error_code: 0, result_list: [{ date: '2026-10-22', total_fans: 9 }] } } }
  })
  await concurrent.authorize(); await assert.rejects(concurrent.client.lookup(binding), { code: 'AUTHORIZATION_REQUIRED' })
})
test('replaying an old disconnect never revokes a newer authorization', async () => {
  const h = harness(); const old = await h.authorize()
  const disconnected = await h.client.disconnect(binding, old.revision)
  assert.deepEqual(await h.client.disconnect(binding, old.revision), disconnected)
  const next = await h.client.begin(binding, 'second'); await h.client.complete(binding, h.callback(next))
  await assert.rejects(h.client.disconnect(binding, old.revision), { code: 'OAUTH_VERSION_CONFLICT' })
  assert.equal((await h.client.status(binding)).status, 'authorized')
})
