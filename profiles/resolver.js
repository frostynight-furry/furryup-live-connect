'use strict'
const https = require('node:https')
const { identifyProfile, ProfileError } = require('./model')

const SHORT_LINKS = [
  ['bilibili', /^https:\/\/b23\.tv\/[A-Za-z0-9]{1,32}$/],
  ['douyin', /^https:\/\/v\.douyin\.com\/[A-Za-z0-9_-]{1,64}\/?$/],
  ['kuaishou', /^https:\/\/v\.kuaishou\.com\/[A-Za-z0-9_-]{1,64}\/?$/]
]
// Resolve one platform share redirect only. Never follow the Location URL.
function requestProfileRedirect(url) {
  if (typeof url !== 'string' || !SHORT_LINKS.some(([, pattern]) => pattern.test(url))) {
    return Promise.reject(new ProfileError('INVALID_PROFILE_URL'))
  }
  return new Promise((resolve, reject) => {
    let timer, settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) reject(error); else resolve(value)
    }
    const req = https.get(url, { headers: { 'User-Agent': 'FurryUP-Profile/0.3' } }, res => {
      const location = res.headers.location
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && typeof location === 'string' && location.length <= 2048) finish(null, location)
      else finish(new ProfileError([403, 412, 429].includes(res.statusCode) ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE'))
      res.destroy(); req.destroy()
    })
    timer = setTimeout(() => { finish(new ProfileError('UPSTREAM_TIMEOUT')); req.destroy() }, 8000)
    req.on('error', () => finish(new ProfileError('UPSTREAM_UNAVAILABLE')))
  })
}
async function resolveProfile(input, requestRedirect = requestProfileRedirect) {
  const value = typeof input === 'string' ? { profileUrl: input } : input
  try { return identifyProfile(value) }
  catch (error) {
    if (error.code !== 'FULL_PROFILE_URL_REQUIRED' || !SHORT_LINKS.some(([, pattern]) => pattern.test(value.profileUrl.trim()))) throw error
  }
  const platform = SHORT_LINKS.find(([, pattern]) => pattern.test(value.profileUrl.trim()))[0]
  if (value.platform && value.platform !== platform) throw new ProfileError('PLATFORM_MISMATCH')
  const location = await requestRedirect(value.profileUrl.trim())
  // Drop tracking only after checking the entire redirect authority and path.
  if (typeof location !== 'string' || location.length > 4096 || !/^https:\/\/[^\s\\#]+$/.test(location)) throw new ProfileError('UNSUPPORTED_PROFILE_URL')
  try { return identifyProfile({ platform, profileUrl: location.split('?')[0] }) }
  catch (_) { throw new ProfileError('UNSUPPORTED_PROFILE_URL') }
}
function requestBilibiliRedirect(url) {
  if (typeof url !== 'string' || !SHORT_LINKS[0][1].test(url)) return Promise.reject(new ProfileError('INVALID_PROFILE_URL'))
  return requestProfileRedirect(url)
}
module.exports = { resolveProfile, requestProfileRedirect, requestBilibiliRedirect }
