'use strict'
// Uses a real Chromium with synthetic HTML fulfilled locally. No platform requests.
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const { createBrowserReader } = require('../browser-service/reader')
const { createWorker } = require('../browser-service/server')
const { createBrowserServiceReader } = require('../profiles/service-client')
const { createFollowerClient } = require('../profiles/client')
async function main() {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: process.platform === 'linux', executablePath: process.env.BROWSER_EXECUTABLE || undefined })
  const token = 'synthetic_local_fixture_'.repeat(3)
  let html = '<main data-e2e="user-info"><div data-e2e="user-info-follow">关注 155</div><div data-e2e="user-info-fans"><div>粉丝</div><div>8650</div></div><div data-e2e="user-info-like">获赞 7.2万</div></main>'
  let reads = 0
  const fixtureBrowser = { close: () => browser.close(), async newContext(options) {
    reads++
    const context = await browser.newContext(options), route = context.route.bind(context)
    context.route = (pattern, handler) => route(pattern, actual => handler({ request: () => actual.request(), abort: () => actual.abort(),
      continue: () => actual.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }) }))
    return context
  } }
  const server = createWorker({ token, readProfile: createBrowserReader(fixtureBrowser) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const readPublicProfile = createBrowserServiceReader({ endpoint: 'https://browser.example.com/v1/douyin/followers', token,
      request: async ({ body, token: auth }) => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/douyin/followers', {
          method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' }, body
        })
        assert.equal(response.status, 200); return response.json()
      } })
    const client = createFollowerClient({ allowPublicDouyin: true, readPublicProfile })
    const profileUrl = 'https://www.douyin.com/user/MS4wLjABsynthetic'
    const result = await client.lookup(profileUrl)
    assert.equal(result.status, 'ok'); assert.equal(result.followerCount, 8650); assert.equal(result.source, 'public_page')
    assert.equal((await client.lookup(profileUrl)).fetchedAt, result.fetchedAt); assert.equal(reads, 1)
    const direct = createBrowserReader(fixtureBrowser)
    html = '<div data-e2e="user-info"><div data-e2e="user-info-fans">粉丝</div></div><script>setTimeout(() => document.querySelector(\'[data-e2e="user-info-fans"]\').innerText = "粉丝 0", 200)</script>'
    assert.equal((await direct(profileUrl)).followerCount, 0)
    html = '<div data-e2e="user-info"><div data-e2e="user-info-fans">粉丝 8.6万</div></div>'
    await assert.rejects(direct(profileUrl), { code: 'EXACT_COUNT_UNAVAILABLE' })
    html = '<div id="captcha_container">合成验证码页面</div>'
    await assert.rejects(direct(profileUrl), { code: 'BROWSER_INTERACTION_REQUIRED' })
    assert.equal(browser.contexts().length, 0)
    console.log('PASS real Chromium synthetic fixture: HTTP worker -> DOM count -> host client; rounded/CAPTCHA rejection; isolated context cleanup. No platform contacted.')
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
