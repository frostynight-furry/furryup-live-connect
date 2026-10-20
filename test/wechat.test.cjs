'use strict';

// Synthetic protocol and Electron mocks only; no real credentials or live requests.

const test = require('node:test');

const assert = require('node:assert/strict');

const { EventEmitter } = require('node:events');
const vm = require('node:vm');

const { decodeWechatResponse, isMessageUrl, LIVE_URL, MAX_BODY } = require('../wechat/wechat-decoder.cjs');

const { WechatCollector } = require('../wechat/wechat-collector.cjs');
const { WECHAT_LOGIN_ORIGIN, WECHAT_LOGIN_KEYS, MAX_WECHAT_LOGIN_BYTES, decodeWechatLogin,
  encodeWechatLogin } = require('../wechat/wechat-login-state.cjs');

const url = 'https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/live/msg';

const newUrl = 'https://channels.weixin.qq.com/micro/live/cgi-bin/mmfinderassistant-bin/live/msg';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');

function sample() {
  return { errCode: 0, data: {
    liveInfo: { liveId: 'fixture-live-room', onlineCnt: '12', likeCnt: 100 },
    msgList: [{ type: 1, clientMsgId: 'comment-1', nickname: '观众', username: 'user-1', content: '<script>hi</script>' },
      { type: 10005, clientMsgId: 'enter-1', nickname: '新观众', username: 'user-2', content: '来了' }],
    appMsgList: [
      { msgType: 20009, clientMsgId: 'gift-1', fromUserContact: { contact: { username: 'user-1', nickname: '观众' } },
        payload: encode({ reward_product_id: 'gift-42', reward_product_name: '小心心', reward_product_count: 2, reward_amount_in_wecoin: '20' }) },
      { msgType: 20013, clientMsgId: 'combo-1', payload: encode({ reward_product_id: 'gift-42', combo_product_count: 2 }) },
      { msgType: 20006, clientMsgId: 'like-1', fromUserContact: { contact: { nickname: '观众' } } }
    ]
  } };
}

test('standalone decoder preserves identities and gift increments without counting combo totals twice', () => {
  const decoded = decodeWechatResponse(JSON.stringify(sample()));
  assert.equal(decoded.roomId, 'fixture-live-room');
  assert.deepEqual(decoded.events.map(event => event.event_type), ['comment', 'enter', 'gift', 'like', 'room_stats']);
  const gift = decoded.events.find(event => event.event_type === 'gift');
  assert.equal(gift.gift_count, 2);
  assert.equal(gift.gift_price_raw, '20');
  assert.equal(gift.gift_price_unit, 'wechat_bean');
  assert.equal(decoded.events.find(event => event.event_type === 'like').count_mode, 'signal');
  assert.equal(decoded.events[0].content, '<script>hi</script>');
  assert.ok(decoded.events[0].source_msg_id, 'actual message identity retained for caller deduplication');
  assert.equal(decoded.events.at(-1).watching_count, 12);
});

test('单条损坏消息不影响其他互动；超大响应、未知事件与无效统计不会编造数据', () => {
  const value = sample();
  value.data.appMsgList.unshift({ msgType: 20009, payload: 'not-json' });
  value.data.appMsgList.push({ msgType: 20009, payload: encode({ reward_product_id: 'bad', reward_product_count: 0 }) });
  value.data.msgList.push({ type: 99999, content: 'unknown' });
  value.data.liveInfo.onlineCnt = '1.2万';
  const result = decodeWechatResponse(JSON.stringify(value));
  assert.equal(result.errors, 2); assert.equal(result.events.length, 5);
  assert.equal(result.events.at(-1).watching_count, undefined);
  assert.throws(() => decodeWechatResponse('x'.repeat(MAX_BODY + 1)));
  assert.equal(decodeWechatResponse(JSON.stringify({ errCode: -1, errMsg: 'cookie=secret' })).error, 'LOGIN_OR_PROTOCOL');
  assert.equal(decodeWechatResponse(JSON.stringify({ errCode: 0, data: { msgList: value.data.msgList } })).events.length, 0);
  assert.equal(decodeWechatResponse(JSON.stringify({ errCode: 0, data: { msgList: value.data.msgList } }), { liveId: 'exact-id' }).roomId, 'exact-id');
  for (const hostile of [url.replace('https:', 'http:'), url.replace('channels.weixin.qq.com', 'channels.weixin.qq.com.evil.test'), url + '/other', 'file:///secret']) assert.equal(isMessageUrl(hostile), false);
  assert.equal(isMessageUrl(url + '?timestamp=123'), true);
  assert.equal(isMessageUrl(newUrl + '?timestamp=123'), true);
  for (const hostile of [newUrl.replace('https:', 'http:'), newUrl.replace('channels.weixin.qq.com', 'channels.weixin.qq.com.evil.test'), newUrl + '/other', newUrl.replace('/micro/live/', '/micro/other/')]) assert.equal(isMessageUrl(hostile), false);
});

function browserFixture({ loadLive = null, messageResponse = sample, bodyResponse = null,
  userAgent = 'Chrome/144.0 furryup-studio/0.6.0 Electron/43.1', onLoginDiagnostic = null, beforeCookieSet = null } = {}) {
  let stored = ''; const states = [], events = [], commands = [], windows = [], loginDiagnostics = [], sessions = [], credentialCalls = [];
  function createSession(partition) {
    const cookies = new EventEmitter(); cookies.items = [];
    cookies.get = async () => {
      const value = cookies.items.map(cookie => ({ ...cookie }));
      if (cookies.readGate) { cookies.readStarted = true; await cookies.readGate.promise; }
      return value;
    };
    cookies.set = async cookie => { if (beforeCookieSet) await beforeCookieSet(); cookies.items.push({ ...cookie }); };
    const session = { partition, cookies, clearCount: 0, on() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
      async clearStorageData() { this.clearCount++; cookies.items = []; this.localStorage.clear(); } };
    class StorageMap extends Map {
      constructor(isLocalStorage) { super(); this.isLocalStorage = isLocalStorage; }
      send(method, data = {}) { session.debugger?.emit('message', {}, `DOMStorage.${method}`,
        { storageId: { securityOrigin: WECHAT_LOGIN_ORIGIN, isLocalStorage: this.isLocalStorage }, ...data }); }
      set(key, value) { const existed = this.has(key); super.set(key, value);
        this.send(existed ? 'domStorageItemUpdated' : 'domStorageItemAdded', { key, newValue: value }); return this; }
      delete(key) { const result = super.delete(key); this.send('domStorageItemRemoved', { key }); return result; }
      clear() { super.clear(); this.send('domStorageItemsCleared'); }
    }
    session.localStorage = new StorageMap(true); session.sessionStorage = new StorageMap(false);
    sessions.push(session); return session;
  }
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.minimized = false;
      this.shows = 0; this.focuses = 0; this.restores = 0; this.focusActions = []; windows.push(this);
      this.webContents = new EventEmitter(); const wc = this.webContents;
      wc.setWindowOpenHandler = fn => { this.openHandler = fn; };
      wc.getUserAgent = () => userAgent; wc.setUserAgent = value => { this.ua = value; };
      wc.getURL = () => this.currentUrl || '';
      wc.debugger = new EventEmitter(); wc.debugger.attach = () => {};
      options.webPreferences.session.debugger = wc.debugger; this.scripts = new Map();
      wc.debugger.sendCommand = async (name, params) => {
        commands.push({ name, params });
        if (name === 'Network.getResponseBody') return bodyResponse ? bodyResponse(params) : { body: JSON.stringify(await messageResponse(params)), base64Encoded: false };
        if (name === 'Page.enable') { this.pageEnabled = true; return {}; }
        if (name === 'Page.addScriptToEvaluateOnNewDocument') {
          assert.equal(this.pageEnabled, true, 'the Page domain must be enabled before registering the first-document script');
          this.scripts.set('restore-1', params.source); return { identifier: 'restore-1' };
        }
        if (name === 'Page.removeScriptToEvaluateOnNewDocument') { this.scripts.delete(params.identifier); return {}; }
        if (name === 'Runtime.evaluate') {
          if (this.destroyed) throw new Error('Target destroyed');
          return { result: { value: JSON.parse(JSON.stringify(this.evaluate(params.expression))) } };
        }
        return {};
      };
    }
    evaluate(source, { origin = new URL(this.currentUrl || 'about:blank').origin, top = true } = {}) {
      const adapter = storage => ({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key), clear: () => storage.clear() });
      const window = {}; window.top = top ? window : {};
      return vm.runInNewContext(source, { location: { origin }, window,
        localStorage: adapter(this.options.webPreferences.session.localStorage),
        sessionStorage: adapter(this.options.webPreferences.session.sessionStorage) });
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; this.restores++; this.focusActions.push('restore'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
    close() { this.emit('close'); this.webContents.debugger.emit('detach', {}, 'target closed'); this.destroyed = true; this.emit('closed'); }
    async loadURL(value) {
      assert.ok([LIVE_URL, 'about:blank'].includes(value)); this.currentUrl = value;
      for (const source of this.scripts.values()) this.evaluate(source);
      if (value === LIVE_URL && loadLive) await loadLive(this);
      this.webContents.emit('dom-ready');
    }
    show() { this.shows++; this.focusActions.push('show'); }
    focus() { this.focuses++; this.focusActions.push('focus'); }
  }
  const credentials = { has: () => Boolean(stored), read: () => { credentialCalls.push('read'); return stored; },
    save: (_p, value) => { credentialCalls.push('save'); stored = value; }, clear: () => { credentialCalls.push('clear'); stored = ''; } };
  const collector = new WechatCollector({ BrowserWindow: FakeWindow, session: { fromPartition: (partition, options) => { assert.equal(options.cache, false); return createSession(partition); } }, credentials,
    onLoginDiagnostic: value => { loginDiagnostics.push(value); return onLoginDiagnostic?.(value); } });
  return { collector, states, events, loginDiagnostics, get session() { return collector.run?.session || sessions.at(-1); }, sessions,
    commands, windows, credentials, credentialCalls, saved: () => stored,
    connect: (options = {}) => collector.connect({ ...options, onState: value => states.push(value), onEvent: (event, roomId) => events.push({ event, roomId }) }) };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setCompleteLogin(session) {
  session.cookies.items = [{ name: 'local-auth', value: 'private-local-cookie', domain: '.weixin.qq.com', path: '/', httpOnly: true }];
  session.localStorage.set('finder_username', 'private-local-finder');
  session.localStorage.set('finder_raw', 'private-local-storage-key');
}

