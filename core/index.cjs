// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { PLATFORMS, EVENT_TYPES, LiveEventStream, normalizeEvent, validateRoute, ObserverSafeEmitter } = require('./event-stream.cjs');
const { avatarInfo, createAvatarCache } = require('./avatar-cache.cjs');
const { createKuaishouProfileAvatars, fetchKuaishouProfileAvatar } = require('./kuaishou-profile-avatars.cjs');
const { createJavaCollector } = require('./java-collector.cjs');

const stableViewer = event => event.user_identity_hidden !== true && !event.preview &&
  typeof event.user_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(event.user_id) &&
  !['0', 'outside', 'anonymous', 'unknown', 'null', 'undefined'].includes(event.user_id.toLowerCase());

function matcher({ platform, roomId, eventTypes } = {}) {
  if (platform !== undefined && !PLATFORMS.includes(platform)) throw new TypeError('Invalid platform filter');
  if (roomId !== undefined && typeof roomId !== 'string') throw new TypeError('Invalid room filter');
  if (eventTypes !== undefined && (!Array.isArray(eventTypes) || eventTypes.some(type => !EVENT_TYPES.includes(type))))
    throw new TypeError('Invalid event type filter');
  const types = eventTypes && new Set(eventTypes);
  return event => (platform === undefined || platform === event.platform) &&
    (roomId === undefined || roomId === event.room_id) && (!types || types.has(event.event_type));
}

/** An in-memory event hub. Collectors remain explicit; opening a room does not log in or connect. */
class LiveConnect extends ObserverSafeEmitter {
  constructor({ maxRooms = 16, avatarCacheOptions, profileOptions } = {}) {
    super();
    if (!Number.isSafeInteger(maxRooms) || maxRooms < 1 || maxRooms > 64) throw new TypeError('Invalid room limit');
    this.maxRooms = maxRooms;
    this.stream = new LiveEventStream();
    this.images = createAvatarCache(avatarCacheOptions);
    this.profileOptions = profileOptions;
    this.rooms = new Map();
    this.closed = false;
    this.stream.on('event', event => {
      this.images.register(event);
      this.emit('event', event);
    });
    this.stream.on('viewer-avatar', event => {
      this.images.register(event);
      this.emit('viewer-avatar', event);
    });
    this.stream.on('observer-error', error => this.emit('observer-error', error));
  }

  openRoom({ platform, roomId, kuaishouCookie = '' } = {}) {
    validateRoute(platform, roomId);
    if (this.closed) throw new Error('LiveConnect is closed');
    const key = JSON.stringify([platform, roomId]);
    if (this.rooms.has(key)) throw new Error('This room is already open');
    if (this.rooms.size >= this.maxRooms) throw new Error('Room limit reached');
    const viewers = new Map();
    let active = true;
    const profile = platform === 'kuaishou' ? createKuaishouProfileAvatars({ ...this.profileOptions,
      roomId, cookie: kuaishouCookie, onAvatar: (event, info) => {
        if (active) this.stream.updateViewerAvatar(event, info);
      } }) : null;

    const session = Object.freeze({
      platform, roomId,
      ingest: raw => {
        if (!active || this.closed) throw new Error('Room session is closed');
        if (raw?.preview === true) throw new TypeError('Live room sessions do not accept preview events');
        // Routing belongs to the session, never to untrusted incoming event fields.
        const accepted = this.stream.push(raw, platform, roomId, false, event => {
          if (profile) return profile.enrich(event);
          if (stableViewer(event)) {
            const info = avatarInfo(event.avatar_url, platform), cached = viewers.get(event.user_id);
            if (info.avatar_id) {
              viewers.delete(event.user_id);
              viewers.set(event.user_id, { ...info, expires: Date.now() + 30 * 60_000 });
              while (viewers.size > 2048) viewers.delete(viewers.keys().next().value);
            } else if (cached?.expires > Date.now()) return { ...event, avatar_url: cached.avatar_url };
            else if (cached) viewers.delete(event.user_id);
          }
          return event;
        });
        if (accepted) profile?.resolve(accepted);
        return accepted;
      },
      history: () => this.history({ platform, roomId }),
      close: () => {
        if (!active) return;
        active = false;
        profile?.dispose();
        viewers.clear();
        this.stream.forgetRoom(platform, roomId);
        this.rooms.delete(key);
      }
    });
    this.rooms.set(key, session);
    return session;
  }

  subscribe(callback, filters) { return this.subscribeTo('event', callback, filters); }
  subscribeAvatars(callback, filters) { return this.subscribeTo('viewer-avatar', callback, filters); }
  subscribeTo(channel, callback, filters) {
    if (this.closed || typeof callback !== 'function') throw new TypeError('Invalid subscription');
    const matches = matcher(filters), listener = event => { if (matches(event)) return callback(event); };
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }
  history(filters) { return this.stream.history.filter(matcher(filters)); }
  getAvatar(id) { return this.images.get(id); }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const room of this.rooms.values()) room.close();
    this.images.stop();
    this.stream.removeAllListeners();
    this.removeAllListeners();
  }
}

const createLiveConnect = options => new LiveConnect(options);
module.exports = { PLATFORMS, EVENT_TYPES, LiveConnect, createLiveConnect, LiveEventStream, normalizeEvent,
  avatarInfo, createAvatarCache, createKuaishouProfileAvatars, fetchKuaishouProfileAvatar, createJavaCollector };
