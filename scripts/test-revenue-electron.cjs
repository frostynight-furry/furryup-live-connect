'use strict';
// Real sandboxed Electron and page fetch, with every HTTPS request intercepted.
// Fixtures have no real credentials, external traffic or platform account data.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { createCreatorRevenueBrowser, createRevenueLedger, createDouyinWalletSync, createRevenueFileStore,
  createCreatorRevenueSync, createCreatorRevenueFileStore } = require('../revenue/index.cjs');
const { partitionFor } = require('../profiles/creator-electron.cjs');
const { REVENUE_PAGES } = require('../revenue/adapters.cjs');
const { ANCHOR_PAGE } = require('../revenue/douyin-anchor.cjs');
const { chinaDay, shiftMonth } = require('../revenue/model.cjs');
const { syntheticRevenueResponse, syntheticAnchorResponse } = require('../testing/revenue-fixtures.cjs');
const { syntheticDouyinWalletResponse } = require('../testing/revenue-wallet-fixtures.cjs');
const report = { state: 'running', synthetic: true, livePlatformValidation: false, checks: [], interceptedRequests: 0 };
const artifacts = path.resolve(process.env.LIVECONNECT_TEST_ARTIFACTS || path.join(os.tmpdir(), 'liveconnect-revenue-fixture-' + process.pid));
const pass = value => { report.checks.push(value); console.log('PASS ' + value); };
let owner = 'synthetic-owner', mode = 'normal', browser, lastWindow, scratch, swapped = false;
const bindings = {}, initialOwner = owner, partitions = {};
const currentMonth = chinaDay(Math.floor(Date.now() / 1000)).slice(0, 7), previousMonth = shiftMonth(currentMonth, -1);
const range = { fromMonth: previousMonth, toMonth: previousMonth };
class TestWindow extends BrowserWindow {
  show() {} focus() {}
  constructor(options) {
    assert.equal(options.webPreferences.nodeIntegration, false); assert.equal(options.webPreferences.contextIsolation, true);
    assert.equal(options.webPreferences.sandbox, true); assert.equal(options.webPreferences.preload, undefined);
    super({ ...options, show: false }); lastWindow = this;
  }
}
const create = () => createCreatorRevenueBrowser({ BrowserWindow: TestWindow, session, getAccount: () => ({ accountId: owner }),
  requestIntervalMs: 0, connectTimeoutMs: 4000, refreshTimeoutMs: 2000, requestTimeoutMs: 700 });
