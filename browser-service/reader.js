'use strict'
const { readDouyinPage } = require('../profiles/browser')
const { identifyProfile, ProfileError } = require('../profiles/model')
const { allowedHost } = require('./egress')

function allowRequest(request, page, profile) {
  let url
  try { url = new URL(request.url()) } catch (_) { return false }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowedHost(url.hostname)) return false
  if (request.isNavigationRequest()) {
    // A redirect to login, a different account or another site is not a profile.
    if (request.frame() !== page.mainFrame()) return false
    try { return identifyProfile(url.href).profileUrl === profile.profileUrl } catch (_) { return false }
  }
  return !['media', 'image', 'font', 'websocket'].includes(request.resourceType())
}
function createBrowserReader(browser, options = {}) {
  const timeoutMs = options.timeoutMs || 12000
  return async input => {
    const profile = identifyProfile(input)
    if (profile.platform !== 'douyin') throw new ProfileError('UNSUPPORTED_PROFILE_URL')
    let context, expired = false, timer, closing
    const close = () => {
      if (!context) return Promise.resolve()
      if (!closing) {
        // Do not admit another job while an old context is still consuming resources.
        // An unresponsive Chromium is recycled by the container's restart policy.
        closing = (async () => {
          let cleanupTimer
          try {
            await Promise.race([context.close(), new Promise(resolve => {
              cleanupTimer = setTimeout(() => { void browser.close(); resolve() }, 1000)
            })])
          } catch (_) { void browser.close() } finally { clearTimeout(cleanupTimer) }
        })()
      }
      return closing
    }
    const work = (async () => {
      context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 },
        serviceWorkers: 'block', acceptDownloads: false, permissions: [] })
      if (expired) { await close(); throw new ProfileError('BROWSER_TIMEOUT') }
      const page = await context.newPage()
      // Context-wide routing also catches popup requests before they can navigate.
      await context.route('**/*', route => allowRequest(route.request(), page, profile) ? route.continue() : route.abort())
      await context.routeWebSocket('**/*', socket => socket.close())
      context.on('page', opened => { if (opened !== page) opened.close().catch(() => {}) })
      page.on('dialog', dialog => dialog.dismiss().catch(() => {}))
      await page.goto(profile.profileUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      await page.waitForFunction(() => {
        const visible = e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0
        const challenge = [...document.querySelectorAll('iframe[src*="captcha"], iframe[src*="verify"], [id*="captcha_container"], [class*="captcha_verify"]')].some(visible)
        const cards = [...document.querySelectorAll('[data-e2e="user-info"] [data-e2e="user-info-fans"]')]
        return challenge || cards.some(card => visible(card) && /^粉丝\s+\S+/.test(card.innerText.trim()))
      }, null, { timeout: timeoutMs })
      const result = await readDouyinPage(page, profile)
      return { ...result, observedAt: new Date().toISOString() }
    })()
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true
          if (!context) void browser.close()
          void close(); reject(new ProfileError('BROWSER_TIMEOUT'))
        }, timeoutMs)
      })])
    } finally { expired = true; clearTimeout(timer); await close() }
  }
}
module.exports = { createBrowserReader, allowRequest }
