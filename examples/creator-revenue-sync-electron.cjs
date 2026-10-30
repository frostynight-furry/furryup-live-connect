'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), { createHash } = require('node:crypto');
const { REVENUE_PLATFORMS, createCreatorRevenueBrowser, createCreatorRevenueSync, createCreatorRevenueFileStore,
  createRevenueLedger, createRevenueFileStore } = require('../revenue/index.cjs');
const args = process.argv.slice(2), selection = args.shift(), watch = args.includes('--watch'), login = args.includes('--login');
const fromArg = args.find(arg => arg.startsWith('--from=')), fromMonth = fromArg?.slice(7);
if (![...REVENUE_PLATFORMS, 'all'].includes(selection) || args.some(arg => !['--watch', '--login'].includes(arg) && !/^--from=20\d{2}-(?:0[1-9]|1[0-2])$/.test(arg))) {
  console.error('Usage: electron examples/creator-revenue-sync-electron.cjs <bilibili|douyin|kuaishou|wechat_channels|all> [--watch] [--login] [--from=YYYY-MM]'); app.exit(1);
} else {
  app.setName('LiveConnect Creator Example'); app.setPath('userData', path.join(app.getPath('appData'), 'LiveConnect Creator Example'));
  if (!app.requestSingleInstanceLock()) app.exit(1);
  else {
    app.on('window-all-closed', () => {});
    const owner = 'example-local-owner', controllers = []; let reader;
    const stop = () => { for (const sync of controllers) sync.dispose(); reader?.dispose(); };
    app.on('before-quit', stop); process.on('SIGINT', () => { stop(); app.quit(); }); process.on('SIGTERM', () => { stop(); app.quit(); });
    const readJson = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
    app.whenReady().then(async () => {
      const root = app.getPath('userData'), directory = path.join(root, 'revenue-sync'); await fs.mkdir(directory, { recursive: true });
      const store = createCreatorRevenueFileStore({ directory });
      reader = createCreatorRevenueBrowser({ BrowserWindow, session, getAccount: () => ({ accountId: owner }) });
      for (const platform of selection === 'all' ? REVENUE_PLATFORMS : [selection]) {
        try {
          const file = path.join(directory, 'binding-' + platform + '.json'); let bound = login ? undefined : await readJson(file);
          if (!bound && !login && platform === 'douyin') bound = await readJson(path.join(root, 'wallet-revenue', 'example-binding.json'));
          if (!bound) {
            const snapshot = await reader.connect({ owner, platform }); bound = { accountId: snapshot.accountId, identityKind: snapshot.identityKind };
          }
          // Validate the binding before it can influence any history-file name.
          const ledger = createRevenueLedger({ platform, accountId: bound.accountId });
          const old = await readJson(path.join(root, 'revenue', platform + '-' + bound.accountId + '.json')); if (old) ledger.ingest(old);
          if (platform === 'douyin') {
            const legacy = await createRevenueFileStore({ directory: path.join(root, 'wallet-revenue') }).load({
              ownerHash: createHash('sha256').update(owner).digest('hex'), accountId: bound.accountId, identityKind: bound.identityKind });
            if (legacy) ledger.ingest(legacy.ledger);
          }
          const sync = createCreatorRevenueSync({ owner, platform, ...bound, reader, store, fromMonth,
            getAccount: () => ({ accountId: owner }), initialLedger: ledger.export(),
            onStatus: status => console.log(JSON.stringify(status)) }); controllers.push(sync);
          await fs.writeFile(file + '.tmp', JSON.stringify({ accountId: bound.accountId, identityKind: bound.identityKind }), { mode: 0o600 }); await fs.rename(file + '.tmp', file);
          if (watch) await sync.start(); else await sync.syncNow();
        } catch (error) { console.error(JSON.stringify({ platform, error: error.code || 'REVENUE_SYNC_FAILED' })); process.exitCode = 1; }
      }
      console.log(JSON.stringify({ savedTo: directory, mode: watch ? 'running-until-exit' : 'one-batch-per-platform', livePlatformValidation: false }));
      if (!watch || !controllers.length) { stop(); app.exit(process.exitCode || 0); }
    }).catch(error => { console.error(error.code || 'REVENUE_SYNC_FAILED'); stop(); app.exit(1); });
  }
}
