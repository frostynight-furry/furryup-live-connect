// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const { createLiveConnect, createJavaCollector } = require('../core/index.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await wait(5); }
  assert.fail('Expected process state');
}
function fakeChild({ graceful = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.input = ''; child.kills = 0;
  child.stdin = new Writable({ write(chunk, _encoding, next) { child.input += chunk.toString(); next(); } });
  child.send = message => child.stdout.write(JSON.stringify(message) + '\n');
  child.finish = () => { if (child.closed) return; child.closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', 0); };
  child.stdin.on('finish', () => { if (graceful) queueMicrotask(child.finish); });
  child.kill = () => { child.kills++; queueMicrotask(child.finish); return true; };
  return child;
}
function setup(t, options = {}) {
  const hub = createLiveConnect(), room = hub.openRoom({ platform: 'bilibili', roomId: 'synthetic-room' });
  const children = [], states = [], args = [];
  const runner = createJavaCollector({ room, classpath: 'synthetic-classpath', cookie: 'synthetic-secret',
    retryDelays: [1, 1], connectTimeoutMs: 200, stopTimeoutMs: 10,
    spawnProcess: (...values) => { args.push(values); const child = fakeChild(); children.push(child); return child; },
    onState: state => states.push(state), ...options });
  t.after(async () => { await runner.stop(); hub.close(); });
  return { hub, room, runner, children, states, args };
}

test('Java runner confines credentials to stdin and passes only validated events', async t => {
  const { runner, children, states, args, room } = setup(t);
  runner.start(); const child = children[0];
  assert.equal(args[0][2].windowsHide, true); assert.equal(args[0][2].shell, false);
  assert.doesNotMatch(JSON.stringify(args), /synthetic-secret/);
  assert.equal(JSON.parse(child.input).cookie, 'synthetic-secret');
  child.send({ kind: 'status', state: 'connected' });
  child.send({ kind: 'event', event: { event_type: 'comment', source_msg_id: 'first', content: 'fixture' } });
  child.send({ kind: 'event', event: { event_type: 'comment', source_msg_id: 'first', content: 'fixture' } });
  child.send({ kind: 'event', event: { event_type: 'unsupported' } });
  child.send({ kind: 'diagnostic', metric: 'synthetic-secret' });
  child.stderr.write('synthetic-secret upstream log');
  assert.equal(room.history().length, 1);
  assert.ok(states.some(state => state.state === 'event-rejected'));
  assert.doesNotMatch(JSON.stringify(states), /synthetic-secret/);
  await runner.stop(); assert.equal(child.closed, true);
  assert.throws(() => runner.start(), /single-use/);
});

test('reconnects consume a finite budget and wait for previous process close', async t => {
  const { runner, children, states } = setup(t);
  runner.start();
  children[0].send({ kind: 'status', state: 'connect-failed', code: 'NETWORK_UNREACHABLE' });
  assert.equal(children.length, 1);
  await until(() => children.length === 2);
  assert.equal(children[0].closed, true);
  children[1].finish(); await until(() => children.length === 3);
  children[2].finish(); await wait(15);
  assert.equal(children.length, 3);
  assert.ok(states.some(state => state.state === 'stopped' && state.retries === 2));
});

test('login, challenge, rate limit, offline and incompatible protocol failures require manual action', async t => {
  for (const code of ['LOGIN_REQUIRED', 'VERIFICATION_REQUIRED', 'RATE_LIMITED', 'ROOM_OFFLINE', 'NO_LIVE_SESSION', 'PROTOCOL_CHANGED']) {
    const { runner, children, states } = setup(t);
    runner.start();
    // A later classified callback takes priority over the SDK's generic status.
    children[0].send({ kind: 'status', state: 'connect_failed' });
    children[0].send({ kind: 'status', state: 'connect-failed', code });
    await wait(10);
    assert.equal(children.length, 1); assert.ok(states.some(state => state.state === 'stopped' && state.code === code));
  }
});

test('stop cancels reconnect timers and kills a child that ignores stdin EOF', async t => {
  const first = setup(t, { retryDelays: [50] });
  first.runner.start(); first.children[0].finish(); await first.runner.stop(); await wait(60);
  assert.equal(first.children.length, 1);
  const child = fakeChild({ graceful: false });
  const second = setup(t, { spawnProcess: () => child });
  second.runner.start(); await second.runner.stop();
  assert.equal(child.kills, 1); assert.equal(child.closed, true);
});

test('connection timeout and bounded output prevent unlimited buffering or retries', async t => {
  const timeout = setup(t, { connectTimeoutMs: 10, retryDelays: [] });
  timeout.runner.start(); await until(() => timeout.children[0].closed);
  assert.ok(timeout.states.some(state => state.code === 'NETWORK_TIMEOUT'));
  const oversized = setup(t);
  oversized.runner.start(); oversized.children[0].stdout.write(Buffer.alloc(256 * 1024 + 1, 65));
  await wait(15); assert.equal(oversized.children.length, 1);
  assert.ok(oversized.states.some(state => state.code === 'INVALID_OUTPUT'));
});

test('real subprocess pipes deliver UTF-8 events and close cleanly without credentials in argv', async t => {
  const hub = createLiveConnect(), room = hub.openRoom({ platform: 'bilibili', roomId: 'synthetic-room' });
  const childSource = `process.stdin.setEncoding('utf8'); let input=''; process.stdin.on('data', chunk => {
    input += chunk; if (!input.includes('\\n')) return;
    const config=JSON.parse(input.split('\\n')[0]);
    process.stdout.write(JSON.stringify({kind:'status',state:'connected'})+'\\n');
    process.stdout.write(JSON.stringify({kind:'event',event:{event_type:'comment',source_msg_id:'synthetic',content:'合成测试'}})+'\\n');
  }); process.stdin.on('end',()=>process.exit(0));`;
  const runner = createJavaCollector({ room, classpath: 'synthetic-classpath', retryDelays: [],
    spawnProcess: (_java, args, options) => {
      assert.deepEqual(args, ['-cp', 'synthetic-classpath', 'local.furryup.Collector']);
      return spawn(process.execPath, ['-e', childSource], options);
    } });
  t.after(async () => { await runner.stop(); hub.close(); });
  runner.start(); await until(() => room.history().length === 1);
  assert.equal(room.history()[0].content, '合成测试'); await runner.stop();
});

test('synchronous cancellation inside status callbacks cannot spawn or schedule another child', async t => {
  let firstRunner;
  const first = setup(t, { onState: state => { if (state.state === 'connecting') void firstRunner.stop(); } });
  firstRunner = first.runner; firstRunner.start();
  assert.equal(first.children.length, 0); await firstRunner.stop();
  let secondRunner;
  const second = setup(t, { onState: state => { if (state.state === 'reconnecting') void secondRunner.stop(); } });
  secondRunner = second.runner; secondRunner.start(); second.children[0].finish();
  await secondRunner.stop(); await wait(10);
  assert.equal(second.children.length, 1);
});
