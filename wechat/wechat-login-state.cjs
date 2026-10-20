'use strict';

// Storage keys read by the public channels.weixin.qq.com account/login code.
// This is deliberately not a browser-profile export: drafts, telemetry, other
// origins, sessionStorage and IndexedDB never enter the credential envelope.
const WECHAT_LOGIN_ORIGIN = 'https://channels.weixin.qq.com';
const WECHAT_LOGIN_KEYS = Object.freeze(['finder_username', 'finder_uin', 'finder_raw', 'finder_login_token']);
const MAX_WECHAT_LOGIN_BYTES = 128 * 1024;
const MAX_LEGACY_COOKIE_BYTES = 24000;
const MAX_COOKIE_BYTES = 64 * 1024;
const MAX_STORAGE_VALUE_BYTES = 16 * 1024;

function invalid() { throw new Error('Invalid saved WeChat login state'); }
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function validCookie(cookie) {
  return plainObject(cookie) && typeof cookie.name === 'string' && cookie.name.length <= 256 &&
    !/[\r\n\0]/.test(cookie.name) && typeof cookie.value === 'string' && cookie.value.length <= 12000 &&
    !/[\r\n\0]/.test(cookie.value) && typeof cookie.domain === 'string' &&
    /^\.?(?:[a-z0-9-]+\.)*weixin\.qq\.com$/.test(cookie.domain) &&
    typeof cookie.path === 'string' && cookie.path.startsWith('/') && cookie.path.length <= 1024 &&
    !/[\r\n\0?#]/.test(cookie.path);
}
function cookieDetails(cookie) {
  const details = { url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`, name: cookie.name, value: cookie.value,
    domain: cookie.domain, path: cookie.path, secure: true, httpOnly: cookie.httpOnly === true };
  if (['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie.sameSite)) details.sameSite = cookie.sameSite;
  if (Number.isFinite(cookie.expirationDate)) details.expirationDate = cookie.expirationDate;
  return details;
}
function normalizeStorage(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !WECHAT_LOGIN_KEYS.includes(key))) invalid();
  const result = {};
  for (const key of WECHAT_LOGIN_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== 'string' || Buffer.byteLength(value[key], 'utf8') > MAX_STORAGE_VALUE_BYTES) invalid();
    result[key] = value[key];
  }
  return result;
}
function normalizeCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length > 100 || cookies.some(cookie => !validCookie(cookie))) invalid();
  const result = cookies.map(cookieDetails);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_COOKIE_BYTES) invalid();
  return result;
}
function encodeWechatLogin(cookies, localStorage = {}) {
  const value = JSON.stringify({ schemaVersion: 2, origin: WECHAT_LOGIN_ORIGIN,
    cookies: normalizeCookies(cookies), localStorage: normalizeStorage(localStorage) });
  if (Buffer.byteLength(value, 'utf8') > MAX_WECHAT_LOGIN_BYTES) invalid();
  return value;
}
function decodeWechatLogin(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_WECHAT_LOGIN_BYTES) invalid();
  let parsed;
  try { parsed = JSON.parse(value); } catch { invalid(); }
  if (Array.isArray(parsed)) {
    if (Buffer.byteLength(value, 'utf8') > MAX_LEGACY_COOKIE_BYTES) invalid();
    return { schemaVersion: 1, origin: WECHAT_LOGIN_ORIGIN, cookies: normalizeCookies(parsed), localStorage: {} };
  }
  if (!plainObject(parsed) || parsed.schemaVersion !== 2 || parsed.origin !== WECHAT_LOGIN_ORIGIN ||
    Object.keys(parsed).some(key => !['schemaVersion', 'origin', 'cookies', 'localStorage'].includes(key))) invalid();
  return { schemaVersion: 2, origin: WECHAT_LOGIN_ORIGIN, cookies: normalizeCookies(parsed.cookies),
    localStorage: normalizeStorage(parsed.localStorage) };
}
module.exports = { WECHAT_LOGIN_ORIGIN, WECHAT_LOGIN_KEYS, MAX_WECHAT_LOGIN_BYTES, MAX_LEGACY_COOKIE_BYTES,
  MAX_STORAGE_VALUE_BYTES, decodeWechatLogin, encodeWechatLogin, normalizeStorage, validCookie, cookieDetails };