test('完整停止先保存白名单登录状态，新内存分区首个官方脚本即可恢复', async () => {
  const f = browserFixture(); await f.connect({ remember: true });
  const oldSession = f.collector.run.session; setCompleteLogin(oldSession);
  await f.collector.stop();
  assert.equal(oldSession.clearCount, 1); assert.equal(oldSession.localStorage.size, 0);
  assert.equal(f.collector.retainedSession, null);
  assert.equal(decodeWechatLogin(f.saved()).localStorage.finder_raw, 'private-local-storage-key');
  await f.connect({ remember: true });
  assert.notEqual(f.collector.run.session, oldSession);
  assert.notEqual(f.collector.run.session.partition, oldSession.partition);
  assert.equal(f.collector.run.session.localStorage.get('finder_username'), 'private-local-finder');
  assert.equal(f.collector.run.session.localStorage.get('finder_raw'), 'private-local-storage-key');
  assert.equal(f.collector.run.session.cookies.items[0].value, 'private-local-cookie');
  assert.equal(f.loginDiagnostics.at(-1).restored, true);
  assert.notEqual(f.loginDiagnostics.at(-1).reused, true);
  await f.collector.stop();
});

test('登录信封严格限制origin、键、UTF8体积和Cookie数量，旧数组保持24k边界', () => {
  const cookie = { name: 'synthetic', value: 'fake', domain: '.weixin.qq.com', path: '/' };
  const valid = { schemaVersion: 2, origin: WECHAT_LOGIN_ORIGIN, cookies: [cookie], localStorage: { finder_raw: '假'.repeat(100) } };
  assert.equal(decodeWechatLogin(encodeWechatLogin(valid.cookies, valid.localStorage)).schemaVersion, 2);
  assert.equal(decodeWechatLogin(JSON.stringify([cookie])).schemaVersion, 1);
  const rejected = [
    { ...valid, origin: 'https://channels.weixin.qq.com.evil.test' },
    { ...valid, localStorage: { finder_raw: '假'.repeat(6000) } },
    { ...valid, localStorage: { finder_raw: 'x', draft: 'private-draft' } },
    { ...valid, sessionStorage: { finder_raw: 'not-supported' } },
    { ...valid, cookies: Array(101).fill(cookie) },
    { ...valid, cookies: [{ ...cookie, domain: '.evil.test' }] },
    { ...valid, localStorage: { finder_username: 123 } }
  ];
  for (const value of rejected) assert.throws(() => decodeWechatLogin(JSON.stringify(value)), /Invalid saved WeChat login state/);
  assert.throws(() => decodeWechatLogin(' '.repeat(MAX_WECHAT_LOGIN_BYTES + 1)));
  assert.throws(() => decodeWechatLogin(JSON.stringify(Array(3).fill({ ...cookie, value: 'x'.repeat(9000) }))));
  assert.throws(() => encodeWechatLogin(Array(10).fill({ ...cookie, value: 'x'.repeat(9000) })));
});

test('旧Cookie数组迁移为v2且丢弃过期项，损坏记录不会被失败连接覆盖', async () => {
  const f = browserFixture();
  f.credentials.save('wechat', JSON.stringify([
    { name: 'alive', value: 'synthetic-alive', domain: '.weixin.qq.com', path: '/' },
    { name: 'expired', value: 'synthetic-expired', domain: '.weixin.qq.com', path: '/', expirationDate: 1 }
  ]));
  await f.connect(); await f.collector.saveLogin(f.collector.run);
  const saved = decodeWechatLogin(f.saved());
  assert.equal(saved.schemaVersion, 2); assert.deepEqual(saved.cookies.map(cookie => cookie.name), ['alive']);
  assert.deepEqual(saved.localStorage, {});
  await f.collector.stop();
  const broken = browserFixture(); broken.credentials.save('wechat', '{"private-corrupt-record":true}');
  await broken.connect();
  assert.equal(broken.saved(), '{"private-corrupt-record":true}');
  assert.equal(broken.states.at(-1).errorCode, 'WECHAT_LOGIN_RECORD');
  assert.doesNotMatch(JSON.stringify(broken.states), /private-corrupt/);
});

test('恢复脚本只作用于官方顶层首次文档，退出清空与后续导航不会回灌旧账户', async () => {
  const firstRead = [];
  const f = browserFixture({ loadLive: async window => firstRead.push(window.options.webPreferences.session.localStorage.get('finder_raw')) });
  f.credentials.save('wechat', encodeWechatLogin([], { finder_username: 'synthetic-finder', finder_raw: 'synthetic-raw' }));
  await f.connect();
  assert.deepEqual(firstRead, ['synthetic-raw']);
  const run = f.collector.run, source = f.commands.find(command => command.name === 'Page.addScriptToEvaluateOnNewDocument').params.source;
  assert.equal(run.window.scripts.size, 0);
  run.session.localStorage.clear();
  run.session.sessionStorage.clear();
  for (const context of [{ origin: 'https://weixin.qq.com' }, { origin: 'https://channels.weixin.qq.com.evil.test' }, { top: false }]) {
    run.window.evaluate(source, context); assert.equal(run.session.localStorage.size, 0);
  }
  // The actual registered script has been removed, including after clearing
  // sessionStorage during an official logout.
  await run.window.loadURL(LIVE_URL);
  assert.equal(run.session.localStorage.size, 0);
  await f.collector.saveLogin(run); assert.equal(f.saved(), '');
  await f.collector.stop(); assert.equal(f.saved(), '');
});

