'use strict';
const { randomUUID } = require('node:crypto');
const { decodeWechatResponse, isMessageUrl, LIVE_URL, MAX_BODY } = require('./wechat-decoder.cjs');
const MAX_LOGIN_BODY = 256 * 1024;
const AUTH_STAGES = new Map([
  ['/cgi-bin/mmfinderassistant-bin/auth/auth_with_oauth', 'oauth'],
  ['/cgi-bin/mmfinderassistant-bin/auth/auth_finder_list', 'finder-list'],
  ['/cgi-bin/mmfinderassistant-bin/auth/login_finder', 'finder-login']
]);
function authStage(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'channels.weixin.qq.com' || url.port || url.username || url.password) return '';
    return AUTH_STAGES.get(url.pathname) || '';
  } catch { return ''; }
}
function numericStatus(value, prefix = '', fields = ['errCode', 'ret', 'code', 'acctStatus']) {
  const result = {};
  for (const field of fields) if (Number.isSafeInteger(value?.[field])) result[prefix + field] = value[field];
  return result;
}
function loginResponseShape(value) {
  const errorFields = ['errCode', 'ret', 'code'];
  const result = { ...numericStatus(value), ...numericStatus(value?.data, 'data_') };
  // Rebuild only known numeric fields. No source object, dynamic key, identity,
  // login code, Cookie, or response text can reach the diagnostic callback.
  Object.assign(result, numericStatus(value?.base_resp, 'base_', errorFields), numericStatus(value?.baseResponse, 'base_', errorFields),
    numericStatus(value?.data?.base_resp, 'data_base_', errorFields), numericStatus(value?.data?.baseResponse, 'data_base_', errorFields));
  const list = Array.isArray(value?.data?.finderList) ? value.data.finderList : Array.isArray(value?.finderList) ? value.finderList : null;
  if (list) {
    result.finderListCount = list.length;
    result.finderStatuses = [];
    for (const item of list) {
      const status = Number.isSafeInteger(item?.acctStatus) ? item.acctStatus : item?.status;
      if (Number.isSafeInteger(status)) result.finderStatuses.push(status);
      if (result.finderStatuses.length === 20) break;
    }
  }
  return result;
}
function allowedPage(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    (url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')); } catch { return false; }
}
function validCookie(cookie) {
  return cookie && typeof cookie.name === 'string' && cookie.name.length <= 256 &&
    typeof cookie.value === 'string' && cookie.value.length <= 12000 &&
    typeof cookie.domain === 'string' && (cookie.domain.replace(/^\./, '') === 'weixin.qq.com' || cookie.domain.endsWith('.weixin.qq.com')) &&
    typeof cookie.path === 'string' && cookie.path.startsWith('/') && cookie.path.length <= 1024;
}
function cookieDetails(cookie) {
  const details = { url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`, name: cookie.name, value: cookie.value,
    domain: cookie.domain, path: cookie.path, secure: true, httpOnly: cookie.httpOnly === true };
  if (['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie.sameSite)) details.sameSite = cookie.sameSite;
  if (Number.isFinite(cookie.expirationDate)) details.expirationDate = cookie.expirationDate;
  return details;
}
const PAGE_LOAD_ERROR = '视频号后台暂时无法打开，请检查网络并在后台窗口刷新，或断开后重新连接。';
// The remote page never receives a preload or Node privileges. Persistence is
// supplied by the embedding application; the example disables it entirely.
class WechatCollector {
  constructor({ BrowserWindow, session, credentials, showWindows = true, onLoginDiagnostic = () => {} }) {
    this.BrowserWindow = BrowserWindow; this.sessionApi = session; this.credentials = credentials;
    this.onLoginDiagnostic = onLoginDiagnostic;
    this.showWindows = showWindows; this.run = null; this.stopping = null; this.retainedSession = null; this.connectGeneration = 0;
  }
  async connect({ remember = true, onState, onEvent, onDiagnostic = () => {} }) {
    const generation = ++this.connectGeneration;
    await this.stop({ preserveSession: true, keepConnecting: true });
    if (generation !== this.connectGeneration) return;
    const retainedSession = this.retainedSession; this.retainedSession = null;
    if (retainedSession && !remember) await retainedSession.clearStorageData().catch(() => {});
    if (generation !== this.connectGeneration) return;
    const run = { active: true, closing: false, remember, restored: false, reused: Boolean(remember && retainedSession), loginSessionReported: false, onState, onEvent, onDiagnostic,
      requests: new Map(), authRequests: new Map(), authInFlight: 0, savedTimer: null, saving: Promise.resolve(), inFlight: 0,
      statusSessionId: randomUUID(), statusSequence: 0, statusRoomId: '', liveStatus: '', requestOrder: 0, lastStatusRequestOrder: 0 };
    this.run = run;
    run.cancelled = new Promise(resolve => { run.cancel = resolve; });
    run.session = run.reused ? retainedSession : this.sessionApi.fromPartition(`furryup-live-connect-wechat-${randomUUID()}`, { cache: false });
    if (!run.reused) {
      run.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      run.session.setPermissionCheckHandler(() => false);
      run.session.on('will-download', event => event.preventDefault());
    }
    let stage = 'login-record';
    try {
      if (remember && !run.reused && this.credentials.has('wechat')) {
        const saved = JSON.parse(this.credentials.read('wechat'));
        if (!Array.isArray(saved) || saved.length > 100 || saved.some(cookie => !validCookie(cookie))) throw new Error('Invalid saved login');
        for (const cookie of saved) {
          if (!run.active) return;
          if (Number.isFinite(cookie.expirationDate) && cookie.expirationDate <= Date.now() / 1000) continue;
          await Promise.race([run.session.cookies.set(cookieDetails(cookie)), run.cancelled]);
          if (!run.active) return;
          run.restored = true;
        }
      }
      if (!run.active) return;
      this.reportLoginSession(run);
      stage = 'browser-window';
      const window = new this.BrowserWindow({ width: 1100, height: 800, minWidth: 800, minHeight: 600,
        title: '视频号后台 · 扫码后进入自己的直播间', show: this.showWindows, autoHideMenuBar: true,
        webPreferences: { session: run.session, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false } });
      run.window = window;
      const wc = window.webContents;
      wc.setUserAgent(wc.getUserAgent().replace(/\s(?:Electron|furryup-live-connect|furryup-studio|FurryUPStudio)\/[^\s]+/g, ''));
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', (event, url) => { if (!allowedPage(url)) event.preventDefault(); });
      wc.on('will-redirect', (event, url) => { if (!allowedPage(url)) event.preventDefault(); });
      wc.on('did-navigate', (_event, url) => {
        if (run.active && allowedPage(url) && /\/login(?:\.html$|[/?-]|$)/.test(new URL(url).pathname)) {
          onState({ state: 'awaiting-login', error: '请在视频号后台扫码登录，再进入自己的直播间。' });
        }
      });
      wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
        // A login redirect intentionally cancels the previous document load.
        // Subresource failures also do not invalidate the login page itself.
        if (run.active && isMainFrame && code !== -3) {
          onState({ state: 'message-error', errorCode: 'WECHAT_PAGE_LOAD', error: PAGE_LOAD_ERROR });
        }
      });
      wc.on('render-process-gone', () => { if (run.active) { onState({ state: 'connect-failed', error: '视频号后台页面异常退出，请断开后重新连接。' }); void this.stop(); } });
      window.on('close', () => { run.closing = true; });
      wc.on('will-prevent-unload', () => { run.closing = false; });
      window.on('closed', () => {
        if (!run.active) return;
        onState({ state: 'stopped', error: '视频号后台窗口已关闭，采集已停止。' });
        void this.stop({ preserveSession: true });
      });
      run.cookiesChanged = () => {
        clearTimeout(run.savedTimer);
        if (run.active && run.remember) {
          run.savedTimer = setTimeout(() => { void this.saveLogin(run); }, 750);
          run.savedTimer.unref?.();
        }
      };
      run.session.cookies.on('changed', run.cookiesChanged);
      stage = 'message-listener';
      // Initialize Chromium's renderer before awaiting CDP commands. An unloaded
      // WebContents has no Network agent and can leave Network.enable pending.
      await Promise.race([window.loadURL('about:blank'), run.cancelled]);
      if (!run.active) return;
      wc.debugger.attach('1.3');
      wc.debugger.on('detach', () => {
        if (run.active && !run.closing) { onState({ state: 'connect-failed', error: '视频号消息监听已断开，请断开后重新连接。' }); void this.stop(); }
      });
      wc.debugger.on('message', (_event, method, params) => { void this.networkMessage(run, method, params); });
      await Promise.race([wc.debugger.sendCommand('Network.enable', { maxTotalBufferSize: MAX_BODY * 2, maxResourceBufferSize: MAX_BODY }), run.cancelled]);
      if (!run.active) return;
      stage = 'page-load';
      onState({ state: 'awaiting-login', error: '请在打开的视频号后台扫码登录，并进入自己的直播间。' });
      await Promise.race([window.loadURL(LIVE_URL), run.cancelled]);
    } catch (error) {
      this.reportLoginSession(run);
      if (stage === 'page-load' && run.active && run.window && !run.window.isDestroyed()) {
        const aborted = error?.code === 'ERR_ABORTED' || error?.errno === -3;
        if (aborted && allowedPage(run.window.webContents.getURL())) return;
        // Leave Chromium's error page open so a refresh can recover without
        // discarding the debugger, transient login session, or collector run.
        onState({ state: 'message-error', errorCode: 'WECHAT_PAGE_LOAD', error: PAGE_LOAD_ERROR });
        return;
      }
      const errors = { 'login-record': '视频号登录记录无法读取，请清除登录记录后重新扫码。',
        'browser-window': '视频号后台窗口未能启动，请重启采集示例后重试。',
        'message-listener': '视频号消息监听未能启动，请重启采集示例后重试。',
        'page-load': '视频号后台无法打开，请检查网络后重新连接。' };
      if (run.active) onState({ state: 'connect-failed', errorCode: `WECHAT_${stage.toUpperCase().replaceAll('-', '_')}`, error: errors[stage] });
      if (this.run === run) await this.stop();
    }
  }
  loginDiagnostic(value) {
    try {
      const pending = this.onLoginDiagnostic(value);
      if (typeof pending?.catch === 'function') pending.catch(() => {});
    } catch { /* Optional diagnostics cannot interrupt login or collection. */ }
  }
  reportLoginSession(run) {
    if (!run.active || run.loginSessionReported) return;
    run.loginSessionReported = true;
    this.loginDiagnostic({ kind: 'session', remember: run.remember === true, restored: run.restored,
      ...(run.reused && { reused: true }) });
  }
  async loginResponse(run, id, encodedDataLength) {
    const request = run.authRequests.get(id); run.authRequests.delete(id);
    if (!request) return;
    const summary = { kind: 'auth', ...request };
    if (encodedDataLength > MAX_LOGIN_BODY || run.authInFlight >= 2) {
      this.loginDiagnostic(summary); return;
    }
    run.authInFlight++;
    try {
      const response = await run.window.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: id });
      if (!run.active) return;
      if (typeof response.body !== 'string' || response.body.length > MAX_LOGIN_BODY * 1.4) throw new Error('Invalid login body');
      const body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
      if (Buffer.byteLength(body, 'utf8') > MAX_LOGIN_BODY) throw new Error('Invalid login body');
      Object.assign(summary, loginResponseShape(JSON.parse(body)));
    } catch { /* The HTTP status remains useful when the body is unavailable. */ }
    finally {
      run.authInFlight--;
      if (run.active) this.loginDiagnostic(summary);
    }
  }
  async networkMessage(run, method, params) {
    if (!run.active) return;
    const id = params.requestId;
    if (method === 'Network.responseReceived') {
      const stage = authStage(params.response?.url);
      if (stage && Number.isSafeInteger(params.response.status) && params.response.status >= 100 && params.response.status <= 599) {
        run.authRequests.set(id, { stage, httpStatus: params.response.status });
        while (run.authRequests.size > 32) run.authRequests.delete(run.authRequests.keys().next().value);
        return;
      }
    } else if (method === 'Network.loadingFinished' && run.authRequests.has(id)) {
      await this.loginResponse(run, id, params.encodedDataLength); return;
    } else if (method === 'Network.loadingFailed') {
      const auth = run.authRequests.get(id); run.authRequests.delete(id);
      if (auth) this.loginDiagnostic({ kind: 'auth', ...auth });
    }
    if (method === 'Network.requestWillBeSent' && isMessageUrl(params.request?.url)) {
      let request = {};
      try { if (params.request.postData?.length <= 64 * 1024) request = JSON.parse(params.request.postData); } catch { }
      // Retain only the session identifier and a local ordering counter, never
      // request headers, Cookies or signatures.
      run.requests.set(id, { liveId: request.liveId, order: ++run.requestOrder });
      while (run.requests.size > 128) run.requests.delete(run.requests.keys().next().value);
    } else if (method === 'Network.responseReceived' && isMessageUrl(params.response?.url)) {
      const request = run.requests.get(id) || { order: ++run.requestOrder };
      request.ready = params.response.status === 200;
      run.requests.set(id, request);
      while (run.requests.size > 128) run.requests.delete(run.requests.keys().next().value);
      if (!request.ready) run.onState({ state: 'message-error', error: '视频号消息请求未成功，请在后台检查登录、验证和开播状态。' });
    } else if (method === 'Network.loadingFailed') {
      if (run.requests.delete(id)) run.onState({ state: 'message-error', error: '视频号消息请求中断，等待后台继续获取；若持续异常，请重新连接。' });
    } else if (method === 'Network.loadingFinished') {
      const request = run.requests.get(id); run.requests.delete(id);
      if (!request?.ready) return;
      if (params.encodedDataLength > MAX_BODY || run.inFlight >= 4) {
        run.onState({ state: 'message-error', error: '已忽略过大或过密的视频号响应。' }); return;
      }
      run.inFlight++;
      try {
        const response = await run.window.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: id });
        if (!run.active) return;
        if (typeof response.body !== 'string' || response.body.length > MAX_BODY * 1.4) throw new Error('Invalid body');
        const body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
        const decoded = decodeWechatResponse(body, request);
        if (decoded.error) {
          run.onState({ state: 'message-error', error: '视频号后台未返回有效消息，请检查登录、验证和开播状态。' }); return;
        }
        if (!decoded.roomId) return;
        for (let i = 0; i < decoded.giftCallbacks; i++) run.onDiagnostic('giftCallbacks');
        for (let i = 0; i < decoded.giftParseErrors; i++) run.onDiagnostic('giftParseErrors');
        run.onState({ state: 'connected', roomId: decoded.roomId, error: '' });
        if (decoded.liveStatus && request.order >= run.lastStatusRequestOrder) {
          run.lastStatusRequestOrder = request.order;
          if (run.statusRoomId !== decoded.roomId || run.liveStatus !== decoded.liveStatus) {
            run.statusRoomId = decoded.roomId; run.liveStatus = decoded.liveStatus;
            // Room status has no platform message ID. A run-local sequence keeps
            // repeated snapshots quiet while retaining later stop/start cycles.
            run.onEvent({ event_type: 'live_status', live_status: decoded.liveStatus,
              source_msg_id: `status:${run.statusSessionId}:${++run.statusSequence}:${decoded.liveStatus}` }, decoded.roomId);
          }
        }
        for (const event of decoded.events) { if (!run.active) break; run.onEvent(event, decoded.roomId); }
        if (decoded.errors) run.onState({ error: '已忽略无法解析的视频号互动；其余消息继续接收。' });
      } catch {
        if (run.active) run.onState({ state: 'message-error', error: '视频号响应暂时无法解析，等待下一次消息；若持续异常，需要更新接入组件。' });
      } finally { run.inFlight--; }
    }
  }
  saveLogin(run) {
    run.saving = run.saving.then(async () => {
      if (!run.remember) return;
      try {
        const cookies = (await run.session.cookies.get({})).filter(validCookie).slice(0, 100).map(cookieDetails);
        if (!run.remember) return;
        if (!cookies.length) { this.credentials.clear('wechat'); if (run.active) run.onState({ loginSaved: false }); return; }
        this.credentials.save('wechat', JSON.stringify(cookies));
        if (run.active) run.onState({ loginSaved: true });
      } catch {
        if (run.active) run.onState({ error: '视频号登录记录未能加密保存，本次仍可接收，下次需重新扫码。' });
      }
    });
    return run.saving;
  }
  async setRemember(value) {
    const run = this.run;
    if (run) { run.remember = value === true; clearTimeout(run.savedTimer); }
    if (!value) {
      if (run) await run.saving;
      await this.stopping;
      await this.clearRetainedSession();
      this.credentials.clear('wechat');
    }
    else if (run) await this.saveLogin(run);
  }
  focus() {
    const window = this.run?.window;
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
    }
  }
  async clearRetainedSession() {
    const retainedSession = this.retainedSession; this.retainedSession = null;
    if (retainedSession) await retainedSession.clearStorageData().catch(() => {});
  }
  async stop({ preserveSession = false, keepConnecting = false } = {}) {
    if (!keepConnecting) this.connectGeneration++;
    if (this.stopping) {
      await this.stopping;
      if (!preserveSession) await this.clearRetainedSession();
      return;
    }
    const run = this.run;
    if (!run) { if (!preserveSession) await this.clearRetainedSession(); return; }
    this.run = null; run.active = false; run.cancel(); clearTimeout(run.savedTimer);
    run.session.cookies.removeListener('changed', run.cookiesChanged || (() => {}));
    if (run.window && !run.window.isDestroyed()) run.window.destroy();
    this.stopping = (async () => {
      await this.saveLogin(run);
      run.requests.clear(); run.authRequests.clear();
      // A normal disconnect stops collection, but keeps the entire transient
      // Chromium login, including official local storage. Rebuilding it from
      // Cookies alone loses part of WeChat's selected-account state.
      if (preserveSession && run.remember) this.retainedSession = run.session;
      else await run.session.clearStorageData().catch(() => {});
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }
}
module.exports = { WechatCollector, allowedPage, validCookie };
