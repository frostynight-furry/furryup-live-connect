'use strict'
const https = require('node:https')
const { identifyProfile, exactCount, isoTime, ProfileError } = require('./model')

const CODES = new Set(['BROWSER_INTERACTION_REQUIRED', 'EXACT_COUNT_UNAVAILABLE', 'ACCOUNT_MISMATCH', 'RATE_LIMITED', 'BROWSER_TIMEOUT', 'UPSTREAM_UNAVAILABLE'])
function serviceConfig(endpoint, token) {
  let url
  try { url = new URL(endpoint) } catch (_) { throw new ProfileError('BROWSER_NOT_CONFIGURED') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== '/v1/douyin/followers' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ||
      typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new ProfileError('BROWSER_NOT_CONFIGURED')
  return { url: url.href, token }
}
function requestBrowserService({ url, token, body }) {
  return new Promise((resolve, reject) => {
    let request, response, done = false
    const finish = (error, value) => {
      if (done) return
      done = true; clearTimeout(timer)
      if (error) { if (response) response.destroy(); if (request) request.destroy(); reject(error) } else resolve(value)
    }
    // Wall-clock deadline includes DNS, TLS, response headers and a slow body.
    const timer = setTimeout(() => finish(new ProfileError('BROWSER_TIMEOUT')), 15000)
    request = https.request(url, { method: 'POST', headers: { authorization: 'Bearer ' + token,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, incoming => {
      response = incoming
      if (incoming.statusCode === 429) return finish(new ProfileError('RATE_LIMITED'))
      if (incoming.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(incoming.headers['content-type'] || '')) return finish(new ProfileError('UPSTREAM_UNAVAILABLE'))
      let size = 0; const chunks = []
      incoming.on('data', chunk => {
        size += chunk.length
        if (size > 4096) return finish(new ProfileError('INVALID_UPSTREAM_RESPONSE'))
        chunks.push(chunk)
      })
      incoming.on('error', () => finish(new ProfileError('UPSTREAM_UNAVAILABLE')))
      incoming.on('aborted', () => finish(new ProfileError('UPSTREAM_UNAVAILABLE')))
      incoming.on('end', () => {
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (_) { finish(new ProfileError('INVALID_UPSTREAM_RESPONSE')) }
      })
    })
    request.on('error', () => finish(new ProfileError('UPSTREAM_UNAVAILABLE')))
    request.end(body)
  })
}
function createBrowserServiceReader(options) {
  // Endpoint and token come only from the host, never a submitted profile or DTO.
  const config = serviceConfig(options.endpoint, options.token)
  const request = options.request || requestBrowserService
  const now = options.now || Date.now
  return async input => {
    const profile = identifyProfile(input)
    if (profile.platform !== 'douyin') throw new ProfileError('UNSUPPORTED_PROFILE_URL')
    const result = await request({ ...config, body: JSON.stringify({ profileUrl: profile.profileUrl }) })
    if (!result || result.ok !== true) throw new ProfileError(result && CODES.has(result.errorCode) ? result.errorCode : 'UPSTREAM_UNAVAILABLE')
    const body = result.data
    if (!body || body.platform !== profile.platform || body.accountId !== profile.accountId || body.profileUrl !== profile.profileUrl) throw new ProfileError('ACCOUNT_MISMATCH')
    const observedAt = isoTime(body.observedAt)
    const age = now() - Date.parse(observedAt)
    if (age < 0 || age > 120000) throw new ProfileError('INVALID_OBSERVATION')
    return { ...profile, followerCount: exactCount(body.followerCount), observedAt }
  }
}
module.exports = { createBrowserServiceReader, requestBrowserService, serviceConfig }