test('只保存四个认证键和精确origin事件，正常关窗用事件镜像保留最新清空值', async () => {
  const f = browserFixture(); await f.connect();
  const run = f.collector.run; setCompleteLogin(run.session);
  run.session.localStorage.set('finder_uin', 'synthetic-uin');
  run.session.localStorage.set('finder_login_token', 'synthetic-token');
  run.session.localStorage.set('private-draft', 'not-saved');
  f.collector.storageMessage(run, 'DOMStorage.domStorageItemUpdated', {
    storageId: { securityOrigin: 'https://other.weixin.qq.com', isLocalStorage: true },
    key: 'finder_raw', newValue: 'foreign-origin' });
  await f.collector.saveLogin(run);
  assert.deepEqual(Object.keys(decodeWechatLogin(f.saved()).localStorage).sort(), [...WECHAT_LOGIN_KEYS].sort());
  assert.doesNotMatch(f.saved(), /private-draft|not-saved|foreign-origin/);
  run.session.localStorage.delete('finder_raw');
  run.session.localStorage.set('finder_login_token', '');
  run.window.close(); await f.collector.stopping;
  const saved = decodeWechatLogin(f.saved());
  assert.equal(saved.localStorage.finder_raw, undefined);
  assert.equal(saved.localStorage.finder_login_token, '');
  assert.equal(saved.localStorage.finder_uin, 'synthetic-uin');
  await f.collector.stop();
});

