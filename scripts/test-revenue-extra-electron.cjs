'use strict';
// Real Electron isolation/native page clients; all HTTPS is synthetic and intercepted.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { createCreatorRevenueBrowser, createCreatorRevenueSync, createCreatorRevenueFileStore } = require('../revenue/index.cjs');
const { partitionFor, identityHash } = require('../profiles/creator-electron.cjs');
const { cleanIdentity } = require('../profiles/creator-page.cjs');
const { REVENUE_PAGES } = require('../revenue/adapters.cjs');
const { chinaDay, shiftMonth } = require('../revenue/model.cjs');
const { KS_USER_ID, WX_FINDER, WX_AUTH_CODE, syntheticExtraRevenueResponse, syntheticWalletResponse } = require('../testing/revenue-extra-fixtures.cjs');
const report = { state: 'running', synthetic: true, livePlatformValidation: false, checks: [], interceptedRequests: 0, trace: [] };
const artifacts = path.resolve(process.env.LIVECONNECT_TEST_ARTIFACTS || path.join(os.tmpdir(), 'liveconnect-revenue-extra-fixture-' + process.pid));
const pass = name => { report.checks.push(name); console.log('PASS ' + name); };
const selected = shiftMonth(chinaDay(Math.floor(Date.now() / 1000)).slice(0, 7), -1), range = { fromMonth: selected, toMonth: selected };
let mode = 'normal', owner = 'synthetic-owner-extra', changed = false, browser, walletReads = 0, handoffs = 0;
const bindings = {}, partitions = {}, created = [];
class TestWindow extends BrowserWindow {
  show() {} focus() {}
  constructor(options) {
    assert.equal(options.webPreferences.nodeIntegration, false); assert.equal(options.webPreferences.contextIsolation, true);
    assert.equal(options.webPreferences.sandbox, true); assert.equal(options.webPreferences.preload, undefined);
    super({ ...options, show: false }); created.push(this);
  }
}
const create = () => createCreatorRevenueBrowser({ BrowserWindow: TestWindow, session, getAccount: () => ({ accountId: owner }),
  requestIntervalMs: 0, connectTimeoutMs: 5000, refreshTimeoutMs: 3500, requestTimeoutMs: 700 });
