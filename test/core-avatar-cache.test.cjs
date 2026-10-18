// Copyright (c) 2026 FrostyNight.
// Extracted from the FurryUP Studio live-connect core; see LICENSE.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { avatarInfo, createAvatarCache } = require('../core/avatar-cache.cjs');
const { normalizeEvent } = require('../core/event-stream.cjs');
const event = (url = 'https://i0.hdslb.com/bfs/face/test.png', platform = 'bilibili') => normalizeEvent({event_type:'comment',content:'hello',avatar_url:url}, platform, 'room');

test('avatars are optional, restrict public platform image domains, and normalize URLs', () => {
  for (const [platform,url] of [['bilibili','https://i0.hdslb.com/face.png'],['douyin','https://p3-pc.douyinpic.com/avatar.png'],['kuaishou','https://tx2.a.yximgs.com/uhead/a.png'],['kuaishou','https://tx2.a.kwimgs.com/uhead/a.png']]) {
    assert.match(event(url,platform).avatar_id, /^[a-f0-9]{64}$/);
  }
  assert.equal(event('https://tx2.a.kwimgs.com.evil.example/uhead/a.png','kuaishou').avatar_id,undefined);
  for (const url of ['',null,'file:///private','data:image/png;base64,abc','https://127.0.0.1/a','https://i0.hdslb.com.evil.example/a','https://user:secret@i0.hdslb.com/a','https://i0.hdslb.com:123/a','https://i0.hdslb.com/a\nb','https://p3.douyinpic.com/a']) {
    const result = event(url); assert.equal(result.content,'hello'); assert.equal(result.avatar_id,undefined);
  }
  assert.equal(avatarInfo('//i0.hdslb.com/a','bilibili').avatar_url,'https://i0.hdslb.com/a');
});

test('avatar requests coalesce and cache successes; missing images cache failure without placeholders', async t => {
  let calls = 0;
  const cache = createAvatarCache({fetchImpl:async (url,options) => {
    calls++; assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'manual'); assert.equal(options.headers.Cookie,undefined);
    return url.endsWith('missing.png') ? new Response(null,{status:404}) : new Response('image-bytes',{headers:{'content-type':'image/png'}});
  }}); t.after(cache.stop);
  const a = event(); cache.register(a);
  const results = await Promise.all([cache.get(a.avatar_id),cache.get(a.avatar_id)]);
  assert.equal(calls,1); assert.equal(results[0].body.toString(),'image-bytes');
  await cache.get(a.avatar_id); assert.equal(calls,1);
  const b = event('https://i0.hdslb.com/missing.png'); cache.register(b);
  assert.equal(await cache.get(b.avatar_id),null); assert.equal(await cache.get(b.avatar_id),null); assert.equal(calls,2);
  assert.equal(await cache.get('unknown'),null);
});

test('Kuaishou catalog gift images pass normalization and cache without allowing lookalike hosts', async t => {
  const url = 'https://p66-live.wskwai.com/bs2/gift/test.png';
  const gift = normalizeEvent({ event_type:'gift', gift_count:1, gift_image_url:url }, 'kuaishou', 'room');
  assert.equal(gift.gift_image_url, url);
  assert.match(gift.gift_image_id, /^[a-f0-9]{64}$/);
  for (const hostile of [
    'https://p66-live.wskwai.com.evil.example/gift.png',
    'https://evilwskwai.com/gift.png',
    'https://user:secret@p66-live.wskwai.com/gift.png',
    'https://p66-live.wskwai.com:123/gift.png'
  ]) {
    assert.equal(normalizeEvent({ event_type:'gift', gift_count:1, gift_image_url:hostile }, 'kuaishou', 'room').gift_image_id, undefined);
  }
  for (const platform of ['bilibili', 'douyin', 'wechat']) {
    assert.equal(normalizeEvent({ event_type:'gift', gift_count:1, gift_image_url:url }, platform, 'room').gift_image_id, undefined);
  }
  const cache = createAvatarCache({ fetchImpl:async (requested, options) => {
    assert.equal(requested, url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Cookie, undefined);
    return new Response('gift-image', { headers:{ 'content-type':'image/png' } });
  } });
  t.after(cache.stop);
  cache.register({ platform:gift.platform, avatar_url:gift.gift_image_url, avatar_id:gift.gift_image_id });
  const result = await cache.get(gift.gift_image_id);
  assert.equal(result.type, 'image/png');
  assert.equal(result.body.toString(), 'gift-image');
});

test('avatar proxy rejects foreign redirects, non-image bodies and oversized downloads', async t => {
  for (const response of [
    () => new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}),
    () => new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}}),
    () => new Response('huge',{headers:{'content-type':'image/png','content-length':String(3*1024*1024)}}),
    () => new Response(Buffer.alloc(2*1024*1024+1),{headers:{'content-type':'image/jpeg'}})
  ]) {
    let calls = 0; const cache = createAvatarCache({fetchImpl:async () => {calls++;return response();}}); t.after(cache.stop);
    const a = event(); cache.register(a); assert.equal(await cache.get(a.avatar_id),null); assert.equal(calls,1);
  }
});

test('avatar downloads are concurrency bounded and timeout or shutdown releases requests', async () => {
  let active = 0, peak = 0;
  const cache = createAvatarCache({timeoutMs:60,fetchImpl:async (_url,{signal}) => {
    active++; peak=Math.max(peak,active);
    try { await new Promise((resolve,reject) => { if(signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}); }); }
    finally { active--; }
  }});
  const requests=[];
  for(let i=0;i<12;i++){const a=event(`https://i0.hdslb.com/${i}.png`);cache.register(a);requests.push(cache.get(a.avatar_id));}
  // Keep the event loop alive while the cache's unref'ed production timers expire.
  const keepAlive=setTimeout(()=>{},500);
  assert.ok((await Promise.all(requests)).every(result=>result===null));clearTimeout(keepAlive);
  assert.ok(peak<=4);assert.equal(active,0);
  const a=event('https://i0.hdslb.com/stop.png');cache.register(a);const pending=cache.get(a.avatar_id);cache.stop();assert.equal(await pending,null);
});

test('injected fetch and body streams that ignore AbortSignal still settle on timeout or stop', async () => {
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const stalled = createAvatarCache({ timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
    const a = event(); stalled.register(a);
    assert.equal(await stalled.get(a.avatar_id), null); stalled.stop();
    let cancelled = 0;
    const body = new ReadableStream({ cancel() { cancelled++; } });
    const streaming = createAvatarCache({ fetchImpl: async () => new Response(body, { headers: { 'content-type': 'image/png' } }) });
    streaming.register(a); const pending = streaming.get(a.avatar_id);
    await new Promise(resolve => setTimeout(resolve, 5)); streaming.stop();
    assert.equal(await pending, null); assert.equal(cancelled, 1);
  } finally { clearTimeout(keepAlive); }
});
