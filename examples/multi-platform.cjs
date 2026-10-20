// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { createLiveConnect, createJavaCollector } = require('../core/index.cjs');
const defaultRuntime = require('../scripts/java-runtime.cjs');

const MAX_CONFIG_BYTES = 128 * 1024;
const JAVA_PLATFORMS = new Set(['bilibili', 'douyin', 'kuaishou']);
const STATE_NAMES = new Set(['connecting', 'connected', 'reconnecting', 'failed', 'stopped', 'event-rejected']);
const HELP = 'Send one JSON line through stdin: an array of {platform,roomId,cookie?}, or {connections:[...]}. '
  + 'Keep stdin open while collecting; EOF, Ctrl+C or SIGTERM stops all collectors. '
  + 'Build Java first with npm run build. WeChat requires the separate Electron example: npm run start:wechat. '
  + 'Never pass cookies as command-line arguments or commit configuration files.';

function parseConfiguration(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error('Configuration exceeds 128 KiB.');
  let value;
  try { value = JSON.parse(text.trim()); } catch { throw new Error('Configuration must be valid JSON on one line.'); }
  const wrapped = value && typeof value === 'object' && !Array.isArray(value);
  if (wrapped && Object.keys(value).some(key => key !== 'connections')) throw new Error('Only the connections field is supported.');
  const connections = Array.isArray(value) ? value : wrapped ? value.connections : null;
  if (!Array.isArray(connections) || !connections.length || connections.length > 16)
    throw new Error('Provide between 1 and 16 connections.');
  const seen = new Set();
  return connections.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['platform', 'roomId', 'cookie'].includes(key)))
      throw new Error('Each connection supports only platform, roomId and optional cookie.');
    if (item.platform === 'wechat') throw new Error('WeChat requires Electron; use npm run start:wechat separately.');
    if (!JAVA_PLATFORMS.has(item.platform)) throw new Error('Supported Java platforms: bilibili, douyin, kuaishou.');
    if (typeof item.roomId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.roomId))
      throw new Error('roomId must be a string containing the platform room identifier, not a URL.');
    const cookie = item.cookie === undefined ? '' : item.cookie;
    if (typeof cookie !== 'string' || /[\u0000-\u001f\u007f]/.test(cookie))
      throw new Error('cookie must be a string without control characters.');
    const result = { platform: item.platform, roomId: item.roomId, cookie };
    if (Buffer.byteLength(JSON.stringify(result)) > 32_768) throw new Error('One connection exceeds the collector configuration limit.');
    const key = JSON.stringify([item.platform, item.roomId]);
    if (seen.has(key)) throw new Error('Duplicate platform and roomId connection.');
    seen.add(key);
    return result;
  });
}

