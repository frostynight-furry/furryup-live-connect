// Copyright (c) 2026 FrostyNight.
// Extracted from the FurryUP Studio live-connect core; see LICENSE.
'use strict';
const { avatarInfo } = require('./avatar-cache.cjs');

const PROFILE_URL = 'https://live.kuaishou.com/live_api/baseuser/userinfo/byid';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const MAX_BODY_BYTES = 128 * 1024;
// Official web modules 12947/48005/43222: request throttling, login required,
// captcha required, or app-only protection. These arrive with HTTP 200 too.
const SESSION_BLOCK_CODES = new Set(['2', '15', '16', '109', '2056', '60200', '400002', '7935']);
const stableId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
  !['0', 'outside', 'unknown', 'anonymous', 'null', 'undefined'].includes(value.toLowerCase());

async function readJson(response, signal) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BODY_BYTES || !response.body?.getReader) {
    await response.body?.cancel(); return null;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
    if (signal.aborted) return null;
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

// This authenticated request is confined to one fixed platform endpoint. Image
// downloads still use avatar-cache's separate, unauthenticated CDN allowlist.
async function fetchKuaishouProfileAvatar(userId, { roomId, cookie, signal = new AbortController().signal, fetchImpl = globalThis.fetch } = {}) {
  if (!stableId(userId) || !stableId(roomId) || typeof cookie !== 'string' || !cookie ||
      cookie.length > 32_768 || /[\r\n]/.test(cookie) || signal.aborted) return {};
  const url = new URL(PROFILE_URL); url.searchParams.set('principalId', userId);
  const response = await fetchImpl(url.href, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Accept: 'application/json', Referer: `https://live.kuaishou.com/u/${roomId}`, 'User-Agent': USER_AGENT, Cookie: cookie } });
  if (!response.ok) {
    await response.body?.cancel();
    return { cooldown: [401, 403, 429].includes(response.status) };
  }
  const body = await readJson(response, signal);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  if ([body.result, body.code, body.data?.result, body.data?.code].some(code => SESSION_BLOCK_CODES.has(String(code))))
    return { cooldown: true };
  // The web endpoint currently omits result on success. Accept only its exact
  // profile envelope and matching identity, never an error/challenge payload.
  if ([body.result, body.data?.result].some(code => code != null && ![0, 1, '0', '1'].includes(code)) ||
      body.code != null && ![0, '0'].includes(body.code) || body.error || body.error_msg || body.errorMsg) return {};
  const user = body.data?.userInfo;
  if (!user || typeof user !== 'object' || Array.isArray(user) || String(user.id ?? '') !== userId || user.mystery === true) return {};
  return avatarInfo(user.avatar, 'kuaishou');
}

function createKuaishouProfileAvatars({ roomId, cookie = '', onAvatar = () => {}, fetchImpl = globalThis.fetch, now = Date.now,
  spacingMs = 1000, timeoutMs = 5000, positiveTtlMs = 30 * 60_000, negativeTtlMs = 5 * 60_000,
  cooldownMs = 5 * 60_000, maxEntries = 2048, maxQueued = 64 } = {}) {
  for (const [value, minimum, maximum] of [[spacingMs, 0, 60_000], [timeoutMs, 1, 60_000],
    [positiveTtlMs, 1, 86_400_000], [negativeTtlMs, 1, 86_400_000], [cooldownMs, 1, 86_400_000],
    [maxEntries, 1, 2048], [maxQueued, 1, 64]]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError('Invalid profile resolver limits');
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof onAvatar !== 'function') throw new TypeError('Invalid profile resolver callbacks');
  const entries = new Map(), waiting = [];
  let stopped = false, pending = null, timer = null, nextAt = 0, cooldownUntil = 0;
  const eligible = event => !stopped && event && event.user_identity_hidden !== true &&
    !event.preview && (!event.platform || event.platform === 'kuaishou') &&
    (!event.room_id || event.room_id === roomId) && stableId(event.user_id);
  function setEntry(userId, entry) {
    entries.delete(userId); entries.set(userId, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }
  function cached(userId) {
    const entry = entries.get(userId);
    if (entry && !entry.queued && entry.expires <= now()) { entries.delete(userId); return null; }
    return entry;
  }
  function enrich(event) {
    if (!eligible(event)) return event;
    const supplied = avatarInfo(event.avatar_url, 'kuaishou');
    if (supplied.avatar_url) {
      setEntry(event.user_id, { info: supplied, expires: now() + positiveTtlMs });
      return event;
    }
    const entry = cached(event.user_id);
    return entry?.info?.avatar_url ? { ...event, ...entry.info } : event;
  }
  function drain() {
    clearTimeout(timer); timer = null;
    if (stopped || pending || !waiting.length) return;
    const delay = Math.max(nextAt, cooldownUntil) - now();
    if (delay > 0) { timer = setTimeout(drain, delay); timer.unref?.(); return; }
    const request = waiting.shift();
    if (entries.get(request.userId) !== request.entry) { drain(); return; }
    pending = request;
    request.controller = new AbortController();
    void run(request);
  }
  async function run(request) {
    let deadline;
    const timeout = new Promise(resolve => { deadline = setTimeout(() => { request.controller.abort(); resolve({}); }, timeoutMs); deadline.unref?.(); });
    let info = {};
    try {
      const lookup = fetchKuaishouProfileAvatar(request.userId, { roomId, cookie, signal: request.controller.signal, fetchImpl });
      // The async helper has called fetchImpl before yielding. Anchor spacing
      // after that call so URL/transport setup or preemption cannot consume it.
      nextAt = now() + spacingMs;
      info = await Promise.race([lookup, timeout]);
    }
    catch { /* Missing profile data must not delay or interrupt live messages. */ }
    finally { clearTimeout(deadline); }
    if (!stopped && pending === request) {
      if (info.cooldown) {
        cooldownUntil = now() + cooldownMs;
        // Do not accumulate a burst of automatic retries behind a challenge.
        for (const queued of waiting.splice(0)) if (entries.get(queued.userId) === queued.entry)
          setEntry(queued.userId, { info: {}, expires: cooldownUntil });
      }
      if (entries.get(request.userId) === request.entry) {
        const accepted = info.avatar_url && !request.controller.signal.aborted ? info : {};
        setEntry(request.userId, { info: accepted, expires: now() + (accepted.avatar_url ? positiveTtlMs : negativeTtlMs) });
        if (accepted.avatar_url) try { onAvatar(request.entry.event, accepted); } catch { /* Metadata observers cannot affect collection. */ }
      }
      pending = null; drain();
    }
  }
  function resolve(event) {
    if (!eligible(event) || event.event_type !== 'comment' || event.room_id !== roomId || event.avatar_id ||
        !cookie || !stableId(roomId) || cooldownUntil > now()) return;
    const existing = cached(event.user_id);
    if (existing) { if (existing.queued) existing.event = event; return; }
    if (waiting.length >= maxQueued) return;
    const entry = { queued: true, event, expires: 0 };
    setEntry(event.user_id, entry); waiting.push({ userId: event.user_id, entry }); drain();
  }
  function dispose() {
    stopped = true; clearTimeout(timer); timer = null;
    pending?.controller.abort(); pending = null; waiting.length = 0; entries.clear(); cookie = '';
  }
  return { enrich, resolve, dispose };
}
module.exports = { createKuaishouProfileAvatars, fetchKuaishouProfileAvatar };
