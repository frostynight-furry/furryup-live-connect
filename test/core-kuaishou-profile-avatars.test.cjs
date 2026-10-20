// Copyright (c) 2026 FrostyNight.
// Extracted from the FurryUP Studio live-connect core; see LICENSE.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createKuaishouProfileAvatars, fetchKuaishouProfileAvatar } = require('../core/kuaishou-profile-avatars.cjs');
const { LiveEventStream } = require('../core/event-stream.cjs');
const { avatarInfo } = require('../core/avatar-cache.cjs');
const avatar = 'https://tx2.a.kwimgs.com/uhead/fixture.png';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const profile = (id, image = avatar) => json({ data: { userInfo: { id, avatar: image } } });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await wait(5); } assert.fail('Expected avatar result'); }
const event = (stream, id = 'viewer', extra = {}) => stream.push({ event_type: 'comment', user_id: id, content: 'hello', ...extra }, 'kuaishou', 'room');

test('profile lookup confines cookie to fixed endpoint and requires exact identity and allowed avatar host', async () => {
  const signal = new AbortController().signal;
  const options = { roomId: 'room', cookie: 'private-fixture-cookie', signal };
  const good = await fetchKuaishouProfileAvatar('viewer', { ...options, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://live.kuaishou.com/live_api/baseuser/userinfo/byid?principalId=viewer');
    assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit');
    assert.equal(request.headers.Cookie, options.cookie);
    assert.equal(request.headers.Referer, 'https://live.kuaishou.com/u/room');
    return profile('viewer');
  } });
  assert.deepEqual(good, avatarInfo(avatar, 'kuaishou'));
  for (const body of [
    { data: { userInfo: { id: 'someone-else', avatar } } },
    { data: { userInfo: { id: 'viewer', avatar: 'https://untrusted.example/private.png' } } },
    { result: 7, data: { userInfo: { id: 'viewer', avatar } } },
    { code: 403, data: { userInfo: { id: 'viewer', avatar } } },
    { data: { userInfo: { id: 'viewer', avatar, mystery: true } } },
  ]) assert.deepEqual(await fetchKuaishouProfileAvatar('viewer', { ...options, fetchImpl: async () => json(body) }), {});
  assert.deepEqual(await fetchKuaishouProfileAvatar('viewer', { ...options, fetchImpl: async () => json({ data: 'x'.repeat(128 * 1024) }) }), {});
});

test('comments arrive immediately; repeated users share lookup and cached avatars without replaying actions', async t => {
  const stream = new LiveEventStream(), interactions = [], updates = [];
  stream.on('event', item => interactions.push(item)); stream.on('viewer-avatar', item => updates.push(item));
  let finish, calls = 0;
  const resolver = createKuaishouProfileAvatars({ roomId: 'room', cookie: 'fixture', spacingMs: 0,
    fetchImpl: async () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    onAvatar: (item, info) => stream.updateViewerAvatar(item, info) });
  t.after(() => resolver.dispose());
  const first = event(stream), second = event(stream);
  resolver.resolve(first); resolver.resolve(second);
  assert.equal(interactions.length, 2); assert.equal(calls, 1); assert.equal(updates.length, 0);
  finish(profile('viewer')); await until(() => updates.length === 1);
  assert.equal(updates[0].event_id, second.event_id, 'latest observed message anchors moderation');
  assert.equal(stream.accepted, 2); assert.equal(stream.sequence, 2); assert.equal(interactions.length, 2);
  assert.ok(stream.history.every(item => item.avatar_id));
  assert.equal(resolver.enrich({ event_type: 'comment', user_id: 'viewer' }).avatar_url, avatar);
  assert.equal(calls, 1);
});

test('supplied gift avatar wins over stale profile; hidden and anonymous viewers never fetch or reuse identity cache', async t => {
  let finish, calls = 0; const updates = [], stream = new LiveEventStream();
  const resolver = createKuaishouProfileAvatars({ roomId: 'room', cookie: 'fixture', spacingMs: 0,
    fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); }, onAvatar: item => updates.push(item) });
  t.after(() => resolver.dispose());
  resolver.resolve(event(stream));
  const newer = avatar.replace('fixture', 'newer');
  resolver.enrich({ event_type: 'gift', user_id: 'viewer', avatar_url: newer });
  finish(profile('viewer')); await wait(15);
  assert.equal(updates.length, 0); assert.equal(resolver.enrich({ user_id: 'viewer' }).avatar_url, newer);
  for (const extra of [{ user_identity_hidden: true }, { preview: true }]) {
    const hidden = { event_type: 'comment', room_id: 'room', user_id: 'viewer', ...extra };
    resolver.resolve(hidden); assert.equal(resolver.enrich(hidden).avatar_url, undefined);
  }
  for (const user_id of ['', '0', 'OUTSIDE', 'unknown', 'anonymous']) resolver.resolve({ event_type: 'comment', room_id: 'room', user_id });
  resolver.enrich({ room_id: 'another-room', user_id: 'viewer', avatar_url: avatar });
  assert.equal(resolver.enrich({ user_id: 'viewer' }).avatar_url, newer);
  assert.equal(resolver.enrich({ room_id: 'another-room', user_id: 'viewer' }).avatar_url, undefined);
  assert.equal(calls, 1);
});

