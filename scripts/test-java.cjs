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
for (const name of ['UserBadgesFixture', 'BilibiliHandshakeFixture', 'BilibiliExtraEventsFixture', 'BilibiliGiftMetadataFixture', 'BilibiliMainInteractionsFixture', 'BilibiliV2Fixture',
  'DouyinHandshakeFixture', 'ExpandedEventFixture', 'KuaishouAvatarFixture', 'KuaishouExtraEventsFixture',
  'PkEventsFixture', 'ViewerSnapshotsFixture']) {
  run(name);
  if (name === 'PkEventsFixture') {
    const { normalizeEvent } = require('../core/index.cjs');
    const output = run(name, 'UTF-8', ['--emit-events']);
    const normalized = output.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
      .map(row => normalizeEvent(row.event, row.platform, 'synthetic-pk-room'));
    const bili = normalized.filter(event => event.platform === 'bilibili');
    const douyin = normalized.filter(event => event.platform === 'douyin');
    assert.ok(bili.some(event => event.pk.phase === 'preparing' && event.pk.participants[0].userId));
    assert.ok(bili.some(event => event.pk.reason === 'battle-progress' && event.pk.participants.length === 2));
    assert.ok(bili.some(event => event.pk.phase === 'ended'));
    assert.ok(douyin.some(event => event.pk.reason === 'battle-progress' && event.pk.participants.some(p => typeof p.score === 'string')));
    assert.ok(douyin.some(event => event.pk.participants.some(p => p.scoreDisplay && p.score === undefined)));
    assert.ok(douyin.some(event => event.pk.phase === 'ended' && event.pk.participants.some(p => typeof p.score === 'string')));
    assert.ok(normalized.every(event => event.count === 0 && event.count_mode === 'snapshot'));
    console.log('PASS PK Java-to-Node wire compatibility');
  }
  console.log(`PASS ${name}`);
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
for (const mode of ['v1-combo', 'v2-bulk']) {
  const { LiveEventStream } = require('../core/index.cjs'), stream = new LiveEventStream();
  const records = run('BilibiliGiftComboFixture', 'UTF-8', [mode]).trim().split(/\r?\n/).map(JSON.parse);
  const emitted = records.filter(row => row.kind === 'event').map(row => row.event);
  const accepted = emitted.map(event => stream.push(event, 'bilibili', 'fixture-room')).filter(Boolean);
  assert.equal(accepted.reduce((sum, event) => sum + event.gift_count, 0), 20);
  assert.equal(accepted.length, mode === 'v1-combo' ? 20 : 1);
  assert.ok(accepted.every(event => event.gift_name === '小花花' && event.count_mode === 'delta'));
  assert.equal(records.filter(row => row.metric === 'giftParseErrors').length, 0);
  console.log(`PASS Bilibili ${mode}: 20 flowers, V1/V2 duplicate suppression, COMBO_SEND not double-counted, real zlib SDK decode`);
}
for (const platform of ['bilibili', 'douyin', 'kuaishou'])
  for (const type of ['comment', 'gift', 'like']) assert.ok(platforms.some(row => row.event.platform === platform && row.event.event_type === type), `${platform}/${type}`);
assert.match(run('Collector', 'UTF-8', ['--self-test']), /self-test-ok/);
console.log('PASS offline three-platform wire and collector self-tests');
