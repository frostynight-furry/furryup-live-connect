'use strict'
// Server-only optional OAuth flow. The host authenticates every invocation and
// supplies a stable application/user/tenant binding plus an atomic private store.
const crypto = require('node:crypto')
const { requestProfile } = require('./transport')
const { parseDailyFans } = require('./client')
const { ProfileError, exactCount, snapshot } = require('./model')
const SCOPES = { douyin: ['user_info', 'data.external.user'], kuaishou: ['user_info'] }
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const fail = code => { throw new ProfileError(code) }
function token(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value)) fail('INVALID_UPSTREAM_RESPONSE')
  return value
}
function seconds(value) {
  const n = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(n) || n < 1 || n > 366 * 86400) fail('INVALID_UPSTREAM_RESPONSE')
  return n
}
function createProfileOAuth(options) {
  const { platform, clientId, clientSecret, redirectUri, store } = options || {}
  if (!Object.hasOwn(SCOPES, platform) || typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId) ||
      typeof clientSecret !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(clientSecret) ||
      !store || typeof store.transaction !== 'function') throw new TypeError('OAuth application and atomic private store are required')
  let redirect
  try { redirect = new URL(redirectUri) } catch (_) { throw new TypeError('HTTPS callback required') }
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.port || redirect.search || redirect.hash) throw new TypeError('HTTPS callback without query required')
  const key = options.encryptionKey
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('A 32-byte server encryption key is required')
  const request = options.request || requestProfile
  const now = options.now || (() => Date.now())
  const app = hash(JSON.stringify([platform, clientId, redirect.href]))
  function instant() { const n = now(); if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_OBSERVATION'); return n }
  function storageKey(binding) {
    if (!binding || ['appId', 'tenantId', 'userId'].some(name => typeof binding[name] !== 'string' || !binding[name] || binding[name].length > 200)) fail('INVALID_BINDING')
    return hash(JSON.stringify([app, binding.appId, binding.tenantId, binding.userId]))
  }
  function seal(value, id) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(id))
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64')
  }
  function open(value, id) {
    try {
      if (typeof value !== 'string' || value.length > 40000) fail('AUTHORIZATION_REQUIRED')
      const data = Buffer.from(value, 'base64')
      if (data.length < 29) fail('AUTHORIZATION_REQUIRED')
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12), { authTagLength: 16 })
      decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(data.subarray(-16))
      return JSON.parse(Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString('utf8'))
    } catch (_) { fail('AUTHORIZATION_REQUIRED') }
  }
  function transact(id, work) {
    // The host must serialize this per key across ALL workers. work is pure local
    // document work; no upstream request occurs inside a retried transaction.
    return store.transaction(id, current => work(current || { revision: 0, grant: null, pending: null, refreshing: null }))
  }
  function dto(grant, revision) {
    return { platform, status: grant ? 'authorized' : 'authorization_required',
      nickname: grant ? grant.nickname : '', expiresAt: grant ? grant.expiresAt : null,
      profileBinding: 'unverified', revision }
  }
  async function send(path, fields, json = false) {
    if (platform === 'douyin') return request({ url: 'https://open.douyin.com' + path, method: 'POST',
      headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
      body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString() })
    return request({ url: 'https://open.kuaishou.com' + path + '?' + new URLSearchParams(fields) })
  }
  function grantFrom(body, previous, startedAt) {
    const data = platform === 'douyin' ? body && body.data : body
    if (!data || (platform === 'douyin' ? String(data.error_code) !== '0' : data.result !== 1)) fail('AUTHORIZATION_REQUIRED')
    const scopes = platform === 'douyin' ? typeof data.scope === 'string' && data.scope.split(',') : data.scopes
    if (!Array.isArray(scopes) || SCOPES[platform].some(scope => !scopes.includes(scope))) fail('OAUTH_SCOPE_REQUIRED')
    const openId = data.open_id === undefined && previous ? previous.openId : data.open_id
    if (typeof openId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(openId) || previous && previous.openId !== openId) fail('ACCOUNT_MISMATCH')
    const refreshSeconds = seconds(platform === 'douyin' ? data.refresh_expires_in : data.refresh_token_expires_in)
    return { platform, openId, accessToken: token(data.access_token), refreshToken: token(data.refresh_token), scopes,
      expiresAt: new Date(startedAt + seconds(data.expires_in) * 1000).toISOString(),
      refreshExpiresAt: new Date(Math.min(startedAt + refreshSeconds * 1000, previous ? Date.parse(previous.refreshExpiresAt) : Infinity)).toISOString(),
      nickname: previous ? previous.nickname : '' }
  }
  async function publicUser(grant) {
    const body = platform === 'douyin' ? await send('/oauth/userinfo/', { access_token: grant.accessToken, open_id: grant.openId }, true)
      : await send('/openapi/user_info', { app_id: clientId, access_token: grant.accessToken })
    const data = platform === 'douyin' ? body && body.data : body && body.user_info
    if (!data || (platform === 'douyin' ? String(data.error_code) !== '0' || data.open_id !== grant.openId || body.err_no !== undefined && body.err_no !== 0 : body.result !== 1)) fail('AUTHORIZATION_REQUIRED')
    const name = platform === 'douyin' ? data.nickname : data.name
    if (typeof name !== 'string' || !name || name.length > 200) fail('INVALID_UPSTREAM_RESPONSE')
    return { nickname: name, followerCount: platform === 'kuaishou' ? exactCount(data.fan) : null }
  }
  function authorizationUrl(state) {
    const params = new URLSearchParams({ response_type: 'code', redirect_uri: redirect.href, scope: SCOPES[platform].join(','), state })
    params.set(platform === 'douyin' ? 'client_key' : 'app_id', clientId)
    if (platform === 'kuaishou') params.set('ua', 'pc')
    return (platform === 'douyin' ? 'https://open.douyin.com/platform/oauth/connect/' : 'https://open.kuaishou.com/oauth2/authorize') + '?' + params
  }
  async function usableGrant(id) {
    const stamp = instant(), lock = crypto.randomBytes(24).toString('hex')
    const selected = await transact(id, row => {
      if (!row.grant) fail('AUTHORIZATION_REQUIRED')
      const grant = open(row.grant, id)
      if (row.refreshing) fail(stamp - row.refreshing.startedAt < 30000 ? 'OAUTH_BUSY' : 'AUTHORIZATION_REQUIRED')
      if (Date.parse(grant.expiresAt) > stamp + 60000) return { record: row, result: { grant, revision: row.revision } }
      if (Date.parse(grant.refreshExpiresAt) <= stamp) fail('AUTHORIZATION_REQUIRED')
      return { record: { ...row, refreshing: { lock, startedAt: stamp } }, result: { grant, refresh: true } }
    })
    if (!selected.refresh) return selected
    try {
      const body = platform === 'douyin' ? await send('/oauth/refresh_token/', { client_key: clientId, grant_type: 'refresh_token', refresh_token: selected.grant.refreshToken })
        : await send('/oauth2/refresh_token', { app_id: clientId, app_secret: clientSecret, grant_type: 'refresh_token', refresh_token: selected.grant.refreshToken })
      const grant = grantFrom(body, selected.grant, stamp)
      return await transact(id, row => {
        if (!row.refreshing || row.refreshing.lock !== lock) fail('AUTHORIZATION_REQUIRED')
        return { record: { ...row, revision: row.revision + 1, grant: seal(grant, id), refreshing: null }, result: { grant, revision: row.revision + 1 } }
      })
    } catch (error) {
      // Rotation can succeed upstream even if its reply is lost. Never reuse an
      // uncertain refresh token; a fresh authorization is required.
      await transact(id, row => ({ record: row.refreshing && row.refreshing.lock === lock ? { ...row, grant: null, refreshing: null, revision: row.revision + 1 } : row, result: null }))
      fail(error instanceof ProfileError ? error.code : 'UPSTREAM_UNAVAILABLE')
    }
  }
  const api = {
    async begin(binding, requestId) {
      const id = storageKey(binding), stamp = instant()
      if (typeof requestId !== 'string' || !/^[\x21-\x7e]{1,120}$/.test(requestId)) fail('INVALID_REQUEST_ID')
      const state = crypto.randomBytes(32).toString('base64url')
      return transact(id, row => {
        let pending = row.pending
        if (pending && pending.requestId === requestId) {
          if (pending.status !== 'pending' || pending.expiresAt <= stamp) fail('OAUTH_STATE_USED')
        } else pending = { requestId, status: 'pending', stateHash: hash(state), state: seal(state, id), expiresAt: stamp + 600000 }
        return { record: { ...row, pending, revision: row.revision + (pending === row.pending ? 0 : 1) }, result: { platform, authorizationUrl: authorizationUrl(open(pending.state, id)), expiresAt: new Date(pending.expiresAt).toISOString() } }
      })
    },
    async complete(binding, callbackUrl) {
      const id = storageKey(binding), stamp = instant()
      let url
      try { url = new URL(callbackUrl) } catch (_) { fail('INVALID_CALLBACK') }
      if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || url.username || url.password || url.hash || url.href.length > 8192) fail('INVALID_CALLBACK')
      const state = url.searchParams.get('state'), code = url.searchParams.get('code')
      if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || ['state', 'code', 'error'].some(name => url.searchParams.getAll(name).length > 1)) fail('INVALID_CALLBACK')
      const denied = url.searchParams.has('error')
      if (!denied && (typeof code !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(code))) fail('INVALID_CALLBACK')
      const stateHash = hash(state), codeHash = hash(code || '')
      const prepared = await transact(id, row => {
        const pending = row.pending
        if (!pending || pending.stateHash !== stateHash) fail('OAUTH_STATE_MISMATCH')
        if (pending.status === 'complete' && pending.codeHash === codeHash && row.grant) return { record: row, result: { completed: dto(open(row.grant, id), row.revision) } }
        if (pending.status !== 'pending') fail('OAUTH_STATE_USED')
        if (pending.expiresAt <= stamp) fail('OAUTH_STATE_EXPIRED')
        return { record: { ...row, pending: { ...pending, state: null, status: denied ? 'denied' : 'exchanging', codeHash } }, result: {} }
      })
      if (prepared.completed) return prepared.completed
      if (denied) fail('OAUTH_DENIED')
      try {
        const body = platform === 'douyin' ? await send('/oauth/access_token/', { client_key: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code' })
          : await send('/oauth2/access_token', { app_id: clientId, app_secret: clientSecret, code, grant_type: 'authorization_code' })
        const grant = grantFrom(body, null, stamp)
        grant.nickname = (await publicUser(grant)).nickname
        return transact(id, row => {
          if (!row.pending || row.pending.stateHash !== stateHash || row.pending.status !== 'exchanging') fail('OAUTH_STATE_USED')
          return { record: { ...row, revision: row.revision + 1, pending: { ...row.pending, status: 'complete' }, grant: seal(grant, id), refreshing: null }, result: dto(grant, row.revision + 1) }
        })
      } catch (error) {
        await transact(id, row => ({ record: row.pending && row.pending.stateHash === stateHash && row.pending.status === 'exchanging'
          ? { ...row, pending: { ...row.pending, status: 'failed' } } : row, result: null }))
        fail(error instanceof ProfileError ? error.code : 'UPSTREAM_UNAVAILABLE')
      }
    },
    async status(binding) {
      return transact(storageKey(binding), row => {
        const grant = row.grant ? open(row.grant, storageKey(binding)) : null
        return { record: row, result: { ...dto(grant, row.revision), needsReauthorization: !grant || Date.parse(grant.refreshExpiresAt) <= instant() || !!row.refreshing && instant() - row.refreshing.startedAt >= 30000 } }
      })
    },
    async disconnect(binding, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('INVALID_REVISION')
      return transact(storageKey(binding), row => {
        if (row.disconnectRevision === expectedRevision && !row.grant && !row.pending) return { record: row, result: dto(null, row.revision) }
        if (row.revision !== expectedRevision) fail('OAUTH_VERSION_CONFLICT')
        return { record: { revision: row.revision + 1, disconnectRevision: expectedRevision, grant: null, pending: null, refreshing: null }, result: dto(null, row.revision + 1) }
      })
    },
    async lookup(binding) {
      const id = storageKey(binding), selected = await usableGrant(id), grant = selected.grant, fetchedAt = new Date(instant()).toISOString()
      let followerCount, dataAsOf = fetchedAt
      if (platform === 'douyin') {
        const body = await request({ url: 'https://open.douyin.com/data/external/user/fans/?' + new URLSearchParams({ open_id: grant.openId, date_type: '7' }), headers: { 'access-token': grant.accessToken } })
        const daily = parseDailyFans(body, fetchedAt); followerCount = daily.followerCount; dataAsOf = daily.dataAsOf
      } else followerCount = (await publicUser(grant)).followerCount
      // Check disconnect/rebinding after I/O. Do not return data for an old grant.
      return transact(id, row => {
        if (!row.grant || row.revision !== selected.revision || open(row.grant, id).accessToken !== grant.accessToken) fail('AUTHORIZATION_REQUIRED')
        return { record: row, result: { ...dto(grant, row.revision), ...snapshot({ followerCount, source: 'official_api', fetchedAt, dataAsOf }) } }
      })
    }
  }
  return Object.fromEntries(Object.entries(api).map(([name, method]) => [name, async (...args) => {
    try { return await method(...args) }
    catch (error) { fail(error instanceof ProfileError ? error.code : 'UPSTREAM_UNAVAILABLE') }
  }]))
}
module.exports = { createProfileOAuth }
