'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveConnect, normalizeEvent } = require('../core/index.cjs');
const pk = (protocol, phase, reason, extra = {}) => ({
  event_type: 'pk_status', pk: { battleId: '9007199254740993', protocol, phase, reason, observedAt: 1_800_000_000_000, ...extra }
});

test('Bilibili seven PK commands preserve exact participants, score units and lifecycle evidence', () => {
  for (const [phase, reason, protocols] of [
    ['preparing', 'battle-preparing', ['PK_BATTLE_PRE', 'PK_BATTLE_PRE_NEW']],
    ['active', 'battle-started', ['PK_BATTLE_START', 'PK_BATTLE_START_NEW']],
    ['active', 'battle-progress', ['PK_BATTLE_PROCESS', 'PK_BATTLE_PROCESS_NEW']],
    ['ended', 'battle-finished', ['PK_BATTLE_END']]
  ]) for (const protocol of protocols) {
    const participants = phase === 'preparing'
      ? [{ side: 'opponent', roomId: '987', userId: '9007199254740995', userName: '合成主播', avatarUrl: 'https://i0.hdslb.com/synthetic.png' }]
      : [{ side: 'init', roomId: '123', score: '18446744073709551615' }, { side: 'match', roomId: '987', score: '0' }];
    const event = normalizeEvent(pk(protocol, phase, reason, { participants, scoreUnit: '票' }), 'bilibili', '123');
    assert.equal(event.pk.phase, phase);
    assert.equal(event.pk.battleId, '9007199254740993');
    assert.equal(event.count_mode, 'snapshot');
    assert.equal(event.count, 0);
    assert.equal(event.pk.scoreUnit, '票');
    assert.equal(event.pk.result, undefined);
    assert.equal(event.pk.winner, undefined);
    assert.ok(Object.isFrozen(event.pk.participants[0]));
    if (phase === 'preparing') assert.match(event.pk.participants[0].avatarId, /^[a-f0-9]{64}$/);
    else assert.equal(event.pk.participants[0].score, '18446744073709551615');
  }
});

test('PK rejects invented evidence, rounded scores, duplicate sides and cross-platform score claims', () => {
  const base = pk('PK_BATTLE_PROCESS_NEW', 'active', 'battle-progress');
  for (const participants of [
    [{ side: 'init', roomId: '1', score: 9007199254740992 }],
    [{ side: 'init', roomId: '1', score: '-1' }],
    [{ side: 'init', roomId: '1', score: '18446744073709551616' }],
    [{ side: 'init', roomId: '1', score: '01' }],
    [{ side: 'init', roomId: '1' }, { side: 'init', roomId: '2' }],
    [{ side: 'init', roomId: '1' }, { side: 'match', roomId: '1' }],
    [{ side: 'opponent', roomId: '1' }]
  ]) assert.throws(() => normalizeEvent({ ...base, pk: { ...base.pk, participants } }, 'bilibili', '1'));
  assert.throws(() => normalizeEvent({ ...base, pk: { ...base.pk, reason: 'battle-finished' } }, 'bilibili', '1'));
  assert.throws(() => normalizeEvent(base, 'douyin', '1'));
  const unknown = normalizeEvent({ ...base, pk: { ...base.pk, participants: [{ side: 'init', roomId: '1' }] } }, 'bilibili', '1');
  assert.equal(unknown.pk.participants[0].score, undefined);
  const invalidAvatar = normalizeEvent(pk('PK_BATTLE_PRE_NEW', 'preparing', 'battle-preparing', {
    participants: [{ side: 'opponent', roomId: '2', avatarUrl: 'https://i0.hdslb.com.evil.example/a.png' }]
  }), 'bilibili', '1');
  assert.equal(invalidAvatar.pk.participants[0].avatarUrl, undefined);
  const ks = normalizeEvent(pk('SC_PK_STATISTIC', 'active', undefined), 'kuaishou', '1');
  assert.equal(ks.pk.participants, undefined);
});

