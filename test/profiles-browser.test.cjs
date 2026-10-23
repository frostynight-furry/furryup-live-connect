'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { readDouyinPage, parseDouyinObservation } = require('../profiles/browser')
const { createFollowerClient } = require('../profiles/client')
const url = 'https://www.douyin.com/user/MS4wLjABsynthetic'
const observation = { profileUrl: url, cardCount: 1, followerText: '粉丝\n8650', requiresInteraction: false }
test('browser page reader accepts one exact fan card for the requested profile only', async () => {
  const result = await readDouyinPage({ evaluate: async () => observation }, url)
  assert.equal(result.followerCount, 8650)
  for (const patch of [{ followerText: '粉丝\n8.6万' }, { cardCount: 2 }, { followerText: '获赞\n8650' },
    { followerText: '粉丝\n' }, { requiresInteraction: true }, { profileUrl: url + 'different' }]) {
    assert.throws(() => parseDouyinObservation({ ...observation, ...patch }, url))
  }
})
test('optional browser provider uses public provenance and never needs an OAuth app', async () => {
  const client = createFollowerClient({ allowPublicDouyin: true, readPublicProfile: profile => readDouyinPage({ evaluate: async () => observation }, profile),
    request: async () => { throw new Error('must not call official API') } })
  const result = await client.lookup(url)
  assert.equal(result.status, 'ok'); assert.equal(result.followerCount, 8650); assert.equal(result.source, 'public_page')
  assert.equal(client.capabilities().find(item => item.platform === 'douyin').mode, 'browser_experimental')
})
test('browser verification and mismatched accounts produce no count', async () => {
  const client = createFollowerClient({ allowPublicDouyin: true, readPublicProfile: () => parseDouyinObservation({ ...observation, requiresInteraction: true }, url) })
  const result = await client.lookup(url)
  assert.equal(result.status, 'unavailable'); assert.equal(result.followerCount, null); assert.equal(result.errorCode, 'BROWSER_INTERACTION_REQUIRED')
})
