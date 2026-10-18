// Copyright (c) 2026 FrostyNight.
// Extracted from the FurryUP Studio live-connect core; see LICENSE.
'use strict';
const { avatarInfo } = require('./avatar-cache.cjs');

function normalizeEmotes(raw, platform, content) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(), result = [];
  for (const item of raw.slice(0, 32)) {
    if (typeof item?.token !== 'string' || !item.token || item.token.length > 80 || /[\u0000-\u001f\u007f]/.test(item.token) || !content.includes(item.token) || seen.has(item.token)) continue;
    const info = avatarInfo(item.url, platform);
    if (!info.avatar_id) continue;
    seen.add(item.token); result.push(Object.freeze({ token:item.token, url:info.avatar_url, id:info.avatar_id }));
  }
  return result;
}

module.exports = { normalizeEmotes };
