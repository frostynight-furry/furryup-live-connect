# 本人创作者收益：抖音、B站、快手与视频号

[English](CREATOR_REVENUE.en.md) · [粉丝数会话](CREATOR_FOLLOWERS.md)

新增[四平台自动同步](REVENUE_SYNC.md)与[抖音安卓连接器](ANDROID_REVENUE.md)。实验性[钱包来源](DOUYIN_WALLET.md)支持按入账月分页、明确标签的视频激励/直播分类、核对及历史保存。网页会话复用与安卓原生身份均未实账验证；安卓还依赖官方 App 允许网页调试，不能视为手机认证已接通。

独立 `revenue/` 模块可以复用 FUS 等 Electron 宿主已有的本人创作者会话，读取平台收益、保存已获得的明细、查询历月记录，并导入规范化 CSV 补录历史。支持 `bilibili/douyin/kuaishou/wechat_channels`，各来源的自动读取范围见下表；视频号视频激励目前需补录，不能宣称四平台所有收益均已自动接通。

这是独立编写的网页适配器，使用平台当前创作者页面的读取接口，并非平台承诺稳定的开放 API。**实现已做合成数据和真实 Electron 流程验证，尚无本模块的真实收益账号验收。** 返回值 `adapterValidation: 'synthetic_only'` 描述适配器的验收范围；不表示登录后的实际数据是演示数据。接入产品前须在本人账号上与对应收益页核对金额和日期。

## 当前范围与历史边界

| 来源 | 已实现 | 边界 |
| --- | --- | --- |
| B站月度报告 | 自然月总额及后台返回的创作激励、直播等分类，逐月读取 | 查询范围遵循当前页面的近六个月；报告可能因收入门槛、权限或更新时间不可用，返回月份必须与请求一致 |
| B站收益总览 | 昨日、近 30 日、近一年金额 | `annual_amt` 是近一年，不是历年累计；不把可提现余额、贝壳、礼物流水当成收入 |
| B站收益趋势 | 后台返回的近 30 日记录 | 页面说明不含小店、签约、课堂等项目；与月度报告使用不同 `scope` |
| 抖音收益中心 | 全部及后台返回分类的昨日/近 7 日/近 30 日汇总，分类累计，近 30 日明细 | “全部累计”视图的趋势仍受近 30 日限制；总览和星图页未显示的累计不制造为总累计 |
| 抖音主播工作台 | 当天、近 7 日、近 30 日汇总，以及可确认日期的近 30 日趋势；入口 `anchor/dashboard/home` | 独立选择 `anchor_dashboard` 来源；按接口元数据保留单位，音浪不换算人民币，也不宣称是钱包结算净收入 |
| 抖音手机钱包（实验性） | 固定月账单、分页核对、明确视频/直播标签、历史同步及安卓原生桥接代码 | 选择 `wallet`；网页登录复用及安卓身份/账单待实测，App 必须允许网页调试；入账月不等于收益发生月，合并分类不猜拆分 |
| 快手视频激励 | 创作者激励合作的个人成员结算月账单，分页核对本人 ID 与账期 | 仅该激励计划，不涵盖所有广告、任务、快接单计划；历史选择器下限 2019-08，权限/迁移可能导致不可用 |
| 快手直播 | 自定义日期范围的直播送礼收入日趋势，按自然月汇总 | 2019-04 起、截至昨天、每段不超过 31 天；是分析口径，非税后结算，缺失日不补零 |
| 视频号直播结算 | 从本人助手跳转官方结算平台，读取平台可见的月账单及收入类型 | 需要主结算主体可用、本人验证通过及账单权限；机构/工作室附加主体不自动选择，历史齐全性不承诺 |
| 视频号视频激励 | 识别电脑端入口权限；规范化账单补录后可按月统计及持久化 | 当前电脑端返回手机查看提示和卡片，没有已核实的金额接口；自动读取报告 `REVENUE_VIDEO_INCENTIVE_MOBILE_REQUIRED` |
| 更早的历史 | 保存以后每次同步到的明细，或导入规范化账单汇总 | 不能凭登录自动恢复平台未开放的全部历史；未覆盖月份保留缺失 |

