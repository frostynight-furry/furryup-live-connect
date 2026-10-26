# 本人创作者后台粉丝采集

[English](CREATOR_FOLLOWERS.en.md)

0.8.0 在原 `profiles` API 之外新增 `createCreatorFollowerBrowser`。它只在宿主显式调用时，通过 Electron 打开平台官方创作者后台，让用户本人登录并读取自己的账号和粉丝统计。无需 FurryUP 账号或完整产品；导入模块不会启动 Electron、登录或联网，Electron 的 `BrowserWindow` 与 `session` 由宿主注入。原公开主页／OAuth／手动客户端的行为保持兼容。

| 平台 | 读取位置／返回 | 验证范围 |
| --- | --- | --- |
| B站 | 创作中心“粉丝总数”；本人 UID | 已有本人会话的真实读取及新进程复验通过；扫码后公共主页回跳有合成回归，未重新清空账号完成首次扫码复验 |
| 抖音 | 创作者中心“粉丝”卡；本人账号标识 | 真实读取及新进程复验通过 |
| 快手 | 官方登录回跳后读取本人 `coreUserInfo.fansNum` 与 `userId`；兼容页面卡片 | 真实读取及新进程复验通过 |
| 视频号 | 本人 `finderUser.fansCount` 与 `finderUsername`；兼容“关注者”卡片 | 真实读取及新进程复验通过；接受 HTTP 201 成功响应 |
| 小红书 | 创作者中心“粉丝数”与受限本人资料响应 | 只有合成测试；维护者没有可参与测试的账号，登录后的字段及实际读取未验证 |

上述实测来自本组件提取前同一实现的宿主验证，不代表所有账号、未来页面版本或长时稳定性。组件提取后的 Electron 测试全部使用合成页面和响应，不包含真实账号或平台原始数据。没有小红书直播采集器。

## 接入

```js
const { app, BrowserWindow, session } = require('electron');
const { createCreatorFollowerBrowser } = require('./profiles/index.cjs');
// Also exported by core/index.cjs. Run after app.whenReady().
let currentOwner = 'local-user-1'; // Host-owned local account ID, not a platform ID.
const reader = createCreatorFollowerBrowser({
  BrowserWindow, session,
  getAccount: () => ({ accountId: currentOwner }),
  partitionPrefix: 'my-app-followers',
  applicationName: 'My App',
  userAgentProductTokens: ['my-app']
});
const binding = await reader.connect({ owner: currentOwner, platform: 'douyin' });
// Persist this returned binding in the host's owner-scoped store.
const latest = await reader.lookup({ owner: currentOwner, platform: binding.platform,
  expectedIdentity: binding.accountId, identityKind: binding.identityKind });
// Explicitly disconnect only the selected owner/platform when requested:
// await reader.disconnect({ owner: currentOwner, platform: binding.platform });
reader.dispose();
```

宿主必须提供真实、随切号更新的 `getAccount()`；退出时可以返回 null 或 `{kind:'signed-out'}`。`owner` 必须与当前 `accountId` 一致；切号时取消在途窗口。每个 owner／平台对应独立持久分区，默认前缀 `liveconnect-followers`。前缀可设为 1～80 位小写字母、数字、点、下划线、短横线，已有宿主应保持原前缀以保留登录。`userAgentProductTokens` 仅用于视频号兼容，移除 UA 中指定应用标记，保留浏览器和操作系统版本。

`connect` 打开登录窗口，成功后返回新绑定；`lookup` 使用同一持久会话隐藏读取，核对 `expectedIdentity` 和 `identityKind`。`disconnect` 清理该 owner／平台的本机会话与缓存；`dispose` 关闭当前窗口、清理内存缓存，不删除登录。宿主负责保存／清除绑定，失败时保留旧快照并显示过期或错误状态；组件不写宿主数据。

