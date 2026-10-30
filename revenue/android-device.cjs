// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const { createHash } = require('node:crypto'), path = require('node:path');
const fs = require('node:fs/promises');
const { fault } = require('./model.cjs');
const { MOBILE_WALLET_PAGE } = require('./douyin-wallet.cjs');
const packages = { douyin: 'com.ss.android.ugc.aweme', wechat_channels: 'com.tencent.mm' };
const digest = value => createHash('sha256').update(value).digest('hex');
function walletPage(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
    u.hostname === 'webcast.amemv.com' && u.pathname === '/falcon/webcast_douyin/page/wallet/bill/index.html' && u.searchParams.get('bill_type') === 'income'; }
  catch { return false; }
}
async function jsonAt(port, fetchImpl) {
  const response = await fetchImpl('http://127.0.0.1:' + port + '/json/list', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw fault('REVENUE_MOBILE_WEBVIEW_UNAVAILABLE');
  let size = 0, text = ''; const reader = response.body.getReader(), decoder = new TextDecoder();
  while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw fault('REVENUE_RESPONSE_TOO_LARGE'); } text += decoder.decode(chunk.value, { stream: true }); }
  text += decoder.decode(); const result = JSON.parse(text);
  if (!Array.isArray(result) || result.length > 100) throw fault('REVENUE_MOBILE_WEBVIEW_UNAVAILABLE'); return result;
}
async function connectCdp(url, { WebSocketImpl, timeoutMs }) {
  const ws = new WebSocketImpl(url), calls = new Map(); let id = 0, revision = 0, closed = false;
  const close = () => { if (closed) return; closed = true; for (const entry of calls.values()) { clearTimeout(entry.timer); entry.reject(fault('REVENUE_MOBILE_DISCONNECTED')); } calls.clear(); ws.close(); };
  ws.addEventListener('close', close); ws.addEventListener('error', close);
  ws.addEventListener('message', event => {
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 3 * 1024 * 1024) return close();
    let message; try { message = JSON.parse(event.data); } catch { return close(); }
    if ((message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) || message.method === 'Inspector.targetCrashed') revision++;
    const entry = calls.get(message.id); if (!entry) return; clearTimeout(entry.timer); calls.delete(message.id);
    if (message.error) entry.reject(fault('REVENUE_MOBILE_WEBVIEW_UNAVAILABLE')); else entry.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { close(); reject(fault('REVENUE_REQUEST_TIMEOUT')); }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(fault('REVENUE_MOBILE_DISCONNECTED')); }, { once: true });
    ws.addEventListener('close', () => { clearTimeout(timer); reject(fault('REVENUE_MOBILE_DISCONNECTED')); }, { once: true });
  });
  function call(method, params = {}) {
    if (closed) return Promise.reject(fault('REVENUE_MOBILE_DISCONNECTED'));
    return new Promise((resolve, reject) => {
      const current = ++id, timer = setTimeout(() => { calls.delete(current); reject(fault('REVENUE_REQUEST_TIMEOUT')); close(); }, timeoutMs);
      calls.set(current, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ id: current, method, params })); } catch { close(); }
    });
  }
  try { await call('Page.enable'); } catch (error) { close(); throw error; }
  return { call, close, revision: () => revision };
}
// Internal bounded device transport. No root, package patching, cookie export,
// external debugging socket, arbitrary shell command or permission modification.
function createAndroidRevenueDevice({ adbPath, authDirectory, adbPort = 5037, commandTimeoutMs = 10000,
  execute = promisify(execFile), fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
  if (typeof adbPath !== 'string' || !path.isAbsolute(adbPath) || typeof authDirectory !== 'string' || !path.isAbsolute(authDirectory) ||
    !Number.isInteger(adbPort) || adbPort < 1024 || adbPort > 65535 || !Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1000 || commandTimeoutMs > 30000) throw new TypeError('An absolute SDK adb path and private auth directory are required');
  const env = { ...process.env, ANDROID_USER_HOME: authDirectory, ANDROID_SDK_HOME: path.dirname(authDirectory), ADB_MDNS_AUTO_CONNECT: '0' };
  const run = async args => {
    try { await fs.mkdir(authDirectory, { recursive: true, mode: 0o700 });
      return (await execute(adbPath, ['-P', String(adbPort), ...args], { env, windowsHide: true, timeout: commandTimeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' })).stdout; }
    catch { throw fault('REVENUE_MOBILE_DEVICE_UNAVAILABLE'); }
  };
  async function devices() {
    const text = await run(['devices', '-l']);
    return text.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts =>
      /^[A-Za-z0-9_.-]{1,100}$/.test(parts[0]) && !parts[0].includes('_adb-tls') && ['device', 'offline', 'unauthorized'].includes(parts[1]))
      .map(parts => ({ serial: parts[0], deviceId: digest(parts[0]), status: parts[1], model: parts.find(p => p.startsWith('model:'))?.slice(6) || 'Android' }));
  }
  async function select(deviceId) {
    if (deviceId !== undefined && !/^[a-f0-9]{64}$/.test(deviceId)) throw fault('REVENUE_MOBILE_BINDING_REQUIRED');
    const found = (await devices()).filter(d => !deviceId || d.deviceId === deviceId);
    if (found.length > 1) throw fault('REVENUE_MOBILE_DEVICE_AMBIGUOUS');
    if (!found.length) throw fault('REVENUE_MOBILE_DEVICE_UNAVAILABLE');
    if (found[0].status === 'unauthorized') throw fault('REVENUE_MOBILE_AUTHORIZATION_REQUIRED');
    if (found[0].status !== 'device') throw fault('REVENUE_MOBILE_DEVICE_UNAVAILABLE'); return found[0];
  }
  async function processes(device, platform) {
    const text = await run(['-s', device.serial, 'shell', 'ps', '-A', '-o', 'PID,NAME']);
    return text.split(/\r?\n/).map(s => s.trim().split(/\s+/)).filter(p => /^\d{1,10}$/.test(p[0]) && (p[1] === packages[platform] || p[1]?.startsWith(packages[platform] + ':'))).map(p => p[0]);
  }
  return {
    async inspect() { return (await devices()).map(({ serial, ...item }) => item); },
    async openDouyinWallet(deviceId) {
      const device = await select(deviceId), uri = 'sslocal://webcast_webview?hide_nav_bar=1&url=' + encodeURIComponent(MOBILE_WALLET_PAGE);
      // adb shell is a remote shell: this fixed URI is explicitly single-quoted.
      await run(['-s', device.serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', "'" + uri + "'", packages.douyin]);
      return device.deviceId;
    },
    async attachWallet(deviceId) {
      const device = await select(deviceId), pids = new Set(await processes(device, 'douyin'));
      const sockets = (await run(['-s', device.serial, 'shell', 'cat', '/proc/net/unix'])).split(/\r?\n/)
        .map(line => line.match(/@(webview_devtools_remote_(\d+))$/)).filter(m => m && pids.has(m[2])).map(m => m[1]);
      if (!sockets.length || sockets.length > 8) throw fault('REVENUE_MOBILE_WEBVIEW_UNAVAILABLE');
      const held = new Set(); let chosen, cdp;
      const remove = async port => { await run(['-s', device.serial, 'forward', '--remove', 'tcp:' + port]).catch(() => {}); held.delete(port); };
      try {
        for (const socket of new Set(sockets)) {
          const port = (await run(['-s', device.serial, 'forward', 'tcp:0', 'localabstract:' + socket])).trim();
          if (!/^\d{4,5}$/.test(port) || Number(port) > 65535 || Number(port) < 1024) throw fault('REVENUE_MOBILE_WEBVIEW_UNAVAILABLE'); held.add(port);
          const targets = (await jsonAt(port, fetchImpl)).filter(t => t.type === 'page' && walletPage(t.url));
          if (targets.length > 1 || targets.length && chosen) throw fault('REVENUE_MOBILE_PAGE_AMBIGUOUS');
          if (!targets.length) { await remove(port); continue; }
          const ws = new URL(targets[0].webSocketDebuggerUrl);
          if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' && ws.hostname !== 'localhost' || ws.port !== port || ws.username || ws.password || ws.search || ws.hash || !/^\/devtools\/page\/[A-Za-z0-9_.-]{1,200}$/.test(ws.pathname)) throw fault('UNTRUSTED_PAGE');
          ws.hostname = '127.0.0.1'; chosen = { port, socket, url: ws.href };
        }
        if (!chosen) throw fault('REVENUE_MOBILE_PAGE_REQUIRED');
        cdp = await connectCdp(chosen.url, { WebSocketImpl, timeoutMs: commandTimeoutMs });
        const baseline = cdp.revision(); let closed = false;
        const guard = async () => {
          if (closed || cdp.revision() !== baseline) throw fault('PAGE_CHANGED');
          await select(device.deviceId);
          const frame = (await cdp.call('Page.getFrameTree'))?.frameTree?.frame;
          if (!frame || !walletPage(frame.url) || cdp.revision() !== baseline) throw fault('UNTRUSTED_PAGE');
        };
        await guard();
        return { deviceId: device.deviceId, guard,
          async evaluate(expression) {
            await guard(); const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            await guard(); if (result.exceptionDetails || !result.result || !Object.hasOwn(result.result, 'value')) throw fault('REVENUE_MOBILE_BRIDGE_UNAVAILABLE'); return result.result.value;
          },
          async close() { closed = true; cdp.close(); for (const port of [...held]) await remove(port); }
        };
      } catch (error) { cdp?.close(); for (const port of [...held]) await remove(port); throw error; }
    }
  };
}
module.exports = { createAndroidRevenueDevice, walletPage };