抖音分类动态读取，不硬编码账号必须开通哪些收益计划。有子分类时采集叶子分类，避免父子重复相加；付费视频当前使用另一套专用页面，返回 `REVENUE_CATEGORY_ENDPOINT_UNSUPPORTED`。默认最多采集 24 个叶子分类，超限会报告 `REVENUE_CATEGORY_LIMIT`。分类名称中的“直播”“创作激励”等仅用于显示分类，不代表结算认证。

默认 `creator_center` 来源会报告 `REVENUE_ANCHOR_NOT_REQUESTED`，提醒宿主另行读取主播工作台。工作台适配对应[官方直播数据页](https://anchor.douyin.com/anchor/dashboard/home)的 `earnScore` 字段，不能将它与收益中心总额相加或当作全部直播结算净收入。

所有收益均为平台报告口径，保留 `provisional: true`，不承诺是扣税后到账金额。总额和分类明细不能再次相加；各 `scope` 也不能混加。

## 快手与视频号接入

```sh
npm run start:revenue -- kuaishou 2026-01 2026-09
npm run start:revenue -- wechat_channels 2026-01 2026-09
```

两者都使用默认 `creator_center` 来源。快手每次最多请求 24 个月，长历史分批调用后合并到同一个 ledger；旧月激励账单与按日直播趋势分别保存。当前月不查询未发布的激励结算，直播只到昨天。服务端不返回某月/某日时保持缺失；选择器允许某日期不代表该账号仍能访问对应历史。个人激励金额字段 `allAccount` 与直播 `receiveAmount` 均按元解释，不能套用快接单等其他页面的分单位。

快手从官方本人接口确认数值用户 ID，再使用页面自身的请求客户端发起固定只读 POST；视频号使用官方助手的请求封装附加当前登录参数。组件不复制签名算法或收集 Cookie。快手粉丝数绑定若只有 handle，须重新建立收益绑定；数值 ID 绑定只有服务端核对一致才可复用。视频号绑定使用本人 `finderUsername` 的哈希。

视频号从 `getRelatedMainPart` 返回的主结算主体发起原生授权跳转；授权码只在本次官方跳转中使用，不进入返回值、账本或日志。新钱包窗口必须实际完成这次登录，旧钱包会话不能代替；钱包读取前后会检查创作者身份与钱包 Cookie 是否变化。个人主体需要手机验证时返回 `REVENUE_ADDITIONAL_VERIFICATION_REQUIRED`，不会绕过验证。企业主体报告 `REVENUE_COMPANY_SETTLEMENT_SUBJECT_SCOPE`：金额属于平台所示结算主体，不能据此认定为某个创作者独占收入；附加工作室账本不包含在此次采集中。

结算月账单中已识别的类型为直播礼物、付费组队、付费直播、视频号会员、付费课程和付费剧集，分别保存，后面三类不归为视频激励。`totalIncome` 单位为万分之一元，仅在可精确转为分时入账；存在不足一分精度则报告 `REVENUE_SUBCENT_PRECISION`，不四舍五入。未结算余额 `unaccountedIncome`、提现记录和收入入口卡片都不生成收益。关闭月份的完整覆盖不代表已付款或税后到账；当月仍是部分覆盖。未知分类、重复账单或结构变化会拒绝该次月账单批次。

视频号视频激励可先将本人手机端或官方账单核对后的月合计转换为本文 CSV，以 `statement.video / video_incentive` 单独补录。该分类与直播结算分开查询，自动采集暂不可用不影响已存历史。FUS 宿主可使用[公共同步器](REVENUE_SYNC.md)定期刷新各来源及保存历史；它只在宿主进程运行时调度，不安装系统定时任务。

## 运行

```sh
npm ci
npm run demo:revenue
npm run start:revenue -- bilibili 2026-04 2026-09
npm run start:revenue -- douyin 2026-04 2026-09
npm run start:revenue -- douyin anchor_dashboard
```

`demo:revenue` 完全离线，输出显式 `synthetic: true`。`start:revenue` 打开官方登录页面；只有用户完成登录/验证。示例复用粉丝数示例的应用目录、owner 和分区，并把规范化记录保存到示例自身 `userData/revenue/`，文件名按平台和账号哈希隔离；重复运行合并记录。控制台会输出收益，请按个人数据保管日志。示例不是 FUS 私有产品的已集成界面。

## Electron 宿主接入

公开导出位于 `require('./revenue/index.cjs')`，也由根模块 `core/index.cjs` 导出。`BrowserWindow`、`session` 由宿主传入，因此纯 Node 的月报、CSV 与离线示例无需 Electron。

```js
const { createCreatorRevenueBrowser, createRevenueLedger } = require('./revenue/index.cjs');

// Electron 主进程，在 app.whenReady() 之后创建。
const revenue = createCreatorRevenueBrowser({
  BrowserWindow, session,
  getAccount: () => currentHostAccount, // { accountId, kind }; signed-out 拒绝采集
  partitionPrefix: 'liveconnect-followers' // 必须与原粉丝数实例一致
});

// 已绑定账号：传入原粉丝数绑定返回的身份；也可用 revenue.connect 首次登录。
const snapshot = await revenue.lookup({
  owner: currentHostAccount.accountId,
  platform: 'bilibili',
  expectedIdentity: followerBinding.accountId,
  identityKind: followerBinding.identityKind,
  fromMonth: '2026-04', toMonth: '2026-09'
});
const ledger = createRevenueLedger({
  platform: snapshot.platform, accountId: snapshot.accountId,
  state: previouslySavedLedger // 首次为 undefined；由宿主按 owner/平台/身份读取
});
ledger.ingest(snapshot);
const monthly = ledger.months({ scope: 'bilibili.monthly', categoryId: 'total',
  fromMonth: '2026-04', toMonth: '2026-09' });
const allStoredMonths = ledger.months({ scope: 'bilibili.monthly' });
const rollingAndLifetime = ledger.metrics();
const persistable = ledger.export(); // 宿主原子写入数据库/文件
revenue.dispose();
```

`connect({ owner, platform, ...range })` 显示登录页，成功后返回同样的 snapshot；它不依赖粉丝数卡片存在。`lookup` 隐藏读取，强制提供 `expectedIdentity`。范围必须同时提供 `fromMonth/toMonth`；缺省请求当前月及之前六个月。`ledger.months` 省略范围时只返回此序列最早到最晚已存月份，**不表示从账号创建以来历史齐全**；显式范围可显示中间或两端缺口。

抖音主播工作台使用相同 reader，明确指定来源；在 reader dispose 之前执行：

```js
const anchorSnapshot = await revenue.lookup({
  owner: currentHostAccount.accountId, platform: 'douyin', source: 'anchor_dashboard',
  expectedIdentity: douyinBinding.accountId, identityKind: douyinBinding.identityKind
});
// 使用该抖音身份的 ledger；不要写入上例的 B站 ledger。
const douyinLedger = createRevenueLedger({ platform: 'douyin', accountId: anchorSnapshot.accountId,
  state: previouslySavedDouyinLedger });
douyinLedger.ingest(anchorSnapshot);
const nativeSummaries = douyinLedger.nativeMetrics();
const nativeMonthly = douyinLedger.nativeSeries().map(series => ({ ...series,
  months: douyinLedger.nativeMonths({ ...series, fromMonth: '2026-01', toMonth: '2026-12' })
}));
const savedDouyin = douyinLedger.export();
```

当天按北京时间查询；近 7/30 日以平台返回的最新统计日期 `dataAsOf` 结束，分别向前取 7/30 个自然日。传入月份范围不会扩大平台查询窗口。三个汇总互相重叠，不相加；仅趋势中含完整年月日的点按日保存，空点保持缺失，当天总量始终 `complete:false`。跨月同步可以逐步补齐已保存月份，之后用 `export()` 持久化；宿主负责定期同步，组件不会安装后台任务。未保存且已超出窗口的历史不能自动恢复。

若 `earnScore` 元数据明确标为元、人民币元或 CNY，金额进入 `records/metrics`；音浪等其他单位进入 `nativeRecords/nativeMetrics`，`currency:null`，十进制数保存在 `value`，不填 `amountMinor`。按单位分别使用 `nativeMetrics()`、`nativeSeries()`、`nativeMonths({scope, categoryId, unit, ...range})`；缺失月份的 `value/observedValue` 都为 null，部分月份只有 `observedValue`。单位缺失或数据日期不明时报告问题，不猜单位、年份或分成比例。只包含平台原始单位的 snapshot 顶层 `currency` 也为 null。

复用登录要求同一 Electron `userData`、同一 owner、同一 `partitionPrefix`。原始 Cookie 不传出、不复制到另一套分区。宿主应串行执行同一平台的粉丝数与收益操作，在退出/切换宿主账号时 dispose 当前 reader，并为新账号创建 reader。`dispose` 只关闭本实例窗口，不清空共享登录；解除平台绑定沿用粉丝数实例的 `disconnect`，宿主另行管理已保存收益。

默认登录上限 180 秒、隐藏采集上限 90 秒、单次请求上限 8 秒、请求间隔 150 毫秒、单响应上限 2 MiB。视频号钱包交接最多 30 秒，并受外层总时限约束。只执行固定官方收益 GET/只读 POST 及本人原生登录交接；拒绝任意 URL、机构代查 talent ID、提现/转账/确认结算操作。窗口禁用 Node/预加载桥、启用隔离与 sandbox，限制官方平台导航、下载和权限。不会处理验证码或绕过验证。

B站在采集前后还会读取官方本人身份接口，核对服务端登录账号与已绑定 UID；不单凭 UID Cookie 接受收益。

## 数据结构

`snapshot` 包含 `schemaVersion:1`、`platform`、哈希 `accountId`、`identityKind`、`fetchedAt`、`records`、`metrics`、`issues`，按来源可含 `requestedMonths/categories/nativeRecords/nativeMetrics/dataAsOf`。`status` 为 `ok/partial/unavailable`；表示本次读取覆盖，不是整个平台全部历史是否完整。`historyComplete` 当前始终为 false。

`records` 的一条数据是一种收益口径、一个分类、一个日期或自然月的合计：`scope/categoryId/period/start/end/amountMinor/currency/complete/provisional/source/fetchedAt`。币种为 CNY，`amountMinor` 为整数**分的字符串**；例如 `"12345"` 为 123.45 元。合计使用 BigInt，避免浮点损失，支持负数调整；不接受小数分、缩写金额或缺失值转 0。

| scope | 用途 |
| --- | --- |
| `bilibili.monthly` | 月报，分类为 `total` 或 `enum:平台编号`，名称从 show_conf 读取 |
| `bilibili.trend` | 趋势日明细，仅同一口径内按月聚合 |
| `bilibili.overview` | 仅汇总 metrics，近一年不转换为历年累计 |
| `douyin.category` | 分类日明细与分类汇总；`total` 和各叶子分类分别保存 |
| `douyin.anchor` | 主播工作台 `earnScore`；人民币与平台原始单位分别保存，不能与收益中心相加 |
| `douyin.wallet_cashflow` | 钱包月度资金入账合计 `total`，可能含退款/转入，不是净收益 |
| `douyin.wallet_income` | 钱包明确标签的 `live/video_incentive` 入账月合计；需与有效 `statements` 一起保存 |
| `kuaishou.incentive_settlement` | 个人创作者激励月账单，分类 `video_incentive` |
| `kuaishou.live_trend` | 直播分析日收入，分类 `live_gifts`，每个日历日齐全才是完整月 |
| `wechat_channels.live_settlement` | 主结算主体月账单，分类 `live_gifts/live_team/live_paid/membership/paid_course/paid_drama` |
| 自定义如 `statement` | 规范化账单导入；默认与在线口径分开核对 |

`metrics` 保存最新的 `today/previous_day/rolling_7_days/rolling_30_days/rolling_year/lifetime` 汇总。滚动和累计汇总不会被拆成日/月记录，也不会与 records 相加。主播工作台当天单日值另存为未结束的日记录。持久化后通过 `fetchedAt` 判断是否陈旧。

`ledger.months()` 每月返回：

- `coverage: complete`：该口径有完整自然月记录或每个日历日都有明确值，`amountMinor` 可用；仍须注意 provisional。
- `coverage: partial`：只有部分日期，或月报含待更新项目；`amountMinor: null`，已观察金额单独放在 `observedAmountMinor`。
- `coverage: missing`：未获取；两个金额均为 null，不能显示为 0 元。

月度记录优先于同口径日明细，不重复相加。相同周期重复同步幂等，更新的 fetchedAt 覆盖旧值；相同时间却金额冲突会拒绝。跨账号、无效 CSV 或有冲突的批次整批拒绝，金额与原始单位记录一并原子校验。时间以 Asia/Shanghai 自然日处理。单个 ledger 的两类记录合计最多 50000 条周期记录、5000 条汇总；宿主负责持久化、备份、定期同步和敏感数据的访问保护。

## 历史账单补录

钱包保留口径 `douyin.wallet_cashflow/douyin.wallet_income` 必须与核对通过的逐月账单匹配，不能直接用 CSV 覆盖；相关补录使用独立 `statement.*` scope。钱包 `statements` 和自动同步器的说明见[专项文档](DOUYIN_WALLET.md)。

提供的是**规范化汇总 CSV 导入**，不是未经核对的“所有平台原始 Excel 自动兼容”。先把平台导出的账单按日期/收益分类汇总并核对单位，再转换成下列格式。不得把每笔礼物或提现作为收入合计行；重复日期/分类/口径会拒绝，不会猜测是否需要累加。

```csv
period,date,scope,category_id,category_name,amount_yuan
month,2025-08,statement,total,平台账单总额,123.45
month,2025-09,statement,total,平台账单总额,0.00
day,2025-10-01,statement,video,视频激励,-0.01
month,2025-10,statement.video,video_incentive,已核对的视频号视频激励,20.00
```

```js
const { importRevenueCsv } = require('./revenue/index.cjs');
ledger.ingest(importRevenueCsv({ text: csvText, platform: snapshot.platform,
  accountId: snapshot.accountId }));
const historical = ledger.months({ scope: 'statement', fromMonth: '2025-01', toMonth: '2025-12' });
```

支持 UTF-8 BOM、引号、CRLF、小数元转精确分；不支持 XLSX、任意列映射、交易明细自动求和或自动推定结算状态。导入依然保留 provisional。若确实与在线来源同一口径，可明确选用相同 scope/categoryId，以新账单更正相同周期；宿主应先展示给用户核对。

`examples/creator-revenue-electron.cjs` 已为四平台按平台/身份隔离 JSON 历史，启动时读取旧账本，合并后原子替换；示例使用固定本地宿主账号，FUS 接入时须换成真实宿主账号并隔离存储目录。历史补录后也须保存 `ledger.export()`；再次同步不会删除先前已存月份。`ledger.series()` 枚举分类后逐项调用 `ledger.months({ ...series })` 可以得到该口径所有已保存月份。

## 错误与验证

`ACCOUNT_CHANGED/PLATFORM_ACCOUNT_CHANGED` 使整次读取失败；不得把失败结果归到新账号。`LOGIN_REQUIRED/VERIFICATION_REQUIRED` 需回到官方登录页；`REVENUE_COLLECTION_TIMEOUT`、`REVENUE_BUSY`、`LOGIN_CANCELLED` 表示超时、同分区忙或窗口关闭。接口拒绝、结构变化、月份回退、历史超窗等则进入 `issues`，其他成功分类可以保留。无数据保持 unavailable，不用空数组推定零收入。

```sh
npm run test:revenue
npm run test:revenue:electron
npm run test:creator:electron
npm run demo:revenue
```

Electron 测试拦截分区内全部 HTTPS，用独立合成账号验证会话复用、跨域收益读取、零值、登录/验证、响应大小、超时、身份切换、并发/取消及资源释放。未登录真实平台，不是实账验收。真实验收应逐项与本人页面比对月报、分类和累计，记录日期范围及缺项，不把 Cookie、响应正文、账号数据或官方网页资源提交到仓库。

主播工作台用例另覆盖固定路由请求头、平台统计日期、三种汇总、跨月补齐、当日未结束、原始单位隔离、空趋势点、冲突日期和登录失效。只检查官方未登录接口的路由与登录错误，不代表本人账号中的单位、金额和日期格式已通过实测。

新增用例覆盖快手机构分页去重、账期/本人 ID 核对、缺日和精度错误；视频号手机验证、月账单万分元单位、未知分类、重复账单、余额排除和视频激励补录。第二组 Electron 回归验证页面原生请求封装、本人身份前后核对、新钱包授权、过期会话、钱包换号、双窗口超时与清理。所有账本数据及授权码均为独立合成值。

## 接口依据（2026-10-30 核对）

端点与字段来自官方公开前端资源，仅作为协议依据；未复制或分发官方实现：B站 [端点声明](https://s1.hdslb.com/bfs/static/upi-mono/income/js/income.3479.d88b7179fb460161.js)、[月报查询与六个月选项](https://s1.hdslb.com/bfs/static/upi-mono/income/js/income.9463.788aecb27220304a.js)、[趋势 days=30 及范围说明](https://s1.hdslb.com/bfs/static/upi-mono/income/js/income.3234.59ff9b02c1a469e8.js)、[收益状态与近一年口径](https://s1.hdslb.com/bfs/static/upi-mono/income/js/income.9028.8cb4eab5e3e3d274.js)；抖音 [收益明细页](https://lf-fe-creator.douyinstatic.com/obj/douyn-creator-scm-cdn/douyin_creator/fe/pc/static/js/revenue-detail.9397ab22.js)。这些网页读取接口可能变化，测试 fixture 仅由字段说明独立合成。参见 [第三方说明](../THIRD_PARTY_NOTICES.md)。

主播工作台依据：[官方入口](https://anchor.douyin.com/anchor/dashboard/home)、[日期范围与数据组件](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/ife/anchor/dashboard/static/js/async/home/page.da785d2b.js)、[汇总/趋势端点与 earnScore](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/ife/anchor/dashboard/static/js/async/35.33cb9100.js)、[请求路由配置](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/ife/anchor/dashboard/static/js/async/840.4249be76.js)。请求使用固定 `aid=477650`、`x-appid:3000`、`x-sub-web-id:1116`；带上述路由的未登录只读请求返回 `status_code:20003`。这些标识不是登录凭据；实际采集仍依赖本人官方页面会话。

快手依据：[创作者平台](https://cp.kuaishou.com/profile)、[激励月账单字段](https://p66-plat.wskwai.com/kos/nlav11104/static/ks-cp/js/incomeEncourage.6fd8b96f.js)、[直播送礼收入趋势](https://p66-plat.wskwai.com/kos/nlav11104/static/ks-cp/js/statisticsLive.17cf273c.js)、[固定端点、日期选择器与页面请求客户端](https://p66-plat.wskwai.com/kos/nlav11104/static/ks-cp/js/7565.ccc7dd62.js)。视频号依据：[收入卡片与手机提示](https://res.wx.qq.com/t/wx_fed/finder/helper/content/finder-helper-content/res/static/js/async/880.4945ce38.js)、[直播主主体与结算跳转](https://res.wx.qq.com/t/wx_fed/finder/helper/live/finder-helper-live/res/static/js/async/805.be559278.js)、[官方结算平台月账单/金额单位](https://res.wxqcloud.qq.com.cn/t/wx_fed/base/wecoin/income-platform/income-main-page/res/js/index.f61bc63e.js)。这些是页面实现事实，未构成平台对第三方接口稳定性或任意账号历史可见范围的承诺。