test('hidden raw share events neither consume nor seed a public profile avatar cache', async t => {
  const stream = new LiveEventStream(); let calls = 0;
  const resolver = createKuaishouProfileAvatars({ roomId: 'room', cookie: 'fixture', spacingMs: 0,
    fetchImpl: async () => { calls++; return profile('viewer'); },
    onAvatar: (item, info) => stream.updateViewerAvatar(item, info) });
  t.after(() => resolver.dispose());
  const comment = event(stream);
  resolver.resolve(comment); await until(() => Boolean(resolver.enrich({ user_id: 'viewer' }).avatar_id));
  const rawShare = { platform: 'kuaishou', room_id: 'room', event_type: 'share', user_id: 'viewer', user_identity_hidden: true };
  const hidden = stream.push(resolver.enrich(rawShare), 'kuaishou', 'room');
  resolver.resolve(hidden);
  assert.equal(hidden.user_identity_hidden, true);
  assert.equal(hidden.avatar_id, undefined, 'sharing never reveals the cached public avatar for mystery identity');
  const supplied = avatar.replace('fixture', 'hidden-message');
  assert.equal(resolver.enrich({ ...rawShare, avatar_url: supplied }).avatar_url, supplied,
    'platform-supplied hidden avatar remains local to the share');
  assert.equal(resolver.enrich({ user_id: 'viewer' }).avatar_url, avatar, 'hidden share cannot overwrite public identity cache');
  stream.updateViewerAvatar(comment, avatarInfo(avatar, 'kuaishou'));
  assert.equal(stream.history.find(item => item.event_id === hidden.event_id).avatar_id, undefined);
  assert.equal(calls, 1);
});

test('positive cache expires and new identities without a supplied login do not initiate profile requests', async t => {
  let clock = 1000, calls = 0;
  const stream = new LiveEventStream();
  const resolver = createKuaishouProfileAvatars({ roomId: 'room', cookie: 'fixture', spacingMs: 0, positiveTtlMs: 10,
    now: () => clock, fetchImpl: async () => { calls++; return profile('viewer'); } });
  t.after(() => resolver.dispose());
  resolver.resolve(event(stream)); await until(() => Boolean(resolver.enrich({ user_id: 'viewer' }).avatar_id));
  clock += 11; assert.equal(resolver.enrich({ user_id: 'viewer' }).avatar_id, undefined);
  resolver.resolve(event(stream)); await until(() => calls === 2);
  const anonymousSession = createKuaishouProfileAvatars({ roomId: 'room', fetchImpl: () => { throw new Error('Unexpected request'); } });
  anonymousSession.resolve(event(stream)); anonymousSession.dispose();
});

test('queue bounds, single request concurrency and spacing protect live ingestion', async t => {
  const stream = new LiveEventStream(), starts = []; let concurrent = 0, maximum = 0;
  const resolver = createKuaishouProfileAvatars({ roomId: 'room', cookie: 'fixture', spacingMs: 25, maxQueued: 2,
    fetchImpl: async url => {
      starts.push(Date.now()); concurrent++; maximum = Math.max(maximum, concurrent);
      await wait(8); concurrent--; return profile(new URL(url).searchParams.get('principalId'));
    } });
  t.after(() => resolver.dispose());
  for (let i = 0; i < 15; i++) resolver.resolve(event(stream, `viewer${i}`));
  await until(() => starts.length === 3); await wait(40);
  assert.equal(starts.length, 3); assert.equal(maximum, 1);
  assert.ok(starts[1] - starts[0] >= 20 && starts[2] - starts[1] >= 20);
  assert.equal(stream.accepted, 15);
});

