// Copyright (c) 2026 FrostyNight.
// Extracted from the FurryUP Studio live-connect core; see LICENSE.
'use strict';
const { createHash } = require('node:crypto');
const DOMAINS = Object.freeze({
  bilibili: ['hdslb.com'],
  douyin: ['douyinpic.com', 'douyincdn.com', 'byteimg.com', 'ibytedtos.com', 'pstatp.com'],
  kuaishou: ['yximgs.com', 'kwimgs.com', 'kwaicdn.com', 'kwai.net', 'wskwai.com'],
  wechat: ['qpic.cn', 'qlogo.cn']
});
function avatarInfo(value, platform) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return {};
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !DOMAINS[platform]?.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return {};
    url.hash = '';
    return { avatar_url: url.href, avatar_id: createHash('sha256').update(platform + '\n' + url.href).digest('hex') };
  } catch { return {}; }
}

// Public image downloads only: never attach platform Cookies or fetch arbitrary profile URLs.
function createAvatarCache({ fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new TypeError('Invalid avatar cache options');
  const entries = new Map(), waiting = [], controllers = new Set();
  const types = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
  let active = 0, bytes = 0, stopped = false;
  function register(event) {
    if (stopped || !event) return;
    const info = avatarInfo(event.avatar_url, event.platform);
    if (!info.avatar_id || info.avatar_id !== event.avatar_id || entries.has(info.avatar_id)) return;
    entries.set(info.avatar_id, { url:info.avatar_url, platform:event.platform, result:null, expires:0, pending:null });
    trim();
  }
  function trim() {
    while (entries.size > 256 || bytes > 16 * 1024 * 1024) {
      const [key, entry] = entries.entries().next().value;
      bytes -= entry.result?.body.length || 0; entries.delete(key);
    }
  }
  function drain() {
    while (!stopped && active < 4 && waiting.length) {
      const job = waiting.shift(); active++;
      job().finally(() => { active--; drain(); });
    }
  }
  async function download(entry, signal) {
    let url = entry.url;
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await fetchImpl(url, { signal, redirect:'manual', credentials:'omit', headers:{ Accept:'image/png,image/jpeg,image/webp,image/gif,image/avif' } });
      if (signal.aborted) { await response.body?.cancel(); return null; }
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel();
        const next = avatarInfo(new URL(response.headers.get('location'), url).href, entry.platform);
        if (!next.avatar_url) return null;
        url = next.avatar_url; continue;
      }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!response.ok || !types.has(type) || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) {
        await response.body?.cancel(); return null;
      }
      const reader = response.body?.getReader(); if (!reader) return null;
      const chunks = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); return null; }
          chunks.push(Buffer.from(value));
        }
        return size && !signal.aborted ? { type, body:Buffer.concat(chunks) } : null;
      } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    }
    return null;
  }
  function get(id) {
    const entry = entries.get(id);
    if (stopped || !entry) return Promise.resolve(null);
    entries.delete(id); entries.set(id, entry);
    if (entry.pending) return entry.pending;
    if (entry.expires > Date.now()) return Promise.resolve(entry.result);
    if (waiting.length >= 32) return Promise.resolve(null);
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    entry.pending = new Promise(resolve => {
      waiting.push(async () => {
        let result = null;
        let abort;
        const cancelled = new Promise(resolve => { abort = () => resolve(null); controller.signal.addEventListener('abort', abort, { once: true }); });
        try { if (!controller.signal.aborted) result = await Promise.race([download(entry, controller.signal), cancelled]); }
        catch { /* Missing images never interrupt a message. */ }
        finally { controller.signal.removeEventListener('abort', abort); }
        if (stopped || controller.signal.aborted) result = null;
        clearTimeout(timer); controllers.delete(controller);
        if (entries.get(id) === entry && !stopped) {
          bytes -= entry.result?.body.length || 0;
          entry.result = result; entry.expires = Date.now() + (result ? 30 * 60_000 : 60_000);
          bytes += result?.body.length || 0; trim();
        }
        entry.pending = null; resolve(result);
      });
    });
    drain(); return entry.pending;
  }
  function stop() {
    stopped = true;
    for (const controller of controllers) controller.abort();
    for (const job of waiting.splice(0)) void job();
    entries.clear(); bytes = 0;
  }
  return { register, get, stop };
}
module.exports = { avatarInfo, createAvatarCache };
