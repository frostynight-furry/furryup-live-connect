# 抖音手机钱包：按月账单与自动同步（实验性）

[English](DOUYIN_WALLET.en.md) · [四平台收益文档](CREATOR_REVENUE.md)

已根据官方手机收入账单页实现固定读取接口、按月分页、视频激励/直播入账分类、历史保存和可恢复同步。另新增[安卓原生桥接连接器](ANDROID_REVENUE.md)和[四平台公共同步器](REVENUE_SYNC.md)。**尚未完成真实收益账号验收，网页登录复用和安卓原生身份均未证实。** `source:'wallet'` 仍为实验性接入，不代表手机登录已经接通；iPhone 未实现。

## 已核实的接口与登录边界

2026-10-30 检查的[官方手机收入账单页](https://webcast.amemv.com/falcon/webcast_douyin/page/wallet/bill/index.html?bill_type=income)及其[公开前端资源](https://lf1-cdn-tos.bytegoofy.com/goofy/ies/live/webcast_douyin/res/pages/wallet/bill/index.4eb76c.js)显示：

- 收入页通过 App 的原生请求桥接调用 `GET https://wallet-activity.amemv.com/webcast/wallet_api/get_billing_list/`。
- 月份参数 `start_time=YYYYMM`，分页参数 `page`、`count=20`、`last_max_time`；下一页游标取最后一笔的 `txn_time`。收入视图固定 `type=0&need_summary=1&is_income_record=1`。
- 返回 `billing_types`、`end_time`、`has_more`、按 `period` 分组的 `bill_list`；每组含 `income/outcome/bills`。`end_time` 用作日历的最早月份，不是最后可查月份，也不是账号创建时间。
- `money/income/outcome/balance` 按分展示；`sign` 为 0/1/2 时分别显示负号/正号/无符号。`txn_time` 是入账时间，不能据此还原视频产生收益的日期。

同一路径在 `creator.douyin.com` 的未登录探测返回 `status_code:20003`。这仅是候选网页路由的登录错误证据，**不证明已登录网页会话有钱包权限**。网页读取器在既有创作者页面中尝试该固定路径，返回 `sessionReuse:'experimental_creator_origin'`。新增安卓读取器则在官方手机钱包页尝试原生桥接，返回 `sessionReuse:'android_native_bridge'`，二者身份独立。安卓需要可调试 App WebView，尚待实机验证；不复制 Cookie、模拟手机签名或安装抓包工具。

`20003` 作为 `REVENUE_WALLET_SESSION_REQUIRED` 抛出，保留旧账单并暂停同步。可先在官方创作者页面重新登录；仍失败则应显示“需要手机钱包登录，当前自动同步不可用”，不能循环重试或提示读取成功。手机账单可以按主文档的规范化 CSV 手工补录到独立 `statement.*` 口径。

## 月份、金额与历史

使用同一 `createCreatorRevenueBrowser`，在调用中指定 `platform:'douyin', source:'wallet'`、本人绑定的 `expectedIdentity` 与 `identityKind:'account-cookie-uid_tt'`。昵称/handle 不能作为钱包身份。可以传入 `fromMonth/toMonth`；每次最多 24 个月，默认当前月及前六个月。查询只限本人会话，读取前后检查宿主账号、平台身份及页面导航，身份切换使整次采集失败。

```sh
npm run start:revenue -- douyin wallet 2026-01 2026-09
npm run start:revenue:wallet
npm run start:revenue:wallet -- --watch
npm run start:revenue:wallet -- --watch --login
```

第一条是指定范围的一次读取，按通用收益示例保存。后三条使用专门的钱包同步目录和检查点：首次建立创作者绑定，此后复用；无 `--watch` 只运行一个批次，`--watch` 保持进程并定期同步，`--login` 重新显示官方创作者登录。两类示例存储目录不同，不自动混合；示例固定本地宿主账号，FUS 需换成实际用户隔离。关闭进程后不会继续同步，也不会安装系统任务或手机后台服务。

账本分开提供两个口径：

| scope / categoryId | 含义 |
| --- | --- |
| `douyin.wallet_cashflow / total` | 官方月账单的收入端资金流水合计，可能含退款、转入等；不是净收益，也不是视频与直播之和 |
| `douyin.wallet_income / live` | 明确标为直播/礼物收益的正向入账 |
| `douyin.wallet_income / video_incentive` | 明确标为视频激励或创作者激励计划的正向入账 |

分类来自平台返回的名称和账单标签，不猜数字类型编号。仅接受明确类别；普通“视频收入”不等于激励，“直播/创作收入”保留 `creator_unsplit`，其他不明入账保留 `unknown`。提现、转账、充值、退款和余额不会计入这两个收益分类，也不自动冲减税前收益。缺少独立分类时不能给出视频或直播的零金额。任意未拆分/未知正向入账会使分类月合计保持部分覆盖；月现金流的核对结果仍可单独使用。

每月最多 100 页、2000 笔；必须分页结束或越过该月边界，并核对明细收入/支出分别等于月头的 `income/outcome`。金额、游标、月份、分类字典或汇总不一致则整月不保存。当前月始终是部分覆盖，旧月完整仅表示当次读到了可核对的整月账单，不代表最终结算、已扣税或未来不会更正。所有记录仍为 `provisional:true`，`historyComplete:false`。

已核对账单放在 `snapshot.statements`，包含月份、更新时间、入账时间口径、完整性标志、月头金额与规范化 `transactions`。交易只存哈希 ID、日期/秒时间、类型编号、方向、分金额、分类及平台类型名；不存原始订单号、余额、用户描述、原始响应或凭据。`ledger.ingest(snapshot)` 原子校验账单与月统计一致；更新的同月账单整体替换，删除已失效的旧分类，避免重复累加。单账本上限 1200 个月、50000 笔交易。

`ledger.statements({fromMonth,toMonth})` 返回历史明细副本，省略范围返回全部已保存账单。`ledger.months({scope:'douyin.wallet_income',categoryId:'live'})` 和 `categoryId:'video_incentive'` 返回各自已保存的月份。钱包按入账月统计，不能与收益中心的发生日趋势相加。钱包两个保留 scope 必须随有效 statement 一起写入，CSV 更正请使用独立 `statement.*`。

## FUS 宿主自动同步

以下保留原钱包专用同步器；新集成建议使用[四平台公共同步器](REVENUE_SYNC.md)，它也支持安卓 reader，并可显式迁移旧钱包 ledger。网页会话不能直接作为安卓原生身份绑定。

```js
const path = require('node:path');
const { createCreatorRevenueBrowser, createDouyinWalletSync, createRevenueFileStore,
  createRevenueLedger } = require('./revenue/index.cjs');

// 在 app.whenReady() 之后。下列账号、绑定和目录由宿主提供。
const reader = createCreatorRevenueBrowser({ BrowserWindow, session,
  getAccount: () => currentHostAccount });
const sync = createDouyinWalletSync({
  owner: currentHostAccount.accountId,
  accountId: douyinBinding.accountId,
  identityKind: douyinBinding.identityKind,
  getAccount: () => currentHostAccount,
  reader,
  store: createRevenueFileStore({ directory: path.join(app.getPath('userData'), 'wallet-revenue') }),
  batchMonths: 6,
  onStatus: status => updateRevenueSyncStatus(status)
});
try { await sync.start(); } catch (error) { showRevenueSyncError(error.code); }
// 同步状态和已提交历史可供界面按需读取：
const status = sync.status();
const ledger = createRevenueLedger({ platform: 'douyin', accountId: douyinBinding.accountId,
  state: sync.export() });
const months = ledger.months({ scope: 'douyin.wallet_income', categoryId: 'live' });
// 用户退出/切换宿主账号或应用退出时调用，而不是紧接着 start 调用：
// sync.dispose(); reader.dispose();
```

默认每 6 小时刷新最近三个月，历史未查完时每 60 秒继续一个批次，每批最多尝试 6 个月。最早月份以接口返回的 `end_time` 为界；可传 `fromMonth` 缩小范围，不能用它扩大平台权限。已保存的旧月默认 30 天后再次核对，允许平台后续调整。配置名为 `intervalMs/backfillIntervalMs/historyRefreshMs/batchMonths/fromMonth`。

每成功核对一个月即原子保存检查点；重启恢复，失败月份下次重试。返回别的月份或无明细时记为 `no_data` 检查点，不生成零收入，也不覆盖已保存的有效账单。`pendingMonths:0` 仅表示所选范围已经检查过，可能仍有缺失数据，不能显示为“全部历史齐全”。网络失败退避重试，登录/账号失效暂停；本人完成登录后显式 `start()` 恢复。`syncNow()` 立即刷新最近月份并继续一个批次；同实例并发合并，同进程同绑定不同实例互斥。

`stop()` 取消后续调度，尚未返回的读取不能再写入；已开始的原子保存可能完成。`dispose()` 还会永久停用同步器，不自动关闭共享 reader。`status()` 和 `onStatus` 只包含状态、时间、错误码和进度；`export()` 返回最近提交的 ledger 副本，不包含检查点或会话。定时回调失败通过 `onStatus` 报告；首次 `start()/syncNow()` 的失败也会 reject，宿主必须处理。

文件存储按宿主 owner 哈希与抖音身份隔离，临时文件写入并同步后同目录替换；恢复时重新校验账单。正常文件只含规范化财务数据与检查点，不含 Cookie/签名。文件未加密，宿主负责目录权限、备份和加密策略。同一目录需只有一个宿主进程写同一账号；组件只有进程内锁。也可提供 `store.load(binding)` / `store.save(binding,state)` 接数据库，保存须原子完成；不要记录或外传整个状态作为遥测。

## 验证范围

`npm run test:revenue` 覆盖分页边界、重复账单、精确分金额、提现/退款排除、合并分类、月合计核对、幂等更正、账号隔离、断点恢复、退避、暂停、取消与磁盘失败。`npm run test:revenue:electron` 在完全拦截的 HTTPS 合成环境验证真实窗口、会话检查、钱包 GET、保存与自动暂停。没有真实收益数据，也没有声称安卓/iOS App 登录或历史权限已经验收。

实账接入仍需本人登录后，对照手机钱包核对一个已结束月份的视频激励、直播入账、入账日期与资金合计，确认分类标签、账户范围、历史下限及分页。若网页会话返回 20003，可在满足条件的安卓设备上验证新原生连接器；未经验证或 App 不允许调试时，不能报告自动获取成功。测试记录不要包含 Cookie、订单号或个人金额；官方资源仅作为字段依据，不分发官方代码。
