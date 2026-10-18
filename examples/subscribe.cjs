// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const readline = require('node:readline');
const { createLiveConnect } = require('../core/index.cjs');

// Pipe real collector JSON lines into this program. No simulated events are generated.
// Example: node examples/subscribe.cjs bilibili YOUR_ROOM_ID < collector.jsonl
// Prefer a process pipe for live use: saved JSONL may contain viewer information.
const [platform, roomId] = process.argv.slice(2);
const live = createLiveConnect();
let room;
try { room = live.openRoom({ platform, roomId }); }
catch { console.error('Usage: node examples/subscribe.cjs <bilibili|douyin|kuaishou|wechat> <roomId>'); process.exitCode = 1; live.close(); }
if (room) {
  // Cookies are opt-in through openRoom({ kuaishouCookie }) in embedding code.
  // This example never reads credentials or performs authenticated profile lookup.
  const unsubscribe = live.subscribe(event => {
    // Print only routing/type/count, not viewer identities, messages, or avatar URLs.
    console.log(JSON.stringify({ platform: event.platform, roomId: event.room_id,
      type: event.event_type, count: event.count }));
  });
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', line => {
    if (Buffer.byteLength(line) > 256 * 1024) return;
    try { const message = JSON.parse(line); if (message.kind === 'event') room.ingest(message.event); }
    catch { console.error('Skipped an invalid event.'); }
  });
  input.on('close', () => { unsubscribe(); live.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { input.close(); live.close(); process.stdin.destroy(); });
}
