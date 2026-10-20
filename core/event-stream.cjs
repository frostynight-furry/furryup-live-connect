// Copyright (c) 2026 FrostyNight.
// Extracted from the FurryUP Studio live-connect core; see LICENSE.
'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { avatarInfo } = require('./avatar-cache.cjs');
const { normalizeEmotes } = require('./emotes.cjs');
const PLATFORMS = Object.freeze(['bilibili', 'douyin', 'kuaishou', 'wechat']);
const EVENT_TYPES = Object.freeze(['comment', 'gift', 'like', 'enter', 'follow', 'share', 'notice', 'super_chat', 'super_chat_delete', 'room_stats', 'live_status', 'entry_effect', 'viewer_snapshot', 'pk_status']);
const TYPES = new Set(EVENT_TYPES);
const clean = (value, max = 128) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
const optionalText = (value, max) => typeof value === 'string' ? clean(value, max).trim() || undefined : undefined;
// Identity must remain exact. Truncating or rounding one can point at another viewer.
const viewerId = value => typeof value === 'number'
  ? Number.isSafeInteger(value) && value > 0 ? String(value) : ''
  : typeof value === 'string' && value.length <= 128 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';
const messageId = value => typeof value === 'number'
  ? Number.isSafeInteger(value) && value >= 0 ? String(value) : ''
  : typeof value === 'string' && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';

// An observer failure must not prevent other subscribers from receiving an
// already accepted event. Preserve EventEmitter's once/off ordering, but report
// only a fixed code and channel, never application exception text or event data.
class ObserverSafeEmitter extends EventEmitter {
  emit(channel, ...args) {
    if (!['event', 'viewer-avatar', 'observer-error'].includes(channel)) return super.emit(channel, ...args);
    const listeners = this.rawListeners(channel);
    const failed = () => {
      if (channel !== 'observer-error')
        this.emit('observer-error', Object.freeze({ channel, code: 'OBSERVER_CALLBACK_FAILED' }));
    };
    for (const listener of listeners) {
      try {
        const result = listener.apply(this, args);
        if (typeof result?.then === 'function') Promise.resolve(result).catch(failed);
      } catch { failed(); }
    }
    return listeners.length > 0;
  }
}
const nonnegativeCount = (value, max = 1_000_000_000_000) => {
  // The SDK exposes some room counters as decimal strings. Do not parse rounded
  // display text such as "1.2万" or values beyond JavaScript's exact range.
  if (typeof value === 'string') {
    if (!/^\d{1,15}$/.test(value)) return undefined;
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
};
const rawPrice = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return undefined;
  const result = String(value);
  return /^\d{1,18}(?:\.\d{1,8})?$/.test(result) ? result : undefined;
};

