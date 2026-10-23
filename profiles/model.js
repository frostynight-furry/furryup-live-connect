'use strict'

// Portable, dependency-free account model. No network or platform credentials.
const PROFILE_PLATFORMS = Object.freeze(['bilibili', 'douyin', 'kuaishou', 'wechat_channels', 'xiaohongshu'])
const SOURCES = Object.freeze(['public_api', 'official_api', 'public_page'])
class ProfileError extends Error {
  constructor(code) { super(code); this.name = 'ProfileError'; this.code = code }
}
function reject(code) { throw new ProfileError(code) }
function identifyProfile(input) {
  const value = typeof input === 'string' ? { profileUrl: input } : input
  if (!value || typeof value.profileUrl !== 'string' || value.profileUrl.length > 500) reject('INVALID_PROFILE_URL')
  const url = value.profileUrl.trim()
  // Reject credentials, IPs, ports, escaped hostnames and arbitrary URLs before any I/O.
  const match = /^https:\/\/([a-z0-9.-]+)(\/[^\s\\#]*)?(?:#[^\s]*)?$/i.exec(url)
  if (!match) reject('INVALID_PROFILE_URL')
  const host = match[1].toLowerCase(), path = (match[2] || '/').split('?')[0].replace(/\/$/, '')
  if (['b23.tv', 'v.douyin.com', 'v.kuaishou.com', 'xhslink.com'].includes(host)) reject('FULL_PROFILE_URL_REQUIRED')
  let platform, accountId, canonical
  let found
  if ((host === 'space.bilibili.com' && (found = /^\/([1-9][0-9]{0,19})$/.exec(path))) ||
      (host === 'm.bilibili.com' && (found = /^\/space\/([1-9][0-9]{0,19})$/.exec(path)))) {
    platform = 'bilibili'; accountId = found[1]; canonical = 'https://space.bilibili.com/' + accountId
  } else if ((['www.douyin.com', 'douyin.com'].includes(host) && (found = /^\/user\/(MS4wLjAB[A-Za-z0-9_-]{1,180})$/.exec(path))) ||
      (host === 'www.iesdouyin.com' && (found = /^\/share\/user\/(MS4wLjAB[A-Za-z0-9_-]{1,180})$/.exec(path)))) {
    platform = 'douyin'; accountId = found[1]; canonical = 'https://www.douyin.com/user/' + accountId
  } else if ((['www.kuaishou.com', 'kuaishou.com', 'live.kuaishou.com'].includes(host) && (found = /^\/profile\/([A-Za-z0-9_-]{1,128})$/.exec(path))) ||
      (host === 'c.kuaishou.com' && (found = /^\/fw\/user\/([A-Za-z0-9_-]{1,128})$/.exec(path)))) {
    platform = 'kuaishou'; accountId = found[1]; canonical = 'https://www.kuaishou.com/profile/' + accountId
  } else if (['www.xiaohongshu.com', 'xiaohongshu.com'].includes(host) && (found = /^\/user\/profile\/([a-f0-9]{24})$/i.exec(path))) {
    platform = 'xiaohongshu'; accountId = found[1].toLowerCase(); canonical = 'https://www.xiaohongshu.com/user/profile/' + accountId
  } else if (host === 'channels.weixin.qq.com') {
    // This identifies a source only. Channels does not expose a universal profile URL/ID API.
    platform = 'wechat_channels'; accountId = ''; canonical = url.split('#')[0]
  } else reject('UNSUPPORTED_PROFILE_URL')
  const expected = value.platform === 'wechat' ? 'wechat_channels' : value.platform
  if (expected && expected !== platform) reject('PLATFORM_MISMATCH')
  return { platform, accountId, profileUrl: canonical }
}
function exactCount(value) {
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,10})$/.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000000000) reject('EXACT_COUNT_UNAVAILABLE')
  return value
}
function isoTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) reject('INVALID_OBSERVATION')
  return value
}
function snapshot(value, count) {
  if (!value || !SOURCES.includes(value.source)) reject('INVALID_OBSERVATION')
  const followerCount = exactCount(value.followerCount)
  if (count !== undefined && followerCount !== count) reject('INVALID_OBSERVATION')
  return { followerCount, source: value.source, fetchedAt: isoTime(value.fetchedAt), dataAsOf: isoTime(value.dataAsOf) }
}
function history(values) {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length > 2) reject('INVALID_OBSERVATION')
  const days = new Map()
  values.forEach(value => {
    const row = snapshot(value)
    if (row.dataAsOf > row.fetchedAt) reject('INVALID_OBSERVATION')
    const day = row.dataAsOf.slice(0, 10), previous = days.get(day)
    if (!previous || row.dataAsOf > previous.dataAsOf || row.dataAsOf === previous.dataAsOf && row.fetchedAt > previous.fetchedAt) days.set(day, row)
  })
  return Array.from(days.values()).sort((a, b) => a.dataAsOf.localeCompare(b.dataAsOf)).slice(-2)
}
function appendHistory(values, observation) {
  const row = snapshot(observation)
  const previous = history(values).filter(item => item.dataAsOf.slice(0, 10) !== row.dataAsOf.slice(0, 10))
  const sameDay = history(values).find(item => item.dataAsOf.slice(0, 10) === row.dataAsOf.slice(0, 10))
  const latest = sameDay && (sameDay.dataAsOf > row.dataAsOf || sameDay.dataAsOf === row.dataAsOf && sameDay.fetchedAt > row.fetchedAt) ? sameDay : row
  return history(previous.concat(latest).sort((a, b) => a.dataAsOf.localeCompare(b.dataAsOf)).slice(-2))
}
function preserveSnapshots(accounts, previous) {
  return (accounts || []).map(account => {
    const result = { ...account }
    delete result.followerSnapshot
    delete result.followerHistory
    const old = (previous || []).find(item => item.platform === account.platform && item.profileUrl === account.profileUrl && item.followerCount === account.followerCount)
    if (old && old.followerSnapshot) result.followerSnapshot = snapshot(old.followerSnapshot, old.followerCount)
    const sameAccount = (previous || []).find(item => item.platform === account.platform && item.profileUrl === account.profileUrl)
    if (sameAccount && sameAccount.followerHistory) result.followerHistory = history(sameAccount.followerHistory)
    return result
  })
}
const STATUS_TEXT = Object.freeze({
  ok: '粉丝数已更新到草稿，审核发布后公开。',
  manual_required: '该平台暂未接通自动获取，可手动填写粉丝数。',
  authorization_required: '需要先完成该平台账号授权，原粉丝数已保留。',
  not_configured: '粉丝数服务尚未配置，原粉丝数已保留。',
  unavailable: '暂时无法取得准确粉丝数，原粉丝数已保留。',
  rate_limited: '请求较频繁，请稍后再试，原粉丝数已保留。',
  demo_disabled: '演示模式不访问外部平台，也不生成虚构粉丝数。'
})
module.exports = { PROFILE_PLATFORMS, SOURCES, ProfileError, identifyProfile, exactCount, isoTime, snapshot, history, appendHistory, preserveSnapshots, STATUS_TEXT }
