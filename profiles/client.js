'use strict'

const { identifyProfile, exactCount, snapshot, ProfileError, PROFILE_PLATFORMS } = require('./model')
const { requestProfile } = require('./transport')
function fail(code) { throw new ProfileError(code) }

// Parse only JSON-shaped hydration data; never evaluate JavaScript from a page.
function initialState(html) {
  if (typeof html !== 'string' || html.length > 1024 * 1024) fail('INVALID_UPSTREAM_RESPONSE')
  const marker = /window\.__INITIAL_STATE__\s*=\s*/g.exec(html)
  if (!marker || html[marker.index + marker[0].length] !== '{') fail('EXACT_COUNT_UNAVAILABLE')
  let depth = 0, quoted = false, escaped = false, json = ''
  for (let i = marker.index + marker[0].length; i < html.length; i++) {
    const char = html[i]
    if (quoted) {
      json += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    if (char === '{' || char === '[') depth++
    if (depth > 64) fail('INVALID_UPSTREAM_RESPONSE')
    if (char === '}' || char === ']') depth--
    if (html.slice(i, i + 9) === 'undefined' && /[\s,}\]]/.test(html[i + 9] || '')) { json += 'null'; i += 8 } else json += char
    if (!depth) {
      try { return JSON.parse(json) } catch (_) { fail('INVALID_UPSTREAM_RESPONSE') }
    }
  }
  fail('INVALID_UPSTREAM_RESPONSE')
}
function xiaohongshuCount(html, accountId) {
  const state = initialState(html)
  const user = state && state.user, page = user && user.userPageData
  const id = page && (page.basicInfo && page.basicInfo.userId || page.userId || user.userId)
  if (id !== accountId) fail('ACCOUNT_MISMATCH')
  const fans = Array.isArray(page.interactions) && page.interactions.filter(item => item && item.type === 'fans')
  if (!fans || fans.length !== 1) fail('EXACT_COUNT_UNAVAILABLE')
  return exactCount(fans[0].count)
}
function parseDailyFans(body, fetchedAt) {
  if (!body || String(body.data && body.data.error_code) !== '0' || (body.extra && String(body.extra.error_code) !== '0')) fail('AUTHORIZATION_REQUIRED')
  const rows = body.data.result_list
  if (!Array.isArray(rows) || rows.length > 60) fail('INVALID_UPSTREAM_RESPONSE')
  const valid = rows.filter(row => row && /^\d{4}-\d{2}-\d{2}$/.test(row.date)).sort((a, b) => b.date.localeCompare(a.date))
  if (!valid.length) fail('EXACT_COUNT_UNAVAILABLE')
  const row = valid[0], millis = Date.parse(row.date + 'T00:00:00+08:00')
  if (!Number.isFinite(millis) || new Date(millis + 8 * 3600000).toISOString().slice(0, 10) !== row.date || millis > Date.parse(fetchedAt)) fail('INVALID_UPSTREAM_RESPONSE')
  return { followerCount: exactCount(row.total_fans), dataAsOf: new Date(millis).toISOString() }
}

