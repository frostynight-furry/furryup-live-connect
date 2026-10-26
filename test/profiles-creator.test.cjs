'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { parseCount, allowedNavigation, identityResponseKind, identityFromResponse, PLATFORMS } = require('../profiles/creator-page.cjs');
const { partitionFor, identityHash } = require('../profiles/creator-electron.cjs');
const at = '2026-10-26T10:00:00.000Z';

test('exact zero and grouped counts are distinct from rounded and missing counts', () => {
  for (const [input, output] of [['0', 0], ['1,234', 1234], ['12，345', 12345], ['10000000000', 10000000000]]) assert.deepEqual(parseCount(input), { precision: 'exact', followerCount: output });
  for (const input of ['1.2万', '1亿', '12K', '999+', '1.25M']) {
    assert.equal(parseCount(input).precision, 'approximate'); assert.equal(parseCount(input).followerCount, undefined);
  }
  for (const input of ['', '—', 'null', '-1', '1,23', '1 2', '1.2', '01', '10000000001', {}, null]) assert.equal(parseCount(input), null);
});
test('login navigation cannot escape the platform or load privileged protocols', () => {
  for (const [platform, config] of Object.entries(PLATFORMS)) assert.equal(allowedNavigation(platform, config.url), true);
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'http://creator.douyin.com', 'https://creator.douyin.com.evil.test/', 'https://creator.douyin.com:9999/', 'https://x:secret@creator.douyin.com/', 'https://127.0.0.1/']) assert.equal(allowedNavigation('douyin', url), false);
});
test('only self-info allowlisted responses can identify an account', () => {
  const url = 'https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data';
  assert.equal(identityResponseKind('wechat_channels', url), 'finder');
  assert.equal(identityResponseKind('douyin', url), null);
  assert.equal(identityResponseKind('wechat_channels', url.replace('channels.weixin.qq.com', 'evil.test')), null);
  assert.equal(identityResponseKind('wechat_channels', url.replace('auth_data', 'user_list')), null);
  assert.deepEqual(identityFromResponse('finder', { errCode: 0, data: { finderUser: { finderUsername: 'account@finder', nickname: 'Own account' } } }), { kind: 'finder', value: 'account@finder', displayName: 'Own account' });
  assert.equal(identityFromResponse('finder', { errCode: -1, data: { finderUser: { finderUsername: 'wrong' } } }), null);
  assert.equal(identityFromResponse('bili', { code: 0, data: { mid: 123, isLogin: false } }), null);
  assert.equal(identityFromResponse('xhs', { success: true, data: { user_id: '0123456789abcdef01234567', nickname: 'Name', token: 'secret' } }).value, '0123456789abcdef01234567');
});
test('persistent sessions and identities are isolated per host owner and platform', () => {
  assert.notEqual(partitionFor('owner-a', 'douyin'), partitionFor('owner-b', 'douyin'));
  assert.notEqual(partitionFor('owner-a', 'douyin'), partitionFor('owner-a', 'bilibili'));
  assert.equal(partitionFor('owner-a', 'douyin').includes('owner-a'), false);
  assert.notEqual(identityHash('douyin', {kind:'handle',value:'a'}), identityHash('douyin', {kind:'handle',value:'b'}));
});
test('Kuaishou self statistics bind the returned user identity and preserve exact zero', () => {
  assert.equal(identityResponseKind('kuaishou','https://cp.kuaishou.com/rest/cp/creator/pc/home/userInfo'),'ks-stats');
  const body={result:1,data:{coreUserInfo:{userId:'12345',userName:'Own account',fansNum:0,token:'private'}}};
  const row=identityFromResponse('ks-stats',body);
  assert.equal(row.value,'12345');assert.deepEqual(row.count,{precision:'exact',followerCount:0});assert.equal(JSON.stringify(row).includes('private'),false);
  body.result=0;assert.equal(identityFromResponse('ks-stats',body),null);
  body.result=1;body.data.coreUserInfo.fansNum='1.3万';assert.equal(identityFromResponse('ks-stats',body).count.precision,'approximate');
  delete body.data.coreUserInfo.userId;assert.equal(identityFromResponse('ks-stats',body),null);
});
test('Channels statistics use the authenticated finder identity and never default absent fans to zero', () => {
  const body={errCode:0,data:{finderUser:{finderUsername:'fixture@finder',nickname:'Own account',fansCount:0}}};
  assert.deepEqual(identityFromResponse('finder',body).count,{precision:'exact',followerCount:0});
  delete body.data.finderUser.fansCount;assert.equal(identityFromResponse('finder',body).count,undefined);
  body.errCode=-1;assert.equal(identityFromResponse('finder',body),null);
});

test('host configuration is explicit and session namespaces do not collide', () => {
 const { createCreatorFollowerBrowser } = require('../profiles/index.cjs');
 assert.equal(require('../core/index.cjs').createCreatorFollowerBrowser, createCreatorFollowerBrowser);
 assert.throws(() => createCreatorFollowerBrowser(), /required/);
 const options = { BrowserWindow: function(){}, session: { fromPartition(){} }, getAccount:()=>({accountId:'fixture'}) };
 assert.doesNotThrow(() => createCreatorFollowerBrowser(options));
 for(const partitionPrefix of ['', 'unsafe/path', 'persist:wrong', 'x'.repeat(81)]) assert.throws(() => createCreatorFollowerBrowser({...options,partitionPrefix}), /partition/);
 for(const cacheMs of [-1,NaN,Infinity,600001]) assert.throws(() => createCreatorFollowerBrowser({...options,cacheMs}), /cache/);
 assert.throws(() => createCreatorFollowerBrowser({...options,userAgentProductTokens:['x/y']}), /agent/);
 assert.notEqual(partitionFor('owner','douyin'),partitionFor('owner','douyin','custom-host'));
});
