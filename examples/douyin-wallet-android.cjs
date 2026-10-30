// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const { createDouyinWalletAndroidReader, createCreatorRevenueSync, createCreatorRevenueFileStore } = require('../revenue/index.cjs');
const args = process.argv.slice(2), options = new Map();
const usage = 'Usage: node examples/douyin-wallet-android.cjs --adb=<absolute SDK adb path> --data=<absolute private data directory> [--inspect|--connect] [--watch] [--device=<device hash>] [--port=5037] [--from=YYYY-MM]';
for (const arg of args) {
  const match = /^--(adb|data|device|port|from)=(.+)$/.exec(arg);
  const key = match?.[1] || (['--inspect', '--connect', '--watch'].includes(arg) ? arg.slice(2) : null);
  if (!key || options.has(key)) { console.error(usage); process.exit(1); }
  options.set(key, match ? match[2] : true);
}
const directory = options.get('data'), adbPath = options.get('adb'), adbPort = Number(options.get('port') || 5037);
if (!directory || !path.isAbsolute(directory) || !adbPath || !path.isAbsolute(adbPath) || !Number.isInteger(adbPort) || adbPort < 1024 || adbPort > 65535 ||
    options.has('device') && !/^[a-f0-9]{64}$/.test(options.get('device')) ||
    options.has('from') && !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(options.get('from')) ||
    options.has('inspect') && (options.has('connect') || options.has('watch'))) {
  console.error(usage); process.exit(1);
}
const owner = 'example-android-local-owner', getAccount = () => ({ accountId: owner });
const reader = createDouyinWalletAndroidReader({ getAccount, adbPath, adbPort, authDirectory: path.join(directory, 'android-auth') });
let sync, keepAlive, stopping = false;
async function stop() {
  if (stopping) return; stopping = true; clearInterval(keepAlive); sync?.dispose(); await reader.dispose();
}
process.on('SIGINT', () => stop().catch(() => {})); process.on('SIGTERM', () => stop().catch(() => {}));
async function main() {
  if (options.has('inspect')) { console.log(JSON.stringify(await reader.inspect({ owner }))); return; }
  const bindingFile = path.join(directory, 'douyin-android-binding.json'); let bound, initialLedger;
  if (options.has('connect')) {
    // Interactive entry opens only the official income bill page. Login, if requested,
    // is completed on the phone by its owner; rerun --connect after that completes.
    const currentMonth = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
    const snapshot = await reader.connect({ owner, deviceId: options.get('device'), openPage: true, fromMonth: currentMonth, toMonth: currentMonth });
    bound = { accountId: snapshot.accountId, identityKind: snapshot.identityKind, deviceId: snapshot.deviceId }; initialLedger = snapshot;
  } else {
    try { bound = JSON.parse(await fs.readFile(bindingFile, 'utf8')); }
    catch { throw Object.assign(new Error(), { code: 'REVENUE_BINDING_REQUIRED' }); }
  }
  if (!bound || !/^[a-f0-9]{64}$/.test(bound.accountId) || bound.identityKind !== 'native_uid' || !/^[a-f0-9]{64}$/.test(bound.deviceId) ||
      options.has('device') && options.get('device') !== bound.deviceId) throw Object.assign(new Error(), { code: 'REVENUE_MOBILE_BINDING_REQUIRED' });
  sync = createCreatorRevenueSync({ owner, platform: 'douyin', accountId: bound.accountId, identityKind: bound.identityKind,
    deviceId: bound.deviceId, getAccount, reader, initialLedger, fromMonth: options.get('from'),
    store: createCreatorRevenueFileStore({ directory: path.join(directory, 'revenue-sync') }),
    onStatus: value => console.log(JSON.stringify(value)) });
  if (stopping) return;
  if (options.has('connect')) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(bindingFile + '.tmp', JSON.stringify(bound), { mode: 0o600 }); await fs.rename(bindingFile + '.tmp', bindingFile);
  }
  if (options.has('watch')) {
    // The library does not keep a host alive; this CLI explicitly owns that lifetime.
    keepAlive = setInterval(() => {}, 3600000); await sync.start();
  } else await sync.syncNow();
  console.log(JSON.stringify({ savedTo: path.join(directory, 'revenue-sync'), liveDeviceValidation: false,
    mode: options.has('watch') ? 'running-until-exit' : 'one-batch' }));
}
main().then(async () => { if (!options.has('watch') || stopping) await stop(); })
  .catch(async error => { console.error(JSON.stringify({ error: error.code || 'REVENUE_MOBILE_SYNC_FAILED' })); process.exitCode = 1; await stop(); });
