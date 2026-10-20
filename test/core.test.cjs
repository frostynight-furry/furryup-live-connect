// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveConnect, LiveEventStream, normalizeEvent } = require('../core/index.cjs');
const avatar = 'https://tx2.a.kwimgs.com/uhead/synthetic.png';
const comment = (id = 'message', extra = {}) => ({ event_type: 'comment', source_msg_id: id,
  user_id: 'synthetic-viewer', content: 'synthetic comment', ...extra });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('room and platform identities isolate deduplication, subscriptions and history', t => {
  const hub = createLiveConnect(); t.after(() => hub.close());
  const first = hub.openRoom({ platform: 'kuaishou', roomId: 'room' });
  const second = hub.openRoom({ platform: 'kuaishou', roomId: 'room:two' });
  const third = hub.openRoom({ platform: 'bilibili', roomId: 'room' });
  const all = [], selected = [];
  hub.subscribe(event => all.push(event));
  const unsubscribe = hub.subscribe(event => selected.push(event), { platform: 'kuaishou', roomId: 'room', eventTypes: ['comment'] });
  assert.ok(first.ingest(comment()));
  assert.equal(first.ingest(comment()), null);
  assert.ok(second.ingest(comment())); assert.ok(third.ingest(comment()));
  assert.equal(all.length, 3); assert.equal(selected.length, 1);
  unsubscribe(); first.ingest(comment('second'));
  assert.equal(selected.length, 1); assert.equal(first.history().length, 2);
  assert.equal(hub.stream.duplicates, 1);
  // Delimiters in room/message IDs cannot collapse identities.
  const fourth = hub.openRoom({ platform: 'kuaishou', roomId: 'room:message' });
  assert.notEqual(first.ingest(comment('message:tail')).event_id, fourth.ingest(comment('tail')).event_id);
  assert.equal(third.ingest(comment('routing', { platform: 'douyin', room_id: 'wrong' })).platform, 'bilibili');
});

test('gift-derived avatars stay within their room and hidden identities never seed or consume them', t => {
  const hub = createLiveConnect(); t.after(() => hub.close());
  const first = hub.openRoom({ platform: 'kuaishou', roomId: 'room' });
  const second = hub.openRoom({ platform: 'kuaishou', roomId: 'other' });
  first.ingest({ event_type: 'gift', source_msg_id: 'gift', user_id: 'synthetic-viewer', gift_count: 2, avatar_url: avatar });
  assert.equal(first.ingest(comment('public')).avatar_url, avatar);
  assert.equal(second.ingest(comment()).avatar_url, undefined);
  assert.equal(first.ingest(comment('hidden', { user_identity_hidden: true })).avatar_url, undefined);
  const ownHidden = avatar.replace('synthetic', 'hidden-synthetic');
  assert.equal(first.ingest(comment('hidden-own', { user_identity_hidden: true, avatar_url: ownHidden })).avatar_url, ownHidden);
  assert.equal(first.ingest(comment('public-again')).avatar_url, avatar);
  first.close(); assert.equal(first.history().length, 0);
  assert.throws(() => first.ingest(comment()), /closed/);
  const replacement = hub.openRoom({ platform: 'kuaishou', roomId: 'room' });
  assert.equal(replacement.ingest(comment()).avatar_url, undefined);
});

test('all four platforms reuse supplied avatars without downloading during ingestion', t => {
  let downloads = 0;
  const hub = createLiveConnect({ avatarCacheOptions: { fetchImpl: async () => { downloads++; throw new Error('Unexpected download'); } } });
  t.after(() => hub.close());
  for (const [platform, url] of [
    ['bilibili', 'https://i0.hdslb.com/synthetic.png'], ['douyin', 'https://p3.douyinpic.com/synthetic.png'],
    ['kuaishou', avatar], ['wechat', 'https://wx.qlogo.cn/synthetic.png']
  ]) {
    const room = hub.openRoom({ platform, roomId: 'room' });
    room.ingest(comment('source', { avatar_url: url }));
    assert.equal(room.ingest(comment('next')).avatar_url, url);
    assert.equal(room.ingest(comment('unknown', { user_id: 'outside' })).avatar_id, undefined);
  }
  assert.equal(downloads, 0);
});

test('async profile metadata updates history without replaying messages or altering gift totals', async t => {
  let finish, lookups = 0;
  const hub = createLiveConnect({ profileOptions: { fetchImpl: async () => { lookups++; return new Promise(resolve => { finish = resolve; }); } } });
  t.after(() => hub.close());
  const room = hub.openRoom({ platform: 'kuaishou', roomId: 'room', kuaishouCookie: 'synthetic-cookie' });
  const actions = [], updates = [];
  hub.subscribe(event => actions.push(event)); hub.subscribeAvatars(event => updates.push(event));
  const original = room.ingest(comment());
  room.ingest({ event_type: 'gift', source_msg_id: 'gift', user_id: 'another', gift_count: 5 });
  assert.equal(actions.length, 2); assert.equal(lookups, 1);
  finish(new Response(JSON.stringify({ data: { userInfo: { id: 'synthetic-viewer', avatar } } })));
  await wait(15);
  assert.equal(updates.length, 1); assert.equal(updates[0].event_id, original.event_id);
  assert.equal(room.history()[0].avatar_url, avatar);
  assert.equal(actions.length, 2); assert.equal(hub.stream.accepted, 2);
  assert.equal(room.history()[1].gift_count, 5);
});

