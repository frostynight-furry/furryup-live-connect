// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { PLATFORMS } = require('../core/event-stream.cjs');
const SCENARIOS = Object.freeze(['delivery', 'room-switch', 'reconnect']);
const TIME = 1_800_000_000_000;
const comment = (id, timestamp = TIME) => ({ event_type: 'comment', source_msg_id: `synthetic-${id}`,
  user_id: 'synthetic-viewer', user_name: '合成观众 · Synthetic viewer',
  content: '合成消息 · Synthetic message', timestamp });
const gift = (id, count, timestamp) => ({ ...comment(id, timestamp), event_type: 'gift',
  gift_id: 'synthetic-gift', gift_name: '合成礼物 · Synthetic gift', gift_count: count });
const ingest = (session, event, expect = 'accepted') => ({ op: 'ingest', session, event, expect });

/** Fresh, entirely authored fixtures: no platform captures, credentials or URLs. */
function createSyntheticScenario(name) {
  if (!SCENARIOS.includes(name)) throw new TypeError('Unknown synthetic scenario');
  const steps = [];
  if (name === 'delivery') {
    for (const platform of PLATFORMS) {
      const session = `synthetic-${platform}`;
      steps.push({ op: 'open', session, platform, roomId: 'synthetic-room' },
        { op: 'select', session },
        ingest(session, comment('message', TIME + 200)),
        ingest(session, comment('message', TIME + 200), 'duplicate'),
        ingest(session, comment('earlier', TIME + 100)),
        ingest(session, gift('gift-1', 2, TIME + 300)),
        ingest(session, gift('gift-1', 2, TIME + 300), 'duplicate'),
        ingest(session, gift('gift-2', 3, TIME + 250)),
        ingest(session, { ...comment('stats'), event_type: 'room_stats', watching_count: 0 }));
    }
  } else if (name === 'room-switch') {
    steps.push(
      { op: 'open', session: 'synthetic-old', platform: 'wechat', roomId: 'synthetic-room-a' },
      { op: 'select', session: 'synthetic-old' },
      ingest('synthetic-old', gift('shared-id', 5, TIME)),
      { op: 'open', session: 'synthetic-new', platform: 'wechat', roomId: 'synthetic-room-b' },
      { op: 'select', session: 'synthetic-new' },
      ingest('synthetic-new', gift('shared-id', 2, TIME + 200)),
      // A late old-room action is genuine history; it must not reset the new room.
      ingest('synthetic-old', gift('late-old-room', 9, TIME + 100)),
      { op: 'close', session: 'synthetic-old' },
      ingest('synthetic-old', comment('stale-callback'), 'rejected'));
  } else {
    steps.push(
      { op: 'open', session: 'synthetic-first', platform: 'bilibili', roomId: 'synthetic-room' },
      { op: 'select', session: 'synthetic-first' },
      ingest('synthetic-first', comment('message')),
      // Retaining a session across a transport reconnect retains its deduplication.
      ingest('synthetic-first', comment('message'), 'duplicate'),
      { op: 'close', session: 'synthetic-first' },
      { op: 'open', session: 'synthetic-second', platform: 'bilibili', roomId: 'synthetic-room' },
      { op: 'select', session: 'synthetic-second' },
      ingest('synthetic-first', comment('late-after-close'), 'rejected'),
      // Closing clears deduplication: durable exactly-once is not promised.
      ingest('synthetic-second', comment('message')));
  }
  return { fixtureVersion: 1, synthetic: true, name, steps };
}
module.exports = { SCENARIOS, createSyntheticScenario };
