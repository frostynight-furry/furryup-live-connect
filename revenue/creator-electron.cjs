// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { partitionFor, identityHash } = require('../profiles/creator-electron.cjs');
const { PLATFORMS, allowedNavigation, cleanIdentity, identityFromResponse, readCreatorPage } = require('../profiles/creator-page.cjs');
const { REVENUE_PLATFORMS, fault, monthRange } = require('./model.cjs');
const { REVENUE_PAGES, requestFor, collectCreatorRevenue } = require('./adapters.cjs');
const { ANCHOR_PAGE, collectDouyinAnchorRevenue } = require('./douyin-anchor.cjs');
const { WALLET_PAGE, collectDouyinWalletRevenue } = require('./douyin-wallet.cjs');
const { kuaishouRequest } = require('./kuaishou.cjs');
const { wechatRequest } = require('./wechat-channels.cjs');
const { fetchRevenuePage, nativeRevenuePage } = require('./page-transport.cjs');
const { readWechatWallet } = require('./wechat-wallet-electron.cjs');
const active = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function allowedRevenueNavigation(platform, address) {
  if (allowedNavigation(platform, address)) return true;
  try {
    const url = new URL(address);
    return platform === 'douyin' && url.protocol === 'https:' && url.hostname === 'anchor.douyin.com' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function createCreatorRevenueBrowser({ BrowserWindow, session, getAccount, partitionPrefix = 'liveconnect-followers',
  connectTimeoutMs = 180000, refreshTimeoutMs = 90000, requestTimeoutMs = 8000, requestIntervalMs = 150,
  applicationName = 'LiveConnect' } = {}) {
  if (typeof BrowserWindow !== 'function' || typeof session?.fromPartition !== 'function' || typeof getAccount !== 'function') throw new TypeError('Electron BrowserWindow, session and getAccount are required');
  partitionFor('validation', 'douyin', partitionPrefix);
  for (const n of [connectTimeoutMs, refreshTimeoutMs, requestTimeoutMs]) if (!Number.isInteger(n) || n < 1 || n > 600000) throw new TypeError('Invalid revenue timeout');
  if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > 5000) throw new TypeError('Invalid revenue request interval');
  if (typeof applicationName !== 'string' || applicationName.length > 80 || /[\x00-\x1f]/.test(applicationName)) throw new TypeError('Invalid application name');
  const windows = new Set(); let disposed = false;
  function check(owner, platform) {
    if (disposed) throw fault('REVENUE_DISPOSED');
    if (!REVENUE_PLATFORMS.includes(platform)) throw fault('REVENUE_UNSUPPORTED_PLATFORM');
    const account = getAccount();
    if (typeof owner !== 'string' || !owner || account?.accountId !== owner || account.kind === 'signed-out') throw fault('ACCOUNT_CHANGED');
  }
  async function acquire({ owner, platform, expectedIdentity, identityKind, fromMonth, toMonth, interactive, source = 'creator_center' }) {
    check(owner, platform);
    if (!['creator_center', 'anchor_dashboard', 'wallet'].includes(source) || (source !== 'creator_center' && platform !== 'douyin')) throw fault('REVENUE_UNSUPPORTED_SOURCE');
    if (source !== 'creator_center' && identityKind === 'handle') throw fault('INVALID_REVENUE_IDENTITY_KIND');
    const pageUrl = source === 'anchor_dashboard' ? ANCHOR_PAGE : source === 'wallet' ? WALLET_PAGE : REVENUE_PAGES[platform];
    if ((!interactive || expectedIdentity !== undefined) && !/^[a-f0-9]{64}$/.test(expectedIdentity || '')) throw fault('REVENUE_BINDING_REQUIRED');
    if ((fromMonth && !toMonth) || (!fromMonth && toMonth)) throw fault('INVALID_REVENUE_RANGE');
    if (fromMonth && monthRange(fromMonth, toMonth).length > 24 && (platform === 'kuaishou' || source === 'wallet')) throw fault('REVENUE_RANGE_TOO_LARGE');
    const allowedKinds = { bilibili: ['uid'], douyin: ['account-cookie-uid_tt', 'handle'],
      kuaishou: ['user_id', 'account-cookie-userId', 'account-cookie-kuaishou.userId'], wechat_channels: ['finder'] }[platform];
    if (identityKind && !allowedKinds.includes(identityKind)) throw fault('INVALID_REVENUE_IDENTITY_KIND');
    const key = partitionFor(owner, platform, partitionPrefix);
    if (active.has(key)) throw fault('REVENUE_BUSY');
    const storage = session.fromPartition(key, { cache: true });
    storage.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    storage.setPermissionCheckHandler(() => false);
    const win = new BrowserWindow({ show: interactive, width: 1120, height: 820, autoHideMenuBar: true,
      title: applicationName + ' · ' + PLATFORMS[platform].name + ' · 创作者收益', skipTaskbar: !interactive,
      webPreferences: { session: storage, nodeIntegration: false, contextIsolation: true, sandbox: true,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, backgroundThrottling: false } });
    active.set(key, win); windows.add(win);
    const wc = win.webContents, creatorOrigin = new URL(pageUrl).origin;
    if (platform === 'wechat_channels') wc.setUserAgent(wc.getUserAgent().replace(/\s(?:Electron|FurryUP|LiveConnect|furryup-live-connect)\/[^\s]+/gi, ''));
    const children = new Set();
    let stopped = false, timer, watcher, finalError = 'LOGIN_REQUIRED', closeReason = 'LOGIN_CANCELLED';
    let bound, boundCookie, lastCookie, ownUserId, needsLogin = false, changed = false, revision = 0;
    const preventDownload = event => event.preventDefault(); storage.on('will-download', preventDownload);
    const cookieChanged = (_event, cookie, cause, removed) => {
      const relevant = platform === 'bilibili' ? cookie.name === 'DedeUserID' : platform === 'douyin' && cookie.name === 'uid_tt';
      if (bound && relevant && (cookie.value !== boundCookie || (removed && cause !== 'overwrite'))) changed = true;
    };
    storage.cookies.on('changed', cookieChanged);
    win.on('page-title-updated', event => event.preventDefault());
    const navigation = (event, url) => { if (!allowedRevenueNavigation(platform, url)) event.preventDefault(); };
    wc.on('will-navigate', navigation); wc.on('will-redirect', navigation);
    wc.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) revision++; });
    wc.setWindowOpenHandler(({ url }) => { if (allowedRevenueNavigation(platform, url)) wc.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    if (interactive) win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
    async function pageRequest(descriptor) {
      const fn = descriptor.transport ? nativeRevenuePage : fetchRevenuePage;
      const result = await wc.executeJavaScript('(' + fn.toString() + ')(' +
        [descriptor, creatorOrigin, requestTimeoutMs, 2 * 1024 * 1024].map(value => JSON.stringify(value)).join(',') + ')');
      if (result.error) throw fault(result.error);
      return result.body;
    }
    async function identity() {
      check(owner, platform);
      if (stopped || win.isDestroyed()) throw fault(closeReason);
      if (changed) throw fault('PLATFORM_ACCOUNT_CHANGED');
      if (!allowedRevenueNavigation(platform, wc.getURL())) throw fault('UNTRUSTED_PAGE');
      if (new URL(wc.getURL()).origin !== creatorOrigin) return null;
      const page = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: '(' + readCreatorPage.toString() + ')(' + JSON.stringify(platform) + ')' }]);
      if (page.challenge) throw fault('VERIFICATION_REQUIRED');
      let own;
      if (platform === 'kuaishou' || platform === 'wechat_channels') {
        let body; const before = revision;
        try { body = await pageRequest(platform === 'kuaishou' ? kuaishouRequest('identity') : wechatRequest('identity')); }
        catch (error) {
          if (error.code === 'LOGIN_REQUIRED') { needsLogin = true; return null; }
          if (error.code === 'REVENUE_PAGE_NOT_READY') { finalError = error.code; return null; }
          throw error;
        }
        if (before !== revision) throw fault('PAGE_CHANGED');
        own = identityFromResponse(platform === 'kuaishou' ? 'ks-self' : 'finder', body);
        needsLogin = !own;
        if (own && platform === 'kuaishou') {
          ownUserId = own.value;
          // Preserve an existing follower binding only after the server proves
          // that its numeric identity equals that cookie-derived binding.
          if (identityKind) own = cleanIdentity(identityKind, own.value);
        }
      } else {
        if (page.login) return null;
        const cookies = await storage.cookies.get({ url: pageUrl });
        const cookieName = platform === 'bilibili' ? 'DedeUserID' : 'uid_tt';
        const values = [...new Set(cookies.filter(item => item.name === cookieName).map(item => item.value))];
        lastCookie = values.length === 1 ? values[0] : undefined;
        if (identityKind === 'handle') own = cleanIdentity('handle', page.handle);
        else if (values.length === 1) own = cleanIdentity(platform === 'bilibili' ? 'uid' : 'account-cookie-uid_tt', values[0]);
      }
      if (!own) return null;
      const value = { accountId: identityHash(platform, own), identityKind: own.kind };
      if ((expectedIdentity && expectedIdentity !== value.accountId) || (bound && bound.accountId !== value.accountId)) throw fault('PLATFORM_ACCOUNT_CHANGED');
      return value;
    }
    async function guard() {
      const value = await identity();
      if (!value) throw fault('LOGIN_REQUIRED');
      check(owner, platform); return value;
    }
    try {
      const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(fault(finalError)), interactive ? connectTimeoutMs : refreshTimeoutMs); });
      const closed = new Promise((_resolve, reject) => win.once('closed', () => reject(fault(disposed ? 'REVENUE_DISPOSED' : closeReason))));
      watcher = setInterval(() => {
        try { check(owner, platform); } catch (error) { closeReason = error.code; if (!win.isDestroyed()) win.destroy(); }
      }, 250);
      const collect = async () => {
        try { await wc.loadURL(pageUrl); } catch { throw fault('REVENUE_NETWORK_ERROR'); }
        let candidate, recovery = 0;
        while (!stopped && !win.isDestroyed()) {
          let value;
          try { value = await identity(); }
          catch (error) {
            if (interactive && error.code === 'VERIFICATION_REQUIRED') { finalError = error.code; await delay(750); continue; }
            throw error;
          }
          if (!value) {
            candidate = null;
            if (interactive && platform === 'kuaishou' && needsLogin && new URL(wc.getURL()).hostname === 'cp.kuaishou.com' && recovery < 2) {
              recovery++; needsLogin = false; await wc.loadURL(PLATFORMS.kuaishou.loginUrl); continue;
            }
            // QR login can finish on Bilibili's public home.
            if (platform === 'bilibili' && new URL(wc.getURL()).hostname === 'www.bilibili.com' && recovery < 2) {
              const auth = await storage.cookies.get({ url: 'https://www.bilibili.com/' });
              if (auth.some(c => c.name === 'DedeUserID' && c.value) && auth.some(c => c.name === 'SESSDATA' && c.value)) {
                recovery++; await wc.loadURL(pageUrl); continue;
              }
            }
            await delay(750); continue;
          }
          if (candidate !== value.accountId) { candidate = value.accountId; await delay(750); continue; }
          bound = value; boundCookie = lastCookie; break;
        }
        if (!bound) throw fault(closeReason);
        finalError = 'REVENUE_COLLECTION_TIMEOUT';
        const request = async descriptor => {
          await guard();
          await delay(requestIntervalMs);
          await guard(); const before = revision;
          const result = await pageRequest(descriptor);
          await guard();
          if (before !== revision) throw fault('PAGE_CHANGED');
          return result;
        };
        const verifySelf = async () => {
          if (platform !== 'bilibili') return;
          const self = identityFromResponse('bili', await request(requestFor(platform, 'identity')));
          if (!self) throw fault('LOGIN_REQUIRED');
          if (identityHash(platform, self) !== bound.accountId) throw fault('PLATFORM_ACCOUNT_CHANGED');
        };
        await verifySelf();
        const snapshot = source === 'anchor_dashboard' ? await collectDouyinAnchorRevenue({ ...bound, request }) :
          source === 'wallet' ? await collectDouyinWalletRevenue({ ...bound, fromMonth, toMonth, request }) :
          await collectCreatorRevenue({ platform, ...bound, ownUserId, fromMonth, toMonth, request,
            readWallet: (url, descriptor) => readWechatWallet({ BrowserWindow, storage, windows: children, guard, url, descriptor,
              requestTimeoutMs, timeoutMs: Math.min(30000, interactive ? connectTimeoutMs : refreshTimeoutMs), interactive }) });
        await verifySelf();
        await guard();
        return { ...snapshot, ...(source === 'anchor_dashboard' && fromMonth ? { requestedMonths: monthRange(fromMonth, toMonth) } : {}), binding: 'creator_session', profileUrl: pageUrl };
      };
      const result = await Promise.race([collect(), deadline, closed]);
      check(owner, platform); return result;
    } finally {
      stopped = true; clearTimeout(timer); clearInterval(watcher);
      storage.cookies.removeListener('changed', cookieChanged); storage.removeListener('will-download', preventDownload);
      for (const child of children) if (!child.isDestroyed()) child.destroy();
      if (!win.isDestroyed()) win.destroy();
      active.delete(key); windows.delete(win);
    }
  }
  return {
    connect: options => acquire({ ...options, interactive: true }),
    lookup: options => acquire({ ...options, interactive: false }),
    dispose() { disposed = true; for (const win of windows) if (!win.isDestroyed()) win.destroy(); }
  };
}
module.exports = { createCreatorRevenueBrowser };