默认登录上限 180 秒、刷新上限 25 秒、成功缓存 60 秒；选项分别为 `connectTimeoutMs`、`refreshTimeoutMs`、`cacheMs`，上限 600 秒，缓存允许 0。刷新需要交互时抛错，宿主可提供重新登录入口。同一分区的并发操作返回 `FOLLOWERS_BUSY`。

## 结果和失败

结果带有 `platform, accountId, identityKind, profileUrl, binding, displayName, status, precision, fetchedAt, dataAsOf`。`accountId` 是平台、身份类型和平台账号标识的 SHA-256，不能与公开主页 ID 或其他身份类型互换；`binding` 为 `creator_session`。`profileUrl` 是固定创作者入口，不是公共个人主页。

- `precision: 'exact'`／`status: 'ok'` 带 `followerCount`，真实 0 有效。
- `precision: 'approximate'`／`status: 'approximate'` 只带原始 `displayCount`，例如 `1.2万`；没有伪造的整数，不能计入准确合计／准确净增。
- 来源兼容现有快照字段 `source: 'public_page'`，另以 `acquisition: 'creator_center'` 明确属于本人登录后的创作者后台。不要向用户描述为匿名公开数据。
- `fetchedAt` 和 `dataAsOf` 都是本次读取时间，平台未提供统计源的更新周期，不表示平台实时精度保证。

错误仅暴露代码：`INVALID_PROFILE_URL`、`ACCOUNT_CHANGED`、`FOLLOWERS_BUSY`、`LOGIN_REQUIRED`、`LOGIN_CANCELLED`、`VERIFICATION_REQUIRED`、`PLATFORM_ACCOUNT_CHANGED`、`IDENTITY_UNAVAILABLE`、`COUNT_UNAVAILABLE`、`AMBIGUOUS_COUNT`、`PAGE_CHANGED`、`NETWORK_ERROR`、`UNTRUSTED_PAGE`。不要把失败转成 0。未知参数或缺少 Electron／身份提供器抛 TypeError。

远程页面没有 Node、preload 或宿主 IPC 权限，权限请求与下载被拒绝；顶层跳转限制在平台官方域名。CDP 只读取列入名单的本人资料／统计响应，限制响应大小、数量和导航生命周期。Cookie 保存在 Electron 本机分区，仅在内存核对必要的本人标识；返回值不含 Cookie、访问令牌或原始响应。登录／验证由用户在平台界面完成，不自动解决挑战或提取他人列表来推算粉丝数。

## 运行和验证

```sh
npm ci
npm run start:creator -- douyin
npm run test:profiles
npm run test:creator:electron
```

最后一项使用拦截的 HTTPS 合成页面与响应；不登录真实平台。Linux 需要图形会话，可用 `xvfb-run -a npm run test:creator:electron`。示例仅在明确传入平台后打开登录窗口；测试输出默认写入系统临时目录，或通过 `LIVECONNECT_TEST_ARTIFACTS` 指定私有证据目录。请勿提交运行生成的浏览器资料或账号记录。

## 调研与复用

沿用 2026-10-26 核验的开源调研：千帆云递 [social-auto-upload-web-ui](https://github.com/DevilJie/social-auto-upload-web-ui/tree/fbf79a49b639a1b762e4d5c4ec48c87094e860cd) 有五平台 `sync_profile`，适合参考后台指标位置；根 MIT 与 README 使用范围文案不一致，因此未复制其 Python 实现或引入发布器／隐身浏览器。F2（Apache-2.0）可作抖音资料参考，但不为单个统计引入下载器和签名维护；MediaCrawler 的非商业限制不适合作为产品复制依赖；已归档的 bilibili-api 不作新依赖。本适配复用现有 Electron 会话与 LiveConnect 的视频号 UA 兼容方式。

视频号 `auth_data` 字段另参考 wordweb/Get-Tencent-Video-Live-Barrage-Gifts 的字段描述；没有复制或执行其代码。快手与视频号实际本人响应的字段在宿主实测时核对。参考项目、官方网页代码、平台图片及真实账号材料均未分发，见 [第三方说明](../THIRD_PARTY_NOTICES.md)。