test('取消保留同步清除，迟到Cookie读取和旧停止任务无法重新写入', async () => {
  const f = browserFixture(); await f.connect();
  const run = f.collector.run; setCompleteLogin(run.session);
  await f.collector.saveLogin(run);
  const gate = deferred(); run.session.cookies.readGate = gate;
  const stopping = f.collector.stop({ preserveSession: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.session.cookies.readStarted, true);
  const clearing = f.collector.setRemember(false);
  assert.equal(f.saved(), '');
  gate.resolve(); await Promise.all([stopping, clearing]);
  assert.equal(f.saved(), ''); assert.equal(f.collector.retainedSession, null);
  assert.equal(run.window.isDestroyed(), true);
});

test('旧保存任务在关闭再开启保留之后仍过期，迟到清除不会抹掉新设置', async () => {
  const f = browserFixture(); await f.connect();
  const run = f.collector.run; setCompleteLogin(run.session);
  const gate = deferred(); run.session.cookies.readGate = gate;
  const oldSave = f.collector.saveLogin(run);
  await new Promise(resolve => setImmediate(resolve));
  const clearing = f.collector.setRemember(false);
  run.session.cookies.items = [{ name: 'new-auth', value: 'synthetic-new-cookie', domain: '.weixin.qq.com', path: '/' }];
  run.session.localStorage.set('finder_raw', 'synthetic-new-raw');
  delete run.session.cookies.readGate;
  const enabled = f.collector.setRemember(true);
  gate.resolve(); await Promise.all([oldSave, clearing, enabled]);
  assert.equal(decodeWechatLogin(f.saved()).cookies[0].value, 'synthetic-new-cookie');
  assert.equal(decodeWechatLogin(f.saved()).localStorage.finder_raw, 'synthetic-new-raw');
  assert.doesNotMatch(f.saved(), /private-local-cookie|private-local-storage-key/);
  await f.collector.stop();
});

test('取消尚未完成的Cookie恢复后不注入旧storage，停止中的迟到恢复不成为可复用会话', async () => {
  for (const action of ['forget', 'stop']) {
    const gate = deferred(), started = deferred();
    const f = browserFixture({ beforeCookieSet: () => { started.resolve(); return gate.promise; } });
    f.credentials.save('wechat', encodeWechatLogin(
      [{ name: 'old-auth', value: 'synthetic-old-cookie', domain: '.weixin.qq.com', path: '/' }],
      { finder_username: 'synthetic-old-account', finder_raw: 'synthetic-old-raw' }));
    const connecting = f.connect(); await started.promise;
    const oldRun = f.collector.run;
    if (action === 'forget') await f.collector.setRemember(false);
    else await f.collector.stop({ preserveSession: true });
    gate.resolve(); await connecting; await new Promise(resolve => setImmediate(resolve));
    assert.equal(oldRun.session.cookies.items.length, 0);
    assert.equal(oldRun.session.localStorage.size, 0);
    assert.equal(f.commands.some(command => command.name === 'Page.addScriptToEvaluateOnNewDocument'), false);
    if (action === 'forget') assert.equal(f.saved(), '');
    else assert.equal(f.collector.retainedSession, null);
    await f.collector.stop();
  }
});

test('有界快照失败保持上次安全记录，异步快照不覆盖更新的storage事件', async () => {
  const f = browserFixture(); await f.connect();
  const run = f.collector.run; setCompleteLogin(run.session); await f.collector.saveLogin(run);
  const previous = f.saved(), send = run.window.webContents.debugger.sendCommand;
  run.window.webContents.debugger.sendCommand = async (method, params) => {
    if (method === 'Runtime.evaluate') throw new Error('PRIVATE_RENDERER_SECRET');
    return send(method, params);
  };
  await f.collector.saveLogin(run);
  assert.equal(f.saved(), previous); assert.doesNotMatch(JSON.stringify(f.states), /PRIVATE_RENDERER_SECRET/);
  const gate = deferred();
  run.window.webContents.debugger.sendCommand = (method, params) => method === 'Runtime.evaluate' ? gate.promise : send(method, params);
  const saving = f.collector.saveLogin(run); await new Promise(resolve => setImmediate(resolve));
  run.session.localStorage.set('finder_raw', 'synthetic-current-raw');
  gate.resolve({ result: { value: { finder_raw: 'synthetic-outdated-raw' } } }); await saving;
  assert.equal(decodeWechatLogin(f.saved()).localStorage.finder_raw, 'synthetic-current-raw');
  run.window.webContents.debugger.sendCommand = send;
  await f.collector.stop();
});

test('保留会话重连时页面未加载不会用空镜像覆盖此前已保存的账号字段', async () => {
  let navigation = 0;
  const f = browserFixture({ loadLive: async window => {
    if (++navigation > 1) {
      window.currentUrl = 'about:blank';
      throw Object.assign(new Error('Synthetic offline'), { code: 'ERR_INTERNET_DISCONNECTED' });
    }
  } });
  await f.connect(); setCompleteLogin(f.session);
  await f.collector.stop({ preserveSession: true });
  assert.equal(f.collector.retainedLoginState.localStorage.finder_raw, 'private-local-storage-key');
  await f.connect();
  assert.equal(f.collector.run.reused, true);
  assert.equal(f.states.at(-1).errorCode, 'WECHAT_PAGE_LOAD');
  await f.collector.stop();
  assert.equal(decodeWechatLogin(f.saved()).localStorage.finder_raw, 'private-local-storage-key');
  assert.equal(decodeWechatLogin(f.saved()).localStorage.finder_username, 'private-local-finder');
  assert.equal(f.collector.retainedLoginState, null);
});

test('不保留登录及清除已有保留会话都会清空完整浏览器数据', async () => {
  const temporary = browserFixture(); await temporary.connect({ remember: false });
  const temporarySession = temporary.collector.run.session; setCompleteLogin(temporarySession);
  await temporary.collector.stop({ preserveSession: true });
  assert.equal(temporary.collector.retainedSession, null); assert.equal(temporarySession.clearCount, 1);
  assert.equal(temporarySession.localStorage.size, 0); assert.deepEqual(temporarySession.cookies.items, []);
  assert.equal(temporary.saved(), '');
  await temporary.connect({ remember: false });
  assert.notEqual(temporary.collector.run.session.partition, temporarySession.partition);
  assert.equal(temporary.collector.run.session.localStorage.size, 0);
  await temporary.collector.stop();
  const remembered = browserFixture(); await remembered.connect({ remember: true });
  const rememberedSession = remembered.collector.run.session; setCompleteLogin(rememberedSession);
  await remembered.collector.stop({ preserveSession: true });
  assert.equal(remembered.collector.retainedSession, rememberedSession);
  await remembered.collector.setRemember(false);
  assert.equal(remembered.collector.retainedSession, null); assert.equal(rememberedSession.clearCount, 1);
  assert.equal(rememberedSession.localStorage.size, 0); assert.deepEqual(rememberedSession.cookies.items, []);
  assert.equal(remembered.saved(), '');
  await remembered.connect({ remember: true });
  assert.notEqual(remembered.collector.run.session.partition, rememberedSession.partition);
  assert.equal(remembered.collector.run.session.localStorage.size, 0);
  assert.deepEqual(remembered.collector.run.session.cookies.items, []);
  await remembered.collector.stop();
});

test('正常关闭后台保留完整登录，重新连接仍创建新窗口', async () => {
  const f = browserFixture(); await f.connect({ remember: true });
  const oldRun = f.collector.run; setCompleteLogin(oldRun.session);
  oldRun.window.close(); await f.collector.stopping;
  assert.equal(f.states.at(-1).state, 'stopped');
  assert.equal(f.collector.retainedSession, oldRun.session); assert.equal(oldRun.session.clearCount, 0);
  await f.connect({ remember: true });
  assert.equal(f.collector.run.session, oldRun.session);
  assert.notEqual(f.collector.run.window, oldRun.window);
  assert.equal(f.collector.run.session.localStorage.get('finder_raw'), 'private-local-storage-key');
  await f.collector.stop();
});

const authRoot = 'https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/';

async function authResponse(fixture, requestId, endpoint, status = 201, encodedDataLength = 300) {
  const run = fixture.collector.run;
  await fixture.collector.networkMessage(run, 'Network.responseReceived', { requestId, response: { url: endpoint, status } });
  await fixture.collector.networkMessage(run, 'Network.loadingFinished', { requestId, encodedDataLength });
}

test('正式客户端名称从浏览器标识移除，Chrome和标准标识保持完整', async () => {
  const expected = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.7871.114 Safari/537.36';
  const f = browserFixture({ userAgent: expected.replace(' Chrome/', ' FurryUPStudio/0.6.0-beta.7 furryup-studio/0.6.0 Chrome/').replace(' Safari/', ' Electron/43.1.1 Safari/') });
  await f.connect({ remember: false });
  assert.equal(f.windows[0].ua, expected);
  await f.collector.stop();
});

test('登录诊断只保留白名单数值，嵌套状态可读且账号、授权码、Cookie和查询绝不透出', async () => {
  const secret = 'PRIVATE_LOGIN_IDENTITY_COOKIE_OAUTH_CODE';
  const bodies = {
    oauth: { errCode: 0, ret: -1, code: secret, acctStatus: 2, base_resp: { errCode: -2, ret: -3, code: -4, token: secret },
      data: { errCode: -5, ret: -6, code: -7, acctStatus: 3, username: secret,
        baseResponse: { errCode: -8, ret: -9, code: -10, rawKeyBuff: secret } } },
    list: { errCode: 0, data: { finderList: Array.from({ length: 25 }, (_, index) => ({
      ...(index === 1 ? { status: 3 } : { acctStatus: 1, status: 999 }), finderUsername: secret, nickname: secret, spamFlag: 123
    })) }, finderList: [{ acctStatus: 99, identity: secret }] },
    login: { errCode: 0, code: 7, data: { acctStatus: 1, finderUsername: secret }, token: secret }
  };
  const f = browserFixture({ messageResponse: ({ requestId }) => bodies[requestId] });
  await f.connect({ remember: false });
  assert.deepEqual(f.loginDiagnostics, [{ kind: 'session', remember: false, restored: false }]);
  await f.collector.networkMessage(f.collector.run, 'Network.requestWillBeSent', {
    requestId: 'oauth', request: { url: authRoot + 'auth_with_oauth?code=' + secret, postData: JSON.stringify({ code: secret }), headers: { Cookie: secret } }
  });
  await f.collector.networkMessage(f.collector.run, 'Network.responseReceived', {
    requestId: 'oauth', response: { url: authRoot + 'auth_with_oauth?code=' + secret, status: 201, headers: { Cookie: secret } }
  });
  assert.deepEqual([...f.collector.run.authRequests.values()], [{ stage: 'oauth', httpStatus: 201 }]);
  assert.doesNotMatch(JSON.stringify([...f.collector.run.requests]), /PRIVATE_/);
  await f.collector.networkMessage(f.collector.run, 'Network.loadingFinished', { requestId: 'oauth', encodedDataLength: 300 });
  await authResponse(f, 'list', authRoot + 'auth_finder_list?signature=' + secret);
  await authResponse(f, 'login', authRoot + 'login_finder', 200);
  assert.deepEqual(f.loginDiagnostics.slice(1), [
    { kind: 'auth', stage: 'oauth', httpStatus: 201, errCode: 0, ret: -1, acctStatus: 2,
      base_errCode: -2, base_ret: -3, base_code: -4, data_errCode: -5, data_ret: -6, data_code: -7, data_acctStatus: 3,
      data_base_errCode: -8, data_base_ret: -9, data_base_code: -10 },
    { kind: 'auth', stage: 'finder-list', httpStatus: 201, errCode: 0, finderListCount: 25, finderStatuses: [1, 3, ...Array(18).fill(1)] },
    { kind: 'auth', stage: 'finder-login', httpStatus: 200, errCode: 0, code: 7, data_acctStatus: 1 }
  ]);
  assert.doesNotMatch(JSON.stringify(f.loginDiagnostics), /PRIVATE_|Cookie|username|finderUsername|nickname|token|rawKeyBuff|signature|https:|spamFlag/);
  const count = f.loginDiagnostics.length, reads = f.commands.length;
  for (const endpoint of [authRoot.replace('https:', 'http:') + 'auth_with_oauth', authRoot.replace('channels.weixin.qq.com', 'channels.weixin.qq.com.evil.test') + 'auth_with_oauth',
    authRoot + 'auth_with_oauth/other', authRoot + 'other', authRoot.replace('https://', 'https://user:password@') + 'auth_finder_list']) await authResponse(f, 'foreign', endpoint);
  assert.equal(f.loginDiagnostics.length, count);
  assert.equal(f.commands.length, reads);
  await f.collector.stop();
});

test('登录恢复诊断仅报告布尔值，过期Cookie不会被标记为恢复成功', async () => {
  for (const expired of [true, false]) {
    const f = browserFixture();
    f.credentials.save('wechat', JSON.stringify([{ name: 'private-auth', value: 'private-cookie', domain: '.weixin.qq.com', path: '/',
      expirationDate: Date.now() / 1000 + (expired ? -60 : 60) }]));
    await f.connect({ remember: true });
    assert.deepEqual(f.loginDiagnostics, [{ kind: 'session', remember: true, restored: !expired }]);
    assert.doesNotMatch(JSON.stringify(f.loginDiagnostics), /private-/);
    await f.collector.stop();
  }
});

test('登录诊断限制体积和独立并发，诊断异常及停止后的迟到响应不影响互动采集', async () => {
  const finish = new Map();
  const f = browserFixture({
    bodyResponse: ({ requestId }) => requestId.startsWith('pending') ? new Promise(resolve => finish.set(requestId, resolve)) :
      { body: requestId === 'large-body' ? 'x'.repeat(256 * 1024 + 1) : requestId === 'invalid' ? 'not-json-private' : JSON.stringify(sample()), base64Encoded: false },
    onLoginDiagnostic: value => { if (value.stage === 'finder-list') throw new Error('private-diagnostic-failure'); return Promise.reject(new Error('private-async-diagnostic-failure')); }
  });
  await f.connect({ remember: false }); const run = f.collector.run;
  const pending = [];
  for (const requestId of ['pending-a', 'pending-b']) {
    await f.collector.networkMessage(run, 'Network.responseReceived', { requestId, response: { url: authRoot + 'auth_with_oauth', status: 201 } });
    pending.push(f.collector.networkMessage(run, 'Network.loadingFinished', { requestId, encodedDataLength: 100 }));
  }
  assert.equal(run.authInFlight, 2); assert.equal(run.inFlight, 0);
  await authResponse(f, 'too-dense', authRoot + 'auth_finder_list');
  await f.collector.networkMessage(run, 'Network.responseReceived', { requestId: 'live', response: { url, status: 200 } });
  await f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'live' });
  assert.equal(f.events.length, 5);
  assert.equal(f.states.findLast(item => item.state)?.state, 'connected');
  for (const requestId of ['pending-a', 'pending-b']) finish.get(requestId)({ body: encode({ errCode: 0, data: { acctStatus: 1, username: 'private-identity' } }), base64Encoded: true });
  await Promise.all(pending);
  const beforeLarge = f.commands.length;
  await authResponse(f, 'large-wire', authRoot + 'auth_with_oauth', 201, 256 * 1024 + 1);
  assert.equal(f.commands.length, beforeLarge);
  await authResponse(f, 'large-body', authRoot + 'auth_with_oauth');
  await authResponse(f, 'invalid', authRoot + 'auth_with_oauth');
  assert.ok(f.loginDiagnostics.filter(item => item.kind === 'auth').slice(-3).every(item => Object.keys(item).length === 3));
  assert.doesNotMatch(JSON.stringify([...f.loginDiagnostics, ...f.states]), /private-/);
  await f.collector.networkMessage(run, 'Network.responseReceived', { requestId: 'pending-late', response: { url: authRoot + 'login_finder', status: 200 } });
  const late = f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'pending-late' });
  await f.collector.stop(); const count = f.loginDiagnostics.length;
  finish.get('pending-late')({ body: JSON.stringify({ errCode: 0 }), base64Encoded: false }); await late;
  assert.equal(f.loginDiagnostics.length, count);
  assert.equal(run.authRequests.size, 0);
});