test('request spacing starts after synchronous transport preparation, even when it consumes the original interval', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const stream = new LiveEventStream(), starts = [];
  const resolver = createKuaishouProfileAvatars({ roomId: 'room', cookie: 'fixture', spacingMs: 25,
    fetchImpl: async url => {
      // Deterministically model initial URL/transport setup or preemption before
      // the first observable request start, without relying on wall-clock load.
      if (!starts.length) t.mock.timers.tick(100);
      starts.push(Date.now());
      return profile(new URL(url).searchParams.get('principalId'));
    } });
  t.after(() => resolver.dispose());
  for (let i = 0; i < 3; i++) resolver.resolve(event(stream, `delayed-viewer-${i}`));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  assert.deepEqual(starts, [1100], 'A slow first transport start must not consume the interval before the next request');
  t.mock.timers.tick(24); await flush(); assert.equal(starts.length, 1);
  t.mock.timers.tick(1); await flush(); assert.deepEqual(starts, [1100, 1125]);
  t.mock.timers.tick(24); await flush(); assert.equal(starts.length, 2);
  t.mock.timers.tick(1); await flush(); assert.deepEqual(starts, [1100, 1125, 1150]);
});

test('negative cache and platform challenge cooldown prevent retries from subsequent comments', async t => {
  let clock = 1000, calls = 0;
  const stream = new LiveEventStream();
  const resolver = createKuaishouProfileAvatars({ roomId: 'room', cookie: 'fixture', spacingMs: 0, now: () => clock,
    negativeTtlMs: 10, cooldownMs: 100, fetchImpl: async () => { calls++; return calls === 1 ? profile('wrong-viewer') : json({ result: 400002 }); } });
  t.after(() => resolver.dispose());
  resolver.resolve(event(stream)); await wait(10);
  resolver.resolve(event(stream)); assert.equal(calls, 1);
  clock += 11; resolver.resolve(event(stream)); resolver.resolve(event(stream, 'queued')); await wait(10);
  resolver.resolve(event(stream, 'after-challenge')); clock += 50; resolver.resolve(event(stream, 'another'));
  assert.equal(calls, 2);
  for (const status of [401, 403, 429]) assert.deepEqual(await fetchKuaishouProfileAvatar('viewer', {
    roomId: 'room', cookie: 'fixture', signal: new AbortController().signal, fetchImpl: async () => new Response('', { status }) }), { cooldown: true });
});

test('HTTP 200 login, rate-limit and nested captcha responses pause new viewer lookups', async t => {
  for (const code of [2, 15, 16, 109, 2056, 60200, 400002, 7935]) {
    for (const body of [{ result: code }, { data: { result: String(code) } }]) {
      assert.deepEqual(await fetchKuaishouProfileAvatar('viewer', { roomId: 'room', cookie: 'fixture',
        signal: new AbortController().signal, fetchImpl: async () => json(body) }), { cooldown: true });
    }
  }
  for (const body of [{ result: 2056 }, { data: { result: 400002 } }]) {
    let calls = 0;
    const stream = new LiveEventStream();
    const resolver = createKuaishouProfileAvatars({ roomId: 'room', cookie: 'fixture', spacingMs: 0,
      fetchImpl: async () => { calls++; return json(body); } });
    t.after(() => resolver.dispose());
    resolver.resolve(event(stream, 'first'));
    await wait(10);
    for (let i = 0; i < 10; i++) resolver.resolve(event(stream, `new-viewer-${i}`));
    await wait(10);
    assert.equal(calls, 1, 'session-level errors stop requests even for different viewers');
    assert.equal(stream.accepted, 11, 'avatar cooldown never interrupts comments');
  }
});

test('timeout and disposal drop late responses without cancelling comments or leaking another session avatar', async t => {
  const stream = new LiveEventStream(); let finish, requestSignal, updates = 0;
  const resolver = createKuaishouProfileAvatars({ roomId: 'room', cookie: 'fixture', timeoutMs: 10,
    fetchImpl: (_, options) => { requestSignal = options.signal; return new Promise(resolve => { finish = resolve; }); }, onAvatar: () => updates++ });
  t.after(() => resolver.dispose());
  resolver.resolve(event(stream)); await until(() => requestSignal.aborted); finish(profile('viewer')); await wait(10);
  assert.equal(updates, 0); assert.equal(stream.accepted, 1);
  let late;
  const next = createKuaishouProfileAvatars({ roomId: 'room', cookie: 'fixture',
    fetchImpl: () => new Promise(resolve => { late = resolve; }), onAvatar: () => updates++ });
  next.resolve(event(stream)); next.dispose(); late(profile('viewer')); await wait(10);
  assert.equal(updates, 0);
  assert.equal(next.enrich({ user_id: 'viewer' }).avatar_url, undefined);
});
