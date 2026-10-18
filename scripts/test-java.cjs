'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, java, classpath } = require('./java-runtime.cjs');
if (!fs.existsSync(path.join(root, 'collector/target/collector.jar'))) {
  console.error('Build the Java collector first: npm run build'); process.exit(1);
}
function run(name, encoding = 'UTF-8', args = []) {
  const result = spawnSync(java, [`-Dstdout.encoding=${encoding}`, '-cp', classpath, `local.furryup.${name}`, ...args],
    { cwd: root, encoding: 'buffer', timeout: 25000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${name}: ${result.error?.message || result.stderr?.toString('utf8') || 'failed'}`);
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
}
for (const name of ['BilibiliExtraEventsFixture', 'BilibiliGiftMetadataFixture', 'BilibiliMainInteractionsFixture', 'BilibiliV2Fixture',
  'DouyinHandshakeFixture', 'ExpandedEventFixture', 'KuaishouAvatarFixture', 'KuaishouExtraEventsFixture',
  'PkEventsFixture', 'ViewerSnapshotsFixture']) {
  run(name); console.log(`PASS ${name}`);
}
for (const encoding of ['GBK', 'UTF-8']) {
  const records = run('CollectorWireFixture', encoding).trim().split(/\r?\n/).map(JSON.parse);
  const events = records.filter(row => row.kind === 'event').map(row => row.event);
  assert.equal(events.length, 5);
  assert.ok(events.every(event => event.user_name === '测试观众·雪❄️🐾'));
  assert.deepEqual(events.filter(event => event.event_type === 'gift').map(event => event.gift_count), [1, 2, 1]);
  assert.equal(events.at(-1).content, '中文弹幕 / English / 🎁 雪花❄️');
  console.log(`PASS CollectorWireFixture (${encoding} host encoding)`);
}
const platforms = run('PlatformEventFixture').trim().split(/\r?\n/).map(JSON.parse).filter(row => row.kind === 'event');
for (const platform of ['bilibili', 'douyin', 'kuaishou'])
  for (const type of ['comment', 'gift', 'like']) assert.ok(platforms.some(row => row.event.platform === platform && row.event.event_type === type), `${platform}/${type}`);
assert.match(run('Collector', 'UTF-8', ['--self-test']), /self-test-ok/);
console.log('PASS offline three-platform wire and collector self-tests');
