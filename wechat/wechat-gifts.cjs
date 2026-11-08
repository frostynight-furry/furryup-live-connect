'use strict';
// Copyright (c) 2026 FrostyNight. See LICENSE and THIRD_PARTY_NOTICES.md.
//
// Independently implemented from the public official assistant's field usage:
// 805.b6dd9a5a.js: /live/gift_enum_list -> data.giftList.
// 794.72f12fb9.js: rewardProductId -> thumbnailFileUrl in getGiftImage.
// https://res.wx.qq.com/t/wx_fed/finder/helper/live/finder-helper-live/res/static/js/async/794.72f12fb9.js
// SHA256: 5a3ce6f292eafbb6801dd3e3c7b374536e215f4219bfca299ec3287d17d9fdf1
// No third-party source or gift catalogue is bundled. This reads only a catalogue
// already requested by the authorized official page; it never initiates a request.
const { avatarInfo } = require('../core/avatar-cache.cjs');
const { MAX_BODY } = require('./wechat-decoder.cjs');
const PATHS = new Set([
  '/cgi-bin/mmfinderassistant-bin/live/gift_enum_list',
  '/micro/live/cgi-bin/mmfinderassistant-bin/live/gift_enum_list'
]);
const MAX_CATALOG_ITEMS = 2048;
function isGiftCatalogUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'channels.weixin.qq.com' &&
      !url.port && !url.username && !url.password && PATHS.has(url.pathname);
  } catch { return false; }
}
function exactId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
  return typeof value === 'string' && value.length <= 128 && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : '';
}
function metadataRoomId(value) {
  const id = exactId(value);
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : '';
}
function decodeWechatGiftCatalog(body, request = {}) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BODY) throw new Error('Invalid gift catalogue');
  const roomId = metadataRoomId(request.liveId);
  if (!roomId) return null;
  const response = JSON.parse(body);
  if (response?.errCode !== 0 || !Array.isArray(response.data?.giftList) ||
    response.data.giftList.length > MAX_CATALOG_ITEMS) return null;
  const gifts = new Map(), conflicts = new Set();
  for (const row of response.data.giftList) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = exactId(row.rewardProductId);
    if (!id || conflicts.has(id)) continue;
    // The shared allowlist currently permits qpic.cn / qlogo.cn. Other CDNs
    // remain unavailable until their provenance is confirmed by a real sample.
    const image = avatarInfo(row.thumbnailFileUrl, 'wechat').avatar_url;
    if (!image) continue;
    if (gifts.has(id) && gifts.get(id) !== image) { gifts.delete(id); conflicts.add(id); }
    else gifts.set(id, image);
  }
  return { roomId, gifts };
}
function limit(value, fallback, max) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}
class WechatGiftCatalog {
  constructor({ now = Date.now, ttlMs = 30 * 60_000, maxRooms = 8, maxEntries = 512 } = {}) {
    this.now = now; this.ttlMs = limit(ttlMs, 30 * 60_000, 24 * 60 * 60_000);
    this.maxRooms = limit(maxRooms, 8, 8); this.maxEntries = limit(maxEntries, 512, 512);
    this.rooms = new Map(); this.details = new Map();
  }
  prune() {
    const now = this.now();
    // Keep the small ordering watermark until capacity eviction so a delayed
    // response cannot refresh an already expired older catalogue.
    for (const snapshot of this.rooms.values()) if (snapshot.expiresAt <= now) snapshot.gifts.clear();
    for (const entries of this.details.values()) for (const entry of entries.values())
      if (entry.expiresAt <= now) { delete entry.gift_name; delete entry.gift_image_url; }
  }
  ingest(body, request) {
    const decoded = decodeWechatGiftCatalog(body, request);
    if (!decoded || !Number.isSafeInteger(request.order) || request.order < 0) return false;
    this.prune();
    const previous = this.rooms.get(decoded.roomId);
    if (previous && request.order <= previous.order) return false;
    const gifts = new Map([...decoded.gifts].slice(0, this.maxEntries));
    this.rooms.delete(decoded.roomId);
    this.rooms.set(decoded.roomId, { gifts, order: request.order, expiresAt: this.now() + this.ttlMs });
    while (this.rooms.size > this.maxRooms) this.rooms.delete(this.rooms.keys().next().value);
    return true;
  }
  enrich(event, roomId) {
    this.prune();
    if (event?.event_type !== 'gift') return event;
    const room = metadataRoomId(roomId), id = exactId(event.gift_id);
    const snapshot = this.rooms.get(room);
    if (snapshot?.gifts.size) snapshot.expiresAt = this.now() + this.ttlMs;
    const details = this.details.get(room)?.get(id);
    const name = typeof event.gift_name === 'string' && event.gift_name.trim() ? '' : details?.gift_name;
    const image = event.gift_image_url ? '' : details?.gift_image_url || snapshot?.gifts.get(id);
    // Fill missing display metadata by exact room/product ID only. Never change
    // quantities, prices or identities; never match a nickname or display text.
    return name || image ? { ...event, ...(name && { gift_name: name }), ...(image && { gift_image_url: image }) } : event;
  }
  ingestDetails(items, roomId, order) {
    const room = metadataRoomId(roomId);
    if (!room || !Number.isSafeInteger(order) || order < 0 || !Array.isArray(items)) return;
    this.prune();
    const batch = new Map(), conflicts = new Set();
    for (const item of items.slice(0, 2000)) {
      const id = exactId(item?.gift_id);
      const name = typeof item?.gift_name === 'string' ? item.gift_name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) : '';
      const image = avatarInfo(item?.gift_image_url, 'wechat').avatar_url || '';
      if (!id || (!name && !image) || conflicts.has(id)) continue;
      const prior = batch.get(id);
      if (prior && ((name && prior.gift_name && name !== prior.gift_name) ||
          (image && prior.gift_image_url && image !== prior.gift_image_url))) {
        batch.delete(id); conflicts.add(id); continue;
      }
      batch.set(id, { ...prior, ...(name && { gift_name: name }), ...(image && { gift_image_url: image }) });
    }
    if (!batch.size && !conflicts.size) return;
    const entries = this.details.get(room) || new Map();
    for (const id of conflicts) if ((entries.get(id)?.order ?? -1) <= order)
      entries.set(id, { order, expiresAt: this.now() + this.ttlMs });
    for (const [id, item] of batch) {
      const previous = entries.get(id);
      if (previous && previous.order >= order) continue;
      entries.delete(id);
      entries.set(id, { ...previous, ...item, order, expiresAt: this.now() + this.ttlMs });
    }
    while (entries.size > this.maxEntries) entries.delete(entries.keys().next().value);
    this.details.delete(room); this.details.set(room, entries);
    while (this.details.size > this.maxRooms) this.details.delete(this.details.keys().next().value);
  }
  clear() { this.rooms.clear(); this.details.clear(); }
}
module.exports = { isGiftCatalogUrl, metadataRoomId, decodeWechatGiftCatalog, WechatGiftCatalog, MAX_CATALOG_ITEMS };
