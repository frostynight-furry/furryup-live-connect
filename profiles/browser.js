'use strict'
const { identifyProfile, exactCount, ProfileError } = require('./model')

function parseDouyinObservation(observation, input) {
  const profile = identifyProfile(input)
  if (profile.platform !== 'douyin') throw new ProfileError('UNSUPPORTED_PROFILE_URL')
  if (!observation || observation.requiresInteraction) throw new ProfileError('BROWSER_INTERACTION_REQUIRED')
  const observed = identifyProfile(observation.profileUrl)
  if (observed.platform !== profile.platform || observed.accountId !== profile.accountId) throw new ProfileError('ACCOUNT_MISMATCH')
  // Read only the selected profile's fan card, never recommendations or likes.
  const text = typeof observation.followerText === 'string' ? observation.followerText.trim() : ''
  const match = /^粉丝\s+(0|[1-9][0-9]{0,10})$/.exec(text)
  if (!match || observation.cardCount !== 1) throw new ProfileError('EXACT_COUNT_UNAVAILABLE')
  return { ...profile, followerCount: exactCount(match[1]) }
}
// The host supplies an already-open Playwright-like page. No browser launch,
// cookie extraction, account login, verification solving or hidden-state access.
async function readDouyinPage(page, input) {
  const observation = await page.evaluate(() => {
    const cards = document.querySelectorAll('[data-e2e="user-info"] [data-e2e="user-info-fans"]')
    const visible = element => !!element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
    const challenge = Array.from(document.querySelectorAll('iframe[src*="captcha"], iframe[src*="verify"], [id*="captcha_container"], [class*="captcha_verify"]')).some(visible)
    return { profileUrl: location.href, cardCount: cards.length, followerText: cards.length === 1 && visible(cards[0]) ? cards[0].innerText : '', requiresInteraction: challenge }
  })
  return parseDouyinObservation(observation, input)
}
module.exports = { readDouyinPage, parseDouyinObservation }
