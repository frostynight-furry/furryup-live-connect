// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { fault } = require('./model.cjs');
const { collectDouyinWalletRevenue } = require('./douyin-wallet.cjs');
const { createAndroidRevenueDevice } = require('./android-device.cjs');
const busy = new Set();
// Runs only in the official App-owned bill WebView. Official SDK registrations
// establish userInfo/fetch/openLive; UID response shapes still need device acceptance.
async function nativeWalletPage(operation, descriptor, timeoutMs) {
  const validPage = () => location.origin === 'https://webcast.amemv.com' &&
    location.pathname === '/falcon/webcast_douyin/page/wallet/bill/index.html' && new URL(location.href).searchParams.get('bill_type') === 'income';
  if (!validPage()) return { error: 'UNTRUSTED_PAGE' };
  if (typeof window.ToutiaoJSBridge?.call !== 'function') return { error: 'REVENUE_MOBILE_BRIDGE_UNAVAILABLE' };
  const invoke = (method, params) => new Promise((resolve, reject) => {
    let done = false; const timer = setTimeout(() => { done = true; reject(new Error('REVENUE_REQUEST_TIMEOUT')); }, timeoutMs);
    try { window.ToutiaoJSBridge.call(method, params, result => { if (done) return; done = true; clearTimeout(timer); resolve(result); }); }
    catch { clearTimeout(timer); reject(new Error('REVENUE_MOBILE_BRIDGE_UNAVAILABLE')); }
  });
  try {
    if (operation === 'identity') {
      const body = await invoke('userInfo', {});
      if (!validPage()) return { error: 'PAGE_CHANGED' };
      if (!body || typeof body !== 'object' || body.code !== undefined && ![0, 1].includes(body.code)) return { error: 'LOGIN_REQUIRED' };
      const values = [];
      for (const value of [body, body.data, body.user_info, body.user]) if (value && typeof value === 'object') {
        for (const key of ['user_id', 'uid', 'userId']) if (value[key] !== undefined) {
          if (typeof value[key] === 'number' && !Number.isSafeInteger(value[key]) || !/^[1-9]\d{0,24}$/.test(String(value[key]))) return { error: 'REVENUE_MOBILE_IDENTITY_UNAVAILABLE' };
          values.push(String(value[key]));
        }
      }
      if (!values.length || new Set(values).size !== 1) return { error: 'REVENUE_MOBILE_IDENTITY_UNAVAILABLE' };
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['douyin', 'native_uid', values[0]])));
      return { accountId: [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''), identityKind: 'native_uid' };
    }
    if (operation === 'login') { await invoke('openLive', { type: 'login_panel', keep_open: 1 }); return { loginRequested: true }; }
    if (operation !== 'bills') return { error: 'REVENUE_UNSUPPORTED_ENDPOINT' };
    const url = new URL(descriptor.url), params = Object.fromEntries(url.searchParams);
    if (url.origin !== 'https://creator.douyin.com' || url.pathname !== '/webcast/wallet_api/get_billing_list/' ||
      descriptor.method !== 'GET' || url.searchParams.size !== 7 || !/^20\d{2}(?:0[1-9]|1[0-2])$/.test(params.start_time) ||
      !/^\d{9,10}$/.test(params.last_max_time) || !/^(?:[1-9]\d?|100)$/.test(params.page) ||
      params.count !== '20' || params.type !== '0' || params.need_summary !== '1' || params.is_income_record !== '1') return { error: 'REVENUE_UNSUPPORTED_ENDPOINT' };
    const result = await invoke('fetch', { url: 'https://wallet-activity.amemv.com/webcast/wallet_api/get_billing_list/', params, method: 'GET' });
    if (!validPage()) return { error: 'PAGE_CHANGED' };
    if (!result || typeof result.raw !== 'object' || result.raw === null) return { error: 'REVENUE_SCHEMA_CHANGED' };
    const json = JSON.stringify(result.raw);
    if (new TextEncoder().encode(json).length > 2 * 1024 * 1024) return { error: 'REVENUE_RESPONSE_TOO_LARGE' };
    return { body: JSON.parse(json) };
  } catch (error) { return { error: ['REVENUE_REQUEST_TIMEOUT', 'REVENUE_MOBILE_BRIDGE_UNAVAILABLE'].includes(error.message) ? error.message : 'REVENUE_SCHEMA_CHANGED' }; }
}
function createDouyinWalletAndroidReader({ getAccount, adbPath, authDirectory, adbPort = 5037,
  requestTimeoutMs = 8000, collectionTimeoutMs = 90000,
  device = createAndroidRevenueDevice({ adbPath, authDirectory, adbPort, commandTimeoutMs: Math.min(30000, requestTimeoutMs + 2000) }) } = {}) {
  if (typeof getAccount !== 'function' || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 20000 ||
    !Number.isInteger(collectionTimeoutMs) || collectionTimeoutMs < requestTimeoutMs || collectionTimeoutMs > 600000) throw new TypeError('Invalid Android reader configuration');
  let disposed = false; const sessions = new Set();
  function check(owner) { const account = getAccount(); if (disposed) throw fault('REVENUE_DISPOSED');
    if (!owner || account?.accountId !== owner || account.kind === 'signed-out') throw fault('ACCOUNT_CHANGED'); }
  async function acquire({ owner, deviceId, expectedIdentity, identityKind, fromMonth, toMonth, platform = 'douyin', source = 'wallet', interactive = false, openPage = false } = {}) {
    check(owner);
    if (platform !== 'douyin' || source !== 'wallet') throw fault('REVENUE_UNSUPPORTED_SOURCE');
    if (identityKind && identityKind !== 'native_uid') throw fault('INVALID_REVENUE_IDENTITY_KIND');
    if ((!interactive || expectedIdentity !== undefined) && !/^[a-f0-9]{64}$/.test(expectedIdentity || '')) throw fault('REVENUE_BINDING_REQUIRED');
    if (!interactive && !/^[a-f0-9]{64}$/.test(deviceId || '')) throw fault('REVENUE_MOBILE_BINDING_REQUIRED');
    if (openPage) { deviceId = await device.openDouyinWallet(deviceId); await new Promise(resolve => setTimeout(resolve, 750)); check(owner); }
    let session, timer, watcher, stopped = false, bound, lock;
    try {
      session = await device.attachWallet(deviceId); check(owner); sessions.add(session);
      if (busy.has(session.deviceId)) throw fault('REVENUE_BUSY'); lock = session.deviceId; busy.add(lock);
      const evaluate = async (op, descriptor) => {
        check(owner); if (stopped) throw fault('REVENUE_COLLECTION_TIMEOUT');
        const result = await session.evaluate('(' + nativeWalletPage.toString() + ')(' +
          [op, descriptor || null, requestTimeoutMs].map(v => JSON.stringify(v)).join(',') + ')');
        check(owner); if (stopped) throw fault('REVENUE_COLLECTION_TIMEOUT'); if (result?.error) throw fault(result.error); return result;
      };
      const identity = async () => {
        const value = await evaluate('identity'); if (!/^[a-f0-9]{64}$/.test(value?.accountId) || value.identityKind !== 'native_uid') throw fault('REVENUE_MOBILE_IDENTITY_UNAVAILABLE');
        if ((expectedIdentity && expectedIdentity !== value.accountId) || bound && bound.accountId !== value.accountId) throw fault('PLATFORM_ACCOUNT_CHANGED'); return value;
      };
      const work = async () => {
        try { bound = await identity(); }
        catch (error) { if (interactive && error.code === 'LOGIN_REQUIRED') await evaluate('login'); throw error; }
        const request = async descriptor => { await identity(); const result = await evaluate('bills', descriptor); await identity(); return result.body; };
        const snapshot = await collectDouyinWalletRevenue({ ...bound, fromMonth, toMonth, request }); await identity();
        return { ...snapshot, deviceId: session.deviceId, binding: 'native_session', sessionReuse: 'android_native_bridge', authenticationValidation: 'synthetic_only' };
      };
      const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => { stopped = true; reject(fault('REVENUE_COLLECTION_TIMEOUT')); }, collectionTimeoutMs); });
      const changed = new Promise((_resolve, reject) => { watcher = setInterval(() => { try { check(owner); } catch (error) { stopped = true; reject(error); } }, 250); });
      return await Promise.race([work(), deadline, changed]);
    } finally {
      stopped = true; clearTimeout(timer); clearInterval(watcher); if (session) { await session.close().catch(() => {}); sessions.delete(session); }
      if (lock) busy.delete(lock);
    }
  }
  return { inspect: async ({ owner }) => { check(owner); const result = await device.inspect(); check(owner); return result; },
    connect: options => acquire({ ...options, interactive: true }), lookup: options => acquire({ ...options, interactive: false, openPage: false }),
    async dispose() { disposed = true; await Promise.all([...sessions].map(s => s.close())); sessions.clear(); } };
}
module.exports = { createDouyinWalletAndroidReader, nativeWalletPage };