const lookup = (platform = 'douyin', source = 'creator_center') => browser.lookup({ owner, platform, source, ...range, expectedIdentity: bindings[platform].accountId, identityKind: bindings[platform].identityKind });
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'creator-revenue-electron-')); app.setPath('userData', scratch);
  await app.whenReady();
  for (const platform of ['bilibili', 'douyin']) {
    const s = session.fromPartition(partitionFor(owner, platform)); partitions[platform] = s;
    await s.protocol.handle('https', async request => {
      report.interceptedRequests++;
      const url = new URL(request.url), page = new URL(REVENUE_PAGES[platform]);
      const isAnchor = platform === 'douyin' && url.hostname === 'anchor.douyin.com';
      if ((url.origin === page.origin && url.pathname === page.pathname) || (isAnchor && url.pathname === '/anchor/dashboard/home')) {
        const body = mode === 'login' || (mode === 'anchor-login' && isAnchor) ? '请先登录，扫码登录' : mode === 'challenge' ? '请完成安全验证' : '独立合成收益页（没有粉丝数卡片）';
        return new Response('<meta charset="utf-8"><body>' + body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (!['api.bilibili.com', 'creator.douyin.com', 'anchor.douyin.com'].includes(url.hostname)) return new Response('Blocked by fixture', { status: 404 });
      const headers = { 'content-type': 'application/json', 'access-control-allow-origin': page.origin, 'access-control-allow-credentials': 'true' };
      if (mode === 'self-mismatch' && url.pathname.endsWith('/nav')) return new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: 456 } }), { headers });
      if (mode === 'host-switch') owner = 'different-synthetic-owner';
      if (mode === 'platform-switch' && !swapped) {
        swapped = true; await s.cookies.set({ url: REVENUE_PAGES[platform], name: 'uid_tt', value: 'synthetic-account-b', secure: true });
      }
      if (mode === 'same-cookie' && !swapped) {
        swapped = true; await s.cookies.set({ url: REVENUE_PAGES[platform], name: 'uid_tt', value: 'synthetic-account-a', secure: true, expirationDate: Date.now() / 1000 + 90000 });
      }
      if (mode === 'oversized') return new Response('{}', { headers: { ...headers, 'content-length': String(3 * 1024 * 1024) } });
      if (mode === 'timeout') { await new Promise(resolve => setTimeout(resolve, 1000)); return new Response('{}', { headers }); }
      if (mode === 'invalid') return new Response('not json', { headers });
      if (isAnchor) {
        assert.equal(request.headers.get('x-appid'), '3000'); assert.equal(request.headers.get('x-sub-web-id'), '1116');
        if (mode === 'anchor-switch') await s.cookies.set({ url: ANCHOR_PAGE, name: 'uid_tt', value: 'synthetic-account-b', secure: true });
        return new Response(JSON.stringify(syntheticAnchorResponse({ url: request.url }, { asOf: chinaDay(Math.floor(Date.now() / 1000) - 86400) })), { headers });
      }
      if (url.pathname === '/webcast/wallet_api/get_billing_list/') {
        assert.equal(request.method, 'GET'); assert.equal(url.origin, 'https://creator.douyin.com');
        assert.equal(url.searchParams.get('is_income_record'), '1'); assert.equal(url.searchParams.get('need_summary'), '1');
        assert.equal(url.searchParams.get('count'), '20');
        if (mode === 'wallet-session') return new Response(JSON.stringify({ status_code: 20003 }), { headers });
        if (mode === 'wallet-switch-back') {
          await s.cookies.set({ url: page.href, name: 'uid_tt', value: 'synthetic-account-b', secure: true });
          await s.cookies.set({ url: page.href, name: 'uid_tt', value: 'synthetic-account-a', secure: true });
        }
        const result = syntheticDouyinWalletResponse({ url: request.url }, { earliest: previousMonth });
        if (mode === 'wallet-unreconciled') result.data.bill_list[0].income = '9999';
        return new Response(JSON.stringify(result), { headers });
      }
      return new Response(JSON.stringify(syntheticRevenueResponse(platform, { url: request.url })), { headers });
    });
    await s.cookies.set({ url: REVENUE_PAGES[platform], name: platform === 'bilibili' ? 'DedeUserID' : 'uid_tt',
      value: platform === 'bilibili' ? '123' : 'synthetic-account-a', secure: true, expirationDate: Date.now() / 1000 + 86400 });
    if (platform === 'douyin') await s.cookies.set({ url: ANCHOR_PAGE, name: 'uid_tt', value: 'synthetic-account-a', secure: true });
  }
  browser = create();
  for (const platform of ['bilibili', 'douyin']) {
    const result = await browser.connect({ owner, platform, ...range }); bindings[platform] = result;
    assert.ok(result.records.length > 0); assert.ok(!JSON.stringify(result).includes('synthetic-account-a'));
    assert.equal(lastWindow.isDestroyed(), true);
    pass(platform + ': authenticated page fetch reads normalized income without depending on follower cards');
  }
  const wallet = await lookup('douyin', 'wallet'), walletLedger = createRevenueLedger({ platform: 'douyin', accountId: wallet.accountId });
  walletLedger.ingest(wallet); assert.equal(walletLedger.statements()[0].transactions.length, 4);
  assert.equal(walletLedger.months({ scope: 'douyin.wallet_income', categoryId: 'live' })[0].amountMinor, '1200');
  assert.equal(walletLedger.months({ scope: 'douyin.wallet_income', categoryId: 'video_incentive' })[0].amountMinor, '345');
  assert.equal(wallet.sessionReuse, 'experimental_creator_origin');
  pass('Wallet monthly pagination runs inside the bound creator session and persists separate live/video posting amounts');
  mode = 'wallet-session'; await assert.rejects(lookup('douyin', 'wallet'), { code: 'REVENUE_WALLET_SESSION_REQUIRED' });
  assert.equal(lastWindow.isDestroyed(), true);
  pass('A mobile-only wallet session is an explicit blocking result, never a zero balance or successful sync');
  mode = 'wallet-unreconciled'; const badWallet = await lookup('douyin', 'wallet');
  assert.equal(badWallet.statements.length, 0); assert.ok(badWallet.issues.some(i => i.code === 'REVENUE_WALLET_RECONCILIATION_FAILED'));
  pass('An unreconciled monthly wallet cannot enter persisted history');
  mode = 'wallet-switch-back'; await assert.rejects(lookup('douyin', 'wallet'), { code: 'PLATFORM_ACCOUNT_CHANGED' });
  mode = 'normal';
  await assert.rejects(browser.lookup({ owner, platform: 'douyin', source: 'wallet', ...range, expectedIdentity: bindings.douyin.accountId, identityKind: 'handle' }), { code: 'INVALID_REVENUE_IDENTITY_KIND' });
  await assert.rejects(browser.connect({ owner, platform: 'bilibili', source: 'wallet' }), { code: 'REVENUE_UNSUPPORTED_SOURCE' });
  pass('Wallet rejects nickname handles, wrong platforms and a session switched away and back during a request');
  const sync = createDouyinWalletSync({ owner, accountId: wallet.accountId, getAccount: () => ({ accountId: owner }), reader: browser,
    store: createRevenueFileStore({ directory: path.join(scratch, 'wallet-history') }) });
  await sync.syncNow(); assert.equal(sync.export().statements.length, 2); const savedWallet = sync.export();
  await sync.start(); mode = 'wallet-session'; await assert.rejects(sync.syncNow(), { code: 'REVENUE_WALLET_SESSION_REQUIRED' });
  assert.equal(sync.status().state, 'needs_login'); assert.deepEqual(sync.export(), savedWallet); sync.dispose(); mode = 'normal';
  pass('The real Electron reader and atomic file store resume monthly history and pause on wallet-session expiry');
  for (const platform of ['bilibili', 'douyin']) {
    const auto = createCreatorRevenueSync({ owner, platform, accountId: bindings[platform].accountId, identityKind: bindings[platform].identityKind,
      getAccount: () => ({ accountId: owner }), reader: browser, fromMonth: previousMonth,
      store: createCreatorRevenueFileStore({ directory: path.join(scratch, 'unified-history') }) });
    await auto.syncNow(); assert.ok(auto.export().records.length);
    if (platform === 'douyin') {
      mode = 'wallet-session'; const status = await auto.syncNow();
      assert.equal(status.sources.find(s => s.source === 'wallet').state, 'needs_login');
      assert.ok(auto.export().nativeRecords.length); mode = 'normal';
    }
    auto.dispose(); pass(platform + ': unified automatic scheduler persists all selected sources and isolates wallet authorization failure');
  }
  const live = await lookup('douyin', 'anchor_dashboard');
  assert.equal(live.profileUrl, ANCHOR_PAGE); assert.equal(live.accountId, bindings.douyin.accountId);
  assert.equal(live.nativeMetrics.length, 3); assert.ok(live.nativeRecords.length > 0); assert.equal(live.records.length, 0);
  assert.ok(live.nativeMetrics.every(row => row.unit === '音浪' && row.currency === null));
  pass('The anchor dashboard uses the bound Douyin partition and preserves native units separately from yuan');
  mode = 'anchor-login'; await assert.rejects(lookup('douyin', 'anchor_dashboard'), { code: 'LOGIN_REQUIRED' });
  mode = 'anchor-switch'; await assert.rejects(lookup('douyin', 'anchor_dashboard'), { code: 'PLATFORM_ACCOUNT_CHANGED' });
  await partitions.douyin.cookies.set({ url: ANCHOR_PAGE, name: 'uid_tt', value: 'synthetic-account-a', secure: true });
  mode = 'normal';
  pass('Anchor-specific login and identity changes cannot fall back to another authenticated creator page');
  browser.dispose(); browser = create();
  assert.equal((await lookup()).accountId, bindings.douyin.accountId);
  pass('Fresh reader reuses the existing follower-compatible session partition');
  mode = 'self-mismatch'; await assert.rejects(lookup('bilibili'), { code: 'PLATFORM_ACCOUNT_CHANGED' });
  pass('Bilibili verifies the server-authenticated identity instead of trusting an inconsistent UID cookie');
  mode = 'same-cookie'; swapped = false; assert.ok((await lookup()).records.length > 0);
  pass('Renewing the same identity cookie does not impersonate an account switch');
  for (const [scenario, code] of [['login', 'LOGIN_REQUIRED'], ['challenge', 'VERIFICATION_REQUIRED']]) {
    mode = scenario; await assert.rejects(lookup(), { code }); assert.equal(lastWindow.isDestroyed(), true);
  }
  pass('Expired login and verification challenges are distinct and release the window');
  for (const [scenario, code] of [['oversized', 'REVENUE_RESPONSE_TOO_LARGE'], ['invalid', 'REVENUE_SCHEMA_CHANGED']]) {
    mode = scenario; const result = await lookup();
    assert.equal(result.status, 'unavailable'); assert.equal(result.records.length, 0); assert.ok(result.issues.some(i => i.code === code));
  }
  pass('Oversized/non-JSON responses cannot be recorded as zero revenue');
  mode = 'timeout';
  await assert.rejects(lookup(), { code: 'REVENUE_COLLECTION_TIMEOUT' }); assert.equal(lastWindow.isDestroyed(), true);
  pass('Slow requests are bounded by both request and collection deadlines');
  mode = 'platform-switch'; swapped = false;
  await assert.rejects(lookup(), { code: 'PLATFORM_ACCOUNT_CHANGED' }); assert.equal(lastWindow.isDestroyed(), true);
  pass('Switching the platform identity during a response rejects the entire acquisition');
  mode = 'normal';
  await partitions.douyin.cookies.set({ url: REVENUE_PAGES.douyin, name: 'uid_tt', value: 'synthetic-account-a', secure: true });
  mode = 'host-switch'; await assert.rejects(lookup(), { code: 'ACCOUNT_CHANGED' });
  assert.equal(lastWindow.isDestroyed(), true); owner = initialOwner;
  pass('Host account changes cannot receive an old account response');
  mode = 'login'; const pending = browser.connect({ owner, platform: 'douyin', ...range });
  await assert.rejects(browser.connect({ owner, platform: 'douyin', ...range }), { code: 'REVENUE_BUSY' });
  setTimeout(() => lastWindow.destroy(), 100); await assert.rejects(pending, { code: 'LOGIN_CANCELLED' });
  pass('Concurrent reads are rejected and closing login cancels collection');
  await assert.rejects(browser.lookup({ owner, platform: 'douyin' }), { code: 'REVENUE_BINDING_REQUIRED' });
  await assert.rejects(browser.connect({ owner, platform: 'xiaohongshu' }), { code: 'REVENUE_UNSUPPORTED_PLATFORM' });
  await assert.rejects(browser.connect({ owner, platform: 'bilibili', source: 'anchor_dashboard' }), { code: 'REVENUE_UNSUPPORTED_SOURCE' });
  browser.dispose(); await assert.rejects(browser.connect({ owner, platform: 'douyin' }), { code: 'REVENUE_DISPOSED' });
  pass('Background reads require a binding; deferred platforms and disposed readers fail explicitly');
  assert.equal(partitions.douyin.listenerCount('will-download'), 0);
  assert.equal(partitions.douyin.cookies.listenerCount('changed'), 0);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  pass('All owned windows and temporary session listeners are released');
  report.state = 'passed';
})().catch(error => { report.state = 'failed'; report.error = error.stack; console.error(error); }).finally(async () => {
  browser?.dispose(); await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ state: report.state, checks: report.checks.length, artifacts })); app.exit(report.state === 'passed' ? 0 : 1);
});
