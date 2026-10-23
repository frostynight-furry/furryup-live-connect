'use strict'
const { createFollowerClient } = require('./client')
const { createBrowserServiceReader } = require('./service-client')

function createConfiguredFollowerClient(env = process.env, overrides = {}) {
  if (env.FUP_FOLLOWER_SYNC !== 'enabled') return null
  let readPublicProfile
  if (env.FUP_FOLLOWER_DOUYIN_BROWSER === 'enabled') {
    try { readPublicProfile = createBrowserServiceReader({ endpoint: env.FUP_BROWSER_SERVICE_URL, token: env.FUP_BROWSER_SERVICE_TOKEN, ...overrides }) }
    catch (_) { /* A bad optional provider must not disable the rest of fupAccounts. */ }
  }
  return createFollowerClient({
    allowPublicBilibili: env.FUP_FOLLOWER_BILIBILI === 'enabled',
    allowPublicXiaohongshu: env.FUP_FOLLOWER_XIAOHONGSHU === 'enabled',
    allowPublicDouyin: true, readPublicProfile
  })
}
module.exports = { createConfiguredFollowerClient }