function createFollowerClient(options = {}) {
  const request = options.request || requestProfile
  const now = options.now || (() => new Date().toISOString())
  const interval = options.intervalMs === undefined ? 60000 : options.intervalMs
  const limit = options.maxEntries === undefined ? 256 : options.maxEntries
  if (!Number.isSafeInteger(interval) || interval < 0 || interval > 86400000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new TypeError('Invalid cache limits')
  const cache = new Map(), running = new Map(), platformNext = new Map()
  const capabilities = () => PROFILE_PLATFORMS.map(platform => ({
    platform, mode: platform === 'wechat_channels' ? 'manual' : ['douyin', 'kuaishou'].includes(platform) ? 'oauth' : 'public_experimental',
    configured: platform === 'bilibili' ? options.allowPublicBilibili === true : platform === 'xiaohongshu' ? options.allowPublicXiaohongshu === true :
      platform === 'wechat_channels' ? false : typeof options.resolveAuthorization === 'function',
    liveCollection: false
  }))
  async function acquire(profile, context) {
    const fetchedAt = now(), platform = profile.platform
    if (platform === 'wechat_channels') return { ...profile, status: 'manual_required', followerCount: null, attemptedAt: fetchedAt }
    if (platform === 'bilibili' && !options.allowPublicBilibili || platform === 'xiaohongshu' && !options.allowPublicXiaohongshu) {
      return { ...profile, status: 'not_configured', followerCount: null, attemptedAt: fetchedAt }
    }
    let authorization
    if (['douyin', 'kuaishou'].includes(platform)) {
      authorization = typeof options.resolveAuthorization === 'function' && await options.resolveAuthorization({ ...profile }, context)
      // Only the trusted host resolves credentials, bound to this exact URL identity.
      if (!authorization || authorization.accountId !== profile.accountId || authorization.platform !== platform ||
          typeof authorization.accessToken !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(authorization.accessToken) ||
          typeof authorization.openId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(authorization.openId) ||
          !Number.isFinite(Date.parse(authorization.expiresAt)) || Date.parse(authorization.expiresAt) <= Date.parse(fetchedAt)) {
        return { ...profile, status: 'authorization_required', followerCount: null, attemptedAt: fetchedAt }
      }
      if (platform === 'kuaishou' && (typeof authorization.appId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(authorization.appId))) fail('AUTHORIZATION_REQUIRED')
    }
    // Recheck authorization before using cached data. No token is part of a key or DTO.
    const key = platform + ':' + profile.accountId
    const cached = cache.get(key), time = Date.parse(fetchedAt)
    if (!Number.isFinite(time)) fail('INVALID_OBSERVATION')
    if (cached && time < cached.nextAt) return { ...cached.result, cached: true }
    if (running.has(key)) return { ...await running.get(key) }
    if (running.size >= 4 || time < (platformNext.get(platform) || 0)) return { ...profile, status: 'rate_limited', followerCount: null, attemptedAt: fetchedAt }
    platformNext.set(platform, time + Math.min(interval, 1000))
    const work = (async () => {
      let result
      try {
        let followerCount, source, dataAsOf = fetchedAt
        if (platform === 'bilibili') {
          const body = await request({ url: 'https://api.bilibili.com/x/relation/stat?vmid=' + profile.accountId })
          if (!body || body.code !== 0 || !body.data) fail('UPSTREAM_UNAVAILABLE')
          if (String(body.data.mid) !== profile.accountId) fail('ACCOUNT_MISMATCH')
          followerCount = exactCount(body.data.follower); source = 'public_api'
        } else if (platform === 'douyin') {
          const query = new URLSearchParams({ open_id: authorization.openId, date_type: '7' })
          const body = await request({ url: 'https://open.douyin.com/data/external/user/fans/?' + query, headers: { 'access-token': authorization.accessToken } })
          const daily = parseDailyFans(body, fetchedAt)
          followerCount = daily.followerCount; dataAsOf = daily.dataAsOf; source = 'official_api'
        } else if (platform === 'kuaishou') {
          const query = new URLSearchParams({ app_id: authorization.appId, access_token: authorization.accessToken })
          const body = await request({ url: 'https://open.kuaishou.com/openapi/user_info?' + query })
          if (!body || body.result !== 1 || !body.user_info) fail('AUTHORIZATION_REQUIRED')
          followerCount = exactCount(body.user_info.fan); source = 'official_api'
        } else {
          const html = await request({ url: profile.profileUrl, format: 'html' })
          followerCount = xiaohongshuCount(html, profile.accountId); source = 'public_page'
        }
        result = { ...profile, status: 'ok', ...snapshot({ followerCount, source, fetchedAt, dataAsOf }), attemptedAt: fetchedAt }
      } catch (error) {
        const code = error instanceof ProfileError ? error.code : 'UPSTREAM_UNAVAILABLE'
        const status = code === 'RATE_LIMITED' ? 'rate_limited' : code === 'AUTHORIZATION_REQUIRED' ? 'authorization_required' : 'unavailable'
        // Exception text, upstream responses and credentials never cross this boundary.
        result = { ...profile, status, followerCount: null, attemptedAt: fetchedAt, errorCode: code }
      }
      cache.delete(key); cache.set(key, { result, nextAt: time + interval })
      while (cache.size > limit) cache.delete(cache.keys().next().value)
      return result
    })()
    running.set(key, work)
    try { return { ...await work } } finally { running.delete(key) }
  }
  return { capabilities, async lookup(input, context) {
    const profile = identifyProfile(input)
    try { return await acquire(profile, context) }
    catch (_) { return { ...profile, status: 'unavailable', followerCount: null, attemptedAt: now(), errorCode: 'UPSTREAM_UNAVAILABLE' } }
  } }
}
module.exports = { createFollowerClient, xiaohongshuCount, parseDailyFans }