const PK_PROTOCOLS = Object.freeze({
  kuaishou: Object.freeze({ SC_PK_STATISTIC: ['active', undefined], SC_PIP_ENDED: ['ended', 'link-ended'] }),
  douyin: Object.freeze({
    WebcastLinkMicBattleMethod: ['active', undefined], WebcastLinkmicBattleMethod: ['active', undefined],
    WebcastLinkMicBattleFinishMethod: ['ended', 'battle-finished'], WebcastLinkmicBattleFinishMethod: ['ended', 'battle-finished'],
    WebcastLinkMicArmiesMethod: ['active', 'battle-refresh'], WebcastLinkmicArmiesMethod: ['active', 'battle-refresh']
  })
});
function normalizePk(value, platform) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PK 状态无效');
  const rule = Object.hasOwn(PK_PROTOCOLS, platform) && Object.hasOwn(PK_PROTOCOLS[platform], value.protocol) ? PK_PROTOCOLS[platform][value.protocol] : null;
  if (!rule || value.phase !== rule[0] || value.reason !== rule[1]) throw new Error('PK 协议依据无效');
  const battleId = typeof value.battleId === 'string' && value.battleId.length <= 128 && value.battleId.trim() === value.battleId &&
    value.battleId.length > 0 && value.battleId !== '0' && !/[\u0000-\u001f\u007f]/.test(value.battleId) ? value.battleId : null;
  if (rule[1] !== 'link-ended' && rule[1] !== 'battle-refresh' && !battleId) throw new Error('PK 场次无效');
  if (['link-ended', 'battle-refresh'].includes(rule[1]) && value.battleId != null) throw new Error('PK 场次依据无效');
  const time = key => {
    if (value[key] === undefined) return undefined;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 8_640_000_000_000_000) throw new Error('PK 时间无效');
    return value[key];
  };
  const observedAt = time('observedAt');
  if (observedAt === undefined) throw new Error('PK 观测时间缺失');
  const result = { battleId, phase: value.phase, protocol: value.protocol, observedAt };
  if (rule[1]) result.reason = rule[1];
  for (const key of ['sourceTimestamp', 'startedAt', 'endsAt']) {
    const stamp = time(key);
    if (stamp !== undefined) result[key] = stamp;
  }
  if (result.endsAt !== undefined && (result.startedAt === undefined || result.endsAt <= result.startedAt || result.endsAt - result.startedAt > 3_600_000)) throw new Error('PK 截止时间无效');
  if (platform === 'kuaishou' && (result.startedAt !== undefined || result.endsAt !== undefined)) throw new Error('当前快手协议没有 PK 倒计时');
  for (const key of ['sourceTime', 'revision']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !/^\d{1,20}$/.test(value[key]) || BigInt(value[key]) > 18446744073709551615n) throw new Error('PK 协议数值无效');
    result[key] = value[key];
  }
  return Object.freeze(result);
}

function validateRoute(platform, roomId) {
  if (!PLATFORMS.includes(platform) || typeof roomId !== 'string' || !roomId.trim() ||
      roomId.length > 256 || /[\u0000-\u001f\u007f]/.test(roomId)) throw new TypeError('Invalid platform or roomId');
}

