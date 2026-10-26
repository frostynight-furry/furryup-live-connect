'use strict';
// Real Electron windows/session/CDP with intercepted HTTPS fixtures. No real
// platform login, cookie import or external request is performed by this test.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(process.env.LIVECONNECT_CREATOR_ROOT || path.join(__dirname, '..'));
const { createCreatorFollowerBrowser, partitionFor } = require(path.join(root, 'profiles/creator-electron.cjs'));
const { PLATFORMS } = require(path.join(root, 'profiles/creator-page.cjs'));
const artifacts = path.resolve(process.env.LIVECONNECT_TEST_ARTIFACTS || path.join(os.tmpdir(), 'liveconnect-creator-fixture-' + process.pid));
const report = { state:'running', simulated:true, livePlatformValidation:false, checks:[], interceptedRequests:0 };
let owner='fixture-owner', mode='normal', browser, lastWindow, scratch, landingVisits=0, ksLoginVisits=0;
const pass = label => { report.checks.push(label); console.log('PASS '+label); };
class TestWindow extends BrowserWindow {
  show() {} // Keep automated fixtures hidden even when the adapter tests login.
  focus() {}
  constructor(options) {
    assert.equal(options.webPreferences.sandbox,true); assert.equal(options.webPreferences.nodeIntegration,false);
    assert.equal(options.webPreferences.contextIsolation,true); assert.equal(options.webPreferences.preload,undefined);
    super({...options,show:false}); lastWindow=this;
  }
}
function html(platform) {
  if (mode==='login') return '<p>请先登录，扫码登录</p>';
  if (mode==='challenge') return '<p>请完成安全验证</p>';
  if (mode==='missing') return '<p>自己的账号</p>';
  if (platform==='kuaishou' && mode==='ks-api') return '<p>Own creator account</p><script>fetch("/rest/cp/creator/pc/home/userInfo")</script>';
  if (platform==='bilibili') return '<div class="fan-item"><span class="fan-label">粉丝总数</span><span class="fan-num">0</span></div><div class="fan-item"><span>关注数</span><span class="fan-num">999</span></div>';
  if (platform==='douyin') return '<div class="statics-item-hash"><span>'+(mode==='rounded'?'1.2万':'1,234')+'</span><span>粉丝</span></div><div class="statics-item-hash"><span>关注</span><span>88</span></div>';
  if (platform==='kuaishou') return '<div class="user-info-dpd" onclick="document.getElementById(\'pop\').style.display=\'block\'">账号</div><div id="pop" style="display:none"><div class="user-cnt__item">56<span>粉丝</span></div><div class="user-cnt__item">99<span>关注</span></div></div>';
  if (platform==='wechat_channels') return '<div class="finder-content-info"><div><span>视频</span><span class="finder-info-num">999</span></div><div><span>关注者</span><span class="finder-info-num">78</span></div></div><script>fetch("/cgi-bin/mmfinderassistant-bin/auth/auth_data",{method:"POST"})</script>';
  return '<div class="description-text"><div><span class="numerical">90</span><span>粉丝数</span></div><div><span class="numerical">99</span><span>关注数</span></div></div><script>fetch("https://edith.xiaohongshu.com/api/sns/web/v1/user/selfinfo")</script>';
}
app.disableHardwareAcceleration(); app.on('window-all-closed',()=>{});
(async()=>{
  scratch=await fs.mkdtemp(path.join(os.tmpdir(),'creator-followers-electron-')); app.setPath('userData',scratch);
  await app.whenReady(); console.log('Electron ready');
  for (const platform of Object.keys(PLATFORMS)) {
    const s=session.fromPartition(partitionFor(owner,platform));
    await s.protocol.handle('https', request=>{
      report.interceptedRequests++;
      if(platform==='bilibili' && mode==='bili-landing') {
        if(new URL(request.url).hostname==='www.bilibili.com') { landingVisits++;return new Response('<html>Logged in</html>',{headers:{'content-type':'text/html'}}); }
        if(!landingVisits) return new Response('<script>location.href="https://www.bilibili.com/"</script>',{headers:{'content-type':'text/html'}});
      }
      if(platform==='kuaishou' && mode==='ks-login') {
        if(new URL(request.url).hostname==='passport.kuaishou.com') {
          ksLoginVisits++;return new Response('<script>location.href="https://cp.kuaishou.com/profile"</script>',{headers:{'content-type':'text/html'}});
        }
        if(!ksLoginVisits) return new Response('<p>立即登录</p>',{headers:{'content-type':'text/html; charset=utf-8'}});
      }
      if(request.url.includes('/auth/auth_data')) return new Response(JSON.stringify({errCode:0,data:{finderUser:{finderUsername:'fixture@finder',nickname:'Fixture Channels',fansCount:78}}}), {status:201,headers:{'content-type':'application/json'}});
      if(request.url.includes('/user/selfinfo')) return new Response(JSON.stringify({success:true,data:{user_id:'0123456789abcdef01234567',nickname:'Fixture XHS'}}), {headers:{'content-type':'application/json','access-control-allow-origin':'*'}});
      if(request.url.includes('/rest/cp/creator/pc/home/userInfo')) return new Response(JSON.stringify({result:1,data:{coreUserInfo:{userId:'54321',userName:'Fixture KS',fansNum:155}}}),{headers:{'content-type':'application/json'}});
      return new Response('<!doctype html><meta charset="utf-8"><style>body{font-family:sans-serif}div,span{min-height:12px}</style>'+html(platform),{headers:{'content-type':'text/html; charset=utf-8'}});
    });
    const cookie={bilibili:['DedeUserID','123'],douyin:['uid_tt','fixture-user-a'],kuaishou:['userId','12345']}[platform];
    if(cookie) await s.cookies.set({url:PLATFORMS[platform].url,name:cookie[0],value:cookie[1],secure:true,expirationDate:Date.now()/1000+86400});
  }
  const create=()=>createCreatorFollowerBrowser({BrowserWindow:TestWindow,session,getAccount:()=>({accountId:owner}),connectTimeoutMs:5000,refreshTimeoutMs:2200,cacheMs:0});
  browser=create(); const rows={}; console.log('Isolated fixtures ready');
  for (const [platform,count] of Object.entries({bilibili:0,douyin:1234,kuaishou:56,wechat_channels:78,xiaohongshu:90})) {
    rows[platform]=await browser.connect({owner,platform});
    assert.equal(rows[platform].followerCount,count); assert.equal(rows[platform].status,'ok'); assert.equal(lastWindow.isDestroyed(),true);
    pass(platform+': secure Electron creator window identifies its own account and reads the correct follower metric');
  }
  mode='rounded'; let value=await browser.lookup({owner,platform:'douyin',expectedIdentity:rows.douyin.accountId,identityKind:rows.douyin.identityKind});
  assert.equal(value.status,'approximate'); assert.equal(value.displayCount,'1.2万'); assert.equal(value.followerCount,undefined);
  pass('Rounded creator count is preserved without manufacturing an exact integer');
  for(const [scenario,code] of [['login','LOGIN_REQUIRED'],['challenge','VERIFICATION_REQUIRED'],['missing','COUNT_UNAVAILABLE']]) {
    mode=scenario;
    await assert.rejects(browser.lookup({owner,platform:'douyin',expectedIdentity:rows.douyin.accountId,identityKind:rows.douyin.identityKind}),{code});
    assert.equal(lastWindow.isDestroyed(),true);
  }
  pass('Login, challenge and missing-count failures remain distinct and always release their windows');
  mode='normal'; const dy=session.fromPartition(partitionFor(owner,'douyin'));
  await dy.cookies.set({url:PLATFORMS.douyin.url,name:'uid_tt',value:'fixture-user-b',secure:true});
  await assert.rejects(browser.lookup({owner,platform:'douyin',expectedIdentity:rows.douyin.accountId,identityKind:rows.douyin.identityKind}),{code:'PLATFORM_ACCOUNT_CHANGED'});
  pass('A different platform account cannot overwrite the bound identity');
  browser.dispose(); browser=create();
  value=await browser.lookup({owner,platform:'bilibili',expectedIdentity:rows.bilibili.accountId,identityKind:rows.bilibili.identityKind});
  assert.equal(value.accountId,rows.bilibili.accountId);
  pass('A new adapter instance reuses the isolated persistent session and stable identity');
  await session.fromPartition(partitionFor(owner,'bilibili')).cookies.set({url:'https://www.bilibili.com/',domain:'.bilibili.com',name:'DedeUserID',value:'123',secure:true});
  await session.fromPartition(partitionFor(owner,'bilibili')).cookies.set({url:'https://www.bilibili.com/',domain:'.bilibili.com',name:'SESSDATA',value:'synthetic-session',secure:true});
  mode='bili-landing';
  value=await browser.connect({owner,platform:'bilibili'});
  assert.equal(landingVisits,1);assert.equal(value.followerCount,0);assert.equal(value.accountId,rows.bilibili.accountId);
  pass('Bilibili returns from its authenticated public landing page to the creator center before reading');
  mode='ks-login';value=await browser.connect({owner,platform:'kuaishou'});
  assert.equal(ksLoginVisits,1);assert.equal(value.followerCount,56);
  pass('Kuaishou opens its official login page once and reads only after returning to the creator center');
  mode='ks-api';value=await browser.connect({owner,platform:'kuaishou'});
  assert.equal(value.followerCount,155);assert.equal(value.identityKind,'user_id');assert.notEqual(value.accountId,rows.kuaishou.accountId);
  pass('Kuaishou reads exact fans and the same user identity from its actual creator response contract');
  mode='normal';
  await browser.disconnect({owner,platform:'bilibili'}); assert.equal((await session.fromPartition(partitionFor(owner,'bilibili')).cookies.get({})).length,0);
  assert.equal((await dy.cookies.get({})).length>0,true);
  pass('Disconnect clears only the selected platform session');
  mode='login'; const pending=browser.connect({owner,platform:'douyin'}); setTimeout(()=>{owner='other-owner';},200);
  await assert.rejects(pending,{code:'ACCOUNT_CHANGED'}); assert.equal(lastWindow.isDestroyed(),true);
  pass('Switching the host account cancels and closes an in-progress platform login');
  report.state='passed';
})().catch(error=>{report.state='failed';report.error=error.stack;console.error(error);}).finally(async()=>{
  browser?.dispose(); await fs.mkdir(artifacts,{recursive:true}); await fs.writeFile(path.join(artifacts,'acceptance.json'),JSON.stringify({...report,scratch},null,2));
  console.log(JSON.stringify({state:report.state,checks:report.checks.length,artifacts}));app.exit(report.state==='passed'?0:1);
});