test('正常关窗先发生debugger断开也报告停止，取消关窗后的异常断开仍报失败', async () => {
  const f = browserFixture(); await f.connect({ remember: false });
  f.windows[0].close(); await f.collector.stop();
  assert.equal(f.states.at(-1).state, 'stopped');
  assert.equal(f.states.some(item => item.state === 'connect-failed'), false);
  const canceled = browserFixture(); await canceled.connect({ remember: false });
  canceled.windows[0].emit('close');
  canceled.windows[0].webContents.emit('will-prevent-unload', {});
  canceled.windows[0].webContents.debugger.emit('detach', {}, 'unexpected detach');
  await canceled.collector.stop();
  assert.equal(canceled.states.at(-1).state, 'connect-failed');
});

test('内置后台使用隔离浏览器、限定响应来源，登录保留与清除且断开后拒绝迟到事件', async () => {
  const f = browserFixture(); await f.connect(); const run = f.collector.run;
  assert.equal(f.windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(f.windows[0].options.webPreferences.preload, undefined);
  assert.equal(f.windows[0].options.webPreferences.sandbox, true);
  assert.equal(f.windows[0].options.webPreferences.backgroundThrottling, false);
  assert.doesNotMatch(f.windows[0].ua, /Electron|furryup/);
  assert.deepEqual(f.windows[0].openHandler(), { action: 'deny' });
  let prevented = false;
  f.windows[0].webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'file:///private');
  assert.equal(prevented, true);
  await f.collector.networkMessage(run, 'Network.responseReceived', { requestId: 'foreign', response: { url: 'https://evil.test', status: 200 } });
  await f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'foreign' });
  assert.equal(f.commands.filter(item => item.name === 'Network.getResponseBody').length, 0);
  await f.collector.networkMessage(run, 'Network.requestWillBeSent', { requestId: 'own', request: { url, postData: JSON.stringify({ liveId: 'fixture-live-room', signature: 'secret' }) } });
  assert.equal(JSON.stringify([...run.requests]).includes('secret'), false);
  await f.collector.networkMessage(run, 'Network.responseReceived', { requestId: 'own', response: { url, status: 200 } });
  await f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'own', encodedDataLength: 500 });
  assert.equal(f.events.length, 5); assert.equal(f.events[0].roomId, 'fixture-live-room');
  f.session.cookies.items = [{ name: 'auth', value: 'private-cookie', domain: '.weixin.qq.com', path: '/', httpOnly: true },
    { name: 'foreign', value: 'not-saved', domain: '.evil.test', path: '/' }];
  await f.collector.saveLogin(run);
  assert.match(f.saved(), /private-cookie/); assert.doesNotMatch(f.saved(), /not-saved/);
  assert.doesNotMatch(JSON.stringify(f.states), /private-cookie/);
  await f.collector.setRemember(false); assert.equal(f.saved(), '');
  await f.collector.stop(); assert.equal(f.windows[0].isDestroyed(), true);
  await f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'own' });
  assert.equal(f.events.length, 5); assert.equal(f.saved(), '');
});

test('扫码后台跳转登录页导致原加载取消时保留窗口与消息监听', async () => {
  const f = browserFixture({ loadLive: async window => {
    window.currentUrl = 'https://channels.weixin.qq.com/login.html';
    window.webContents.emit('did-navigate', {}, window.currentUrl);
    window.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', LIVE_URL, true);
    throw Object.assign(new Error('ERR_ABORTED'), { code: 'ERR_ABORTED', errno: -3 });
  } });
  await f.connect();
  const run = f.collector.run;
  assert.ok(run?.active);
  assert.equal(f.windows[0].isDestroyed(), false);
  assert.equal(f.states.at(-1).state, 'awaiting-login');
  assert.equal(f.states.some(item => item.state === 'connect-failed'), false);
  await f.collector.networkMessage(run, 'Network.responseReceived', { requestId: 'after-login', response: { url, status: 200 } });
  await f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'after-login' });
  assert.equal(f.events.length, 5);
  assert.equal(f.states.findLast(item => item.state)?.state, 'connected');
  await f.collector.stop();
  assert.equal(f.windows[0].isDestroyed(), true);
});

test('新版视频号互动地址与嵌套评论身份进入原消息链路，旧地址仍兼容', async () => {
  const value = sample();
  value.data.msgList[0] = { type: 1, clientMsgId: 'nested-comment', content: '新版后台评论',
    finderLiveContact: { contact: { username: 'nested-user', nickname: '新版观众', headUrl: 'https://wx.qlogo.cn/test/avatar.png' } } };
  const decoded = decodeWechatResponse(JSON.stringify(value));
  assert.equal(decoded.events[0].user_id, 'nested-user');
  assert.equal(decoded.events[0].user_name, '新版观众');
  assert.equal(decoded.events[0].content, '新版后台评论');
  assert.equal(decoded.events[0].avatar_url, 'https://wx.qlogo.cn/test/avatar.png');
  value.data.msgList[0].username = 'existing-stable-user';
  assert.equal(decodeWechatResponse(JSON.stringify(value)).events[0].user_id, 'existing-stable-user');
  const f = browserFixture(); await f.connect();
  const run = f.collector.run;
  for (const [index, endpoint] of [newUrl, url].entries()) {
    const requestId = `endpoint-${index}`;
    await f.collector.networkMessage(run, 'Network.requestWillBeSent', { requestId, request: { url: endpoint, postData: JSON.stringify({ liveId: 'fixture-live-room' }) } });
    await f.collector.networkMessage(run, 'Network.responseReceived', { requestId, response: { url: endpoint, status: 200 } });
    await f.collector.networkMessage(run, 'Network.loadingFinished', { requestId });
  }
  assert.equal(f.events.length, 10);
  assert.equal(f.commands.filter(command => command.name === 'Network.getResponseBody').length, 2);
  await f.collector.stop();
});

