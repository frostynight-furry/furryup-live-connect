# 四平台自动同步与历史保存

[English](REVENUE_SYNC.en.md) · [收益字段与来源](CREATOR_REVENUE.md) · [安卓钱包](ANDROID_REVENUE.md)

`createCreatorRevenueSync` 将现有四平台读取器接入同一套定时刷新、逐月检查点和持久化流程。已完成合成数据及 Electron 流程验证，尚未完成真实收益账号验收。自动同步只能保存平台允许读取的数据；视频号视频激励仍没有已核实的金额接口，抖音安卓钱包仍需手机实测。

## 各来源如何同步

| 平台／来源 | 自动刷新范围 | 无法自动补回的部分 |
| --- | --- | --- |
| B站 | 当月近 30 日趋势、前六个完整自然月报告及总览 | 页面查询窗口外的旧月；未发布／无权限报告 |
| 抖音收益中心、主播工作台 | 近 30 日数据及各来源可见汇总；保存后按月累积 | 首次同步之前已离开滚动窗口的明细；音浪不换成人民币 |
| 抖音钱包 | 最近三个月及接口最早月份以后的历史，逐月分页、核对和保存 | 需要有效钱包会话；混合标签不能拆分视频／直播；按入账月统计 |
| 快手 | 近三个月的个人激励账单与直播日趋势，分批回查至 2019-04 或指定起月 | 视频激励选择器始于 2019-08；只覆盖已实现的个人激励计划，日期可选不保证有历史权限 |
| 视频号 | 读取主结算主体的全部可见账单，按请求范围过滤；发现新月并保存更正 | 追加结算主体、平台未返回历史、需手机验证的会话，以及视频激励金额接口 |

默认每 6 小时刷新；快手／钱包待查历史每 60 秒继续一批，每批最多尝试 6 个月。最近三个月之外的已查月份默认 30 天重新核对。B站、抖音滚动页面、视频号结算页在每次到期时各读取一次自身支持的窗口，并非为每一个历史月重复打开同一页面。`fromMonth` 只缩小范围。

视频号视频激励明确返回 `REVENUE_VIDEO_INCENTIVE_MOBILE_REQUIRED`。不能用会员费、课程、剧集或直播收入替代。核对本人官方月账单后，可以用既有规范化 CSV 导入独立 `statement.video` 口径；补录同样可保存和查询历史，但不属于自动采集。

## Electron 宿主接入

```js
const path = require('node:path');
const { createCreatorRevenueBrowser, createCreatorRevenueSync,
  createCreatorRevenueFileStore, createRevenueLedger } = require('./revenue/index.cjs');

// app.whenReady() 后，宿主提供当前账号、已确认的平台绑定及 UI 回调。
const reader = createCreatorRevenueBrowser({ BrowserWindow, session,
  getAccount: () => currentHostAccount });
const sync = createCreatorRevenueSync({
  owner: currentHostAccount.accountId,
  platform: platformBinding.platform,
  accountId: platformBinding.accountId,
  identityKind: platformBinding.identityKind,
  getAccount: () => currentHostAccount,
  reader,
  store: createCreatorRevenueFileStore({ directory: path.join(app.getPath('userData'), 'revenue-sync') }),
  // 可选：fromMonth: '2026-01', batchMonths: 6,
  onStatus: status => updateSyncStatus(status)
});
await sync.start();
const ledger = createRevenueLedger({ platform: platformBinding.platform,
  accountId: platformBinding.accountId, state: sync.export() });
const saved = ledger.series().map(series => ({ ...series, months: ledger.months(series) }));
// 退出、宿主换号或停用采集时执行：sync.dispose(); reader.dispose();
```

首次绑定使用 `reader.connect({ owner, platform })`，将返回的 `accountId/identityKind` 与平台一起保存。后台同步用 `lookup`，不会自动弹出登录窗口。读取器核对宿主身份与平台身份；换号导致本轮失败，不能把新账号金额写进旧账本。不同平台各创建一个同步器，可共享同一 reader 和 store。

抖音网页身份默认同步 `creator_center/anchor_dashboard/wallet`，其余平台为 `creator_center`。`sources` 可选其中子集。抖音安卓身份 `native_uid` 只允许 `wallet`，还须提供绑定的 `deviceId` 和安卓 reader，详见[手机接入说明](ANDROID_REVENUE.md)。安卓绑定与网页绑定分别存储，不根据昵称自动合并。

## 调度、失败与界面状态

