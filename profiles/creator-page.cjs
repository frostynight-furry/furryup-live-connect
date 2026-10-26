// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';

// Creator-page locations were researched against QianFan Sync (see docs/CREATOR_FOLLOWERS.md
// for research and attribution). This adapter is independently implemented for Electron hosts;
// no publisher, Python runtime, stealth browser or upstream parser is bundled.
const kuaishouCallback = new URL('https://cp.kuaishou.com/rest/infra/sts');
kuaishouCallback.search = new URLSearchParams({ followUrl: 'https://cp.kuaishou.com/profile', setRootDomain: 'true' }).toString();
const kuaishouLogin = new URL('https://passport.kuaishou.com/pc/account/login/');
kuaishouLogin.search = new URLSearchParams({ sid: 'kuaishou.web.cp.api', callback: kuaishouCallback.href }).toString();
const PLATFORMS = Object.freeze({
  bilibili: { url: 'https://member.bilibili.com/platform/home', hosts: ['member.bilibili.com', 'passport.bilibili.com', 'account.bilibili.com', 'www.bilibili.com'], name: 'B站' },
  douyin: { url: 'https://creator.douyin.com/creator-micro/home', hosts: ['creator.douyin.com', 'www.douyin.com', 'sso.douyin.com'], name: '抖音' },
  kuaishou: { url: 'https://cp.kuaishou.com/profile', loginUrl: kuaishouLogin.href, hosts: ['cp.kuaishou.com', 'passport.kuaishou.com'], name: '快手' },
  wechat_channels: { url: 'https://channels.weixin.qq.com/platform', hosts: ['channels.weixin.qq.com', 'open.weixin.qq.com'], name: '视频号' },
  xiaohongshu: { url: 'https://creator.xiaohongshu.com/new/home', hosts: ['creator.xiaohongshu.com', 'customer.xiaohongshu.com'], name: '小红书' }
});
function allowedNavigation(platform, address) {
  try { const u = new URL(address); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && PLATFORMS[platform]?.hosts.includes(u.hostname); }
  catch { return false; }
}
function parseCount(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const raw = value.trim().replace(/\u00a0/g, ' ');
  if (/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:[,，]\d{3})+)$/.test(raw)) {
    const count = Number(raw.replace(/[,，]/g, ''));
    return Number.isSafeInteger(count) && count <= 10000000000 ? { precision: 'exact', followerCount: count } : null;
  }
  // Preserve rounded notation; never turn it into an exact integer.
  if (/^(?:0|[1-9]\d*)(?:\.\d{1,3})?\s*(?:万|亿|[kKmMbB])\+?$/.test(raw) || /^(?:0|[1-9]\d*)\+$/.test(raw)) {
    return { precision: 'approximate', displayCount: raw };
  }
  return null;
}
function cleanIdentity(kind, value, name = '') {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) value = String(value);
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.@:-]{1,200}$/.test(value) || value === '0') return null;
  return { kind, value, displayName: typeof name === 'string' ? name.replace(/[\x00-\x1f]/g, '').slice(0, 80) : '' };
}
// Only self-information responses on specific official hosts qualify. Never
// inspect arbitrary API bodies, cookies, request headers or another user's page.
function identityResponseKind(platform, address) {
  let u; try { u = new URL(address); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const p = u.pathname.replace(/\/$/, '');
  if (platform === 'wechat_channels' && u.hostname === 'channels.weixin.qq.com' && p === '/cgi-bin/mmfinderassistant-bin/auth/auth_data') return 'finder';
  if (platform === 'bilibili' && u.hostname === 'api.bilibili.com' && p === '/x/web-interface/nav') return 'bili';
  if (platform === 'xiaohongshu' && u.hostname === 'edith.xiaohongshu.com' && p === '/api/sns/web/v1/user/selfinfo') return 'xhs';
  if (platform === 'xiaohongshu' && u.hostname === 'creator.xiaohongshu.com' && p === '/api/galaxy/creator/home/personal_info') return 'xhs-creator';
  if (platform === 'xiaohongshu' && u.hostname === 'creator.xiaohongshu.com' && p === '/api/galaxy/user/info') return 'xhs-creator';
  if (platform === 'kuaishou' && u.hostname === 'cp.kuaishou.com' && p === '/rest/v2/creator/pc/authority/account/current') return 'ks-self';
  if (platform === 'kuaishou' && u.hostname === 'cp.kuaishou.com' && p === '/rest/cp/creator/pc/home/userInfo') return 'ks-stats';
  return null;
}
function identityFromResponse(kind, body) {
  if (!body || typeof body !== 'object') return null;
  if (kind === 'finder' && body.errCode === 0) {
    const user = body.data?.finderUser, identity = cleanIdentity('finder', user?.finderUsername, user?.nickname);
    const count = parseCount(typeof user?.fansCount === 'number' ? String(user.fansCount) : user?.fansCount);
    return identity && count ? { ...identity, count } : identity;
  }
  if (kind === 'bili' && body.code === 0 && body.data?.isLogin === true) return cleanIdentity('uid', body.data.mid, body.data.uname);
  if (['xhs', 'xhs-creator'].includes(kind) && (body.success === true || body.code === 0)) {
    const data = body.data?.personal_info || body.data;
    return cleanIdentity('user_id', data?.user_id || data?.userId, data?.nickname || data?.userName || data?.name);
  }
  if (kind === 'ks-self' && body.result === 1 && body.data?.logined === true) return cleanIdentity('user_id', body.data.userId, body.data.userName);
  if (kind === 'ks-stats' && body.result === 1) {
    const user = body.data?.coreUserInfo, identity = cleanIdentity('user_id', user?.userId, user?.userName);
    if (identity) return { ...identity, count: parseCount(typeof user.fansNum === 'number' ? String(user.fansNum) : user.fansNum) };
  }
  return null;
}

// Runs in an isolated world in the official creator page. Return bounded,
// selected display fields only. No host bridge or credentials are exposed.
function readCreatorPage(platform) {
  const visible = el => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = el => (el?.textContent || '').trim().slice(0, 300);
  const all = selector => Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, 80);
  const results = [];
  const add = value => { if (typeof value === 'string' && value.length <= 40 && value.trim()) results.push(value.trim()); };
  const labeled = (items, label, numberSelector) => {
    for (const card of items) {
      if (!label.test(text(card))) continue;
      const number = card.querySelector(numberSelector);
      if (visible(number)) add(text(number));
    }
  };
  if (platform === 'bilibili') labeled(all('.fan-item'), /粉丝总数|Total followers/i, '.fan-num');
  if (platform === 'douyin') {
    for (const card of all('[class*="statics-item-"], [data-e2e="user-info-fans"]')) {
      const full = text(card);
      if (!/粉丝|followers/i.test(full)) continue;
      const candidates = Array.from(card.querySelectorAll('span')).filter(visible).map(text).filter(s => /^[\d,，.]+\s*[万亿kKmMbB]?\+?$/.test(s));
      if (candidates.length === 1) add(candidates[0]);
      else add(full.replace(/粉丝|followers/gi, '').trim());
    }
  }
  if (platform === 'kuaishou') {
    const cards = all('.user-cnt__item');
    // Only open the account-information popover; never click publish controls.
    if (!cards.length) {
      const trigger = all('.user-info-dpd')[0];
      if (trigger && !document.querySelector('[data-fus-follower-opened]')) { trigger.setAttribute('data-fus-follower-opened', 'true'); trigger.click(); }
    }
    for (const card of cards) {
      if (!Array.from(card.querySelectorAll('span')).some(el => /^(粉丝|followers)$/i.test(text(el)))) continue;
      add(Array.from(card.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim());
    }
  }
  if (platform === 'wechat_channels') labeled(all('.finder-content-info > div'), /关注者|followers/i, '.finder-info-num');
  if (platform === 'xiaohongshu') {
    for (const num of all('.numerical')) {
      if (/粉丝数|followers/i.test(text(num.parentElement))) add(text(num));
    }
  }
  // Handles are obtained only from the creator's account header/card, never a
  // follower list or an arbitrary profile link elsewhere on the page.
  const scopes = { bilibili: '.header-entry-mini, .user-info', douyin: '[class*="user-info"], [class*="account-info"], [class*="userInfo"]',
    kuaishou: '.header-info-card, .user-info-dpd, .profile-info', wechat_channels: '.finder-content-info', xiaohongshu: '.user-info, .account-info, .personal-info' };
  const patterns = { bilibili: /(?:UID)\s*[:：]?\s*([1-9]\d{0,19})/i, douyin: /抖音号\s*[:：]?\s*([A-Za-z0-9_.-]{1,128})/,
    kuaishou: /快手号\s*[:：]?\s*([A-Za-z0-9_.-]{1,128})/, xiaohongshu: /小红书号\s*[:：]?\s*([A-Za-z0-9_.-]{1,128})/ };
  const identities = patterns[platform] ? all(scopes[platform]).map(el => patterns[platform].exec(text(el))?.[1]).filter(Boolean) : [];
  const uniqueIdentities = [...new Set(identities)];
  const names = { bilibili: '.nickname, .user-name', douyin: '[class*="name-"]', kuaishou: '.user-info-name, .header-info-card .user-name', wechat_channels: '.finder-nickname, .finder-name', xiaohongshu: '.user-name, .nickname' };
  const body = (document.body?.innerText || '').slice(0, 12000);
  const challenge = /请完成安全验证|拖动滑块|安全验证|请先完成身份验证|验证码错误|verify you are human/i.test(body);
  const login = /\/login(?:[/?#]|$)|\/passport(?:[/?#]|$)/i.test(location.href) || (!results.length && /扫码登录|短信登录|请先登录|立即登录|微信扫码|Sign in to/i.test(body));
  return { counts: results.slice(0, 10), handle: uniqueIdentities.length === 1 ? uniqueIdentities[0] : '',
    displayName: text(all(names[platform])[0]).slice(0, 80), challenge, login };
}
module.exports = { PLATFORMS, allowedNavigation, parseCount, cleanIdentity, identityResponseKind, identityFromResponse, readCreatorPage };