test('closing a room aborts profile requests and drops late results before reopening', async t => {
  let requestSignal, finish;
  const hub = createLiveConnect({ profileOptions: { fetchImpl: async (_, options) => {
    requestSignal = options.signal; return new Promise(resolve => { finish = resolve; });
  } } }); t.after(() => hub.close());
  const room = hub.openRoom({ platform: 'kuaishou', roomId: 'room', kuaishouCookie: 'synthetic-cookie' });
  let updates = 0; hub.subscribeAvatars(() => updates++);
  room.ingest(comment()); room.close();
  assert.equal(requestSignal.aborted, true);
  finish(new Response(JSON.stringify({ data: { userInfo: { id: 'synthetic-viewer', avatar } } })));
  const next = hub.openRoom({ platform: 'kuaishou', roomId: 'room' });
  next.ingest(comment()); await wait(15);
  assert.equal(updates, 0); assert.equal(next.history()[0].avatar_id, undefined);
});

test('unknown counts and prices are omitted; stats do not enter replay history', () => {
  const stream = new LiveEventStream();
  const stats = stream.push({ event_type: 'room_stats', watching_count: 0, liked_count: '1.2万' }, 'bilibili', 'room');
  assert.equal(stats.watching_count, 0); assert.equal(stats.liked_count, undefined);
  assert.equal(stats.count_mode, 'snapshot'); assert.equal(stream.history.length, 0);
  const gift = stream.push({ event_type: 'gift', gift_count: 3, gift_price_raw: 'unknown' }, 'bilibili', 'room');
  assert.equal(gift.gift_price_raw, undefined); assert.equal(gift.gift_count, 3);
  assert.throws(() => stream.push({ event_type: 'room_stats', watched_count: '1.2万' }, 'douyin', 'room'));
  assert.throws(() => normalizeEvent(comment(), 'unavailable', 'room'));
  assert.throws(() => normalizeEvent(comment(), 'kuaishou', ''));
});

test('memory bounds and close are deterministic, with no reuse after hub shutdown', () => {
  const hub = createLiveConnect({ maxRooms: 1 });
  const room = hub.openRoom({ platform: 'wechat', roomId: 'room' });
  assert.throws(() => hub.openRoom({ platform: 'wechat', roomId: 'room' }), /already/);
  assert.throws(() => hub.openRoom({ platform: 'wechat', roomId: 'other' }), /limit/);
  for (let i = 0; i < 140; i++) room.ingest(comment(String(i)));
  assert.equal(room.history().length, 100);
  hub.close(); hub.close();
  assert.equal(hub.history().length, 0);
  assert.throws(() => hub.openRoom({ platform: 'wechat', roomId: 'room' }), /closed/);
  assert.throws(() => createLiveConnect({ maxRooms: Infinity }));
});

test('invalid and duplicate events cannot poison identity caches, and preview is explicitly rejected', t => {
  const hub = createLiveConnect(); t.after(() => hub.close());
  for (const [platform, url] of [['kuaishou', avatar], ['bilibili', 'https://i0.hdslb.com/synthetic.png']]) {
    const room = hub.openRoom({ platform, roomId: 'room' });
    assert.throws(() => room.ingest(comment('invalid', { event_type: 'invalid', avatar_url: url })));
    assert.equal(room.ingest(comment('first')).avatar_id, undefined);
    assert.equal(room.ingest(comment('first', { avatar_url: url })), null);
    assert.equal(room.ingest(comment('second')).avatar_id, undefined);
    assert.throws(() => room.ingest(comment('preview', { preview: true, avatar_url: url })), /preview/);
    assert.equal(room.ingest(comment('third')).avatar_id, undefined);
  }
});

test('identity normalization never truncates or rounds a viewer ID before profile lookup', async t => {
  let calls = 0;
  const hub = createLiveConnect({ profileOptions: { fetchImpl: async () => { calls++; throw new Error('Unexpected profile request'); } } });
  t.after(() => hub.close());
  const room = hub.openRoom({ platform: 'kuaishou', roomId: 'room', kuaishouCookie: 'synthetic-cookie' });
  let index = 0;
  for (const user_id of ['a'.repeat(129), ' name ', 'name\n', Number.MAX_SAFE_INTEGER + 1, {}, 0]) {
    assert.equal(room.ingest(comment(`identity-${index++}`, { user_id })).user_id, '');
  }
  await wait(10); assert.equal(calls, 0);
  const numeric = hub.openRoom({ platform: 'bilibili', roomId: 'numeric' });
  numeric.ingest(comment('number', { user_id: 12345, avatar_url: 'https://i0.hdslb.com/synthetic.png' }));
  assert.ok(numeric.ingest(comment('string', { user_id: '12345' })).avatar_id);
  assert.equal(hub.stream.updateViewerAvatar({ platform: 'kuaishou', event_type: 'comment', user_id: 12345 }, {}), false);
});

