'use strict'
const http = require('node:http')
const { timingSafeEqual } = require('node:crypto')
const { identifyProfile, exactCount, isoTime, ProfileError } = require('../profiles/model')
const SAFE_ERRORS = new Set(['BROWSER_INTERACTION_REQUIRED', 'EXACT_COUNT_UNAVAILABLE', 'ACCOUNT_MISMATCH', 'BROWSER_TIMEOUT'])
function createWorker({ token, readProfile, now = Date.now, isReady = () => true }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('BROWSER_SERVICE_TOKEN_REQUIRED')
  const expected = Buffer.from('Bearer ' + token), cache = new Map(), running = new Map()
  let nextStart = 0, requests = 0
  const send = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  }
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') return send(response, isReady() ? 200 : 503, { ok: isReady() })
    const actual = Buffer.from(request.headers.authorization || '')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { request.resume(); return send(response, 401, { ok: false }) }
    if (request.method !== 'POST' || request.url !== '/v1/douyin/followers') { request.resume(); return send(response, 404, { ok: false }) }
    if (!isReady()) { request.resume(); return send(response, 503, { ok: false }) }
    if (++requests > 16) { requests--; request.resume(); return send(response, 429, { ok: false, errorCode: 'RATE_LIMITED' }) }
    try {
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return send(response, 400, { ok: false })
      const chunks = []; let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 4096) { send(response, 413, { ok: false }); request.destroy(); return }
        chunks.push(chunk)
      }
      let profile
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!input || Object.keys(input).length !== 1 || typeof input.profileUrl !== 'string') throw new Error()
        profile = identifyProfile(input)
        if (profile.platform !== 'douyin' || profile.profileUrl !== input.profileUrl) throw new Error()
      } catch (_) { return send(response, 400, { ok: false, errorCode: 'INVALID_PROFILE' }) }
      const key = profile.accountId, cached = cache.get(key)
      if (cached && now() < cached.expiresAt) return send(response, 200, cached.body)
      if (!running.has(key)) {
        if (running.size || now() < nextStart) return send(response, 429, { ok: false, errorCode: 'RATE_LIMITED' })
        nextStart = now() + 5000
        const work = Promise.resolve().then(() => readProfile(profile)).then(result => {
          if (result.platform !== profile.platform || result.accountId !== key || result.profileUrl !== profile.profileUrl) throw new ProfileError('ACCOUNT_MISMATCH')
          const observedAt = isoTime(result.observedAt), age = now() - Date.parse(observedAt)
          if (age < 0 || age > 120000) throw new Error()
          return { ok: true, data: { ...profile, followerCount: exactCount(result.followerCount), observedAt } }
        }).catch(error => ({ ok: false, errorCode: error instanceof ProfileError && SAFE_ERRORS.has(error.code) ? error.code : 'UPSTREAM_UNAVAILABLE' }))
          .then(body => {
            cache.delete(key); cache.set(key, { body, expiresAt: now() + (body.ok ? 60000 : 15000) })
            while (cache.size > 256) cache.delete(cache.keys().next().value)
            return body
          }).finally(() => running.delete(key))
        running.set(key, work)
      }
      send(response, 200, await running.get(key))
    } catch (_) { if (!response.headersSent && !response.destroyed) send(response, 400, { ok: false }) }
    finally { requests-- }
  })
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 18000; server.keepAliveTimeout = 1000
  server.maxConnections = 32
  return server
}
async function main() {
  const token = process.env.FUP_BROWSER_SERVICE_TOKEN
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token || '')) throw new Error('BROWSER_SERVICE_TOKEN_REQUIRED')
  const { chromium } = require('playwright')
  const { createEgressProxy } = require('./egress')
  const { createBrowserReader } = require('./reader')
  const proxy = await createEgressProxy()
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 10000,
    proxy: { server: proxy.url }, args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] })
  const server = createWorker({ token, readProfile: createBrowserReader(browser), isReady: () => browser.isConnected() })
  const port = Number(process.env.PORT || 8080)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT')
  server.listen(port, '0.0.0.0', () => console.log('Follower browser service ready'))
  const shutdown = () => {
    server.close(); server.closeAllConnections()
    Promise.allSettled([browser.close(), proxy.close()]).then(() => process.exit(0))
    setTimeout(() => process.exit(1), 3000).unref()
  }
  browser.once('disconnected', () => process.exit(1))
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown)
}
if (require.main === module) main().catch(() => { console.error('Follower browser service failed to start'); process.exit(1) })
module.exports = { createWorker }