test('官方关注与新版点赞通知保留发送者和消息 ID，通用互动展示原通知且不猜测分享', () => {
  const value = sample();
  value.data.msgList = [];
  value.data.appMsgList = [
    { msgType: 20078, clientMsgId: 'follow-notice-1',
      fromUserContact: { displayNickname: '展示昵称', contact: { username: 'stable-viewer', headUrl: 'https://wx.qlogo.cn/test/follower.png' } },
      payload: encode({ wording: '关注了主播' }) },
    { msgType: 20122, localClientMsgId: 'like-notice-1',
      fromUserContact: { contact: { username: 'stable-viewer', nickname: '本人昵称' } },
      payload: encode({ wording: '赞了直播', count: 999, like_count: 999 }) },
    { msgType: 20125, seq: '7', fromUserContact: { displayNickname: '分享观众', contact: { username: 'another-viewer' } },
      payload: encode({ wording: '分享了直播间' }) },
    { msgType: 20125, seq: '8', payload: encode({ wording: '关注了主播' }) },
    { msgType: 99999, payload: encode({ wording: '分享了直播间' }) }
  ];
  const decoded = decodeWechatResponse(JSON.stringify(value));
  const [follow, like, notice, otherNotice] = decoded.events;
  assert.deepEqual(decoded.events.map(event => event.event_type), ['follow', 'like', 'notice', 'notice', 'room_stats']);
  assert.equal(follow.user_id, 'stable-viewer'); assert.equal(follow.user_name, '展示昵称');
  assert.equal(follow.avatar_url, 'https://wx.qlogo.cn/test/follower.png');
  assert.equal(follow.source_msg_id, 'follow-notice-1'); assert.equal(follow.content, '关注了主播');
  assert.equal(like.user_name, '本人昵称'); assert.equal(like.source_msg_id, 'like-notice-1');
  assert.equal(like.count, 1); assert.equal(like.count_mode, 'signal');
  assert.equal(notice.user_id, 'another-viewer'); assert.equal(notice.source_msg_id, 'app:7');
  assert.equal(notice.content, '分享了直播间'); assert.equal(otherNotice.event_type, 'notice');
  assert.equal(decoded.giftCallbacks, 0); assert.equal(decoded.giftParseErrors, 0);
});

test('损坏通知隔离于真实礼物，身份和通知文案有边界且未知事件不会伪造关注分享', () => {
  const value = sample();
  value.data.appMsgList.push(
    { msgType: 20078, payload: 'not-json' },
    { msgType: 20125, payload: encode({ wording: '' }) },
    { msgType: 20122, payload: encode([]) },
    { msgType: 20078, clientMsgId: 'x'.repeat(200), fromUserContact: { displayNickname: 'a'.repeat(200),
      contact: { username: Number.MAX_SAFE_INTEGER + 1, headUrl: { unsafe: true } } }, payload: encode({ wording: 'b'.repeat(2000) }) }
  );
  value.data.msgList.push({ type: 10001, content: '新人进入直播间；关注了主播；分享了直播间' });
  const decoded = decodeWechatResponse(JSON.stringify(value));
  assert.equal(decoded.errors, 3);
  assert.equal(decoded.giftCallbacks, 1); assert.equal(decoded.giftParseErrors, 0);
  assert.equal(decoded.events.filter(event => event.event_type === 'gift').length, 1);
  assert.equal(decoded.events.filter(event => event.event_type === 'enter').length, 1);
  assert.equal(decoded.events.filter(event => event.event_type === 'share').length, 0);
  const follow = decoded.events.find(event => event.event_type === 'follow');
  assert.equal(follow.user_id, ''); assert.equal(follow.avatar_url, '');
  assert.equal(follow.user_name.length, 64); assert.equal(follow.source_msg_id, ''); assert.equal(follow.content.length, 1000);
});

test('迟到的旧视频号状态不能覆盖新的下播状态，旧响应内真实互动仍继续接收', async () => {
  let finishOlder;
  const older = new Promise(resolve => { finishOlder = resolve; });
  const response = liveStatus => ({ errCode: 0, data: { liveInfo: { liveId: 'room', liveStatus }, msgList: [], appMsgList: [] } });
  const f = browserFixture({ messageResponse: ({ requestId }) => requestId === 'older' ? older : response(0) });
  await f.connect(); const run = f.collector.run;
  for (const requestId of ['older', 'newer']) {
    await f.collector.networkMessage(run, 'Network.requestWillBeSent', { requestId,
      request: { url, postData: JSON.stringify({ liveId: 'room', signature: 'never-retained' }) } });
    await f.collector.networkMessage(run, 'Network.responseReceived', { requestId, response: { url, status: 200 } });
  }
  const pending = f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'older' });
  await f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'newer' });
  const oldResponse = response(1);
  oldResponse.data.msgList.push({ type: 1, clientMsgId: 'old-comment', nickname: '观众', content: '仍保留此条评论' });
  finishOlder(oldResponse); await pending;
  assert.deepEqual(f.events.filter(item => item.event.event_type === 'live_status').map(item => item.event.live_status), ['ended']);
  assert.equal(f.events.find(item => item.event.event_type === 'comment').event.content, '仍保留此条评论');
  assert.equal(run.liveStatus, 'ended');
  await f.collector.stop();
});

test('后台网络失败保留可刷新的窗口，忽略子资源失败且重试后继续采集', async () => {
  const f = browserFixture({ loadLive: async () => {
    throw Object.assign(new Error('private-cookie=never-expose'), { code: 'ERR_INTERNET_DISCONNECTED', errno: -106 });
  } });
  await f.connect();
  const run = f.collector.run;
  assert.ok(run?.active);
  assert.equal(f.windows[0].isDestroyed(), false);
  assert.equal(f.states.at(-1).state, 'message-error');
  assert.equal(f.states.at(-1).errorCode, 'WECHAT_PAGE_LOAD');
  assert.doesNotMatch(JSON.stringify(f.states), /private-cookie/);
  const previousCount = f.states.length;
  f.windows[0].webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', url, false);
  assert.equal(f.states.length, previousCount);
  f.windows[0].webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', LIVE_URL, true);
  assert.equal(f.states.length, previousCount + 1);
  await f.collector.networkMessage(run, 'Network.responseReceived', { requestId: 'retry', response: { url, status: 200 } });
  await f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'retry' });
  assert.equal(f.events.length, 5);
  assert.equal(f.states.findLast(item => item.state)?.state, 'connected');
  await f.collector.stop();
});

test('业务回调失败只报告脱敏observer错误，后续互动和其他诊断观察者继续接收', async () => {
  const f = browserFixture(), delivered = [], diagnostics = [], observerErrors = [];
  const fail = () => { throw new Error('PRIVATE_ACCOUNT_COOKIE'); };
  f.collector.on('observer-error', fail);
  f.collector.on('observer-error', async () => { throw new Error('PRIVATE_DIAGNOSTIC'); });
  f.collector.on('observer-error', value => observerErrors.push(value));
  await f.collector.connect({
    remember: false,
    onState: fail,
    onEvent: event => {
      delivered.push(event.event_type);
      if (event.event_type === 'comment') fail();
      if (event.event_type === 'enter') return Promise.reject(new Error('PRIVATE_ASYNC_ACCOUNT'));
    },
    onDiagnostic: metric => {
      diagnostics.push(metric);
      if (metric === 'giftCallbacks') fail();
    }
  });
  const run = f.collector.run;
  await f.collector.networkMessage(run, 'Network.responseReceived', { requestId: 'batch', response: { url, status: 200 } });
  await f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'batch' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delivered, ['comment', 'enter', 'gift', 'like', 'room_stats']);
  assert.ok(diagnostics.includes('observerErrors'));
  assert.ok(observerErrors.some(value => value.channel === 'onEvent'));
  assert.ok(observerErrors.some(value => value.channel === 'onDiagnostic'));
  assert.ok(observerErrors.every(value => value.code === 'OBSERVER_CALLBACK_FAILED' &&
    Object.keys(value).sort().join() === 'channel,code'));
  assert.doesNotMatch(JSON.stringify(observerErrors), /PRIVATE/);
  await f.collector.stop();
});

