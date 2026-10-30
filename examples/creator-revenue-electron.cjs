'use strict';
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path'), fs = require('node:fs/promises');
const { createCreatorRevenueBrowser, createRevenueLedger, REVENUE_PLATFORMS } = require('../revenue/index.cjs');
const args = process.argv.slice(2), platform = args.shift();
const source = ['anchor_dashboard', 'wallet'].includes(args[0]) ? args.shift() : 'creator_center';
const [fromMonth, toMonth] = args;
if (!REVENUE_PLATFORMS.includes(platform) || (!!fromMonth !== !!toMonth) || args.length > 2 || (source !== 'creator_center' && platform !== 'douyin')) {
  console.error('Usage: electron examples/creator-revenue-electron.cjs <bilibili|douyin|kuaishou|wechat_channels> [anchor_dashboard|wallet] [YYYY-MM YYYY-MM]'); app.exit(1);
} else {
  // Same example application/owner/partition as creator-followers-electron.cjs.
  app.setName('LiveConnect Creator Example');
  app.setPath('userData', path.join(app.getPath('appData'), 'LiveConnect Creator Example'));
  app.on('window-all-closed', () => {});
  let browser;
  app.whenReady().then(async () => {
    const owner = 'example-local-owner';
    browser = createCreatorRevenueBrowser({ BrowserWindow, session, getAccount: () => ({ accountId: owner }) });
    const snapshot = await browser.connect({ owner, platform, source, fromMonth, toMonth });
    const directory = path.join(app.getPath('userData'), 'revenue'); await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, platform + '-' + snapshot.accountId + '.json');
    let state; try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const ledger = createRevenueLedger({ platform, accountId: snapshot.accountId, state }); ledger.ingest(snapshot);
    // Replace only after a full valid snapshot has been merged.
    await fs.writeFile(file + '.tmp', JSON.stringify(ledger.export(), null, 2)); await fs.rename(file + '.tmp', file);
    const series = ledger.series().map(item => ({ ...item, months: ledger.months({ ...item, fromMonth, toMonth }) }));
    const nativeSeries = ledger.nativeSeries().map(item => ({ ...item, months: ledger.nativeMonths({ ...item, fromMonth, toMonth }) }));
    console.log(JSON.stringify({ platform, source, status: snapshot.status, metrics: snapshot.metrics, nativeMetrics: snapshot.nativeMetrics || [],
      issues: snapshot.issues, series, nativeSeries, savedTo: file }, null, 2));
  }).catch(error => { console.error(error.code || 'REVENUE_READ_FAILED'); process.exitCode = 1; })
    .finally(() => { browser?.dispose(); app.exit(process.exitCode || 0); });
}
