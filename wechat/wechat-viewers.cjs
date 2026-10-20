// Copyright (c) 2026 FrostyNight. See LICENSE and THIRD_PARTY_NOTICES.md.
'use strict';
const { avatarInfo } = require('../core/avatar-cache.cjs');
const { MAX_BODY } = require('./wechat-decoder.cjs');
// The official live assistant maps liveContacts from online_member to
// currentOnline. Reward infoList/recentRewardContacts are different lists.
// There is no verified pagination/completeness contract for this response.
const PATHS = new Set([
  '/cgi-bin/mmfinderassistant-bin/live/online_member',
  '/micro/live/cgi-bin/mmfinderassistant-bin/live/online_member'
]);
function isViewerListUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'channels.weixin.qq.com' &&
      !url.port && !url.username && !url.password && PATHS.has(url.pathname);
  } catch { return false; }
}
function id(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';
}
function text(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 64) : '';
}
function decodeWechatViewersResponse(body, request = {}) {
  const empty = () => ({ roomId: '', event: null });
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY) throw new Error('Invalid viewer response size');
  const roomId = id(request.liveId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) return empty();
  const response = JSON.parse(body);
  const data = response?.data;
  if (!response || response.errCode !== 0 || !data || typeof data !== 'object' ||
      Array.isArray(data) || !Array.isArray(data.liveContacts)) return empty();
  if (data.liveContacts.length > 500) throw new Error('Viewer response exceeds entry limit');
  const seen = new Set(), viewers = [];
  for (const item of data.liveContacts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const contact = item.contact && typeof item.contact === 'object' && !Array.isArray(item.contact) ? item.contact : {};
    // A display nickname is never used as a stable identity or joined to chat.
    const userId = id(contact.username);
    if (userId && seen.has(userId)) continue;
    if (userId) seen.add(userId);
    const userName = text(item.displayNickname);
    const avatar = avatarInfo(contact.headUrl, 'wechat');
    if (!userId && !userName && !avatar.avatar_url) continue;
    viewers.push({
      ...(userId && { userId }), userName: userName || '一位朋友',
      ...(avatar.avatar_url && { avatarUrl: avatar.avatar_url })
    });
  }
  return { roomId, event: { event_type: 'viewer_snapshot', viewer_snapshot: {
    source: 'wechat-online-member', presenceEvidence: 'online-list', complete: false, viewers
  } } };
}
module.exports = { isViewerListUrl, decodeWechatViewersResponse };
