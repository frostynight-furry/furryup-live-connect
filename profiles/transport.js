'use strict'

const https = require('node:https')
const { ProfileError } = require('./model')
const ENDPOINTS = Object.freeze({
  'api.bilibili.com': /^\/x\/relation\/stat$/,
  'open.douyin.com': /^\/(?:data\/external\/user\/fans|oauth\/(?:access_token|refresh_token|userinfo))\/$/,
  'open.kuaishou.com': /^\/(?:openapi\/user_info|oauth2\/(?:access_token|refresh_token))$/,
  'www.xiaohongshu.com': /^\/user\/profile\/[a-f0-9]{24}$/
})
// Never request a user-supplied URL. Only these fixed, adapter-built endpoints.
function requestProfile({ url, headers = {}, format = 'json', signal, method = 'GET', body } = {}) {
  let target
  try { target = new URL(url) } catch (_) { return Promise.reject(new ProfileError('INVALID_ENDPOINT')) }
  if (target.protocol !== 'https:' || target.username || target.password || target.port || target.hash ||
      !Object.hasOwn(ENDPOINTS, target.hostname) || !ENDPOINTS[target.hostname].test(target.pathname) ||
      method !== (target.hostname === 'open.douyin.com' && target.pathname.startsWith('/oauth/') ? 'POST' : 'GET') ||
      (body !== undefined && (method !== 'POST' || typeof body !== 'string' || Buffer.byteLength(body) > 16384))) {
    return Promise.reject(new ProfileError('INVALID_ENDPOINT'))
  }
  return new Promise((resolve, reject) => {
    let settled = false, timer
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) reject(error); else resolve(value)
    }
    const send = method === 'GET' ? https.get : https.request
    const req = send(target, { signal, method, headers: { Accept: format === 'html' ? 'text/html' : 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'FurryUP-Profile/0.3', ...headers,
      ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) } }, res => {
      if (res.statusCode !== 200) {
        finish(new ProfileError([403, 412, 429].includes(res.statusCode) ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE'))
        res.destroy(); req.destroy()
        return
      }
      let length = 0
      const chunks = []
      res.on('data', chunk => {
        length += chunk.length
        if (length > 1024 * 1024) { finish(new ProfileError('RESPONSE_TOO_LARGE')); res.destroy(); req.destroy(); return }
        chunks.push(chunk)
      })
      res.on('error', () => finish(new ProfileError('UPSTREAM_UNAVAILABLE')))
      res.on('end', () => {
        if (settled) return
        const body = Buffer.concat(chunks).toString('utf8')
        try { finish(null, format === 'html' ? body : JSON.parse(body)) }
        catch (_) { finish(new ProfileError('INVALID_UPSTREAM_RESPONSE')) }
      })
    })
    timer = setTimeout(() => { finish(new ProfileError('UPSTREAM_TIMEOUT')); req.destroy() }, 8000)
    req.on('error', () => finish(new ProfileError('UPSTREAM_UNAVAILABLE')))
    if (method === 'POST') req.end(body)
  })
}
module.exports = { requestProfile }
