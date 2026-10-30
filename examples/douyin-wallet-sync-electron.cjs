'use strict';
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path'), fs = require('node:fs/promises');
const { createCreatorRevenueBrowser, createDouyinWalletSync, createRevenueFileStore } = require('../revenue/index.cjs');
const args = process.argv.slice(2), watch = args.includes('--watch'), rebind = args.includes('--login');
if (args.some(arg => !['--watch', '--login'].includes(arg))) {
  console.error('Usage: electron examples/douyin-wallet-sync-electron.cjs [--watch] [--login]'); app.exit(1);
} else {
  app.setName('LiveConnect Creator Example');
  app.setPath('userData', path.join(app.getPath('appData'), 'LiveConnect Creator Example'));
  // One example process owns the checkpoint directory. Production hosts should
  // likewise coordinate writers across processes and stop on account logout.
  if (!app.requestSingleInstanceLock()) app.exit(1);
  else {
    app.on('window-all-closed', () => {});
    const owner = 'example-local-owner'; let reader, sync;
    const stop = () => { sync?.dispose(); reader?.dispose(); };
    app.on('before-quit', stop); process.on('SIGINT', () => { stop(); app.quit(); }); process.on('SIGTERM', () => { stop(); app.quit(); });
    app.whenReady().then(async () => {
      const directory = path.join(app.getPath('userData'), 'wallet-revenue'), file = path.join(directory, 'example-binding.json');
      reader = createCreatorRevenueBrowser({ BrowserWindow, session, getAccount: () => ({ accountId: owner }) });
      let bound;
      if (!rebind) try { bound = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!bound) {
        // Bind through the ordinary creator login first. The wallet may require
        // a separate native app session; failure below leaves existing bills intact.
        const result = await reader.connect({ owner, platform: 'douyin' });
        bound = { accountId: result.accountId, identityKind: result.identityKind };
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(file + '.tmp', JSON.stringify(bound), { mode: 0o600 }); await fs.rename(file + '.tmp', file);
      }
      sync = createDouyinWalletSync({ owner, ...bound, getAccount: () => ({ accountId: owner }), reader,
        store: createRevenueFileStore({ directory }), onStatus: status => {
          console.log(JSON.stringify(status));
          if (status.state === 'needs_login') console.error('Wallet login is required. Use --login to refresh creator login; if it still fails, native wallet authentication is not yet supported.');
        } });
      if (watch) await sync.start(); else await sync.syncNow();
      console.log(JSON.stringify({ savedTo: directory, mode: watch ? 'running-until-exit' : 'one-batch', livePlatformValidation: false }));
      if (!watch) { stop(); app.quit(); }
    }).catch(error => { console.error(error.code || 'REVENUE_SYNC_FAILED'); stop(); app.exit(1); });
  }
}
