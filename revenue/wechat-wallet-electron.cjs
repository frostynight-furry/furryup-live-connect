// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { fault } = require('./model.cjs');
const { WECHAT_WALLET_ORIGIN, walletRequest } = require('./wechat-channels.cjs');
const { fetchRevenuePage } = require('./page-transport.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function walletLocation(address) {
  try { const u = new URL(address); return u.origin === WECHAT_WALLET_ORIGIN && !u.username && !u.password; }
  catch { return false; }
}
async function readWechatWallet({ BrowserWindow, storage, windows, guard, url, descriptor, requestTimeoutMs, timeoutMs, interactive }) {
  if (!walletLocation(url) || descriptor.url !== walletRequest().url || descriptor.method !== 'POST') throw fault('UNTRUSTED_PAGE');
  const entry = new URL(url), query = new URLSearchParams(entry.hash.split('?')[1]);
  if (entry.pathname !== '/' || !entry.hash.startsWith('#/login?') || query.get('busid') !== '3' || !query.get('authcode') || !['1', '2'].includes(query.get('account_type'))) throw fault('UNTRUSTED_PAGE');
  await guard();
  const win = new BrowserWindow({ show: interactive, width: 1050, height: 780, autoHideMenuBar: true, skipTaskbar: !interactive,
    title: '视频号 · 官方直播结算', webPreferences: { session: storage, nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, backgroundThrottling: false } });
  windows.add(win);
  const wc = win.webContents; let stopped = false, authenticated = false, authFailed = false, timer, revision = 0;
  let cookieBaseline, cookiesChanged = false;
  const cookieKey = cookie => JSON.stringify([cookie.domain, cookie.path, cookie.name]);
  const cookieChanged = (_event, cookie, cause, removed) => {
    const domain = (cookie.domain || '').replace(/^\./, '');
    if (cookieBaseline && (domain === 'qy.webeans.weixin.qq.com' || 'qy.webeans.weixin.qq.com'.endsWith('.' + domain)) &&
      (cookieBaseline.get(cookieKey(cookie)) !== cookie.value || removed && cause !== 'overwrite')) cookiesChanged = true;
  };
  storage.cookies.on('changed', cookieChanged);
  const pending = new Map();
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const navigation = (event, address) => { if (!walletLocation(address)) event.preventDefault(); };
  wc.on('will-navigate', navigation); wc.on('will-redirect', navigation);
  wc.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { revision++; authenticated = false; } });
  // Require this fresh handoff to authenticate. An old wallet cookie alone
  // cannot establish that the wallet belongs to the bound creator account.
  const observe = async (_event, method, params) => {
    if (stopped) return;
    if (method === 'Network.responseReceived') {
      if (params.type === 'XHR' || params.type === 'Fetch') {
        const response = params.response;
        if (response.url === WECHAT_WALLET_ORIGIN + '/api/auth/getCookie') {
          if (![200, 201].includes(response.status)) authFailed = true;
          else pending.set(params.requestId, revision);
        }
      }
    } else if (method === 'Network.loadingFailed') pending.delete(params.requestId);
    else if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
      const started = pending.get(params.requestId); pending.delete(params.requestId);
      if (params.encodedDataLength > 1024 * 1024) { authFailed = true; return; }
      try {
        const body = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        if (body.base64Encoded || typeof body.body !== 'string' || Buffer.byteLength(body.body) > 1024 * 1024) { authFailed = true; return; }
        const response = JSON.parse(body.body);
        if (response.error || !response.data || !(response.data.cookie === true || typeof response.data.cookie === 'string' && response.data.cookie)) { authFailed = true; return; }
        if (!stopped && revision === started) authenticated = true;
      } catch { authFailed = true; }
    }
  };
  try {
    wc.debugger.attach('1.3'); wc.debugger.on('message', observe);
    // A fresh WebContents may not create its renderer until navigation starts.
    // Queue observation first, then await it alongside navigation under the deadline.
    const enabled = wc.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 2 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024 });
    const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(fault('REVENUE_WALLET_TIMEOUT')), timeoutMs); });
    const closed = new Promise((_resolve, reject) => win.once('closed', () => reject(fault('LOGIN_CANCELLED'))));
    const collect = async () => {
      try { await Promise.all([wc.loadURL(url), enabled]); } catch { throw fault('REVENUE_NETWORK_ERROR'); }
      while (!stopped && !win.isDestroyed() && !authenticated) {
        if (authFailed) throw fault('REVENUE_WALLET_LOGIN_REQUIRED');
        await guard(); await delay(750);
      }
      if (stopped || win.isDestroyed()) throw fault('LOGIN_CANCELLED');
      await guard(); const before = revision;
      const cookieState = async () => JSON.stringify((await storage.cookies.get({ url: WECHAT_WALLET_ORIGIN + '/' }))
        .map(c => [c.domain, c.path, c.name, c.value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
      const boundCookies = await cookieState();
      cookieBaseline = new Map((await storage.cookies.get({ url: WECHAT_WALLET_ORIGIN + '/' })).map(c => [cookieKey(c), c.value]));
      const result = await wc.executeJavaScript('(' + fetchRevenuePage.toString() + ')(' +
        [descriptor, WECHAT_WALLET_ORIGIN, requestTimeoutMs, 2 * 1024 * 1024].map(v => JSON.stringify(v)).join(',') + ')');
      await guard();
      if (cookiesChanged || await cookieState() !== boundCookies) throw fault('PLATFORM_ACCOUNT_CHANGED');
      if (!authenticated || before !== revision) throw fault('PAGE_CHANGED');
      if (result.error) throw fault(result.error === 'LOGIN_REQUIRED' ? 'REVENUE_WALLET_LOGIN_REQUIRED' : result.error);
      return result.body;
    };
    return await Promise.race([collect(), deadline, closed]);
  } finally {
    stopped = true; clearTimeout(timer); pending.clear(); wc.debugger.removeListener('message', observe);
    storage.cookies.removeListener('changed', cookieChanged);
    try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
    if (!win.isDestroyed()) win.destroy(); windows.delete(win);
  }
}
module.exports = { readWechatWallet };
