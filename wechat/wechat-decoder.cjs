'use strict';
// Message types documented by fire4nt/wxlivespy (MIT); see THIRD_PARTY_NOTICES.
// Current notice types and liveStatus are also confirmed by the official
// video-account assistant's 26092402 build (module 44704 / updateAppList):
// https://res.wx.qq.com/t/wx_fed/finder/helper/live/finder-helper-live/res/static/js/async/969.9949886a.js
// 20125 is a generic interaction notice: wording is display text, not a share
// discriminator. Never infer a paid action or share from that text.
const MAX_BODY = 2 * 1024 * 1024;
const LIVE_URL = 'https://channels.weixin.qq.com/platform/live/liveBuild';
const MESSAGE_PATHS = new Set([
  '/cgi-bin/mmfinderassistant-bin/live/msg',
  '/micro/live/cgi-bin/mmfinderassistant-bin/live/msg'
]);
function isMessageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'channels.weixin.qq.com' && !url.port &&
      !url.username && !url.password && MESSAGE_PATHS.has(url.pathname);
  } catch { return false; }
}
function identifier(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
  return typeof value === 'string' && value.length <= 128 && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : '';
}
function counter(value) {
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000 ? value : undefined;
}
function boundedText(value, max = 1000) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
}
function liveStatus(value) {
  const status = counter(value);
  return status === 0 ? 'ended' : status === 1 ? 'started' : status === 2 ? 'waiting' : '';
}
function payload(value) {
  if (typeof value !== 'string' || !value || value.length > 128 * 1024) throw new Error('Invalid payload');
  const result = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid payload');
  return result;
}
function identity(message, kind, contact = message) {
  const sourceId = identifier(message.clientMsgId) || identifier(message.localClientMsgId) || (identifier(message.seq) ? `${kind}:${identifier(message.seq)}` : '');
  return { source_msg_id: sourceId, user_id: identifier(contact.username),
    user_name: boundedText(contact.nickname, 64),
    avatar_url: boundedText(contact.headUrl || contact.headImgUrl, 2048) };
}
// Official assistant badgeInfos enums; unknown types/role values stay absent.
// These are labels on this message, not permissions or a persistent viewer profile.
function userBadges(contact) {
  const badges = [];
  for (const item of (Array.isArray(contact?.badgeInfos) ? contact.badgeInfos : []).slice(0, 32)) {
    if (!item || typeof item !== 'object') continue;
    const type = counter(item.badgeType), level = counter(item.badgeLevel);
    if (type === 5) {
      const label = ({ 1: '主播', 3: '助手', 4: '助手', 5: '主播', 10: '房管' })[level];
      if (label) badges.push({ kind: 'role', label });
    } else if ((type === 2 || type === 4) && level > 0 && level <= 1000) {
      badges.push({ kind: type === 2 ? 'wealth' : 'fans', label: type === 2 ? '等级' : '亲密度', level });
    } else if (type === 12) badges.push({ kind: 'membership', label: '超级粉丝' });
  }
  return badges.length ? { user_badges: badges } : {};
}
function decodeWechatResponse(body, request = {}) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BODY) throw new Error('Invalid response');
  const response = JSON.parse(body);
  if (!response || typeof response !== 'object' || response.errCode !== 0) return { error: 'LOGIN_OR_PROTOCOL', events: [], roomId: '' };
  const data = response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response');
  const info = data.liveInfo && typeof data.liveInfo === 'object' && !Array.isArray(data.liveInfo) ? data.liveInfo : {};
  // A present but invalid/mismatched room ID must not be replaced by another
  // request's route. Only a genuinely omitted response ID may use its request.
  const hasResponseRoom = Object.hasOwn(info, 'liveId');
  const hasRequestRoom = Object.hasOwn(request, 'liveId') && request.liveId !== undefined;
  const responseRoomId = identifier(info.liveId), requestRoomId = identifier(request.liveId);
  const roomId = hasResponseRoom ? responseRoomId : requestRoomId;
  if (hasRequestRoom && (!requestRoomId || hasResponseRoom && responseRoomId !== requestRoomId))
    return { events: [], roomId: '', errors: 0 };
  if (!roomId || !/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) return { events: [], roomId: '', errors: 0 };
  const events = [];
  let errors = 0, giftCallbacks = 0, giftParseErrors = 0;
  for (const message of (Array.isArray(data.msgList) ? data.msgList : []).slice(0, 2000)) {
    if (!message || typeof message !== 'object') { errors++; continue; }
    const type = counter(message.type);
    if (type !== 1 && type !== 10005) continue;
    if (type === 1 && typeof message.content !== 'string') { errors++; continue; }
    const contact = message.finderLiveContact?.contact;
    const viewer = { username: message.username || contact?.username,
      nickname: contact?.nickname || message.nickname,
      headUrl: contact?.headUrl || contact?.headImgUrl || message.headUrl || message.headImgUrl };
    events.push({ ...identity(message, 'msg', viewer), ...userBadges(message.finderLiveContact),
      event_type: type === 1 ? 'comment' : 'enter', content: boundedText(message.content) });
  }
  for (const message of (Array.isArray(data.appMsgList) ? data.appMsgList : []).slice(0, 2000)) {
    if (!message || typeof message !== 'object') { errors++; continue; }
    const type = counter(message.msgType);
    // 20013 is a combo-total notification, not another paid gift increment.
    // Count confirmed 20009 rewards only; never award both for the same gift.
    if (![20009, 20006, 20078, 20122, 20125].includes(type)) continue;
    const from = message.fromUserContact || {};
    const contact = from.contact || {};
    const user = { ...identity(message, 'app', { ...contact, nickname: contact.nickname || from.displayNickname }), ...userBadges(from) };
    if (type === 20006) { events.push({ ...user, event_type: 'like', count: 1, count_mode: 'signal' }); continue; }
    if (type !== 20009) {
      try {
        const notice = payload(message.payload);
        const wording = boundedText(notice.wording);
        if (type === 20125 && !wording.trim()) throw new Error('Invalid notice');
        events.push({ ...user, event_type: type === 20078 ? 'follow' : type === 20122 ? 'like' : 'notice',
          content: wording, count: 1, ...(type === 20122 && { count_mode: 'signal' }) });
      } catch { errors++; }
      continue;
    }
    giftCallbacks++;
    try {
      const gift = payload(message.payload);
      const count = counter(gift.reward_product_count);
      const giftId = identifier(gift.reward_product_id);
      if (!giftId || !count || count > 1_000_000) throw new Error('Invalid gift');
      events.push({ ...user, event_type: 'gift', gift_id: giftId, gift_count: count,
        gift_name: boundedText(gift.reward_product_name, 100),
        content: boundedText(gift.content),
        gift_price_raw: gift.reward_amount_in_wecoin, gift_price_unit: 'wechat_bean' });
    } catch { errors++; giftParseErrors++; }
  }
  const stats = Object.fromEntries([['onlineCnt', 'watching_count'], ['likeCnt', 'liked_count']]
    .map(([key, target]) => [target, counter(info[key])]).filter(([, value]) => value !== undefined));
  if (Object.keys(stats).length) events.push({ event_type: 'room_stats', ...stats });
  // This is a snapshot. The collector emits it only on the first valid value or
  // a change, rather than adding a fresh live-status event on every long poll.
  return { roomId, events, liveStatus: liveStatus(info.liveStatus), errors, giftCallbacks, giftParseErrors };
}
module.exports = { decodeWechatResponse, isMessageUrl, LIVE_URL, MAX_BODY };
