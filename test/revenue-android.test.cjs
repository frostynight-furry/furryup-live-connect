'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto'), path = require('node:path'), os = require('node:os'), fs = require('node:fs/promises');
const { createDouyinWalletAndroidReader, createCreatorRevenueSync, createRevenueLedger } = require('../revenue/index.cjs');
const { createAndroidRevenueDevice } = require('../revenue/android-device.cjs');
const { MOBILE_WALLET_PAGE, walletRequest } = require('../revenue/douyin-wallet.cjs');
const { nativeWalletPage } = require('../revenue/douyin-wallet-android.cjs');
const { syntheticDouyinWalletResponse } = require('../testing/revenue-wallet-fixtures.cjs');
const DEVICE = 'f'.repeat(64), UID = '123456789';
const account = id => createHash('sha256').update(JSON.stringify(['douyin', 'native_uid', id])).digest('hex');
function nativeHarness() {
  let owner = 'synthetic-owner', mode = 'normal', identity = UID, closed = 0, pending;
  const requests = [], methods = [], target = { location: new URL(MOBILE_WALLET_PAGE), crypto: webcrypto, Uint8Array, TextEncoder, URL, setTimeout, clearTimeout };
  target.window = { ToutiaoJSBridge: { call(method, params, callback) {
    methods.push(method);
    if (mode === 'timeout') return;
    if (method === 'userInfo') return queueMicrotask(() => callback(mode === 'logged-out' ? { code: -1 } : mode === 'ambiguous' ? { code: 1, uid: UID, user_id: '987654321' } : { code: 1, user_id: identity, nickname: 'private-synthetic-nickname', session: 'private-synthetic-session' }));
    if (method === 'openLive') { assert.deepEqual(JSON.parse(JSON.stringify(params)), { type: 'login_panel', keep_open: 1 }); return queueMicrotask(() => callback({ code: 1 })); }
    assert.equal(method, 'fetch'); assert.equal(params.method, 'GET'); assert.equal(params.url, 'https://wallet-activity.amemv.com/webcast/wallet_api/get_billing_list/'); requests.push(params);
    if (mode === 'switch') identity = '987654321';
    if (mode === 'host-switch') owner = 'different-owner';
    if (mode === 'page-switch') target.location = new URL('https://untrusted.invalid/');
    const response = mode === 'wallet-login' ? { status_code: 20003 } : syntheticDouyinWalletResponse({ url: params.url + '?' + new URLSearchParams(params.params) });
    const deliver = () => callback({ raw: response }); if (mode === 'defer') pending = deliver; else queueMicrotask(deliver);
  } } };
  const makeDevice = () => ({ inspect: async () => [{ deviceId: DEVICE, status: 'device', model: 'Synthetic' }],
    openDouyinWallet: async id => id || DEVICE,
    attachWallet: async () => ({ deviceId: DEVICE, evaluate: async expr => JSON.parse(JSON.stringify(await vm.runInNewContext(expr, target))), close: async () => { closed++; } }) });
  const make = extra => createDouyinWalletAndroidReader({ getAccount: () => ({ accountId: owner }), device: makeDevice(), requestTimeoutMs: 150, collectionTimeoutMs: 2000, ...extra });
  const reader = make(), options = { owner: 'synthetic-owner', deviceId: DEVICE, fromMonth: '2026-09', toMonth: '2026-09' };
  return { reader, make, options, requests, methods, target, closed: () => closed, owner: value => { owner = value; }, mode: value => { mode = value; }, release: () => pending?.() };
}
test('native wallet binds its own numeric identity and calls only the official native GET without exporting session fields', async () => {
  const h = nativeHarness(), result = await h.reader.connect(h.options);
  assert.equal(result.accountId, account(UID)); assert.equal(result.identityKind, 'native_uid'); assert.equal(result.deviceId, DEVICE);
  assert.equal(result.sessionReuse, 'android_native_bridge'); assert.equal(result.authenticationValidation, 'synthetic_only');
  assert.equal(result.statements.length, 1); assert.equal(h.requests.length, 2); assert.ok(h.methods.every(m => ['userInfo', 'fetch'].includes(m)));
  assert.ok(!JSON.stringify(result).includes(UID)); assert.ok(!JSON.stringify(result).includes('private-synthetic'));
  const ledger = createRevenueLedger({ platform: 'douyin', accountId: result.accountId }); ledger.ingest(result); assert.equal(ledger.statements()[0].transactions.length, 4);
  assert.equal(h.closed(), 1); await h.reader.dispose();
});
test('native account changes, host switches and navigation changes reject acquisition and release the session', async () => {
  for (const [mode, code] of [['switch', 'PLATFORM_ACCOUNT_CHANGED'], ['host-switch', 'ACCOUNT_CHANGED'], ['page-switch', 'PAGE_CHANGED']]) {
    const h = nativeHarness(); h.mode(mode); await assert.rejects(h.reader.connect(h.options), { code }); assert.equal(h.closed(), 1); await h.reader.dispose();
  }
});
test('native login is interactive-only, ambiguous UID responses cannot bind, and wallet authentication is not bypassed', async () => {
  const h = nativeHarness(); h.mode('logged-out'); await assert.rejects(h.reader.connect(h.options), { code: 'LOGIN_REQUIRED' });
  assert.equal(h.methods.filter(m => m === 'openLive').length, 1);
  await assert.rejects(h.reader.lookup({ ...h.options, expectedIdentity: account(UID), identityKind: 'native_uid' }), { code: 'LOGIN_REQUIRED' });
  assert.equal(h.methods.filter(m => m === 'openLive').length, 1);
  h.mode('ambiguous'); await assert.rejects(h.reader.connect(h.options), { code: 'REVENUE_MOBILE_IDENTITY_UNAVAILABLE' });
  h.mode('wallet-login'); await assert.rejects(h.reader.connect(h.options), { code: 'REVENUE_WALLET_SESSION_REQUIRED' }); await h.reader.dispose();
});
test('background mobile lookups require both device and native account bindings, keeping web identities separate', async () => {
  const h = nativeHarness(); await assert.rejects(h.reader.lookup(h.options), { code: 'REVENUE_BINDING_REQUIRED' });
  await assert.rejects(h.reader.lookup({ ...h.options, deviceId: undefined, expectedIdentity: account(UID) }), { code: 'REVENUE_MOBILE_BINDING_REQUIRED' });
  await assert.rejects(h.reader.lookup({ ...h.options, expectedIdentity: account(UID), identityKind: 'account-cookie-uid_tt' }), { code: 'INVALID_REVENUE_IDENTITY_KIND' });
  await assert.rejects(h.reader.lookup({ ...h.options, expectedIdentity: 'e'.repeat(64), identityKind: 'native_uid' }), { code: 'PLATFORM_ACCOUNT_CHANGED' });
  assert.equal(h.requests.length, 0); await h.reader.dispose();
});
test('native bridge timeout is bounded and does not create zero history', async () => {
  const h = nativeHarness(); h.mode('timeout'); await assert.rejects(h.reader.connect(h.options), { code: 'REVENUE_REQUEST_TIMEOUT' }); assert.equal(h.closed(), 1); await h.reader.dispose();
});
test('a rejected competing native reader cannot remove the first reader device lock', async () => {
  const h = nativeHarness(); h.mode('defer'); const first = h.reader.connect(h.options); await new Promise(r => setTimeout(r, 20));
  const second = h.make(); await assert.rejects(second.connect(h.options), { code: 'REVENUE_BUSY' });
  await assert.rejects(second.connect(h.options), { code: 'REVENUE_BUSY' });
  h.mode('normal'); h.release(); await first; await h.reader.dispose(); await second.dispose();
});
test('native page forbids arbitrary endpoints, non-income requests and malformed native account values', async () => {
  const h = nativeHarness(), evaluate = (op, descriptor) => vm.runInNewContext('(' + nativeWalletPage.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(descriptor) + ',100)', h.target);
  const good = walletRequest({ month: '2026-09', page: 1, cursor: 1790726400 });
  for (const descriptor of [{ ...good, url: 'https://example.invalid/' }, { ...good, method: 'POST' }, { ...good, url: good.url.replace('type=0', 'type=1') }]) {
    assert.equal((await evaluate('bills', descriptor)).error, 'REVENUE_UNSUPPORTED_ENDPOINT');
  }
  assert.equal(h.requests.length, 0); assert.equal((await evaluate('withdraw', good)).error, 'REVENUE_UNSUPPORTED_ENDPOINT');
  h.target.window.ToutiaoJSBridge.call = (_method, _params, callback) => callback({ code: 1, uid: Number.MAX_SAFE_INTEGER + 1 });
  assert.equal((await evaluate('identity', null)).error, 'REVENUE_MOBILE_IDENTITY_UNAVAILABLE'); await h.reader.dispose();
});
test('native wallet reader works with the shared automatic scheduler and its separate persisted identity', async () => {
  const h = nativeHarness(), bound = await h.reader.connect(h.options); let saved;
  const sync = createCreatorRevenueSync({ owner: h.options.owner, platform: 'douyin', accountId: bound.accountId, identityKind: bound.identityKind,
    deviceId: DEVICE, reader: h.reader, getAccount: () => ({ accountId: h.options.owner }), fromMonth: '2026-09',
    store: { load: async () => saved, save: async (_key, value) => { saved = structuredClone(value); } } });
  await sync.syncNow(); assert.ok(sync.export().statements.length); assert.deepEqual(sync.status().sources.map(s => s.source), ['wallet']);
  h.mode('wallet-login'); await sync.syncNow(); assert.equal(sync.status().state, 'needs_login'); assert.ok(sync.export().statements.length);
  sync.dispose(); await h.reader.dispose();
});
async function deviceHarness(mode = 'normal') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'creator-android-auth-')), calls = []; let socket;
  const execute = async (_file, args, options) => {
    assert.equal(options.windowsHide, true); assert.equal(options.env.ANDROID_USER_HOME, directory); const rest = args.slice(2); calls.push(rest);
    if (rest[0] === 'devices') return { stdout: 'List of devices attached\nsynthetic-device\t' + (mode === 'unauthorized' ? 'unauthorized' : 'device') + ' model:Synthetic\n' };
    const cmd = rest.slice(2).join(' ');
    if (cmd === 'shell ps -A -o PID,NAME') return { stdout: 'PID NAME\n42 com.ss.android.ugc.aweme\n99 com.unrelated.app\n' };
    if (cmd === 'shell cat /proc/net/unix') return { stdout: '0 @webview_devtools_remote_' + (mode === 'unrelated' ? '99' : '42') + '\n' };
    if (cmd === 'forward tcp:0 localabstract:webview_devtools_remote_42') return { stdout: '43210\n' };
    if (cmd === 'forward --remove tcp:43210') return { stdout: '' };
    throw new Error('Unexpected command');
  };
  class SyntheticSocket extends EventTarget {
    constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) { const request = JSON.parse(text); let result;
      if (request.method === 'Page.enable') result = {};
      else if (request.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'main', url: MOBILE_WALLET_PAGE } } };
      else if (request.method === 'Runtime.evaluate') result = { result: { value: { synthetic: true } } };
      else throw new Error('Unexpected CDP method');
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result }) })));
    }
    close() { if (this.closed) return; this.closed = true; this.dispatchEvent(new Event('close')); }
  }
  const device = createAndroidRevenueDevice({ adbPath: path.join(directory, 'synthetic-adb'), authDirectory: directory, execute, WebSocketImpl: SyntheticSocket,
    fetchImpl: async url => { assert.equal(url, 'http://127.0.0.1:43210/json/list'); const target = { type: 'page', url: MOBILE_WALLET_PAGE,
      webSocketDebuggerUrl: (mode === 'external' ? 'ws://example.invalid' : 'ws://127.0.0.1') + ':43210/devtools/page/synthetic' };
      return new Response(JSON.stringify(mode === 'ambiguous' ? [target, target] : [target]), { headers: { 'content-type': 'application/json' } }); } });
  return { device, calls, cleanup: () => fs.rmdir(directory), navigate: () => socket.dispatchEvent(new MessageEvent('message', {
    data: JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url: MOBILE_WALLET_PAGE } } }) })) };
}
test('Android attach only forwards the selected App socket to loopback and cleans up owned forwards', async () => {
  const h = await deviceHarness(), devices = await h.device.inspect(); assert.ok(!JSON.stringify(devices).includes('synthetic-device'));
  const attached = await h.device.attachWallet(devices[0].deviceId); assert.deepEqual(await attached.evaluate('synthetic-only'), { synthetic: true });
  h.navigate(); await assert.rejects(attached.guard(), { code: 'PAGE_CHANGED' }); await attached.close();
  assert.ok(h.calls.some(c => c.slice(2).join(' ') === 'forward --remove tcp:43210')); await h.cleanup();
});
test('USB authorization, App-owned sockets, unique pages and loopback targets are required', async () => {
  for (const [mode, code] of [['unauthorized', 'REVENUE_MOBILE_AUTHORIZATION_REQUIRED'], ['unrelated', 'REVENUE_MOBILE_WEBVIEW_UNAVAILABLE'],
    ['ambiguous', 'REVENUE_MOBILE_PAGE_AMBIGUOUS'], ['external', 'UNTRUSTED_PAGE']]) {
    const h = await deviceHarness(mode); await assert.rejects(h.device.attachWallet(), { code });
    if (['ambiguous', 'external'].includes(mode)) assert.ok(h.calls.some(c => c.slice(2).join(' ') === 'forward --remove tcp:43210'));
    else assert.ok(!h.calls.some(c => c.includes('forward'))); await h.cleanup();
  }
});