- `start()` 开始调度并立即执行一批；再次显式调用会尝试恢复登录暂停的来源。
- `syncNow({sources?})` 立即执行一批；不自动开启后续定时任务。运行中的同实例请求合并。
- `stop()` 停止后续调度并拒收迟到的读取结果；已进入原子保存的写入可能完成。
- `dispose()` 永久停用同步器，reader 由宿主另行释放。进程退出／睡眠期间不执行任务；应用重新启动时恢复持久化检查点。
- `status()/onStatus` 返回各来源状态、时间、问题码、`checkedMonths/pendingMonths`。不返回金额、Cookie 或原始接口正文。

来源的登录失败且无有效数据时记为 `needs_login`，该来源停止定时重试，其他来源继续。本人重新登录后显式 `start()` 或 `syncNow({sources:[...]})` 恢复。网络及临时错误按 60 秒起退避，上限为刷新间隔；设备离线等错误同样退避，不反复弹出登录。宿主／平台换号、存储损坏、磁盘写入失败会停用本同步器，调用方必须处理 `start()/syncNow()` 的拒绝及 `onStatus` 错误。

单个来源失败通常体现在返回的 `sources[].state/lastErrorCode/issues`，不一定使 `start()` reject。UI 不能只以 Promise 成功作为“全部同步成功”。来源有部分数据时仍可保存有效分类，同时保留缺项标记。

`checkedMonths` 是检查次数对应的不同月份数，`pendingMonths:0` 只表示待查列表耗尽。二者都不是“全部历史齐全”。逐月记录的 `no_data` 不生成零金额；已有有效钱包月账单不能被后来的空结果清除。月金额通过 ledger 的 `coverage/complete/provisional` 判断，累计汇总与日／月账单保留不同口径，不能混加。滚动来源没有逐月待查队列，`pendingMonths` 为 `null`。

配置项：`batchMonths` 1–24（默认 6），`intervalMs` 默认 6 小时，`backfillIntervalMs` 默认 60 秒，`historyRefreshMs` 默认 30 天，`fromMonth` 可选。正常刷新和补历史间隔至少 1 秒，历史复核周期不短于刷新周期且不超过 365 天。`now/timers` 可注入以进行合成测试。

## 保存、恢复与旧版本数据

`createCreatorRevenueFileStore({directory})` 要求绝对路径，按宿主 owner 哈希、平台、平台账号哈希与身份类型隔离。保存规范化 ledger、问题码、检查点和下次执行时间；先写临时文件、同步磁盘再同目录替换。恢复时重新校验结构和账单，单文件上限 32 MiB。不保存原始响应或网页登录凭据；财务数据本身未加密，宿主负责数据目录权限、备份和加密。应用数据目录应在源码仓库之外。

可替换成数据库：提供 `store.load(binding)` 和 `store.save(binding,state)`；save 必须原子提交。组件只有同进程同绑定互斥，同一账号的同一存储须由一个宿主进程负责。可持久化后查询任何已保存月份，不受本次接口滚动窗口影响。

新存储使用 `creator-revenue-<hash>.json` 与 `schemaVersion:2`，原钱包 `createDouyinWalletSync/createRevenueFileStore` 仍兼容，ledger 本身保持 schemaVersion 1。传入 `initialLedger` 可将旧 ledger 和规范化 CSV 记录幂等并入新存储；绑定不一致会拒绝，不覆盖较新记录，不删除旧文件。不要让两套调度器同时写同一逻辑账号。

```sh
npm run start:revenue:sync -- all --watch
npm run start:revenue:sync -- kuaishou --from=2026-01
npm run start:revenue:sync -- douyin --login --watch
```

示例使用已有创作者示例的数据目录，迁移相同身份的普通收益 ledger 及旧抖音钱包历史到 `revenue-sync`；保留旧文件。`--login` 重新显示官方登录流程，`--watch` 持续运行，否则各平台只执行一批。日志仅打印状态和保存位置。`all` 会依次建立尚未绑定的平台会话，需要本人完成各平台登录。

## 验证

`npm run test:revenue` 覆盖四平台调度、来源独立暂停、历史批次恢复、月份范围、已有补录保留、网络退避、换号、并发、取消及磁盘失败。Electron 合成回归检查实际窗口和分区中的四平台自动保存。这些测试未连接真实收益账号；安卓与视频号激励的剩余验证要求见[手机接入说明](ANDROID_REVENUE.md)。
