'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEvent, LiveEventStream } = require('../core/index.cjs');
const { decodeWechatResponse } = require('../wechat/wechat-decoder.cjs');
const Ajv = require('ajv');
const validate = new Ajv({strict:true}).compile(require('../schemas/live-event.v1.schema.json'));
test('four platforms keep multiple bounded badges without changing message/count identity', () => {
  for(const platform of ['bilibili','douyin','kuaishou','wechat']) {
    const stream = new LiveEventStream();
    const raw = {event_type:'comment',source_msg_id:'synthetic',content:'hello',user_badges:[
      {kind:'role',label:'房管'}, {kind:'fans',label:'合成团',level:300}, {kind:'wealth',label:'等级',level:38}]};
    const e=stream.push(raw,platform,'synthetic-room');
    assert.equal(e.user_badges.length,3); assert.equal(e.user_badges[1].level,300);
    assert.equal(validate(e),true,JSON.stringify(validate.errors)); assert.ok(Object.isFrozen(e.user_badges[0]));
    assert.equal(stream.push(raw,platform,'synthetic-room'),null);
    assert.equal(stream.push({...raw,source_msg_id:'new',user_badges:[]},platform,'synthetic-room').user_badges,undefined);
  }
});
test('invalid fields never leak image URLs, permissions, styles or unbounded lists', () => {
  const e=normalizeEvent({event_type:'comment',user_badges:[null,{kind:'admin',label:'bad'},
    {kind:'role',label:'  房管\n',level:-1,url:'javascript:bad',permissions:['admin']},
    {kind:'role',label:'房管'}, ...Array.from({length:90},(_,i)=>({kind:'title',label:'x'.repeat(100)+i,level:1001}))]},'kuaishou','r');
  assert.deepEqual(e.user_badges,[{kind:'role',label:'房管'},{kind:'title',label:'x'.repeat(64)}]);
  const old=normalizeEvent({event_type:'comment',badge_name:'旧粉丝牌',badge_level:9},'bilibili','r');
  assert.deepEqual(old.user_badges,[{kind:'fans',label:'旧粉丝牌',level:9}]);
});
test('WeChat badges stay on their own sender and unknown enums do not become titles', () => {
  const badgeInfos=[{badgeType:5,badgeLevel:10},{badgeType:2,badgeLevel:38},{badgeType:4,badgeLevel:14},{badgeType:12,badgeLevel:1},
    {badgeType:5,badgeLevel:999},{badgeType:999,badgeLevel:1}];
  const result=decodeWechatResponse(JSON.stringify({errCode:0,data:{liveInfo:{liveId:'synthetic'},
    msgList:[{type:1,content:'hello',finderLiveContact:{contact:{username:'a'},badgeInfos}}],
    appMsgList:[{msgType:20006,fromUserContact:{contact:{username:'b'},badgeInfos:[{badgeType:5,badgeLevel:3}]}}]}}));
  assert.equal(result.events[0].user_badges.length,4);
  assert.equal(result.events[0].user_badges[0].label,'房管');
  assert.deepEqual(result.events[1].user_badges,[{kind:'role',label:'助手'}]);
});
