// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { PLATFORMS, createLiveConnect } = require('../core/index.cjs');

// Entirely synthetic: no collectors, credentials, images, network calls, or Java.
// openRoom() only creates a normalization session; it does not connect anywhere.
// Live room sessions reject preview:true, so the demo marks its own output
// explicitly instead of passing an unsupported simulation flag to ingest().
function runDemo({ write = value => console.log(JSON.stringify(value)) } = {}) {
  const live = createLiveConnect();
  const totals = Object.fromEntries(PLATFORMS.map(platform => [platform, 0]));
  let giftEvents = 0;
  try {
    write({ demo: true, source: 'synthetic', kind: 'start',
      message: 'OFFLINE DEMO — all viewers, rooms and events are synthetic. No live platform is connected.' });
    live.subscribe(event => write({ demo: true, source: 'synthetic', kind: 'event',
      schemaVersion: event.schemaVersion, platform: event.platform, roomId: event.room_id,
      sourceMessageId: event.source_msg_id, type: event.event_type,
      count: event.count, countMode: event.count_mode,
      ...(event.event_type === 'gift' && { giftName: event.gift_name, giftCount: event.gift_count }) }));
    live.subscribe(event => { totals[event.platform] += event.gift_count; giftEvents++; }, { eventTypes: ['gift'] });

    // All four sessions exist together. Reusing source IDs across platforms is
    // deliberate: only a replay within the same platform and room is a duplicate.
    const rooms = PLATFORMS.map(platform => live.openRoom({ platform, roomId: 'synthetic-demo-room' }));
    const sender = { user_id: 'synthetic-demo-viewer', user_name: '合成观众', timestamp: 1_700_000_000_000 };
    for (const room of rooms) room.ingest({ ...sender, source_msg_id: 'synthetic-comment-1',
      event_type: 'comment', content: '离线合成弹幕，不是真实直播消息。' });
    const firstGift = { ...sender, source_msg_id: 'synthetic-gift-batch-1', event_type: 'gift',
      gift_id: 'synthetic-gift', gift_name: '合成礼物', gift_count: 2 };
    const secondGift = { ...firstGift, source_msg_id: 'synthetic-gift-batch-2', gift_count: 3 };
    for (const room of rooms) room.ingest(firstGift);
    for (const room of rooms) room.ingest(firstGift); // Same batch replayed: ignored.
    for (const room of rooms) room.ingest(secondGift); // New batch: add three, not a cumulative total.

    const summary = { demo: true, source: 'synthetic', kind: 'summary', platforms: PLATFORMS,
      acceptedEvents: live.stream.accepted, ignoredDuplicates: live.stream.duplicates,
      giftEvents, giftTotals: totals, explanation: 'Each platform received gift deltas 2 + 3 = 5; replaying the first batch added nothing.' };
    write(summary);
    return summary;
  } finally { live.close(); }
}

if (require.main === module) runDemo();
module.exports = { runDemo };