function normalizeEvent(raw, platform, roomId, preview = false) {
  validateRoute(platform, roomId);
  if (!PLATFORMS.includes(platform) || !TYPES.has(raw?.event_type)) throw new Error('不支持的直播事件');
  const isStats = raw.event_type === 'room_stats';
  const isViewers = raw.event_type === 'viewer_snapshot';
  const isPk = raw.event_type === 'pk_status';
  const count = isStats || isViewers || isPk ? 0 : Number(raw.event_type === 'gift' ? raw.gift_count : raw.count ?? 1);
  if (!isStats && !isViewers && !isPk && (!Number.isSafeInteger(count) || count <= 0 || count > 1_000_000)) throw new Error('互动数量无效');
  const stats = Object.fromEntries(['watching_count', 'watched_count', 'liked_count']
    .map(key => [key, nonnegativeCount(raw[key])]).filter(([, value]) => value !== undefined));
  if (isStats && !Object.keys(stats).length) throw new Error('房间统计无效');
  const liveStatus = optionalText(raw.live_status, 64);
  if (raw.event_type === 'live_status' && !liveStatus) throw new Error('直播状态无效');
  const explicitSuperChatId = typeof raw.super_chat_id === 'string' && raw.super_chat_id.length <= 20 ? raw.super_chat_id : undefined;
  const superChatId = explicitSuperChatId && /^[1-9]\d{0,19}$/.test(explicitSuperChatId) ? explicitSuperChatId :
    (raw.event_type === 'super_chat' && /^bili-super-chat:[1-9]\d{0,19}$/.test(raw.source_msg_id || '') ? raw.source_msg_id.slice(16) : undefined);
  let superChatIds;
  if (raw.event_type === 'super_chat_delete') {
    if (platform !== 'bilibili' || !Array.isArray(raw.super_chat_ids) || !raw.super_chat_ids.length || raw.super_chat_ids.length > 128)
      throw new Error('醒目留言撤回数据无效');
    superChatIds = [...new Set(raw.super_chat_ids.map(value => {
      if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('醒目留言编号无效');
      if (typeof value !== 'number' && typeof value !== 'string') throw new Error('醒目留言编号无效');
      const id = String(value);
      if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error('醒目留言编号无效');
      return id;
    }))];
  }
  const sourceMessageId = messageId(raw.source_msg_id);
  const sourceId = messageId(raw.event_id) || sourceMessageId || randomUUID();
  const giftImage = avatarInfo(raw.gift_image_url, platform);
  const rich = {};
  if (isPk) rich.pk = normalizePk(raw.pk, platform);
  if (isViewers) {
    const value = raw.viewer_snapshot;
    if (!value || typeof value !== 'object' || !Array.isArray(value.viewers) || value.viewers.length > 500 ||
        !['online-list', 'unknown'].includes(value.presenceEvidence) || typeof value.complete !== 'boolean' ||
        typeof value.source !== 'string' || !value.source.trim()) throw new Error('观众名单数据无效');
    const viewers = value.viewers.map(viewer => {
      if (!viewer || typeof viewer !== 'object' || Array.isArray(viewer)) throw new Error('观众数据无效');
      const userId = viewerId(viewer.userId);
      const userLevel = nonnegativeCount(viewer.userLevel, 1000);
      const wealthLevel = nonnegativeCount(viewer.wealthLevel, 1000);
      return Object.freeze({ ...(userId ? { userId } : {}), userName: optionalText(viewer.userName, 64) || '一位朋友',
        ...(userLevel !== undefined ? { userLevel } : {}), ...(wealthLevel !== undefined ? { wealthLevel } : {}),
        ...(typeof viewer.online === 'boolean' ? { online: viewer.online } : {}),
        ...(typeof viewer.highWealth === 'boolean' ? { highWealth: viewer.highWealth } : {}) });
    });
    const revision = nonnegativeCount(value.revision);
    rich.viewer_snapshot = Object.freeze({ source: clean(value.source, 80), presenceEvidence: value.presenceEvidence,
      complete: value.complete, ...(revision !== undefined ? { revision } : {}),
      viewers: Object.freeze(viewers) });
  }
  for (const [field, max] of Object.entries({ badge_name: 64, gift_price_unit: 32, gift_coin_type: 32, gift_unit: 16, super_chat_price_unit: 32,
    receive_user_name: 64 })) {
    const value = optionalText(raw[field], max);
    if (value) rich[field] = value;
  }
  for (const field of ['receive_user_id', 'combo_id']) {
    const value = viewerId(raw[field]);
    if (value) rich[field] = value;
  }
  for (const [field, max] of Object.entries({ badge_level: 1000, super_chat_duration: 86_400 })) {
    const value = nonnegativeCount(raw[field], max);
    if (value !== undefined) rich[field] = value;
  }
  for (const field of ['gift_price_raw', 'super_chat_price_raw']) {
    const value = rawPrice(raw[field]);
    if (value !== undefined) rich[field] = value;
  }
  if (raw.event_type === 'gift' && platform === 'bilibili' && raw.gift_kind === 'membership') {
    rich.gift_kind = 'membership';
    if (['purchase', 'renew'].includes(raw.membership_action)) rich.membership_action = raw.membership_action;
  }
  if (raw.event_type === 'super_chat' && superChatId) rich.super_chat_id = superChatId;
  if (superChatIds) rich.super_chat_ids = Object.freeze(superChatIds);
  if (giftImage.avatar_url) {
    rich.gift_image_url = giftImage.avatar_url;
    rich.gift_image_id = giftImage.avatar_id;
  }
  return Object.freeze({
    schemaVersion: 1,
    event_id: `${preview ? 'preview' : 'live'}:${platform}:${encodeURIComponent(roomId)}:${encodeURIComponent(sourceId)}`,
    source_msg_id: sourceMessageId,
    platform, room_id: roomId, event_type: raw.event_type,
    source: preview ? 'simulation' : isStats && platform === 'bilibili' && raw.stats_source === 'bilibili-online-rank-api'
      ? 'bilibili-online-rank-api' : platform === 'wechat' ? 'wechat-backstage' : 'ordinaryroad', preview,
    user_id: viewerId(raw.user_id), user_name: clean(raw.user_name || '一位朋友', 64),
    ...(raw.user_identity_hidden === true ? { user_identity_hidden: true } : {}),
    ...avatarInfo(raw.avatar_url, platform),
    content: clean(raw.content, 1000),
    emotes: Object.freeze(normalizeEmotes(raw.emotes, platform, clean(raw.content, 1000))), gift_id: viewerId(raw.gift_id),
    gift_name: clean(raw.gift_name || '未知礼物', 100),
    gift_count: raw.event_type === 'gift' ? count : 0, count,
    count_mode: isStats || isViewers || isPk ? 'snapshot' : platform === 'wechat' && raw.event_type === 'like' ? 'signal' : 'delta', value: null,
    ...rich,
    ...stats,
    ...(liveStatus && { live_status: liveStatus }),
    timestamp: Number.isSafeInteger(raw.timestamp) && raw.timestamp >= 0 && raw.timestamp <= 8_640_000_000_000_000 ? raw.timestamp : Date.now(),
    received_at: Date.now()
  });
}

