// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { spawn } = require('node:child_process');

const CODES = new Set(['LOCAL_NETWORK_INIT', 'RATE_LIMITED', 'VERIFICATION_REQUIRED', 'LOGIN_REQUIRED',
  'NETWORK_TIMEOUT', 'NETWORK_UNREACHABLE', 'TLS_ERROR', 'NO_LIVE_SESSION', 'ROOM_OFFLINE',
  'PROTOCOL_CHANGED', 'CONNECT_FAILED', 'PROCESS_START', 'PROCESS_EXIT', 'INVALID_OUTPUT']);
const MANUAL = new Set(['RATE_LIMITED', 'VERIFICATION_REQUIRED', 'LOGIN_REQUIRED', 'NO_LIVE_SESSION',
  'ROOM_OFFLINE', 'PROTOCOL_CHANGED', 'TLS_ERROR', 'LOCAL_NETWORK_INIT', 'PROCESS_START', 'INVALID_OUTPUT']);

/** Owns one Java subprocess and a finite reconnect budget. Credentials use stdin only. */
function createJavaCollector({ room, java = 'java', classpath, cwd, cookie = '',
  retryDelays = [3000, 6000], connectTimeoutMs = 45_000, stopTimeoutMs = 2000,
  onState = () => {}, spawnProcess = spawn } = {}) {
  if (!room || !['bilibili', 'douyin', 'kuaishou'].includes(room.platform) || typeof room.ingest !== 'function' ||
    typeof room.roomId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(room.roomId)) throw new TypeError('A supported room session is required');
  if (typeof java !== 'string' || !java || typeof classpath !== 'string' || !classpath ||
    typeof cookie !== 'string' || /[\r\n]/.test(cookie) || typeof onState !== 'function' || typeof spawnProcess !== 'function')
    throw new TypeError('Invalid Java collector options');
  if (!Array.isArray(retryDelays) || retryDelays.length > 5 || retryDelays.some(ms => !Number.isSafeInteger(ms) || ms < 0 || ms > 60_000))
    throw new TypeError('Invalid retry budget');
  for (const time of [connectTimeoutMs, stopTimeoutMs]) if (!Number.isSafeInteger(time) || time < 1 || time > 120_000)
    throw new TypeError('Invalid process timeout');
  let config = JSON.stringify({ platform: room.platform, roomId: room.roomId, cookie });
  if (Buffer.byteLength(config) > 32_768) throw new TypeError('Collector configuration is too large');
  cookie = '';
  const delays = retryDelays.slice();
  let started = false, stopped = false, current = null, retryTimer = null, retries = 0, stopping;
  const report = (state, code) => {
    try { onState(Object.freeze({ state, ...(code && { code }), retries, retryLimit: delays.length })); }
    catch { /* Observers cannot interrupt process cleanup. */ }
  };
  function endProcess(run) {
    if (run.ending) return;
    run.ending = true;
    run.killTimer = setTimeout(() => {
      try { run.child.kill('SIGKILL'); } catch { /* Already exited. */ }
      // OS termination can fail. Do not spawn another collector until close confirms exit.
    }, stopTimeoutMs);
    try { run.child.stdin.end(); } catch { try { run.child.kill('SIGKILL'); } catch {} }
  }
  function failed(run, code) {
    if (stopped || current !== run || run.failed) return;
    run.failed = true; run.code = CODES.has(code) ? code : 'CONNECT_FAILED';
    clearTimeout(run.connectTimer); clearTimeout(run.failureTimer);
    report('failed', run.code); endProcess(run);
  }
  function finished(run) {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.connectTimer); clearTimeout(run.failureTimer); clearTimeout(run.killTimer);
    run.resolveClosed();
    if (current !== run) return;
    current = null;
    if (stopped) return;
    const code = run.code || 'PROCESS_EXIT';
    if (MANUAL.has(code) || retries >= delays.length) { report('stopped', code); config = ''; return; }
    const delay = delays[retries++];
    report('reconnecting', code);
    if (stopped || current) return;
    retryTimer = setTimeout(() => { retryTimer = null; launch(); }, delay);
  }
  function line(run, text) {
    if (stopped || current !== run || run.failed) return;
    let message;
    try { message = JSON.parse(text); } catch { failed(run, 'INVALID_OUTPUT'); return; }
    if (message?.kind === 'event') {
      try { room.ingest(message.event); }
      catch { report('event-rejected'); }
    } else if (message?.kind === 'status') {
      if (message.state === 'connected') {
        clearTimeout(run.connectTimer); clearTimeout(run.failureTimer); run.failureTimer = null; report('connected');
      } else if (['connect_failed', 'connect-failed', 'disconnected', 'reconnecting'].includes(message.state)) {
        if (CODES.has(message.code)) failed(run, message.code);
        // The SDK emits a generic status immediately before the classified error callback.
        else if (!run.failureTimer) run.failureTimer = setTimeout(() => failed(run, 'CONNECT_FAILED'), 75);
      } else if (['invalid-room', 'invalid-platform'].includes(message.state)) failed(run, 'PROTOCOL_CHANGED');
    }
    // Room-info and diagnostics are intentionally not presented as interaction events.
  }
  function launch() {
    if (stopped || current) return;
    report('connecting');
    if (stopped || current) return;
    let child;
    try { child = spawnProcess(java, ['-cp', classpath, 'local.furryup.Collector'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false
    }); } catch { report('stopped', 'PROCESS_START'); config = ''; return; }
    const run = { child, buffer: Buffer.alloc(0), failed: false, finished: false };
    run.closed = new Promise(resolve => { run.resolveClosed = resolve; });
    current = run;
    run.connectTimer = setTimeout(() => failed(run, 'NETWORK_TIMEOUT'), connectTimeoutMs);
    child.stdout.on('data', chunk => {
      if (stopped || run.failed || current !== run) return;
      run.buffer = Buffer.concat([run.buffer, Buffer.from(chunk)]);
      for (;;) {
        const index = run.buffer.indexOf(10);
        if (index < 0) break;
        if (index > 256 * 1024) { failed(run, 'INVALID_OUTPUT'); return; }
        const text = run.buffer.subarray(0, index).toString('utf8').trim();
        run.buffer = run.buffer.subarray(index + 1);
        if (text) line(run, text);
        if (run.failed) return;
      }
      if (run.buffer.length > 256 * 1024) failed(run, 'INVALID_OUTPUT');
    });
    child.stderr.resume(); // Never forward upstream log text, cookies or signed URLs.
    child.stdin.on('error', () => failed(run, 'PROCESS_EXIT'));
    child.on('error', () => failed(run, 'PROCESS_START'));
    child.on('close', () => finished(run));
    try { child.stdin.write(config + '\n'); } catch { failed(run, 'PROCESS_START'); }
  }
  return Object.freeze({
    start() {
      if (started || stopped) throw new Error('Collector instances are single-use');
      started = true; launch();
    },
    stop() {
      if (stopping) return stopping;
      stopped = true; config = ''; clearTimeout(retryTimer); retryTimer = null;
      const run = current;
      stopping = (async () => {
        if (run) {
          clearTimeout(run.connectTimer); clearTimeout(run.failureTimer); endProcess(run);
          await run.closed;
        }
        report('stopped');
      })();
      return stopping;
    }
  });
}

module.exports = { createJavaCollector };
