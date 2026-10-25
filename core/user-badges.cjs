'use strict';
const KINDS = new Set(['role', 'membership', 'fans', 'wealth', 'level', 'title']);
function normalizeUserBadges(raw) {
  const source = Array.isArray(raw.user_badges) ? raw.user_badges :
    typeof raw.badge_name === 'string' ? [{ kind: 'fans', label: raw.badge_name, level: raw.badge_level }] : [];
  const result = [], seen = new Set();
  for (const badge of source.slice(0, 64)) {
    if (!badge || typeof badge !== 'object' || !KINDS.has(badge.kind) || typeof badge.label !== 'string') continue;
    const label = badge.label.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 64);
    if (!label) continue;
    const level = Number.isSafeInteger(badge.level) && badge.level > 0 && badge.level <= 1000 ? badge.level : undefined;
    const key = JSON.stringify([badge.kind, label, level]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(Object.freeze({ kind: badge.kind, label, ...(level !== undefined ? { level } : {}) }));
    if (result.length === 16) break;
  }
  return Object.freeze(result);
}
module.exports = { normalizeUserBadges };
