'use strict';
const { app, BrowserWindow, session } = require('electron');
const { WechatCollector } = require('../wechat/wechat-collector.cjs');
let collector, closing = false;
const seen = new Map();
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const credentials = { has: () => false, read: () => '', save: () => {}, clear: () => {} };
async function stop() {
  if (closing) return;
  closing = true;
  await collector?.stop();
  app.quit();
}
app.on('window-all-closed', () => { void stop(); });
app.on('before-quit', event => { if (!closing) { event.preventDefault(); void stop(); } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(); });
app.whenReady().then(async () => {
  collector = new WechatCollector({ BrowserWindow, session, credentials });
  await collector.connect({ remember: false,
    onState: state => emit({ kind: 'status', platform: 'wechat', ...state }),
    onDiagnostic: metric => emit({ kind: 'diagnostic', platform: 'wechat', metric }),
    onEvent(event, roomId) {
      // Long polling may replay messages. Deduplicate only real message IDs;
      // room snapshots without IDs remain snapshots, not counted interactions.
      if (event.source_msg_id) {
        const now = Date.now(), key = JSON.stringify([roomId, event.source_msg_id]);
        for (const [id, at] of seen) { if (now - at > 600000) seen.delete(id); else break; }
        if (seen.has(key)) return;
        seen.set(key, now);
        while (seen.size > 20000) seen.delete(seen.keys().next().value);
      }
      emit({ kind: 'event', event: { ...event, platform: 'wechat', room_id: roomId } });
    }
  });
}).catch(() => { console.error('视频号采集启动失败，请检查 Electron 环境。'); process.exitCode = 1; void stop(); });
