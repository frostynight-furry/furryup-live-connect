'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const schema = require('../schemas/live-event.v1.schema.json');
const { PLATFORMS, EVENT_TYPES, normalizeEvent, LiveEventStream } = require('../core/index.cjs');
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
const raw = (event_type, extra = {}) => ({ event_type, source_msg_id: 'synthetic-message',
  user_id: 'synthetic-viewer', content: '合成消息 / Synthetic message', timestamp: 1_800_000_000_000, ...extra });
const expectValid = event => assert.equal(validate(event), true, JSON.stringify(validate.errors));

test('schema enumerates exactly the public platforms and event types', () => {
  assert.deepEqual(schema.properties.platform.enum, [...PLATFORMS]);
  assert.deepEqual(schema.properties.event_type.enum, [...EVENT_TYPES]);
});

test('all event variants conform; unknown values stay absent and snapshots are not increments', () => {
  for (const type of EVENT_TYPES) {
    const extras = {
      gift: { gift_count: 3, gift_price_raw: '123.50', gift_price_unit: 'synthetic-unit' },
      super_chat: { super_chat_id: '9007199254740993', super_chat_price_raw: '12.50', super_chat_duration: 30 },
      super_chat_delete: { super_chat_ids: ['9007199254740993'] },
      room_stats: { watching_count: 0, liked_count: 'unknown' },
      live_status: { live_status: 'started' },
      viewer_snapshot: { viewer_snapshot: { source: 'synthetic', complete: false, presenceEvidence: 'unknown',
        viewers: [{ userId: 'synthetic-viewer', userName: '合成 / Synthetic', online: true, rank: 1 }] } },
      pk_status: { pk: { battleId: '9007199254740993', phase: 'active', protocol: 'PK_BATTLE_PROCESS',
        reason: 'battle-progress', observedAt: 1_800_000_000_000, scoreUnit: 'synthetic-unit',
        participants: [{ side: 'init', roomId: '9007199254740993', score: '18446744073709551615' },
          { side: 'match', roomId: '9007199254740995', score: '0' }] } }
    };
    const event = new LiveEventStream().push(raw(type, extras[type]), 'bilibili', 'synthetic-room');
    expectValid(event);
    assert.equal(event.sequence, 1);
    if (type === 'gift') assert.equal(event.count, event.gift_count);
    if (type === 'room_stats') { assert.equal(event.watching_count, 0); assert.equal(event.liked_count, undefined); }
  }
  expectValid(normalizeEvent(raw('like'), 'wechat', 'synthetic-room'));
  expectValid(normalizeEvent(raw('comment'), 'douyin', 'synthetic-room', true));
});

test('schema rejects broken envelopes and count modes while allowing future optional fields', () => {
  const event = normalizeEvent(raw('comment'), 'kuaishou', 'synthetic-room');
  for (const mutation of [{ schemaVersion: 2 }, { platform: 'unsupported' }, { room_id: '' },
    { timestamp: -1 }, { received_at: 1.5 }, { sequence: 0 }, { count_mode: 'snapshot' },
    { gift_count: 1 }, { value: 2 }, { event_type: 'unknown' }, { preview: true }])
    assert.equal(validate({ ...event, ...mutation }), false, JSON.stringify(mutation));
  const { event_id, ...missingIdentity } = event;
  assert.equal(validate(missingIdentity), false);
  expectValid({ ...event, future_optional_field: { synthetic: true } });
  const stats = normalizeEvent(raw('room_stats', { watching_count: 0 }), 'wechat', 'synthetic-room');
  assert.equal(validate({ ...stats, count: 1 }), false);
  const signal = normalizeEvent(raw('like'), 'wechat', 'synthetic-room');
  assert.equal(validate({ ...signal, count_mode: 'delta' }), false);
});

test('deduplication TTL is receipt-based and explicitly expires after ten minutes', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const stream = new LiveEventStream();
  assert.ok(stream.push(raw('comment'), 'bilibili', 'synthetic-room'));
  t.mock.timers.tick(600_000);
  assert.equal(stream.push(raw('comment'), 'bilibili', 'synthetic-room'), null);
  t.mock.timers.tick(1);
  assert.ok(stream.push(raw('comment'), 'bilibili', 'synthetic-room'));
});

test('capacity eviction and clearing history do not imply persistent exactly-once delivery', () => {
  const stream = new LiveEventStream();
  for (let i = 0; i < 20_001; i++) stream.push(raw('comment', { source_msg_id: `synthetic-${i}` }), 'douyin', 'synthetic-room');
  assert.equal(stream.seen.size, 20_000);
  assert.equal(stream.history.length, 100);
  stream.clear();
  assert.equal(stream.push(raw('comment', { source_msg_id: 'synthetic-20000' }), 'douyin', 'synthetic-room'), null);
  assert.ok(stream.push(raw('comment', { source_msg_id: 'synthetic-0' }), 'douyin', 'synthetic-room'));
});

test('consumer inputs cannot override routing or leak unknown raw payload fields', () => {
  const { createLiveConnect } = require('../core/index.cjs');
  const live = createLiveConnect();
  try {
    const room = live.openRoom({ platform: 'wechat', roomId: 'synthetic-current' });
    const event = room.ingest(raw('comment', { platform: 'douyin', room_id: 'synthetic-wrong',
      cookie: 'synthetic-only', raw_payload: { synthetic: true }, account: 'synthetic-account' }));
    assert.equal(event.platform, 'wechat'); assert.equal(event.room_id, 'synthetic-current');
    for (const field of ['cookie', 'raw_payload', 'account']) assert.equal(Object.hasOwn(event, field), false);
    expectValid(event);
  } finally { live.close(); }
});
