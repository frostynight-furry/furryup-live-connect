'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isViewerListUrl, decodeWechatViewersResponse } = require('../wechat/wechat-viewers.cjs');
const { normalizeEvent } = require('../core/index.cjs');
const body = liveContacts => JSON.stringify({ errCode: 0, data: { liveContacts } });

test('WeChat online-member reads visible contacts without claiming full coverage or inferring ranking/entry', () => {
  const result = decodeWechatViewersResponse(body([
    { displayNickname: '合成观众', contact: { username: 'synthetic-viewer', headUrl: 'https://wx.qlogo.cn/synthetic.png' },
      rewardAmountInHeat: 1000, rank: 1 },
    { displayNickname: '同名观众' }, { displayNickname: '同名观众' },
    { displayNickname: '重复', contact: { username: 'synthetic-viewer' } }
  ]), { liveId: 'synthetic-room' });
  const event = normalizeEvent(result.event, 'wechat', result.roomId);
  assert.equal(event.count, 0);
  assert.equal(event.count_mode, 'snapshot');
  assert.equal(event.viewer_snapshot.complete, false);
  assert.equal(event.viewer_snapshot.source, 'wechat-online-member');
  assert.equal(event.viewer_snapshot.presenceEvidence, 'online-list');
  assert.equal(event.viewer_snapshot.viewers.length, 3);
  assert.equal(event.viewer_snapshot.viewers[0].avatarUrl, 'https://wx.qlogo.cn/synthetic.png');
  assert.equal(event.viewer_snapshot.viewers[0].rank, undefined);
  assert.equal(event.viewer_snapshot.viewers[0].online, undefined);
  assert.equal(event.viewer_snapshot.viewers[1].userId, undefined);
});

test('WeChat viewer endpoint, route, response and images have bounded explicit contracts', () => {
  for (const prefix of ['', '/micro/live'])
    assert.ok(isViewerListUrl(`https://channels.weixin.qq.com${prefix}/cgi-bin/mmfinderassistant-bin/live/online_member?lang=zh`));
  for (const url of ['https://evil.example/cgi-bin/mmfinderassistant-bin/live/online_member',
    'https://channels.weixin.qq.com.evil.example/cgi-bin/mmfinderassistant-bin/live/online_member',
    'https://user:pass@channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/live/online_member',
    'http://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/live/online_member',
    'https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/live/reward_gains'])
    assert.equal(isViewerListUrl(url), false);
  for (const request of [{}, { liveId: ' room' }, { liveId: 'a'.repeat(129) }])
    assert.equal(decodeWechatViewersResponse(body([]), request).event, null);
  for (const payload of [{ errCode: 1, data: { liveContacts: [] } },
    { errCode: 0, data: { infoList: [] } }, { errCode: 0, data: { liveContacts: {} } }])
    assert.equal(decodeWechatViewersResponse(JSON.stringify(payload), { liveId: 'room' }).event, null);
  assert.deepEqual(decodeWechatViewersResponse(body([]), { liveId: 'room' }).event.viewer_snapshot.viewers, []);
  assert.throws(() => decodeWechatViewersResponse(body(Array.from({ length: 501 }, () => ({}))), { liveId: 'room' }));
  assert.throws(() => decodeWechatViewersResponse('x'.repeat(2 * 1024 * 1024 + 1), { liveId: 'room' }));
  const rows = decodeWechatViewersResponse(body([{ displayNickname: '合成', contact: { username: 'x'.repeat(129), headUrl: 'https://evil.example/image.png' } }]), { liveId: 'room' }).event.viewer_snapshot.viewers;
  assert.equal(rows[0].userId, undefined);
  assert.equal(rows[0].avatarUrl, undefined);
});
