'use strict';
// Explicitly run with a platform argument; only the user completes official login.
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const { createCreatorFollowerBrowser } = require('../profiles/index.cjs');
const { PLATFORMS } = require('../profiles/creator-page.cjs');
const platform = process.argv[2];
if (!Object.hasOwn(PLATFORMS, platform)) {
  console.error('Usage: electron examples/creator-followers-electron.cjs <bilibili|douyin|kuaishou|wechat_channels|xiaohongshu>');
  app.exit(1);
} else {
  app.setName('LiveConnect Creator Example');
  app.setPath('userData', path.join(app.getPath('appData'), 'LiveConnect Creator Example'));
  app.on('window-all-closed', () => {});
  let browser;
  app.whenReady().then(async () => {
    const owner = 'example-local-owner';
    browser = createCreatorFollowerBrowser({ BrowserWindow, session, getAccount: () => ({ accountId: owner }) });
    const result = await browser.connect({ owner, platform });
    console.log(JSON.stringify({ platform: result.platform, status: result.status,
      followerCount: result.followerCount, displayCount: result.displayCount, fetchedAt: result.fetchedAt }));
  }).catch(error => { console.error(error.code || 'CREATOR_READ_FAILED'); process.exitCode = 1; })
    .finally(() => { browser?.dispose(); app.exit(process.exitCode || 0); });
}
