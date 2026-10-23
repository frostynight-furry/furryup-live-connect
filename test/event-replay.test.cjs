'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { SCENARIOS, createSyntheticScenario, replayScenario } = require('../testing/index.cjs');

test('four-platform replay is deterministic, preserves arrival order and never fetches', () => {
  const before = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected network access'); };
  try {
    const result = replayScenario(createSyntheticScenario('delivery'));
    assert.deepEqual(result, replayScenario(createSyntheticScenario('delivery')));
    assert.equal(result.accepted, 20); assert.equal(result.duplicates, 8); assert.equal(result.rejected, 0);
    assert.equal(result.rooms.length, 4);
    for (const room of result.rooms) assert.deepEqual([room.comments, room.gifts, room.watchingCount], [2, 5, 0]);
    const events = result.trace.filter(row => row.event).map(row => row.event);
    assert.deepEqual(events.map(event => event.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
    assert.ok(events[0].timestamp > events[1].timestamp);
    assert.ok(events.every(event => event.schemaVersion === 1 && event.preview === false));
    assert.equal(result.synthetic, true); // Simulation marker belongs to the fixture envelope.
  } finally { globalThis.fetch = before; }
});

test('late old-room gifts remain in their own history without changing the selected room', () => {
  const result = replayScenario(createSyntheticScenario('room-switch'));
  assert.equal(result.accepted, 3); assert.equal(result.rejected, 1);
  assert.deepEqual(result.rooms.map(room => room.gifts), [14, 2]);
  assert.equal(result.activeRooms.length, 1);
  assert.equal(result.activeRooms[0].roomId, 'synthetic-room-b');
  assert.equal(result.activeRooms[0].gifts, 2);
  const events = result.trace.filter(row => row.event).map(row => row.event);
  assert.notEqual(events[0].event_id, events[1].event_id);
  assert.equal(events[2].room_id, 'synthetic-room-a');
});

test('reconnect boundaries retain dedup only while the same session lives', () => {
  const scenario = createSyntheticScenario('reconnect');
  // Re-closing an old handle must not deselect the replacement session.
  scenario.steps.push({ op: 'close', session: 'synthetic-first' });
  const result = replayScenario(scenario);
  assert.equal(result.accepted, 2); assert.equal(result.duplicates, 1); assert.equal(result.rejected, 1);
  assert.equal(result.activeRooms.length, 1);
  const events = result.trace.filter(row => row.event).map(row => row.event);
  assert.equal(events[0].event_id, events[1].event_id);
  assert.notEqual(events[0].sequence, events[1].sequence);
});

test('synthetic fixture boundary rejects credential fields, URLs, real identifiers and oversized input', () => {
  const rejected = mutate => { const s = createSyntheticScenario('delivery'); mutate(s); assert.throws(() => replayScenario(s)); };
  rejected(s => { s.synthetic = false; });
  rejected(s => { s.steps[0].roomId = '123456'; });
  rejected(s => { s.steps[2].event.user_id = 'real-user'; });
  rejected(s => { s.steps[2].event.cookie = 'synthetic-only'; });
  rejected(s => { s.steps[2].event.avatar_url = 'https://example.invalid/synthetic.png'; });
  rejected(s => { s.steps[2].event.content = 'synthetic https://example.invalid'; });
  rejected(s => { s.steps[2].event.timestamp = Infinity; });
  rejected(s => { s.steps = Array(10_001).fill(s.steps[0]); });
  rejected(s => { s.steps[2].expect = 'duplicate'; });
  rejected(s => { s.steps[2].event.event_type = 'unknown'; });
  rejected(s => { Object.defineProperty(s.steps[2].event, 'content', { get() { throw new Error('Getter must not execute'); } }); });
});

test('CLI accepts only built-in scenario names and produces synthetic JSON reports', () => {
  const script = path.resolve(__dirname, '../examples/replay-events.cjs');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const reports = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(reports.map(row => row.name), [...SCENARIOS]);
  assert.ok(reports.every(row => row.synthetic === true));
  const invalid = spawnSync(process.execPath, [script, '../user-data.json'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /Usage:/);
});