test('切房后的旧请求不覆盖新房连接与统计，旧真实互动保留原路由', async () => {
  const older = deferred();
  const response = (liveId, onlineCnt, messageId) => ({ errCode: 0, data: {
    liveInfo: { liveId, onlineCnt, liveStatus: 1 },
    msgList: [{ type: 1, clientMsgId: messageId, content: 'synthetic' }]
  } });
  const f = browserFixture({ messageResponse: ({ requestId }) =>
    requestId === 'older' ? older.promise : response('new-room', 20, 'new-comment') });
  await f.connect(); const run = f.collector.run;
  await f.collector.networkMessage(run, 'Network.requestWillBeSent', { requestId: 'old-failure',
    request: { url, postData: JSON.stringify({ liveId: 'old-room' }) } });
  for (const [requestId, liveId] of [['older', 'old-room'], ['newer', 'new-room']]) {
    await f.collector.networkMessage(run, 'Network.requestWillBeSent', { requestId, request: { url, postData: JSON.stringify({ liveId }) } });
    await f.collector.networkMessage(run, 'Network.responseReceived', { requestId, response: { url, status: 200 } });
  }
  const pending = f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'older' });
  await f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'newer' });
  await f.collector.networkMessage(run, 'Network.loadingFailed', { requestId: 'old-failure' });
  older.resolve(response('old-room', 10, 'old-comment')); await pending;
  assert.deepEqual(f.states.filter(state => state.state === 'connected').map(state => state.roomId), ['new-room']);
  assert.equal(f.states.some(state => state.state === 'message-error'), false);
  assert.deepEqual(f.events.filter(item => item.event.event_type === 'room_stats').map(item => item.roomId), ['new-room']);
  assert.deepEqual(f.events.filter(item => item.event.event_type === 'comment').map(item => item.roomId), ['new-room', 'old-room']);
  await f.collector.stop();
});

test('在connected回调同步停止后不再发送状态或同批互动', async () => {
  const value = sample(); value.data.liveInfo.liveStatus = 1;
  const f = browserFixture({ messageResponse: () => value });
  const events = []; let stopping;
  await f.collector.connect({ remember: false,
    onState: state => { if (state.state === 'connected') stopping = f.collector.stop(); },
    onEvent: event => events.push(event)
  });
  const run = f.collector.run;
  await f.collector.networkMessage(run, 'Network.responseReceived', { requestId: 'batch', response: { url, status: 200 } });
  await f.collector.networkMessage(run, 'Network.loadingFinished', { requestId: 'batch' });
  await stopping;
  assert.deepEqual(events, []);
  assert.equal(run.active, false);
});

test('视频号不截断消息与用户身份，无效或冲突房间不回退到其他路由', () => {
  const { createLiveConnect } = require('../core/index.cjs');
  const prefix = 'x'.repeat(128);
  const response = { errCode: 0, data: { liveInfo: { liveId: 'room' }, msgList: [
    { type: 1, clientMsgId: prefix + 'a', username: prefix + 'a', content: 'first' },
    { type: 1, clientMsgId: prefix + 'b', username: prefix + 'b', content: 'second' }
  ] } };
  const decoded = decodeWechatResponse(JSON.stringify(response));
  assert.ok(decoded.events.every(event => event.source_msg_id === '' && event.user_id === ''));
  const hub = createLiveConnect(), room = hub.openRoom({ platform: 'wechat', roomId: decoded.roomId });
  for (const event of decoded.events) room.ingest(event);
  assert.equal(room.history().length, 2);
  hub.close();
  for (const liveId of [prefix + 'a', 'bad\nroom', 'other-room', null]) {
    const value = { ...response, data: { ...response.data, liveInfo: { liveId } } };
    assert.equal(decodeWechatResponse(JSON.stringify(value), { liveId: 'room' }).roomId, '');
  }
  assert.equal(decodeWechatResponse(JSON.stringify(response), { liveId: prefix + 'a' }).roomId, '');
  assert.equal(decodeWechatResponse(JSON.stringify({ errCode: 0, data: { msgList: [] } }), { liveId: 'room' }).roomId, 'room');
});

const giftCatalogUrl = 'https://channels.weixin.qq.com/micro/live/cgi-bin/mmfinderassistant-bin/live/gift_enum_list';
const viewerListUrl = 'https://channels.weixin.qq.com/micro/live/cgi-bin/mmfinderassistant-bin/live/online_member';
const syntheticGiftCatalog = (image = 'https://mmbiz.qpic.cn/synthetic-gift.png') =>
  ({ errCode: 0, data: { giftList: [{ rewardProductId: 'gift-42', thumbnailFileUrl: image }] } });
const syntheticViewers = (name = '合成观众') => ({ errCode: 0, data: {
  liveContacts: [{ displayNickname: name, contact: { username: 'synthetic-viewer', headUrl: 'https://wx.qlogo.cn/synthetic-viewer.png' } }]
} });
async function startResponse(f, requestId, endpoint, liveId = 'fixture-live-room', status = 200) {
  const run = f.collector.run;
  await f.collector.networkMessage(run, 'Network.requestWillBeSent', { requestId,
    request: { url: endpoint, postData: JSON.stringify({ liveId, secret: 'MUST_NOT_RETAIN' }) } });
  await f.collector.networkMessage(run, 'Network.responseReceived', { requestId, response: { url: endpoint, status } });
}
async function finishResponse(f, requestId, encodedDataLength = 100) {
  await f.collector.networkMessage(f.collector.run, 'Network.loadingFinished', { requestId, encodedDataLength });
}

test('被动目录接入补齐真实礼物增量图片，目录本身不产生互动或连接状态', async () => {
  const f = browserFixture({ messageResponse: ({ requestId }) => requestId === 'catalog' ? syntheticGiftCatalog() : sample() });
  await f.connect({ remember: false });
  const run = f.collector.run, stateCount = f.states.length;
  await startResponse(f, 'catalog', giftCatalogUrl);
  assert.doesNotMatch(JSON.stringify([...run.metadataRequests.values()]), /MUST_NOT_RETAIN/);
  await finishResponse(f, 'catalog');
  assert.equal(f.states.length, stateCount); assert.deepEqual(f.events, []);
  await startResponse(f, 'message', url); await finishResponse(f, 'message');
  const giftEvent = f.events.find(item => item.event.event_type === 'gift').event;
  assert.equal(giftEvent.gift_image_url, 'https://mmbiz.qpic.cn/synthetic-gift.png');
  assert.equal(giftEvent.gift_name, '小心心'); assert.equal(giftEvent.gift_count, 2);
  assert.equal(giftEvent.gift_price_raw, '20'); assert.equal(giftEvent.source_msg_id, 'gift-1');
  const { createLiveConnect } = require('../core/index.cjs');
  const hub = createLiveConnect(), room = hub.openRoom({ platform: 'wechat', roomId: 'fixture-live-room' });
  room.ingest(giftEvent); room.ingest(giftEvent);
  assert.equal(room.history().length, 1);
  assert.equal(room.history()[0].gift_image_url, giftEvent.gift_image_url);
  hub.close();
  assert.ok(f.commands.every(command => ['Network.enable', 'DOMStorage.enable', 'Network.getResponseBody'].includes(command.name)),
    'collector never initiates an API request');
  await f.collector.stop();
  assert.equal(run.giftCatalog.rooms.size, 0);
});