// Dependency arguments allow lifecycle tests without starting Java or accessing a
// platform. Normal CLI use always uses the real core collectors above.
function runFromStdin({ input = process.stdin, output = process.stdout, error = process.stderr, signals = process,
  runtime = defaultRuntime, liveFactory = createLiveConnect, collectorFactory = createJavaCollector } = {}) {
  let live, unsubscribe, configured = false, stopping = false;
  let buffer = Buffer.alloc(0);
  const runners = [];
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const write = value => output.write(JSON.stringify(value) + '\n');
  const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => finish(0)]));

  function finish(code, message) {
    if (stopping) return;
    stopping = true;
    input.off('data', onData); input.off('end', onEnd); input.off('error', onInputError);
    for (const [name, handler] of signalHandlers) signals.off(name, handler);
    input.pause(); input.destroy();
    buffer = Buffer.alloc(0);
    if (message) error.write(message + '\n'); // Fixed messages only; never echo input or an exception.
    let cleanupFailed = false;
    try { unsubscribe?.(); } catch { cleanupFailed = true; }
    void (async () => {
      try {
        const results = await Promise.allSettled(runners.map(entry => Promise.resolve().then(() => entry.runner.stop())));
        if (results.some(result => result.status === 'rejected')) cleanupFailed = true;
      } catch { cleanupFailed = true; }
      finally {
        // External producers stop first. Even a rejected stop must not skip
        // closing room sessions, profile lookups and the shared image cache.
        try { live?.close(); } catch { cleanupFailed = true; }
        if (cleanupFailed) { error.write('A collector could not be stopped cleanly.\n'); code = 1; }
        complete(code);
      }
    })();
  }

  function configure(text) {
    let connections;
    try { connections = parseConfiguration(text); } catch (failure) { finish(1, failure.message); return; }
    configured = true;
    try {
      live = liveFactory();
      unsubscribe = live.subscribe(event => {
        if (stopping) return;
        // The subscription receives the full normalized event. Keep the example's
        // terminal output to routing and counts, excluding viewer data and URLs.
        write({ kind: 'event', schemaVersion: event.schemaVersion, platform: event.platform,
          roomId: event.room_id, type: event.event_type, count: event.count, countMode: event.count_mode,
          ...(event.event_type === 'gift' && { giftCount: event.gift_count }) });
      });
      // Construct every collector before starting any. Invalid configuration or
      // construction failure therefore cannot leave a partially launched group.
      for (const connection of connections) {
        const { platform, roomId, cookie } = connection;
        const room = live.openRoom({ platform, roomId, kuaishouCookie: platform === 'kuaishou' ? cookie : '' });
        const entry = { runner: null, terminal: false };
        entry.runner = collectorFactory({ room, java: runtime.java, classpath: runtime.classpath, cwd: runtime.root, cookie,
          onState: state => {
            if (stopping) return;
            write({ kind: 'collector-state', platform, roomId,
              state: STATE_NAMES.has(state.state) ? state.state : 'unknown',
              ...(typeof state.code === 'string' && /^[A-Z_]{1,40}$/.test(state.code) && { code: state.code }),
              ...(Number.isSafeInteger(state.retries) && { retries: state.retries }),
              ...(Number.isSafeInteger(state.retryLimit) && { retryLimit: state.retryLimit }) });
            if (state.state === 'stopped') {
              entry.terminal = true;
              if (runners.every(item => item.terminal)) finish(1, 'All collectors stopped. Check the reported status codes before reconnecting.');
            }
          } });
        runners.push(entry);
      }
      for (const entry of runners) { if (!stopping) entry.runner.start(); }
    } catch { finish(1, 'Unable to start the collector group. Check the Java build and configuration.'); }
    finally { for (const connection of connections) connection.cookie = ''; }
  }

  function onData(chunk) {
    if (stopping) return;
    if (configured) {
      if (String(chunk).trim()) finish(1, 'Only one configuration line is accepted; reconnect to change connections.');
      return;
    }
    const bytes = Buffer.from(chunk);
    if (buffer.length + bytes.length > MAX_CONFIG_BYTES + 2) { finish(1, 'Configuration exceeds 128 KiB.'); return; }
    buffer = Buffer.concat([buffer, bytes]);
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline)); }
    catch { finish(1, 'Configuration must use UTF-8.'); return; }
    if (buffer.subarray(newline + 1).toString('utf8').trim()) {
      finish(1, 'Only one configuration line is accepted; reconnect to change connections.'); return;
    }
    buffer = Buffer.alloc(0);
    configure(text);
  }
  function onEnd() {
    finish(configured ? 0 : 1, configured ? undefined : 'No configuration line received. Send one JSON line and keep stdin open.');
  }
  function onInputError() { finish(1, 'Unable to read configuration from stdin.'); }

  error.write(HELP + '\n');
  input.on('data', onData); input.once('end', onEnd); input.once('error', onInputError);
  for (const [name, handler] of signalHandlers) signals.once(name, handler);
  return done;
}

if (require.main === module) {
  if (process.argv.length > 2) {
    console.error(HELP);
    process.exitCode = process.argv.length === 3 && process.argv[2] === '--help' ? 0 : 1;
  } else {
    void runFromStdin().then(code => { process.exitCode = code; }).catch(() => {
      console.error('The example stopped unexpectedly.'); process.exitCode = 1;
    });
  }
}
module.exports = { parseConfiguration, runFromStdin };
