'use strict';
// All IDs, catalogues and URLs below are synthetic. No network requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeWechatGiftCatalog, isGiftCatalogUrl, WechatGiftCatalog, MAX_CATALOG_ITEMS } = require('../wechat/wechat-gifts.cjs');
const { MAX_BODY } = require('../wechat/wechat-decoder.cjs');
const image = 'https://mmbiz.qpic.cn/synthetic-gift.png';
const catalog = rows => JSON.stringify({ errCode: 0, data: { giftList: rows } });
const row = (id = 'gift-42', url = image) => ({ rewardProductId: id, thumbnailFileUrl: url });
const gift = { event_type: 'gift', source_msg_id: 'synthetic-1', gift_id: 'gift-42',
  gift_name: '事件中的原名', gift_count: 2, gift_price_raw: '20', gift_price_unit: 'wechat_bean' };

test('官方目录字段仅按精确礼物ID补图，名称、数量、价格和去重身份保持原值', () => {
  const cache = new WechatGiftCatalog();
  assert.equal(cache.ingest(catalog([{ ...row(), name: '不可猜测的目录名', price: 999 }]), { liveId: 'room-a', order: 1 }), true);
  assert.deepEqual(cache.enrich(gift, 'room-a'), { ...gift, gift_image_url: image });
  assert.equal(cache.enrich(gift, 'room-b'), gift);
  assert.equal(cache.enrich({ ...gift, gift_id: 'missing' }, 'room-a').gift_image_url, undefined);
  assert.equal(cache.enrich({ ...gift, event_type: 'comment' }, 'room-a').gift_image_url, undefined);
  const existing = { ...gift, gift_image_url: 'https://mmbiz.qpic.cn/event.png' };
  assert.equal(cache.enrich(existing, 'room-a'), existing);
  cache.clear(); assert.equal(cache.enrich(gift, 'room-a'), gift);
});

test('目录路径、房间、礼物ID与图片域名严格验证，不猜测近似字段', () => {
  const url = 'https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/live/gift_enum_list';
  assert.equal(isGiftCatalogUrl(url + '?timestamp=123'), true);
  assert.equal(isGiftCatalogUrl(url.replace('/cgi-bin/', '/micro/live/cgi-bin/')), true);
  for (const value of [url.replace('https:', 'http:'), url + '/extra',
    url.replace('channels.weixin.qq.com', 'channels.weixin.qq.com.evil.test'),
    url.replace('https://', 'https://user@'), url.replace('.com/', '.com:8443/')]) assert.equal(isGiftCatalogUrl(value), false);
  const decoded = decodeWechatGiftCatalog(catalog([
    row(), row('unsafe-url', 'https://private.invalid/image'), row('credentials', 'https://u@qpic.cn/x'),
    row('x'.repeat(129)), row(' bad'), row(Number.MAX_SAFE_INTEGER + 1),
    { giftId: 'guessed', iconUrl: image }, { rewardProductId: 'wrong-image', iconUrl: image },
    row(42), row('duplicate'), row('duplicate', 'https://mmbiz.qpic.cn/conflicting.png')
  ]), { liveId: 'room-a' });
  assert.deepEqual([...decoded.gifts.keys()], ['gift-42', '42']);
  for (const liveId of ['', ' room', 'x'.repeat(129), 'room\n', null, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(decodeWechatGiftCatalog(catalog([row()]), { liveId }), null);
});

test('目录有界并过期，旧快照不能覆盖更新或重新启用已过期图片', () => {
  let now = 1000;
  const cache = new WechatGiftCatalog({ now: () => now, ttlMs: 50, maxRooms: 2, maxEntries: 2 });
  const ingest = (liveId, order, rows = [row()]) => cache.ingest(catalog(rows), { liveId, order });
  ingest('room-a', 2, [row(), row('second'), row('third')]);
  assert.equal(cache.rooms.get('room-a').gifts.size, 2);
  assert.equal(ingest('room-a', 1, [row('gift-42', 'https://qpic.cn/older')]), false);
  now += 51;
  assert.equal(cache.enrich(gift, 'room-a'), gift);
  assert.equal(ingest('room-a', 1), false);
  ingest('room-b', 3); ingest('room-c', 4);
  assert.equal(cache.rooms.size, 2);
  assert.equal(cache.rooms.has('room-a'), false);
  ingest('room-b', 5, []);
  assert.equal(cache.enrich(gift, 'room-b'), gift);
});

test('错误、缺字段、超量目录与超大响应不制造图片', () => {
  const request = { liveId: 'room-a' };
  for (const body of [JSON.stringify({ errCode: -1, data: { giftList: [row()] } }),
    JSON.stringify({ errCode: 0, data: { recordList: [row()] } }),
    catalog(Array.from({ length: MAX_CATALOG_ITEMS + 1 }, () => row()))])
    assert.equal(decodeWechatGiftCatalog(body, request), null);
  assert.throws(() => decodeWechatGiftCatalog('{', request));
  assert.throws(() => decodeWechatGiftCatalog('x'.repeat(MAX_BODY + 1), request));
});
