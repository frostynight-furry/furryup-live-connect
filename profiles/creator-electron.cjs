// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { createHash } = require('node:crypto');
const { PLATFORMS, allowedNavigation, parseCount, cleanIdentity, identityResponseKind, identityFromResponse, readCreatorPage } = require('./creator-page.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const fault = code => Object.assign(new Error(code), { code });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const identityHash = (platform, identity) => hash(JSON.stringify([platform, identity.kind, identity.value]));
function partitionFor(owner, platform, prefix = 'liveconnect-followers') {
  if (typeof prefix !== 'string' || !/^[a-z0-9._-]{1,80}$/.test(prefix)) throw new TypeError('Invalid session partition prefix');
  return 'persist:' + prefix + '-' + hash(JSON.stringify([owner, platform]));
}

function createCreatorFollowerBrowser({ BrowserWindow, session, getAccount, translate = value => value,
  connectTimeoutMs = 180000, refreshTimeoutMs = 25000, cacheMs = 60000,
  partitionPrefix = 'liveconnect-followers', applicationName = 'LiveConnect', userAgentProductTokens = [] } = {}) {
  if (typeof BrowserWindow !== 'function' || !session || typeof session.fromPartition !== 'function' || typeof getAccount !== 'function') throw new TypeError('Electron BrowserWindow, session and getAccount are required');
  partitionFor('validation', 'douyin', partitionPrefix);
  if (typeof applicationName !== 'string' || applicationName.length > 80 || /[\x00-\x1f]/.test(applicationName)) throw new TypeError('Invalid application name');
  if (!Array.isArray(userAgentProductTokens) || userAgentProductTokens.length > 20 || userAgentProductTokens.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(value))) throw new TypeError('Invalid user agent product tokens');
  for (const value of [connectTimeoutMs, refreshTimeoutMs]) if (!Number.isFinite(value) || value < 1 || value > 600000) throw new TypeError('Invalid acquisition timeout');
  if (!Number.isFinite(cacheMs) || cacheMs < 0 || cacheMs > 600000) throw new TypeError('Invalid cache duration');
  const active = new Map(), cache = new Map();
  function check(owner, platform) {
    if (!Object.hasOwn(PLATFORMS, platform)) throw fault('INVALID_PROFILE_URL');
    const account = getAccount();
    if (!owner || account?.accountId !== owner || account.kind === 'signed-out') throw fault('ACCOUNT_CHANGED');
  }
  async function acquire({ owner, platform, interactive = false, expectedIdentity, identityKind }) {
    check(owner, platform);
    const key = partitionFor(owner, platform, partitionPrefix);
    if (active.has(key)) throw fault('FOLLOWERS_BUSY');
    const cached = cache.get(key);
    if (!interactive && cached && Date.now() - cached.at < cacheMs && cached.value.accountId === expectedIdentity) return structuredClone(cached.value);
    if (interactive) cache.delete(key);
    const storage = session.fromPartition(key, { cache: true });
    storage.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    storage.setPermissionCheckHandler(() => false);
    const preventDownload = event => event.preventDefault();
    storage.on('will-download', preventDownload);
    const win = new BrowserWindow({ show: interactive, width: 1120, height: 820, autoHideMenuBar: true,
      title: applicationName + ' · ' + translate(PLATFORMS[platform].name) + ' · ' + translate('登录后自动读取粉丝数'),
      skipTaskbar: !interactive, webPreferences: { session: storage, nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, backgroundThrottling: false } });
    active.set(key, win);
    if (interactive) win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
    const wc = win.webContents;
    // Reuse the existing LiveConnect WeChat collector's Chromium compatibility
    // setting. Retain Chromium/OS versions; only remove embedded app tokens.
    if (platform === 'wechat_channels') wc.setUserAgent(wc.getUserAgent().split(/\s+/).filter(token => !['Electron', 'furryup-live-connect', ...userAgentProductTokens].includes(token.split('/')[0])).join(' '));
    let stopped = false, latest = null, latestIdentity = null, latestStats = null, revision = 0, timer, accountWatcher, closeReason = 'LOGIN_CANCELLED';
    let finalError = 'LOGIN_REQUIRED';
    const requests = new Map();
    win.on('page-title-updated', event => event.preventDefault());
    const navigation = (event, url) => { if (!allowedNavigation(platform, url)) event.preventDefault(); };
    wc.on('will-navigate', navigation); wc.on('will-redirect', navigation);
    wc.setWindowOpenHandler(({ url }) => {
      if (allowedNavigation(platform, url)) wc.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    wc.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) { revision++; latestIdentity = null; latestStats = null; requests.clear(); }
    });
    const onProtocol = async (_event, method, params) => {
      if (stopped) return;
      if (method === 'Network.responseReceived') {
        const kind = identityResponseKind(platform, params.response?.url);
        if (kind && params.response?.status >= 200 && params.response.status < 300 && /json/i.test(params.response?.mimeType || '') && requests.size < 20) requests.set(params.requestId, { kind, revision });
      } else if (method === 'Network.loadingFinished' && requests.has(params.requestId)) {
        const entry = requests.get(params.requestId); requests.delete(params.requestId);
        if (params.encodedDataLength > 1024 * 1024) return;
        try {
          const result = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          if (result.base64Encoded || result.body.length > 1024 * 1024 || stopped || entry.revision !== revision) return;
          const identity = identityFromResponse(entry.kind, JSON.parse(result.body));
          if (identity) { latestIdentity = identity; if (identity.count) latestStats = identity; }
        } catch { /* Missing/changed self-info is surfaced without recording the body. */ }
      } else if (method === 'Network.loadingFailed') requests.delete(params.requestId);
    };
    try {
      wc.debugger.attach('1.3'); wc.debugger.on('message', onProtocol);
      // On a new hidden WebContents, CDP initialization may await the first
      // navigation. Start both under the same bounded acquisition deadline.
      const networkReady = wc.debugger.sendCommand('Network.enable', { maxResourceBufferSize: 1024 * 1024, maxTotalBufferSize: 2 * 1024 * 1024 });
      const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(fault(finalError)), interactive ? connectTimeoutMs : refreshTimeoutMs); });
      const closed = new Promise((_resolve, reject) => win.once('closed', () => reject(fault(closeReason))));
      accountWatcher = setInterval(() => {
        try { check(owner, platform); } catch { closeReason = 'ACCOUNT_CHANGED'; if (!win.isDestroyed()) win.destroy(); }
      }, 500);
      const collect = async () => {
        await Promise.all([networkReady, wc.loadURL(PLATFORMS[platform].url).catch(() => { finalError = 'NETWORK_ERROR'; })]);
        let stable = '', stableSince = 0, recoveryCount = 0, recoveredAt = 0, loginOpened = false;
        const loadedAt = Date.now();
        while (!stopped && !win.isDestroyed()) {
          check(owner, platform);
          if (!allowedNavigation(platform, wc.getURL())) throw fault('UNTRUSTED_PAGE');
          if (new URL(wc.getURL()).hostname !== new URL(PLATFORMS[platform].url).hostname) {
            // Bilibili can finish QR confirmation on its public home rather
            // than the requested creator URL. Return only after authenticated
            // cookies exist; never scrape that public page as the owner's data.
            if (platform === 'bilibili' && recoveryCount < 2 && Date.now() - recoveredAt > 10000) {
              const auth = await storage.cookies.get({ url: 'https://www.bilibili.com/' });
              if (auth.some(c => c.name === 'DedeUserID' && c.value) && auth.some(c => c.name === 'SESSDATA' && c.value)) {
                recoveryCount++; recoveredAt = Date.now();
                await wc.loadURL(PLATFORMS[platform].url).catch(() => {}); continue;
              }
            }
            finalError = 'LOGIN_REQUIRED'; await delay(750); continue;
          }
          let page;
          try { page = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: '(' + readCreatorPage.toString() + ')(' + JSON.stringify(platform) + ')' }]); }
          catch { finalError = 'PAGE_CHANGED'; await delay(500); continue; }
          if (page.challenge) { finalError = 'VERIFICATION_REQUIRED'; if (!interactive) throw fault(finalError); await delay(750); continue; }
          if (page.login) {
            finalError = 'LOGIN_REQUIRED';
            if (interactive && !loginOpened && PLATFORMS[platform].loginUrl) {
              loginOpened = true; await wc.loadURL(PLATFORMS[platform].loginUrl).catch(() => {}); continue;
            }
            if (!interactive && Date.now() - loadedAt >= 3000) throw fault(finalError); await delay(750); continue;
          }
          const identities = [];
          if (latestIdentity) identities.push(latestIdentity);
          const cookieNames = { bilibili: ['DedeUserID'], douyin: ['uid_tt'], kuaishou: ['userId', 'kuaishou.userId'] };
          if (cookieNames[platform]) {
            const cookies = await storage.cookies.get({ url: PLATFORMS[platform].url });
            for (const name of cookieNames[platform]) {
              const values = [...new Set(cookies.filter(item => item.name === name).map(item => item.value))];
              if (values.length === 1) {
                const identity = cleanIdentity(platform === 'bilibili' ? 'uid' : 'account-cookie-' + name, values[0], page.displayName);
                if (identity) identities.push(identity);
              }
            }
          }
          const handle = cleanIdentity(platform === 'bilibili' ? 'uid' : 'handle', page.handle, page.displayName);
          if (handle) identities.push(handle);
          const identity = identityKind ? identities.find(item => item.kind === identityKind) : identities[0];
          if (!identity) { finalError = 'IDENTITY_UNAVAILABLE'; await delay(750); continue; }
          const accountId = identityHash(platform, identity);
          if (expectedIdentity && accountId !== expectedIdentity) throw fault('PLATFORM_ACCOUNT_CHANGED');
          if (latestStats && identityHash(platform, latestStats) !== accountId) { finalError = 'COUNT_UNAVAILABLE'; await delay(750); continue; }
          const counts = latestStats && identityHash(platform, latestStats) === accountId ? [latestStats.count] :
            (Array.isArray(page.counts) ? page.counts : []).map(parseCount).filter(Boolean);
          const unique = [...new Map(counts.map(value => [JSON.stringify(value), value])).values()];
          if (unique.length !== 1) { finalError = unique.length ? 'AMBIGUOUS_COUNT' : 'COUNT_UNAVAILABLE'; await delay(750); continue; }
          // A stable account and counter over two samples avoids taking a half
          // rendered card during login or an account transition.
          const signature = JSON.stringify([accountId, unique[0]]);
          if (signature !== stable) { stable = signature; stableSince = Date.now(); await delay(750); continue; }
          if (Date.now() - stableSince < 700) { await delay(250); continue; }
          check(owner, platform);
          const at = new Date().toISOString();
          latest = { platform, accountId, profileUrl: PLATFORMS[platform].url, binding: 'creator_session', identityKind: identity.kind,
            displayName: identity.displayName || page.displayName || '', ...unique[0],
            status: unique[0].precision === 'exact' ? 'ok' : 'approximate', source: 'public_page', acquisition: 'creator_center', fetchedAt: at, dataAsOf: at };
          return latest;
        }
        throw fault('LOGIN_CANCELLED');
      };
      const value = await Promise.race([collect(), deadline, closed]);
      check(owner, platform);
      cache.set(key, { at: Date.now(), value: structuredClone(value) });
      return value;
    } finally {
      stopped = true; clearTimeout(timer); clearInterval(accountWatcher); requests.clear();
      try { wc.debugger.removeListener('message', onProtocol); if (wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* Closed renderer. Preserve the original failure/cancellation. */ }
      storage.removeListener('will-download', preventDownload);
      if (!win.isDestroyed()) win.destroy();
      active.delete(key);
    }
  }
  return {
    connect: request => acquire({ ...request, interactive: true }),
    lookup: request => acquire({ ...request, interactive: false }),
    async disconnect({ owner, platform }) {
      check(owner, platform);
      const key = partitionFor(owner, platform, partitionPrefix); active.get(key)?.destroy(); cache.delete(key);
      const storage = session.fromPartition(key);
      await storage.clearStorageData(); await storage.clearCache();
    },
    dispose() { for (const win of active.values()) if (!win.isDestroyed()) win.destroy(); cache.clear(); }
  };
}
module.exports = { createCreatorFollowerBrowser, identityHash, partitionFor };