const lookup = (platform, extra = {}) => browser.lookup({ owner, platform, ...range, expectedIdentity: bindings[platform].accountId, identityKind: bindings[platform].identityKind, ...extra });
const nativeScript = platform => platform === 'kuaishou' ?
  `window.$http={post:async(url,body)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-synthetic-native':'kuaishou'},body:JSON.stringify(body)});return r.json()}};` :
  `window.requestX={RequestService:class {}};window.$shareData={isUserExpiredErrorCode:code=>code===-999,getBaseService:()=>class {async post({url,data}){const r=await fetch('/cgi-bin/mmfinderassistant-bin/'+url,{method:'POST',headers:{'content-type':'application/json','x-synthetic-native':'wechat'},body:JSON.stringify(data)});return r.json()}}};`;
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
(async () => {
  app.setPath('userData', await fs.mkdtemp(path.join(os.tmpdir(), 'creator-revenue-extra-'))); await app.whenReady();
  for (const platform of ['kuaishou', 'wechat_channels']) {
    const storage = session.fromPartition(partitionFor(owner, platform)); partitions[platform] = storage;
    await storage.protocol.handle('https', async req => {
      report.interceptedRequests++;
      const url = new URL(req.url), page = new URL(REVENUE_PAGES[platform]);
      report.trace.push([mode, platform, url.pathname]);
      const headers = { 'content-type': 'application/json' };
      if (url.origin === page.origin && url.pathname === page.pathname) {
        const html = '<meta charset="utf-8"><body>Synthetic own-account revenue page<script>' +
          (mode === 'no-native-client' ? '' : nativeScript(platform)) + '</script>';
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (url.origin === 'https://qy.webeans.weixin.qq.com') {
        if (url.pathname === '/') {
          const js = mode === 'stale-wallet' ? '' : `fetch('/api/auth/getCookie',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json()).then(()=>history.replaceState({},'', '/#/aidHome'))`;
          return new Response('<body>Synthetic wallet<script>' + js + '</script>', { headers: { 'content-type': 'text/html' } });
        }
        assert.equal(req.method, 'POST'); assert.equal(await req.text(), '{}');
        if (url.pathname === '/api/auth/getCookie') {
          handoffs++;
          return new Response(JSON.stringify(mode === 'wallet-login' ? { error: { code: -1000001 } } : { data: { cookie: true } }), { status: 201, headers });
        }
        assert.equal(url.pathname, '/api/platform/platformGetSettleListForFinderLive'); walletReads++;
        if (mode === 'wallet-account-switch') changed = true;
        if (mode === 'wallet-cookie-switch' || mode === 'wallet-cookie-switch-back') {
          await storage.cookies.set({ url: url.origin, name: 'syntheticWalletIdentity', value: 'different', secure: true });
          if (mode === 'wallet-cookie-switch-back') await storage.cookies.set({ url: url.origin, name: 'syntheticWalletIdentity', value: 'original', secure: true });
        }
        if (mode === 'host-switch') owner = 'another-host-owner';
        if (mode === 'wallet-oversized') return new Response('{}', { headers: { ...headers, 'content-length': String(3 * 1024 * 1024) } });
        return new Response(JSON.stringify(syntheticWalletResponse(selected)), { status: 201, headers });
      }
      if (url.origin !== page.origin) return new Response('Blocked by synthetic fixture', { status: 404 });
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.get('x-synthetic-native'), platform === 'kuaishou' ? 'kuaishou' : 'wechat');
      const body = JSON.parse(await req.text()), descriptor = { url: req.url, body };
      const response = syntheticExtraRevenueResponse(platform, descriptor);
      const self = url.pathname.endsWith('/account/current') || url.pathname.endsWith('/auth_data');
      if (self && changed) {
        if (platform === 'kuaishou') response.data.userId = '987654321'; else response.data.finderUser.finderUsername = 'another-synthetic-finder';
      }
      if (self && mode === 'wechat-expired') return new Response(JSON.stringify({ errCode: -999 }), { headers });
      if (url.pathname.endsWith('/pc/trending') && mode === 'ks-account-switch') changed = true;
      if (!self && mode === 'native-oversized') response.padding = 'x'.repeat(3 * 1024 * 1024);
      if (url.pathname.endsWith('/getRelatedMainPart') && mode === 'phone-verification') response.data.cocertInfo.extInfo = {};
      return new Response(JSON.stringify(response), { headers });
    });
  }
  browser = create();
  for (const platform of ['kuaishou', 'wechat_channels']) {
    const result = await browser.connect({ owner, platform, ...range }); bindings[platform] = result;
    assert.ok(result.records.length > 0); assert.equal(result.binding, 'creator_session');
    assert.ok(!JSON.stringify(result).includes(WX_AUTH_CODE)); assert.ok(!JSON.stringify(result).includes(KS_USER_ID));
    assert.ok(created.every(win => win.isDestroyed()));
    pass(platform + ': native page transport and server-verified identity acquire normalized periods');
  }
  assert.ok(handoffs > 0 && walletReads > 0);
  pass('Channels native handoff requires a fresh wallet login and accepts HTTP 201 monthly responses');
  for (const platform of ['kuaishou', 'wechat_channels']) {
    const auto = createCreatorRevenueSync({ owner, platform, accountId: bindings[platform].accountId, identityKind: bindings[platform].identityKind,
      getAccount: () => ({ accountId: owner }), reader: browser, fromMonth: selected,
      store: createCreatorRevenueFileStore({ directory: path.join(app.getPath('userData'), 'unified-history') }) });
    await auto.syncNow(); assert.ok(auto.export().records.length);
    if (platform === 'wechat_channels') assert.ok(auto.status().sources[0].issues.some(i => i.code === 'REVENUE_VIDEO_INCENTIVE_MOBILE_REQUIRED'));
    auto.dispose(); pass(platform + ': unified scheduler writes reusable monthly history without treating unavailable video incentive as zero');
  }
  assert.equal((await lookup('kuaishou')).accountId, bindings.kuaishou.accountId);
  const cookieBinding = identityHash('kuaishou', cleanIdentity('account-cookie-userId', KS_USER_ID));
  assert.equal((await lookup('kuaishou', { expectedIdentity: cookieBinding, identityKind: 'account-cookie-userId' })).accountId, cookieBinding);
  await assert.rejects(lookup('kuaishou', { identityKind: 'handle' }), { code: 'INVALID_REVENUE_IDENTITY_KIND' });
  pass('Existing numeric follower bindings are verified against the server; handles cannot bind financial data');
  for (const [platform, scenario] of [['kuaishou', 'ks-account-switch'], ['wechat_channels', 'wallet-account-switch']]) {
    mode = scenario; changed = false; await assert.rejects(lookup(platform), { code: 'PLATFORM_ACCOUNT_CHANGED' });
    assert.ok(created.every(win => win.isDestroyed())); changed = false;
  }
  pass('Server identity changes during either platform response reject the entire acquisition');
  mode = 'wallet-cookie-switch'; await assert.rejects(lookup('wechat_channels'), { code: 'PLATFORM_ACCOUNT_CHANGED' });
  await partitions.wechat_channels.cookies.set({ url: 'https://qy.webeans.weixin.qq.com', name: 'syntheticWalletIdentity', value: 'original', secure: true });
  mode = 'wallet-cookie-switch-back'; await assert.rejects(lookup('wechat_channels'), { code: 'PLATFORM_ACCOUNT_CHANGED' });
  pass('An independently changed wallet session cannot be attributed to the previous creator');
  mode = 'phone-verification'; const before = handoffs; const phone = await lookup('wechat_channels');
  assert.equal(handoffs, before); assert.equal(phone.records.length, 0);
  assert.ok(phone.issues.some(i => i.code === 'REVENUE_ADDITIONAL_VERIFICATION_REQUIRED'));
  pass('Required phone verification is respected before opening the financial handoff');
  mode = 'wallet-login'; const loggedOut = await lookup('wechat_channels');
  assert.equal(loggedOut.records.length, 0); assert.ok(loggedOut.issues.some(i => i.code === 'REVENUE_WALLET_LOGIN_REQUIRED'));
  pass('Wallet login failures stay unavailable without falling back to existing cookies');
  mode = 'stale-wallet'; const previousReads = walletReads;
  await assert.rejects(lookup('wechat_channels'), { code: 'REVENUE_COLLECTION_TIMEOUT' });
  assert.equal(walletReads, previousReads); assert.ok(created.every(win => win.isDestroyed()));
  pass('A stale authenticated wallet without this handoff cannot supply income; deadlines close both windows');
  mode = 'wechat-expired'; await assert.rejects(lookup('wechat_channels'), { code: 'LOGIN_REQUIRED' });
  pass('Native helper session-expiry codes remain explicit login failures');
  for (const [platform, scenario] of [['kuaishou', 'native-oversized'], ['wechat_channels', 'wallet-oversized']]) {
    mode = scenario; const result = await lookup(platform);
    assert.equal(result.records.length, 0); assert.ok(result.issues.some(i => i.code === 'REVENUE_RESPONSE_TOO_LARGE'));
  }
  pass('Native client and wallet response limits prevent oversized data from entering a ledger');
  mode = 'host-switch'; await assert.rejects(lookup('wechat_channels'), { code: 'ACCOUNT_CHANGED' }); owner = 'synthetic-owner-extra';
  assert.ok(created.every(win => win.isDestroyed()));
  pass('Host logout/account switching also closes a pending official wallet');
  mode = 'no-native-client'; await assert.rejects(lookup('kuaishou'), { code: 'REVENUE_PAGE_NOT_READY' });
  pass('Changed or missing official page clients fail explicitly without guessing session/signing data');
  browser.dispose();
  for (const storage of Object.values(partitions)) {
    assert.equal(storage.listenerCount('will-download'), 0); assert.equal(storage.cookies.listenerCount('changed'), 0);
  }
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  pass('All creator/wallet windows and temporary session listeners are released');
  report.state = 'passed';
})().catch(error => { report.state = 'failed'; report.error = error.stack; console.error(error); }).finally(async () => {
  browser?.dispose(); await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'acceptance-extra.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ state: report.state, checks: report.checks.length, artifacts })); app.exit(report.state === 'passed' ? 0 : 1);
});
