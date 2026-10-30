# 安卓抖音钱包连接器（待实机验收）

[English](ANDROID_REVENUE.en.md) · [四平台同步](REVENUE_SYNC.md) · [钱包账单语义](DOUYIN_WALLET.md)

新增 `createDouyinWalletAndroidReader`：在本人安卓抖音的官方收入账单网页中，尝试调用 App 原生身份与只读请求桥接，再交给既有钱包解析、按月核对及历史保存模块。代码通过合成测试，**尚未验证实际手机可连接、身份字段可读取或真实账单可用**。它是有明确前提的实验实现，不是已经接通的手机登录方案。

## 必须具备的条件

本人安卓设备已通过 USB 授权调试、已登录官方抖音，并且钱包页面所在 App WebView 允许调试。电脑使用已有的 [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)，向组件传入 `adb` 的绝对路径和私有授权目录。

[Android 官方说明](https://developer.android.com/develop/ui/views/layout/webapps/debug-chrome-devtools)要求 App 自行允许 WebView 调试。**仅开启手机 USB 调试并不保证抖音钱包网页可以连接。** 若官方 App 未提供调试通道，返回 `REVENUE_MOBILE_WEBVIEW_UNAVAILABLE`，本连接器便不可用；组件不尝试修改 App、强制开启调试、提权、读取私有数据库、导出 Cookie 或绕过手机验证。iPhone 尚无此连接器。

读取时手机需要在线且官方钱包页面保持可用。后台同步不打开页面、不弹登录、不解锁手机。设备离线或页面消失会退避重试；是否能在特定机型锁屏后继续运行，尚未验证。

## 已核实与待核实的协议

2026-10-30 检查的[官方账单页资源](https://lf1-cdn-tos.bytegoofy.com/goofy/ies/live/webcast_douyin/res/pages/wallet/bill/index.4eb76c.js)通过 `app.fetch` 读取收入账单；[官方 SDK 注册资源](https://lf1-cdn-tos.bytegoofy.com/goofy/ies/live/webcast_douyin/res/common/vendor.684694.js)将其映射为 `ToutiaoJSBridge.call('fetch',...)`，并注册 `userInfo` 与 `openLive` 登录面板。这里只引用接口事实，没有复制或分发官方代码。

固定钱包地址为 `https://webcast.amemv.com/falcon/webcast_douyin/page/wallet/bill/index.html?bill_type=income`。固定请求是 `GET https://wallet-activity.amemv.com/webcast/wallet_api/get_billing_list/`，参数、分页和金额处理与[钱包文档](DOUYIN_WALLET.md)一致。页面原生请求封装负责当前会话，组件不生成手机签名或转存认证信息。

公开注册代码未确定本机 `userInfo` 回调的实际结构。当前严格校验候选字段 `uid/user_id/userId`：只接受唯一、一致、非零的十进制身份；精度不安全、字段缺失或冲突均拒绝。身份在手机页面中哈希后返回 `identityKind:'native_uid'`，原始 UID 不离开页面。该字段处理仅以合成响应测试，必须在本人设备上确认后才能升级验收状态。

网页 `account-cookie-uid_tt` 绑定与安卓 `native_uid` 绑定含义不同，**不自动共用账号哈希或合并金额**。即使是同一人的同一抖音号，也应分别展示来源；后续可靠确认映射前不能按昵称关联，更不能把两份相同收入相加。

## API 与持久化

```js
const path = require('node:path');
const { createDouyinWalletAndroidReader, createCreatorRevenueSync,
  createCreatorRevenueFileStore } = require('./revenue/index.cjs');

// sdkAdbPath / privateDataDirectory 均由宿主配置为绝对路径。
const reader = createDouyinWalletAndroidReader({
  adbPath: sdkAdbPath,
  authDirectory: path.join(privateDataDirectory, 'android-auth'),
  getAccount: () => currentHostAccount
});
const devices = await reader.inspect({ owner: currentHostAccount.accountId });
// 本人选择设备后，在交互连接中建立绑定；多个设备时必须选择 deviceId。
const snapshot = await reader.connect({ owner: currentHostAccount.accountId,
  deviceId: selectedDeviceId, openPage: true, fromMonth: '2026-09', toMonth: '2026-09' });
const binding = { accountId: snapshot.accountId, identityKind: snapshot.identityKind,
  deviceId: snapshot.deviceId };
// 宿主保存 binding；后续启动可直接恢复该绑定，不必再次 connect。
const sync = createCreatorRevenueSync({
  owner: currentHostAccount.accountId, platform: 'douyin', ...binding,
  getAccount: () => currentHostAccount, reader, initialLedger: snapshot,
  store: createCreatorRevenueFileStore({ directory: path.join(privateDataDirectory, 'revenue-sync') }),
  onStatus: status => updateSyncStatus(status)
});
await sync.start();
// 退出时：sync.dispose(); await reader.dispose();
```

`inspect` 返回设备哈希、型号及授权状态，不返回原始设备序列号。`connect` 是交互建立绑定；`openPage:true` 只打开固定官方收入页。如果桥接明确返回未登录，可请求 App 自身登录面板，本人完成后重新调用 `connect`。页面加载慢或未就绪时也需在其打开后重试。`lookup` 必须提供 `expectedIdentity/identityKind/deviceId`，不自动打开任何页面或登录界面。

每次读取前后检查宿主账号、App 身份和页面；每次账单请求还前后核对身份。页面换址、账号切换、断线或超时使采集失败，未核对的整月不保存。每月最多 100 页，单响应上限 2 MiB，月份合计必须对账。所得 snapshot 标记 `binding:'native_session'`、`sessionReuse:'android_native_bridge'`、`authenticationValidation:'synthetic_only'`，后者描述适配器的验收范围。

连接只选择官方 `com.ss.android.ugc.aweme` 进程对应的 WebView 调试 socket，通过本机 loopback 转发访问；同一设备只允许一个钱包读取器正在采集。多个钱包页会拒绝选择，避免读取错误页面。结束／失败时关闭本次连接并移除本次转发，不关闭手机 App 或其他 ADB 会话。[CDP Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) 与 [Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/) 用于固定脚本执行和导航检查，不对外提供任意请求接口。

默认原生调用超时 8 秒、账单采集超时 90 秒；设备发现及连接阶段另有逐命令时间上限。`adbPort` 默认 5037，可指定已有独立服务器端口。ADB 可能在私有授权目录生成标准设备授权密钥；它们不写入账本或日志，宿主必须保留在应用私有目录，不能打进源码包。

## 独立示例

```sh
# 将下列绝对路径替换为本机 SDK 与源码目录之外的私有数据目录。
npm run start:revenue:android -- --adb=/absolute/sdk/platform-tools/adb --data=/absolute/private-data --inspect
npm run start:revenue:android -- --adb=/absolute/sdk/platform-tools/adb --data=/absolute/private-data --connect --watch
# 建立绑定后，后续进程直接恢复：
npm run start:revenue:android -- --adb=/absolute/sdk/platform-tools/adb --data=/absolute/private-data --watch
```

Windows 使用带盘符的绝对路径，含空格时为整个 `--adb=...` 或 `--data=...` 参数加引号。可选 `--device=<inspect 返回的哈希>`、`--port=5049`、`--from=YYYY-MM`。无 `--watch` 时只执行一批；Ctrl+C 停止。示例不要求 Electron，且同一数据目录只应运行一个实例。日志仅包含连接状态、同步进度与目录，不打印金额或原始账单。

## 视频号视频激励的剩余缺口

电脑端[官方收入卡片](https://res.wx.qq.com/t/wx_fed/finder/helper/content/finder-helper-content/res/static/js/async/880.4945ce38.js)给出手机微信入口 `https://channels.weixin.qq.com/assistant-support/pages/creator-home/income`，附带本人账号标识；它不是已核实的金额 API。未认证访问该网页返回页面校验失败。[腾讯广告官方说明](https://training.tencentads.com/uploads/202406/lUKWuerT_DtCfUk.pdf)展示手机创作者中心内的广告收入／创作分成操作，但未提供可复用的账单接口契约。

目前没有添加猜测的金额端点、微信私有数据库读取或会员收入替代实现。四平台公共同步和历史保存已实现；视频号视频激励自动读取仍缺实机中的入口、身份和按月响应字段。需本人手机实际打开对应页面后确认这些事实，再补适配器和独立合成用例。已实现的视频号直播结算不受此缺口影响，详见[收益来源表](CREATOR_REVENUE.md)。

## 手机连接后的验收项

先确认官方 App 是否暴露所需网页，以及原生身份回调能否可靠绑定本人。随后对照一个已结束月份的视频激励、直播入账和总额，检查分页、入账日期、历史下限及分类标签；再验证重新启动、断线、过期登录和换号时不会串账。只记录通过／失败、字段形状和覆盖范围，不提交 Cookie、设备序列号、原始 UID、订单号、真实金额或官方页面包。

`test/revenue-android.test.cjs` 目前验证合成桥接调用、固定端点、身份冲突、页面切换、登录界限、超时、设备互斥、ADB 归属/本机转发及清理，并与公共月同步器联测。测试通过不能替代上述实机验收。
