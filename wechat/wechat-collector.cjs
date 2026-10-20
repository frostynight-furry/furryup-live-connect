'use strict';
const { randomUUID } = require('node:crypto');
const { ObserverSafeEmitter } = require('../core/event-stream.cjs');
const { decodeWechatResponse, isMessageUrl, LIVE_URL, MAX_BODY } = require('./wechat-decoder.cjs');
const { isGiftCatalogUrl, metadataRoomId, WechatGiftCatalog } = require('./wechat-gifts.cjs');
const { isViewerListUrl, decodeWechatViewersResponse } = require('./wechat-viewers.cjs');
const { WECHAT_LOGIN_ORIGIN, WECHAT_LOGIN_KEYS, MAX_STORAGE_VALUE_BYTES,
  decodeWechatLogin, encodeWechatLogin, normalizeStorage, validCookie, cookieDetails } = require('./wechat-login-state.cjs');
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
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Login state operation timed out')), 3000);
  })]).finally(() => clearTimeout(timer));
}
const PAGE_LOAD_ERROR = '视频号后台暂时无法打开，请检查网络并在后台窗口刷新，或断开后重新连接。';
// The remote page never receives a preload or Node privileges. Persistence is
// supplied by the embedding application; the example disables it entirely.
class WechatCollector extends ObserverSafeEmitter {
  constructor({ BrowserWindow, session, credentials, showWindows = true, onLoginDiagnostic = () => {} }) {
    super();
    this.BrowserWindow = BrowserWindow; this.sessionApi = session; this.credentials = credentials;
    this.onLoginDiagnostic = onLoginDiagnostic;
    this.showWindows = showWindows; this.run = null; this.stopping = null; this.retainedSession = null; this.connectGeneration = 0;
    this.loginGeneration = 0; this.stoppingRun = null; this.retainedLoginState = null;
  }
  notify(run, channel, ...args) {
    if (!run.active || typeof run[channel] !== 'function') return;
    const failed = () => {
      if (!run.active) return;
      this.emit('observer-error', Object.freeze({ channel, code: 'OBSERVER_CALLBACK_FAILED' }));
      // A broken diagnostic callback is reported through observer-error only;
      // calling it again would recursively report its own failure.
      if (channel !== 'onDiagnostic') this.notify(run, 'onDiagnostic', 'observerErrors');
    };
    try {
      const result = run[channel](...args);
      if (typeof result?.then === 'function') Promise.resolve(result).catch(failed);
    } catch { failed(); }
  }
  notifyRequestState(run, request, state) {
    if (!run.active || request.order < run.lastStatusRequestOrder) return;
    run.lastStatusRequestOrder = request.order;
    this.notify(run, 'onState', state);
  }
  async connect({ remember = true, onState, onEvent, onDiagnostic = () => {} }) {
    const generation = ++this.connectGeneration;
    await this.stop({ preserveSession: true, keepConnecting: true });
    if (generation !== this.connectGeneration) return;
    const retainedSession = this.retainedSession, retainedLoginState = this.retainedLoginState;
    this.retainedSession = null; this.retainedLoginState = null;
    if (retainedSession && !remember) await retainedSession.clearStorageData().catch(() => {});
    if (generation !== this.connectGeneration) return;
    const run = { active: true, closing: false, remember, restored: false, reused: Boolean(remember && retainedSession), loginSessionReported: false, onState, onEvent, onDiagnostic,
      loginGeneration: this.loginGeneration, restoreGeneration: this.loginGeneration, canSaveLogin: false,
      localStorage: remember && retainedSession ? { ...retainedLoginState?.localStorage } : {},
      storageRevision: 0, invalidStorageKeys: new Set(remember && retainedSession ? retainedLoginState?.invalidStorageKeys : []), storageClosed: false,
      requests: new Map(), authRequests: new Map(), authInFlight: 0, savedTimer: null, saving: Promise.resolve(), inFlight: 0,
      metadataRequests: new Map(), metadataInFlight: 0, metadataOrder: 0, latestViewerOrder: 0,
      giftCatalog: new WechatGiftCatalog(), messageRoomId: '',
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
        const saved = decodeWechatLogin(this.credentials.read('wechat'));
        run.localStorage = saved.localStorage;
        for (const cookie of saved.cookies) {
          if (!run.active) return;
          if (!run.remember || run.restoreGeneration !== this.loginGeneration) break;
          if (Number.isFinite(cookie.expirationDate) && cookie.expirationDate <= Date.now() / 1000) continue;
          const restoring = run.session.cookies.set(cookieDetails(cookie)).then(async () => {
            // cookies.set itself is not cancellable. Clean its late result in
            // this not-yet-exposed partition before it can become a new run.
            if (!run.active || !run.remember || run.restoreGeneration !== this.loginGeneration) {
              await run.session.clearStorageData().catch(() => {});
            }
          });
          await Promise.race([bounded(restoring), run.cancelled]);
          if (!run.active) return;
          if (!run.remember || run.restoreGeneration !== this.loginGeneration) break;
          run.restored = true;
        }
      }
      if (!run.active) return;
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
          this.notify(run, 'onState', { state: 'awaiting-login', error: '请在视频号后台扫码登录，再进入自己的直播间。' });
        }
      });
      wc.on('dom-ready', () => {
        if (!run.active) return;
        try { if (new URL(wc.getURL()).origin === WECHAT_LOGIN_ORIGIN) void this.removeRestoreScript(run); } catch {}
        this.scheduleLoginSave(run);
      });
      wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
        // A login redirect intentionally cancels the previous document load.
        // Subresource failures also do not invalidate the login page itself.
        if (run.active && isMainFrame && code !== -3) {
          this.notify(run, 'onState', { state: 'message-error', errorCode: 'WECHAT_PAGE_LOAD', error: PAGE_LOAD_ERROR });
        }
      });
      wc.on('render-process-gone', () => { if (run.active) { this.notify(run, 'onState', { state: 'connect-failed', error: '视频号后台页面异常退出，请断开后重新连接。' }); void this.stop(); } });
      window.on('close', () => { run.closing = true; });
      wc.on('will-prevent-unload', () => { run.closing = false; });
      window.on('closed', () => {
        if (!run.active) return;
        this.notify(run, 'onState', { state: 'stopped', error: '视频号后台窗口已关闭，采集已停止。' });
        void this.stop({ preserveSession: true });
      });
      run.cookiesChanged = () => this.scheduleLoginSave(run);
      run.session.cookies.on('changed', run.cookiesChanged);
      stage = 'message-listener';
      // Initialize Chromium's renderer before awaiting CDP commands. An unloaded
      // WebContents has no Network agent and can leave Network.enable pending.
      await Promise.race([window.loadURL('about:blank'), run.cancelled]);
      if (!run.active) return;
      wc.debugger.attach('1.3');
      wc.debugger.on('detach', () => {
        if (run.active && !run.closing) { this.notify(run, 'onState', { state: 'connect-failed', error: '视频号消息监听已断开，请断开后重新连接。' }); void this.stop(); }
      });
      wc.debugger.on('message', (_event, method, params) => {
        this.storageMessage(run, method, params);
        void this.networkMessage(run, method, params);
      });
      await Promise.race([wc.debugger.sendCommand('Network.enable', { maxTotalBufferSize: MAX_BODY * 2, maxResourceBufferSize: MAX_BODY }), run.cancelled]);
      if (!run.active) return;
      await Promise.race([bounded(wc.debugger.sendCommand('DOMStorage.enable')), run.cancelled]);
      if (!run.active) return;
      if (!run.remember || run.restoreGeneration !== this.loginGeneration) run.localStorage = {};
      if (!run.reused && Object.keys(run.localStorage).length) {
        // Chromium can return a script identifier while the Page agent is
        // disabled without running that script on the next document.
        await Promise.race([bounded(wc.debugger.sendCommand('Page.enable')), run.cancelled]);
        if (!run.active) return;
        // A transient sessionStorage marker prevents a second restoration even
        // if the first page immediately navigates before CDP removes the script.
        // It contains no credential and is never included in the saved state.
        run.restoreMarker = `furryup-login-restored-${randomUUID()}`;
        const source = `(() => { if (location.origin !== ${JSON.stringify(WECHAT_LOGIN_ORIGIN)} || window !== window.top) return;
          const marker = ${JSON.stringify(run.restoreMarker)};
          if (sessionStorage.getItem(marker)) return;
          sessionStorage.setItem(marker, '1');
          const values = ${JSON.stringify(run.localStorage)};
          for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
        })();`;
        const result = await Promise.race([bounded(wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source })), run.cancelled]);
        if (!run.active) return;
        if (typeof result?.identifier !== 'string' || !result.identifier) throw new Error('Login restoration unavailable');
        run.restoreScript = result.identifier;
        if (!run.remember || run.restoreGeneration !== this.loginGeneration) {
          if (!await this.removeRestoreScript(run)) throw new Error('Cancelled login restoration unavailable');
          run.localStorage = {};
        } else run.restored = true;
      }
      this.reportLoginSession(run);
      stage = 'page-load';
      run.canSaveLogin = true;
      this.notify(run, 'onState', { state: 'awaiting-login', error: '请在打开的视频号后台扫码登录，并进入自己的直播间。' });
      if (!run.active) return;
      await Promise.race([window.loadURL(LIVE_URL), run.cancelled]);
    } catch (error) {
      this.reportLoginSession(run);
      if (stage === 'page-load' && run.active && run.window && !run.window.isDestroyed()) {
        const aborted = error?.code === 'ERR_ABORTED' || error?.errno === -3;
        if (aborted && allowedPage(run.window.webContents.getURL())) return;
        // Leave Chromium's error page open so a refresh can recover without
        // discarding the debugger, transient login session, or collector run.
        this.notify(run, 'onState', { state: 'message-error', errorCode: 'WECHAT_PAGE_LOAD', error: PAGE_LOAD_ERROR });
        return;
      }
      const errors = { 'login-record': '视频号登录记录无法读取，请清除登录记录后重新扫码。',
        'browser-window': '视频号后台窗口未能启动，请重启采集示例后重试。',
        'message-listener': '视频号消息监听未能启动，请重启采集示例后重试。',
        'page-load': '视频号后台无法打开，请检查网络后重新连接。' };
      if (run.active) this.notify(run, 'onState', { state: 'connect-failed', errorCode: `WECHAT_${stage.toUpperCase().replaceAll('-', '_')}`, error: errors[stage] });
      if (this.run === run) await this.stop();
    }
  }
  scheduleLoginSave(run) {
    clearTimeout(run.savedTimer);
    if (run.active && run.remember) {
      run.savedTimer = setTimeout(() => {
        // Coalesce a busy page's changes instead of growing an unbounded chain
        // while a renderer or Cookie read is slow.
        if (run.autoSavePending) { run.autoSaveAgain = true; return; }
        run.autoSavePending = true;
        void this.saveLogin(run).finally(() => {
          run.autoSavePending = false;
          if (run.autoSaveAgain) { run.autoSaveAgain = false; this.scheduleLoginSave(run); }
        });
      }, 750);
      run.savedTimer.unref?.();
    }
  }
  async removeRestoreScript(run) {
    const identifier = run.restoreScript;
    if (!identifier) return true;
    if (run.removingRestoreScript) return run.removingRestoreScript;
    run.removingRestoreScript = (async () => {
      try {
        await bounded(run.window.webContents.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier }));
        run.restoreScript = '';
        return true;
      } catch { return false; /* The marker still prevents ordinary navigation replay. */ }
    })().finally(() => { run.removingRestoreScript = null; });
    return run.removingRestoreScript;
  }
  storageMessage(run, method, params) {
    if (run.storageClosed || params?.storageId?.securityOrigin !== WECHAT_LOGIN_ORIGIN) return;
    if (params.storageId.isLocalStorage === false && params.key === run.restoreMarker) {
      void this.removeRestoreScript(run); return;
    }
    if (params.storageId.isLocalStorage !== true) return;
    if (method === 'DOMStorage.domStorageItemsCleared') {
      run.localStorage = {}; run.invalidStorageKeys.clear();
    } else if (WECHAT_LOGIN_KEYS.includes(params.key)) {
      if (method === 'DOMStorage.domStorageItemRemoved') {
        delete run.localStorage[params.key]; run.invalidStorageKeys.delete(params.key);
      } else if (method === 'DOMStorage.domStorageItemAdded' || method === 'DOMStorage.domStorageItemUpdated') {
        if (typeof params.newValue !== 'string' || Buffer.byteLength(params.newValue, 'utf8') > MAX_STORAGE_VALUE_BYTES) {
          run.invalidStorageKeys.add(params.key);
        } else {
          run.localStorage[params.key] = params.newValue; run.invalidStorageKeys.delete(params.key);
        }
      } else return;
    } else return;
    run.storageRevision++;
    this.scheduleLoginSave(run);
  }
  async captureLoginStorage(run) {
    if (!run.window || run.window.isDestroyed()) return;
    const revision = run.storageRevision;
    // Read only the allowlisted values, with bounds inside the renderer too.
    // A different official origin cannot overwrite the last channels snapshot.
    const expression = `(() => { if (location.origin !== ${JSON.stringify(WECHAT_LOGIN_ORIGIN)}) return null;
      const result = {}; for (const key of ${JSON.stringify(WECHAT_LOGIN_KEYS)}) {
        const value = localStorage.getItem(key); if (value === null) continue;
        if (typeof value !== 'string' || value.length > ${MAX_STORAGE_VALUE_BYTES}) return false; result[key] = value;
      } return result; })()`;
    const result = await bounded(run.window.webContents.debugger.sendCommand('Runtime.evaluate',
      { expression, returnByValue: true, timeout: 1000 }));
    if (result.exceptionDetails) throw new Error('Login storage unavailable');
    if (revision !== run.storageRevision || result.result?.value === null) return;
    run.localStorage = normalizeStorage(result.result?.value);
    run.invalidStorageKeys.clear();
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
  async metadataResponse(run, id, encodedDataLength) {
    const request = run.metadataRequests.get(id); run.metadataRequests.delete(id);
    if (!request?.ready) return;
    const diagnostic = request.kind === 'gifts' ? 'giftCatalogErrors' : 'viewerSnapshotErrors';
    if (encodedDataLength > MAX_BODY || run.metadataInFlight >= 2) {
      this.notify(run, 'onDiagnostic', diagnostic); return;
    }
    run.metadataInFlight++;
    try {
      const response = await run.window.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: id });
      if (!run.active) return;
      if (typeof response.body !== 'string' || response.body.length > MAX_BODY * 1.4) throw new Error('Invalid metadata body');
      const body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
      if (request.kind === 'gifts') {
        run.giftCatalog.ingest(body, request);
      } else {
        // A list is a partial snapshot of one current room, never a reconnect or
        // live-status signal. Do not let an earlier request switch rooms back.
        if (request.order !== run.latestViewerOrder || request.liveId !== run.messageRoomId) return;
        const decoded = decodeWechatViewersResponse(body, request);
        if (decoded.event && decoded.roomId === run.messageRoomId) {
          this.notify(run, 'onEvent', { ...decoded.event,
            source_msg_id: `viewers:${run.statusSessionId}:${request.order}` }, decoded.roomId);
        }
      }
    } catch {
      if (run.active) this.notify(run, 'onDiagnostic', diagnostic);
    } finally { run.metadataInFlight--; }
  }
  metadataMessage(run, method, params) {
    const id = params.requestId;
    const kindFor = url => isGiftCatalogUrl(url) ? 'gifts' : isViewerListUrl(url) ? 'viewers' : '';
    if (method === 'Network.requestWillBeSent') {
      // Redirects reuse a CDP request ID. Never keep an allowlisted route for a
      // redirected response or a request whose body no longer identifies a room.
      run.metadataRequests.delete(id);
      const kind = kindFor(params.request?.url);
      if (!kind) return false;
      let input;
      try { if (params.request.postData?.length <= 64 * 1024) input = JSON.parse(params.request.postData); } catch {}
      const liveId = metadataRoomId(input?.liveId);
      if (liveId) {
        const order = ++run.metadataOrder;
        run.metadataRequests.set(id, { kind, liveId, order, ready: false });
        if (kind === 'viewers') run.latestViewerOrder = order;
        while (run.metadataRequests.size > 32) run.metadataRequests.delete(run.metadataRequests.keys().next().value);
      }
      return true;
    }
    if (method === 'Network.responseReceived') {
      const kind = kindFor(params.response?.url), request = run.metadataRequests.get(id);
      if (!kind && !request) return false;
      if (!request || request.kind !== kind || params.response.status !== 200) run.metadataRequests.delete(id);
      else request.ready = true;
      return true;
    }
    if (method === 'Network.loadingFailed') {
      return run.metadataRequests.delete(id);
    }
    if (method === 'Network.loadingFinished' && run.metadataRequests.has(id)) {
      return this.metadataResponse(run, id, params.encodedDataLength).then(() => true);
    }
    return false;
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
    const metadata = this.metadataMessage(run, method, params);
    if (metadata) { await metadata; return; }
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
      if (!request.ready) this.notifyRequestState(run, request, { state: 'message-error', error: '视频号消息请求未成功，请在后台检查登录、验证和开播状态。' });
    } else if (method === 'Network.loadingFailed') {
      const request = run.requests.get(id); run.requests.delete(id);
      if (request) this.notifyRequestState(run, request, { state: 'message-error', error: '视频号消息请求中断，等待后台继续获取；若持续异常，请重新连接。' });
    } else if (method === 'Network.loadingFinished') {
      const request = run.requests.get(id); run.requests.delete(id);
      if (!request?.ready) return;
      if (params.encodedDataLength > MAX_BODY || run.inFlight >= 4) {
        this.notifyRequestState(run, request, { state: 'message-error', error: '已忽略过大或过密的视频号响应。' }); return;
      }
      run.inFlight++;
      try {
        const response = await run.window.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: id });
        if (!run.active) return;
        if (typeof response.body !== 'string' || response.body.length > MAX_BODY * 1.4) throw new Error('Invalid body');
        const body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
        const decoded = decodeWechatResponse(body, request);
        if (decoded.error) {
          this.notifyRequestState(run, request, { state: 'message-error', error: '视频号后台未返回有效消息，请检查登录、验证和开播状态。' }); return;
        }
        if (!decoded.roomId) return;
        for (let i = 0; i < decoded.giftCallbacks && run.active; i++) this.notify(run, 'onDiagnostic', 'giftCallbacks');
        for (let i = 0; i < decoded.giftParseErrors && run.active; i++) this.notify(run, 'onDiagnostic', 'giftParseErrors');
        if (!run.active) return;
        const currentSnapshot = request.order >= run.lastStatusRequestOrder;
        if (currentSnapshot) {
          run.messageRoomId = decoded.roomId;
          this.notifyRequestState(run, request, { state: 'connected', roomId: decoded.roomId, error: '' });
          if (!run.active) return;
          if (decoded.liveStatus && (run.statusRoomId !== decoded.roomId || run.liveStatus !== decoded.liveStatus)) {
            run.statusRoomId = decoded.roomId; run.liveStatus = decoded.liveStatus;
            // Room status has no platform message ID. A run-local sequence keeps
            // repeated snapshots quiet while retaining later stop/start cycles.
            this.notify(run, 'onEvent', { event_type: 'live_status', live_status: decoded.liveStatus,
              source_msg_id: `status:${run.statusSessionId}:${++run.statusSequence}:${decoded.liveStatus}` }, decoded.roomId);
          }
        }
        for (const event of decoded.events) {
          if (!run.active) break;
          if (event.event_type === 'room_stats' && !currentSnapshot) continue;
          this.notify(run, 'onEvent', run.giftCatalog.enrich(event, decoded.roomId), decoded.roomId);
        }
        if (decoded.errors) this.notifyRequestState(run, request, { error: '已忽略无法解析的视频号互动；其余消息继续接收。' });
      } catch {
        if (run.active) this.notifyRequestState(run, request, { state: 'message-error', error: '视频号响应暂时无法解析，等待下一次消息；若持续异常，需要更新接入组件。' });
      } finally { run.inFlight--; }
    }
  }
  saveLogin(run) {
    const generation = run.loginGeneration;
    const allowed = () => run.canSaveLogin && run.remember && generation === this.loginGeneration && generation === run.loginGeneration;
    run.saving = run.saving.then(async () => {
      if (!allowed()) return;
      try {
        await this.captureLoginStorage(run);
        if (!allowed()) return;
        const cookies = (await bounded(run.session.cookies.get({}))).filter(validCookie)
          .filter(cookie => !Number.isFinite(cookie.expirationDate) || cookie.expirationDate > Date.now() / 1000);
        if (!allowed()) return;
        if (run.invalidStorageKeys.size) throw new Error('Invalid login storage');
        if (!cookies.length && !Object.values(run.localStorage).some(Boolean)) {
          this.credentials.clear('wechat'); if (run.active) this.notify(run, 'onState', { loginSaved: false }); return;
        }
        this.credentials.save('wechat', encodeWechatLogin(cookies, run.localStorage));
        if (run.active) this.notify(run, 'onState', { loginSaved: true });
      } catch {
        if (run.active) this.notify(run, 'onState', { error: '视频号登录记录未能加密保存，本次仍可接收，下次需重新扫码。' });
      }
    });
    return run.saving;
  }
  async setRemember(value) {
    const generation = ++this.loginGeneration, run = this.run || this.stoppingRun;
    if (run) { run.loginGeneration = generation; run.remember = value === true; clearTimeout(run.savedTimer); }
    if (value !== true) {
      // Clear synchronously, before pending renderer/Cookie reads complete. All
      // previously queued saves belong to an older generation and cannot write.
      this.credentials.clear('wechat');
      if (run) void this.removeRestoreScript(run);
      if (run) await run.saving;
      await this.stopping;
      if (generation === this.loginGeneration) await this.clearRetainedSession();
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
    const retainedSession = this.retainedSession; this.retainedSession = null; this.retainedLoginState = null;
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
    this.run = null; this.stoppingRun = run; run.active = false; run.cancel(); clearTimeout(run.savedTimer);
    run.metadataRequests.clear(); run.giftCatalog.clear();
    run.session.cookies.removeListener('changed', run.cookiesChanged || (() => {}));
    this.stopping = (async () => {
      // Checkpoint while the renderer still exists. If a user already closed
      // the window, the bounded DOMStorage event mirror is the last snapshot.
      await this.saveLogin(run);
      run.storageClosed = true;
      if (run.window && !run.window.isDestroyed()) run.window.destroy();
      run.requests.clear(); run.authRequests.clear();
      // A normal disconnect stops collection, but keeps the entire transient
      // Chromium login, including official local storage. Rebuilding it from
      // Cookies alone loses part of WeChat's selected-account state.
      if (preserveSession && run.remember && run.canSaveLogin) {
        this.retainedSession = run.session;
        this.retainedLoginState = { localStorage: { ...run.localStorage }, invalidStorageKeys: [...run.invalidStorageKeys] };
      } else await run.session.clearStorageData().catch(() => {});
      run.localStorage = {}; run.invalidStorageKeys.clear();
    })().finally(() => { this.stopping = null; this.stoppingRun = null; });
    return this.stopping;
  }
}
module.exports = { WechatCollector, allowedPage, validCookie };