test('Douyin score updates and finishes distinguish exact values from relative or blurred display text', () => {
  for (const [protocol, phase, reason] of [
    ['WebcastLinkMicMethod', 'active', 'battle-progress'],
    ['WebcastLinkMicBattleFinishMethod', 'ended', 'battle-finished'],
    ['WebcastLinkmicBattleFinishMethod', 'ended', 'battle-finished']
  ]) {
    const event = normalizeEvent(pk(protocol, phase, reason, { participants: [
      { side: 'participant', userId: '9007199254740993', score: '9007199254740995' },
      { side: 'participant', userId: '42', scoreDisplay: '领先' }
    ] }), 'douyin', 'room');
    assert.equal(event.pk.participants[0].roomId, undefined);
    assert.equal(event.pk.participants[0].score, '9007199254740995');
    assert.equal(event.pk.participants[1].score, undefined);
    assert.equal(event.pk.participants[1].scoreDisplay, '领先');
    assert.equal(event.pk.winner, undefined);
  }
  for (const participants of [
    [{ side: 'participant', userId: '42', score: '1', scoreDisplay: '***' }],
    [{ side: 'participant', roomId: '42', score: '1' }],
    [{ side: 'participant', userId: '42' }, { side: 'participant', userId: '42' }]
  ]) assert.throws(() => normalizeEvent(pk('WebcastLinkMicMethod', 'active', 'battle-progress', { participants }), 'douyin', 'room'));
  assert.throws(() => normalizeEvent(pk('WebcastLinkMicBattleMethod', 'active', undefined, {
    participants: [{ side: 'participant', userId: '42', score: '1' }]
  }), 'douyin', 'room'));
});

test('visible viewer avatars and source ranks survive the hub and remain separate from interactions', async t => {
  let downloads = 0, delivered = 0;
  const live = createLiveConnect({ avatarCacheOptions: { fetchImpl: async (url, options) => {
    downloads++;
    assert.equal(url, 'https://p3.douyinpic.com/synthetic.png');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Cookie, undefined);
    return new Response('synthetic-image', { headers: { 'content-type': 'image/png' } });
  } } });
  t.after(() => live.close());
  live.subscribe(() => delivered++);
  const room = live.openRoom({ platform: 'douyin', roomId: 'room' });
  const event = room.ingest({ event_type: 'viewer_snapshot', viewer_snapshot: {
    source: 'douyin-contributor-rank', complete: false, presenceEvidence: 'unknown',
    viewers: [{ userId: '42', userName: '合成观众', rank: 3, avatarUrl: 'https://p3.douyinpic.com/synthetic.png' },
      { userId: '43', rank: 501, avatarUrl: 'https://evil.example/a.png' }]
  } });
  assert.equal(downloads, 0);
  assert.equal(event.viewer_snapshot.viewers[0].rank, 3);
  assert.equal(event.viewer_snapshot.viewers[0].online, undefined);
  assert.equal(event.viewer_snapshot.viewers[1].rank, undefined);
  assert.equal(event.viewer_snapshot.viewers[1].avatarId, undefined);
  assert.equal((await live.getAvatar(event.viewer_snapshot.viewers[0].avatarId)).body.toString(), 'synthetic-image');
  assert.equal(delivered, 1);
  assert.equal(room.history().length, 0);
});

test('Bilibili PK metadata images are registered without replaying any chat or gift', async t => {
  const live = createLiveConnect({ avatarCacheOptions: { fetchImpl: async () => new Response('avatar', { headers: { 'content-type': 'image/png' } }) } });
  t.after(() => live.close());
  const room = live.openRoom({ platform: 'bilibili', roomId: '1' });
  const event = room.ingest(pk('PK_BATTLE_PRE', 'preparing', 'battle-preparing', {
    participants: [{ side: 'opponent', roomId: '2', avatarUrl: 'https://i0.hdslb.com/synthetic.png' }]
  }));
  assert.equal((await live.getAvatar(event.pk.participants[0].avatarId)).body.toString(), 'avatar');
  assert.equal(room.history().length, 0);
});

test('a visible anonymous list image is retained without manufacturing a viewer identity', () => {
  const event = normalizeEvent({ event_type: 'viewer_snapshot', viewer_snapshot: {
    source: 'wechat-online-member', complete: false, presenceEvidence: 'online-list',
    viewers: [{ userName: '合成显示名', avatarUrl: 'https://wx.qlogo.cn/synthetic.png' }]
  } }, 'wechat', 'room');
  assert.equal(event.viewer_snapshot.viewers[0].userId, undefined);
  assert.equal(event.viewer_snapshot.viewers[0].avatarUrl, 'https://wx.qlogo.cn/synthetic.png');
  assert.equal(event.viewer_snapshot.viewers[0].online, undefined);
});
