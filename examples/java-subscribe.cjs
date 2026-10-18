// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const readline = require('node:readline');
const { createLiveConnect, createJavaCollector } = require('../core/index.cjs');
const { root, java, classpath } = require('../scripts/java-runtime.cjs');

// Read one configuration JSON line from stdin: {"platform":"bilibili","roomId":"...","cookie":"..."}.
// Keep stdin open while collecting; EOF, Ctrl+C or SIGTERM disconnects.
// Do not put credentials in command-line arguments or commit configuration files.
const live = createLiveConnect();
const input = readline.createInterface({ input: process.stdin });
let runner, configured = false;
live.subscribe(event => console.log(JSON.stringify({ platform: event.platform, roomId: event.room_id,
  type: event.event_type, count: event.count })));
input.on('line', line => {
  if (configured) return;
  configured = true;
  try {
    if (Buffer.byteLength(line) > 32_768) throw new Error('Too large');
    const config = JSON.parse(line);
    const room = live.openRoom({ platform: config.platform, roomId: config.roomId,
      kuaishouCookie: config.platform === 'kuaishou' ? config.cookie || '' : '' });
    runner = createJavaCollector({ room, java, classpath, cwd: root, cookie: config.cookie || '',
      onState: state => console.error(JSON.stringify(state)) });
    runner.start();
  } catch { console.error('Invalid collector configuration or Java runtime.'); process.exitCode = 1; input.close(); }
});
async function stop() { await runner?.stop(); live.close(); }
input.on('close', () => { void stop(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { input.close(); process.stdin.destroy(); });
