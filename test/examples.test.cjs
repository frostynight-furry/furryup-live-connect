// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { createLiveConnect } = require('../core/index.cjs');
const { parseConfiguration, runFromStdin } = require('../examples/multi-platform.cjs');
const root = path.resolve(__dirname, '..');
const platforms = ['bilibili', 'douyin', 'kuaishou'];
const connections = () => platforms.map(platform => ({ platform, roomId: 'synthetic-room', cookie: 'synthetic-secret' }));

test('offline demo normalizes four synthetic platforms and deduplicates gift deltas without network or Java', () => {
  const source = `
    const forbidden = () => { throw new Error('Offline example attempted network or a subprocess'); };
    globalThis.fetch = forbidden;
    for (const module of ['node:http','node:https']) {
      require(module).request = forbidden; require(module).get = forbidden;
    }
    require('node:net').connect = forbidden; require('node:net').createConnection = forbidden;
    require('node:tls').connect = forbidden;
    for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) require('node:child_process')[method] = forbidden;
    require('./examples/offline-demo.cjs').runDemo();
  `;
  const result = spawnSync(process.execPath, ['-e', source], { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.every(row => row.demo === true && row.source === 'synthetic'));
  const events = rows.filter(row => row.kind === 'event'), summary = rows.at(-1);
  assert.equal(events.length, 12);
  assert.equal(new Set(events.map(event => event.platform)).size, 4);
  assert.equal(summary.acceptedEvents, 12); assert.equal(summary.ignoredDuplicates, 4);
  assert.equal(summary.giftEvents, 8);
  assert.deepEqual(summary.giftTotals, { bilibili: 5, douyin: 5, kuaishou: 5, wechat: 5 });
  assert.ok(events.filter(event => event.type === 'gift').every(event => event.countMode === 'delta'));
  const direct = spawnSync(process.execPath, ['examples/offline-demo.cjs'], { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(direct.status, 0, direct.stderr); assert.match(direct.stdout, /OFFLINE DEMO/);
});

test('multi-platform accepts array or connections wrapper and rejects unsupported or unsafe input without echoing it', () => {
  assert.deepEqual(parseConfiguration(JSON.stringify(connections())), connections());
  assert.deepEqual(parseConfiguration(JSON.stringify({ connections: connections() })), connections());
  assert.equal(parseConfiguration('[{"platform":"bilibili","roomId":"12345"}]')[0].cookie, '');
  for (const value of [[], null, {}, { connections: connections(), extra: true }, [...connections(), connections()[0]],
    [{ platform: 'bilibili', roomId: 12345 }], [{ platform: 'douyin', roomId: 'https://example.com/room' }],
    [{ platform: 'unknown', roomId: 'synthetic' }], [{ platform: 'bilibili', roomId: 'synthetic', cookie: '\nsecret' }],
    [{ platform: 'bilibili', roomId: 'synthetic', cookie: 42 }], [{ platform: 'bilibili', roomId: 'synthetic', cookie: 'x'.repeat(33_000) }],
    Array.from({ length: 17 }, (_, i) => ({ platform: 'bilibili', roomId: String(i) }))]) {
    assert.throws(() => parseConfiguration(JSON.stringify(value)));
  }
  assert.throws(() => parseConfiguration('[{"platform":"wechat","roomId":"synthetic"}]'), /Electron/);
  assert.throws(() => parseConfiguration('{"connections":"synthetic-secret"'), error => !error.message.includes('synthetic-secret'));
});

function session(t, override = {}) {
  const input = new PassThrough(), signals = new EventEmitter();
  const output = [], errors = [], created = [], lifecycle = [];
  let live;
  const done = runFromStdin({ input, signals,
    output: { write: value => output.push(value) }, error: { write: value => errors.push(value) },
    runtime: { java: 'synthetic-java', classpath: 'synthetic-classpath', root: root },
    liveFactory: () => {
      live = createLiveConnect({ profileOptions: { fetchImpl: async () => { throw new Error('Offline profile fixture'); } } });
      const close = live.close.bind(live);
      live.close = () => { lifecycle.push('close'); close(); };
      return live;
    },
    collectorFactory: options => {
      const record = { options, starts: 0, stops: 0 }; created.push(record);
      return {
        start() {
          record.starts++;
          options.onState({ state: 'connected', retries: 0, retryLimit: 2 });
          options.room.ingest({ event_type: 'comment', source_msg_id: 'synthetic-message',
            user_id: 'synthetic-viewer', content: 'synthetic-private-content' });
        },
        async stop() {
          assert.equal(live.closed, false, 'The event hub must stay open until its producers stop');
          lifecycle.push(`stop:${options.room.platform}`); record.stops++;
        }
      };
    }, ...override });
  t.after(async () => { signals.emit('SIGTERM'); input.destroy(); await done; });
  return { input, signals, done, output, errors, created, lifecycle, get live() { return live; } };
}

test('three real-core sessions start together, receive routed events and clean up all runners on EOF', async t => {
  const run = session(t);
  const config = Buffer.from(JSON.stringify({ connections: connections() }) + '\n');
  run.input.write(config.subarray(0, 7)); assert.equal(run.created.length, 0);
  run.input.write(config.subarray(7));
  assert.equal(run.created.length, 3);
  assert.ok(run.created.every(item => item.starts === 1 && item.stops === 0));
  assert.ok(run.created.every(item => item.options.cookie === 'synthetic-secret'));
  const events = run.output.map(line => JSON.parse(line)).filter(row => row.kind === 'event');
  assert.deepEqual(events.map(event => event.platform), platforms);
  assert.doesNotMatch(run.output.join('') + run.errors.join(''), /synthetic-secret|synthetic-private-content|synthetic-viewer/);
  run.input.end(); assert.equal(await run.done, 0);
  assert.ok(run.created.every(item => item.stops === 1)); assert.equal(run.live.closed, true);
  assert.deepEqual(run.lifecycle, [...platforms.map(platform => `stop:${platform}`), 'close']);
  assert.equal(run.signals.listenerCount('SIGINT'), 0); assert.equal(run.signals.listenerCount('SIGTERM'), 0);
});

test('invalid whole-group configuration starts no collector and cannot expose credentials in errors', async t => {
  const run = session(t);
  run.input.write(JSON.stringify([...connections(), { platform: 'wechat', roomId: 'synthetic', cookie: 'synthetic-secret' }]) + '\n');
  assert.equal(await run.done, 1); assert.equal(run.created.length, 0);
  assert.match(run.errors.join(''), /Electron/); assert.doesNotMatch(run.errors.join(''), /synthetic-secret/);
});

test('startup failure rolls back constructed collectors before any starts and suppresses exception text', async t => {
  let creates = 0, stops = 0, starts = 0;
  const run = session(t, { collectorFactory: () => {
    if (++creates === 2) throw new Error('synthetic-secret');
    return { start() { starts++; }, async stop() { stops++; } };
  } });
  run.input.write(JSON.stringify(connections()) + '\n');
  assert.equal(await run.done, 1); assert.equal(starts, 0); assert.equal(stops, 1);
  assert.equal(run.live.closed, true); assert.doesNotMatch(run.errors.join(''), /synthetic-secret/);
});

test('signals stop every collector once; configuration cannot be replaced while running', async t => {
  const first = session(t);
  first.input.write(JSON.stringify(connections()) + '\n');
  first.signals.emit('SIGINT'); first.signals.emit('SIGTERM');
  assert.equal(await first.done, 0); assert.ok(first.created.every(item => item.stops === 1));
  const second = session(t);
  second.input.write(JSON.stringify(connections()) + '\n');
  second.input.write('synthetic-secret');
  assert.equal(await second.done, 1); assert.ok(second.created.every(item => item.stops === 1));
  assert.doesNotMatch(second.errors.join(''), /synthetic-secret/);
});

test('configuration buffering is bounded and partial input at EOF starts nothing', async t => {
  const large = session(t); large.input.write(Buffer.alloc(128 * 1024 + 3, 65));
  assert.equal(await large.done, 1); assert.equal(large.created.length, 0);
  const partial = session(t); partial.input.end('{"connections":');
  assert.equal(await partial.done, 1); assert.equal(partial.created.length, 0);
  const extra = session(t); extra.input.write(JSON.stringify(connections()) + '\n' + JSON.stringify(connections()) + '\n');
  assert.equal(await extra.done, 1); assert.equal(extra.created.length, 0);
});

test('a terminal failure on one platform leaves the others running; all terminal failures clean up the group', async t => {
  const run = session(t);
  run.input.write(JSON.stringify(connections()) + '\n');
  run.created[0].options.onState({ state: 'stopped', code: 'LOGIN_REQUIRED', retries: 0, retryLimit: 2 });
  assert.equal(run.live.closed, false); assert.ok(run.created.every(item => item.stops === 0));
  for (const record of run.created.slice(1)) record.options.onState({ state: 'stopped', code: 'ROOM_OFFLINE', retries: 0, retryLimit: 2 });
  assert.equal(await run.done, 1);
  assert.equal(run.live.closed, true); assert.ok(run.created.every(item => item.stops === 1));
});

test('CLI help and rejected command-line credentials never start Java or echo arguments', () => {
  const help = spawnSync(process.execPath, ['examples/multi-platform.cjs', '--help'], {
    cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(help.status, 0); assert.match(help.stderr, /stdin/); assert.match(help.stderr, /Electron/);
  const rejected = spawnSync(process.execPath, ['examples/multi-platform.cjs', 'synthetic-secret'], {
    cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(rejected.status, 1); assert.doesNotMatch(rejected.stdout + rejected.stderr, /synthetic-secret/);
});

test('all stop operations settle before hub close, including rejection, and late events or status never log', async t => {
  const live = createLiveConnect({ profileOptions: { fetchImpl: async () => { throw new Error('Offline profile fixture'); } } });
  const order = [];
  const close = live.close.bind(live);
  live.close = () => { order.push('close'); close(); };
  let release;
  const run = session(t, { liveFactory: () => live, collectorFactory: options => ({
    start() {},
    stop() {
      order.push(`stop:${options.room.platform}`);
      assert.equal(live.closed, false);
      options.onState({ state: 'connected', retries: 0, retryLimit: 2 });
      options.room.ingest({ event_type: 'like', source_msg_id: 'synthetic-late-event', count: 1 });
      if (options.room.platform === 'douyin') throw new Error('synthetic-secret');
      if (options.room.platform === 'kuaishou') return new Promise(resolve => {
        release = () => { order.push('settled:kuaishou'); resolve(); };
      });
      return Promise.resolve();
    }
  }) });
  run.input.write(JSON.stringify(connections()) + '\n');
  const previousOutput = run.output.length;
  run.signals.emit('SIGTERM');
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, platforms.map(platform => `stop:${platform}`));
    assert.equal(live.closed, false);
    assert.equal(run.output.length, previousOutput, 'Shutdown suppresses status and event output immediately');
  } finally { release?.(); }
  assert.equal(await run.done, 1);
  assert.deepEqual(order.slice(-2), ['settled:kuaishou', 'close']);
  assert.equal(live.closed, true);
  assert.match(run.errors.join(''), /could not be stopped cleanly/);
  assert.doesNotMatch(run.errors.join(''), /synthetic-secret/);
});