class LiveEventStream extends ObserverSafeEmitter {
  constructor() { super(); this.seen = new Map(); this.history = []; this.sequence = 0; this.accepted = 0; this.duplicates = 0; }
  push(raw, platform, roomId, preview = false, enrichAvatar) {
    const event = normalizeEvent(raw, platform, roomId, preview);
    const now = Date.now();
    for (const [id, time] of this.seen) { if (now - time > 600_000) this.seen.delete(id); else break; }
    if (this.seen.has(event.event_id)) { this.duplicates++; return null; }
    // Only validated, nonduplicate events may seed a viewer identity cache. A
    // metadata hook can supply an avatar; it cannot replace message identities.
    const metadata = enrichAvatar ? avatarInfo(enrichAvatar(event)?.avatar_url, platform) : {};
    this.seen.set(event.event_id, now);
    while (this.seen.size > 20_000) this.seen.delete(this.seen.keys().next().value);
    const item = Object.freeze({ ...event, ...metadata, sequence: ++this.sequence });
    this.accepted++;
    // Statistics are state snapshots, not actions to replay in a message feed.
    if (item.event_type === 'super_chat_delete') {
      const removed = new Set(item.super_chat_ids);
      this.history = this.history.filter(previous => previous.platform !== item.platform || previous.room_id !== item.room_id ||
        previous.preview !== item.preview || previous.event_type !== 'super_chat' || !removed.has(previous.super_chat_id));
    } else if (!['room_stats', 'viewer_snapshot', 'pk_status'].includes(item.event_type)) {
      this.history.push(item);
      if (this.history.length > 100) this.history.shift();
    }
    this.emit('event', item);
    return item;
  }
  updateViewerAvatar(event, value) {
    // Avatar hydration is metadata, not another interaction. Keep the original
    // message identity for output moderation and never replay gifts or counters.
    if (!event || event.preview || event.platform !== 'kuaishou' || event.event_type !== 'comment' ||
        event.user_identity_hidden === true || typeof event.user_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.user_id) ||
        ['0', 'outside', 'unknown', 'anonymous'].includes(event.user_id.toLowerCase()) ||
        !this.history.some(item => item.event_id === event.event_id && item.sequence === event.sequence &&
          item.platform === event.platform && item.room_id === event.room_id && item.user_id === event.user_id &&
          !item.preview && item.user_identity_hidden !== true)) return false;
    const info = avatarInfo(value?.avatar_url, event.platform);
    if (!info.avatar_id) return false;
    this.history = this.history.map(item => item.platform === event.platform && item.room_id === event.room_id &&
      item.user_id === event.user_id && !item.preview && item.user_identity_hidden !== true && !item.avatar_id
      ? Object.freeze({ ...item, ...info }) : item);
    this.emit('viewer-avatar', Object.freeze({ ...event, ...info }));
    return true;
  }
  clear() { this.history = []; }
  forgetRoom(platform, roomId) {
    validateRoute(platform, roomId);
    this.history = this.history.filter(item => item.platform !== platform || item.room_id !== roomId);
    for (const id of this.seen.keys()) {
      if (['live', 'preview'].some(mode => id.startsWith(`${mode}:${platform}:${encodeURIComponent(roomId)}:`))) this.seen.delete(id);
    }
  }
}
module.exports = { PLATFORMS, EVENT_TYPES, LiveEventStream, normalizeEvent, validateRoute, ObserverSafeEmitter };