test('目录响应乱序、房间隔离、错误和停止中的迟到结果不会替换有效图片', async () => {
  const old = deferred(), stopping = deferred();
  const f = browserFixture({ messageResponse: ({ requestId }) =>
    requestId === 'old' ? old.promise : requestId === 'stopping' ? stopping.promise :
      requestId === 'invalid' ? { errCode: 0, data: { unknown: [] } } :
        syntheticGiftCatalog('https://mmbiz.qpic.cn/newer.png') });
  await f.connect({ remember: false }); const run = f.collector.run;
  await startResponse(f, 'old', giftCatalogUrl); const pending = finishResponse(f, 'old');
  await startResponse(f, 'new', giftCatalogUrl); await finishResponse(f, 'new');
  old.resolve(syntheticGiftCatalog('https://mmbiz.qpic.cn/older.png')); await pending;
  const giftEvent = { event_type: 'gift', gift_id: 'gift-42' };
  assert.equal(run.giftCatalog.enrich(giftEvent, 'fixture-live-room').gift_image_url, 'https://mmbiz.qpic.cn/newer.png');
  assert.equal(run.giftCatalog.enrich(giftEvent, 'another-room'), giftEvent);
  await startResponse(f, 'invalid', giftCatalogUrl); await finishResponse(f, 'invalid');
  assert.equal(run.giftCatalog.enrich(giftEvent, 'fixture-live-room').gift_image_url, 'https://mmbiz.qpic.cn/newer.png');
  await startResponse(f, 'stopping', giftCatalogUrl); const late = finishResponse(f, 'stopping');
  await f.collector.stop();
  stopping.resolve(syntheticGiftCatalog()); await late;
  assert.equal(run.giftCatalog.rooms.size, 0); assert.equal(run.metadataInFlight, 0);
  assert.deepEqual(f.events, []);
});

test('辅助响应要求已捕获精确房间，拒绝重定向、失败、过大或过密请求并继续接收弹幕', async () => {
  const gate = deferred();
  const f = browserFixture({ bodyResponse: ({ requestId }) => requestId.startsWith('pending') ? gate.promise :
    Promise.resolve({ body: requestId === 'malformed' ? '{' :
      JSON.stringify(requestId === 'message' ? sample() : syntheticGiftCatalog()), base64Encoded: false }) });
  await f.connect({ remember: false }); const run = f.collector.run;
  await f.collector.networkMessage(run, 'Network.responseReceived', { requestId: 'untracked', response: { url: giftCatalogUrl, status: 200 } });
  await finishResponse(f, 'untracked');
  for (const [id, liveId, status] of [['no-room', undefined, 200], ['bad-room', ' room ', 200], ['denied', 'fixture-live-room', 403]]) {
    // undefined is deliberately serialized as an omitted key here.
    await f.collector.networkMessage(run, 'Network.requestWillBeSent', { requestId: id,
      request: { url: giftCatalogUrl, postData: JSON.stringify({ liveId }) } });
    await f.collector.networkMessage(run, 'Network.responseReceived', { requestId: id, response: { url: giftCatalogUrl, status } });
    await finishResponse(f, id);
  }
  await startResponse(f, 'redirect', giftCatalogUrl);
  await f.collector.networkMessage(run, 'Network.requestWillBeSent', { requestId: 'redirect', request: { url: 'https://unrelated.invalid/response' } });
  await finishResponse(f, 'redirect');
  await startResponse(f, 'huge', giftCatalogUrl); await finishResponse(f, 'huge', MAX_BODY + 1);
  assert.equal(f.commands.filter(command => command.name === 'Network.getResponseBody').length, 0);
  await startResponse(f, 'malformed', giftCatalogUrl); await finishResponse(f, 'malformed');
  const pending = [];
  for (let i = 0; i < 3; i++) {
    await startResponse(f, `pending-${i}`, giftCatalogUrl);
    pending.push(finishResponse(f, `pending-${i}`));
  }
  assert.equal(run.metadataInFlight, 2);
  await startResponse(f, 'message', url); await finishResponse(f, 'message');
  assert.ok(f.events.some(item => item.event.event_type === 'comment'));
  assert.equal(f.states.some(state => state.state === 'message-error'), false);
  gate.resolve({ body: JSON.stringify(syntheticGiftCatalog()), base64Encoded: false }); await Promise.all(pending);
  for (let i = 0; i < 40; i++) await startResponse(f, `bounded-${i}`, giftCatalogUrl);
  assert.equal(run.metadataRequests.size, 32);
  await f.collector.stop();
});

test('被动在线名单是部分快照，只发当前房间的最新请求，空名单也保持快照语义', async () => {
  const old = deferred();
  const f = browserFixture({ messageResponse: ({ requestId }) =>
    requestId === 'message' ? sample() : requestId === 'old' ? old.promise :
      requestId === 'empty' ? { errCode: 0, data: { liveContacts: [] } } : syntheticViewers('最新合成观众') });
  await f.connect({ remember: false });
  await startResponse(f, 'before-room', viewerListUrl); await finishResponse(f, 'before-room');
  assert.deepEqual(f.events, []);
  await startResponse(f, 'message', url); await finishResponse(f, 'message');
  const stateCount = f.states.length;
  await startResponse(f, 'old', viewerListUrl); const pending = finishResponse(f, 'old');
  await startResponse(f, 'new', viewerListUrl); await finishResponse(f, 'new');
  old.resolve(syntheticViewers('旧合成观众')); await pending;
  const snapshots = () => f.events.filter(item => item.event.event_type === 'viewer_snapshot');
  assert.equal(snapshots().length, 1);
  assert.equal(snapshots()[0].event.viewer_snapshot.viewers[0].userName, '最新合成观众');
  assert.equal(snapshots()[0].event.viewer_snapshot.complete, false);
  assert.equal(snapshots()[0].event.viewer_snapshot.presenceEvidence, 'online-list');
  await startResponse(f, 'other-room', viewerListUrl, 'other-room'); await finishResponse(f, 'other-room');
  assert.equal(snapshots().length, 1);
  await startResponse(f, 'empty', viewerListUrl); await finishResponse(f, 'empty');
  assert.equal(snapshots().length, 2);
  assert.deepEqual(snapshots()[1].event.viewer_snapshot.viewers, []);
  assert.notEqual(snapshots()[0].event.source_msg_id, snapshots()[1].event.source_msg_id);
  assert.equal(f.states.length, stateCount);
  await f.collector.stop();
});

test('切房后的旧名单和停止后的名单不回到事件流，畸形名单不改变连接状态', async () => {
  const old = deferred(), late = deferred();
  const f = browserFixture({ bodyResponse: ({ requestId }) => {
    if (requestId === 'old-viewers') return old.promise;
    if (requestId === 'late-viewers') return late.promise;
    const value = sample();
    if (requestId === 'new-message') value.data.liveInfo.liveId = 'new-room';
    return { body: requestId === 'broken-viewers' ? '{' : JSON.stringify(value), base64Encoded: false };
  } });
  await f.connect({ remember: false }); const run = f.collector.run;
  await startResponse(f, 'old-message', url); await finishResponse(f, 'old-message');
  await startResponse(f, 'old-viewers', viewerListUrl); const pending = finishResponse(f, 'old-viewers');
  await startResponse(f, 'new-message', url, 'new-room'); await finishResponse(f, 'new-message');
  old.resolve({ body: JSON.stringify(syntheticViewers()), base64Encoded: false }); await pending;
  const stateCount = f.states.length;
  await startResponse(f, 'broken-viewers', viewerListUrl, 'new-room'); await finishResponse(f, 'broken-viewers');
  assert.equal(f.states.length, stateCount);
  await startResponse(f, 'late-viewers', viewerListUrl, 'new-room'); const stopping = finishResponse(f, 'late-viewers');
  await f.collector.stop();
  late.resolve({ body: JSON.stringify(syntheticViewers()), base64Encoded: false }); await stopping;
  assert.equal(f.events.some(item => item.event.event_type === 'viewer_snapshot'), false);
  assert.equal(run.metadataRequests.size, 0);
});