test('failing subscribers cannot lose accepted events or metadata, including direct and once listeners', async t => {
  const hub = createLiveConnect(); t.after(() => hub.close());
  const room = hub.openRoom({ platform: 'kuaishou', roomId: 'room' });
  const received = [], metadata = [], diagnostics = [];
  const fail = () => { throw new Error('PRIVATE_ACCOUNT_COOKIE'); };
  hub.subscribe(fail);
  hub.on('event', async () => { throw new Error('PRIVATE_ASYNC_ACCOUNT'); });
  let onceCalls = 0;
  hub.once('event', () => { onceCalls++; fail(); });
  hub.subscribe(event => received.push(event));
  hub.stream.on('event', fail);
  hub.on('observer-error', fail);
  hub.on('observer-error', async () => { throw new Error('PRIVATE_DIAGNOSTIC'); });
  hub.on('observer-error', value => diagnostics.push(value));
  hub.subscribeAvatars(fail);
  hub.subscribeAvatars(update => metadata.push(update));
  const first = room.ingest(comment('first'));
  room.ingest(comment('second'));
  assert.equal(hub.stream.updateViewerAvatar(first, { avatar_url: avatar }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received.map(event => event.source_msg_id), ['first', 'second']);
  assert.equal(onceCalls, 1);
  assert.equal(metadata.length, 1);
  assert.equal(hub.stream.accepted, 2);
  assert.equal(room.ingest(comment('first')), null);
  assert.ok(diagnostics.some(value => value.channel === 'event'));
  assert.ok(diagnostics.some(value => value.channel === 'viewer-avatar'));
  assert.ok(diagnostics.every(value => value.code === 'OBSERVER_CALLBACK_FAILED' &&
    Object.keys(value).sort().join() === 'channel,code'));
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE/);
});

test('public subscriptions return asynchronous failures to isolation without treating ordinary results as promises', async t => {
  const hub = createLiveConnect(); t.after(() => hub.close());
  const room = hub.openRoom({ platform: 'kuaishou', roomId: 'room' });
  const diagnostics = [], events = [], avatars = [];
  hub.on('observer-error', value => diagnostics.push(value));
  hub.subscribe(async () => { throw new Error('PRIVATE_SUBSCRIPTION'); });
  hub.subscribeAvatars(async () => { throw new Error('PRIVATE_AVATAR_SUBSCRIPTION'); });
  hub.subscribe(() => ({ then: 42 }));
  hub.once('event', () => Object.defineProperty({}, 'then', {
    get() { throw new Error('PRIVATE_THEN_GETTER'); }
  }));
  hub.subscribe(event => events.push(event));
  hub.subscribeAvatars(event => avatars.push(event));
  const event = room.ingest(comment('async-public'));
  assert.equal(hub.stream.updateViewerAvatar(event, { avatar_url: avatar }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(avatars.length, 1);
  assert.equal(hub.stream.accepted, 1);
  assert.deepEqual(diagnostics.map(value => value.channel).sort(), ['event', 'event', 'viewer-avatar']);
  assert.ok(diagnostics.every(value => value.code === 'OBSERVER_CALLBACK_FAILED'));
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE/);
});

test('message and snapshot identities remain exact or are discarded rather than aliased', t => {
  const hub = createLiveConnect(); t.after(() => hub.close());
  const room = hub.openRoom({ platform: 'wechat', roomId: 'room' });
  const prefix = 'x'.repeat(128);
  const first = room.ingest(comment(prefix + 'a'));
  const second = room.ingest(comment(prefix + 'b'));
  assert.notEqual(first.event_id, second.event_id);
  assert.notEqual(first.source_msg_id, second.source_msg_id);
  for (const source_msg_id of ['x'.repeat(513), Number.MAX_SAFE_INTEGER + 1, {}, 'bad\nidentity']) {
    const a = room.ingest(comment(source_msg_id)), b = room.ingest(comment(source_msg_id));
    assert.equal(a.source_msg_id, '');
    assert.notEqual(a.event_id, b.event_id);
  }
  const snapshot = room.ingest({ event_type: 'viewer_snapshot', viewer_snapshot: {
    source: 'synthetic', presenceEvidence: 'unknown', complete: false,
    viewers: [{ userId: prefix + 'a' }, { userId: prefix + 'b' }]
  } });
  assert.ok(snapshot.viewer_snapshot.viewers.every(viewer => viewer.userId === undefined));
  const sc = normalizeEvent({ event_type: 'super_chat', super_chat_id: '1'.repeat(21) }, 'bilibili', 'room');
  assert.equal(sc.super_chat_id, undefined);
});
