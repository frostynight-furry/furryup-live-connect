# Own-account creator revenue: Douyin, Bilibili, Kuaishou and Channels

New [four-platform synchronization](REVENUE_SYNC.en.md) and an [Android Douyin connector](ANDROID_REVENUE.en.md). The experimental [wallet source](DOUYIN_WALLET.en.md) supports posting-month pagination, explicit video/live labels, reconciliation and saved history. Authenticated web reuse and native Android identity remain unverified on real accounts. Android also requires an App-debuggable WebView; working phone authentication is not claimed.

[中文](CREATOR_REVENUE.md) · [Follower sessions](CREATOR_FOLLOWERS.en.md)

The independent `revenue/` module reuses an Electron host's authenticated creator session, reads reported income, stores acquired periods, builds monthly reports and imports normalized historical CSV summaries. It supports `bilibili/douyin/kuaishou/wechat_channels` with the source limits below. Channels video incentive currently requires reconciled statement import; not all income is automatically accessible.

These independently authored adapters call the current creator website's read endpoints, not guaranteed public developer APIs. **Validation uses synthetic responses and real Electron execution, not a real revenue account.** `adapterValidation: 'synthetic_only'` describes the implementation's acceptance evidence; it does not label the data obtained from a signed-in account as synthetic. Compare dates and amounts against the account's actual pages before product deployment.

## Supported scope

| Source | Implemented | Limits |
| --- | --- | --- |
| Bilibili monthly report | Natural-month total and returned categories, including video incentive/live where present | Queries follow the current page's six-month selector; thresholds, permissions and publication dates can make reports unavailable; returned month must match |
| Bilibili overview | Previous day, rolling 30 days and rolling year | annual_amt is a rolling year, not lifetime; no conversion of withdrawal balances, shells or gift purchases into income |
| Bilibili trend | Returned recent 30-day observations | The page excludes shop, contract and course income; separate scope from the monthly report |
| Douyin revenue center | Aggregate/category recent summaries, category lifetime where shown, recent 30-day details | Selecting lifetime does not expose lifetime daily history; hidden lifetime totals for aggregate/Xingtu are not manufactured |
| Douyin anchor dashboard | Today, rolling 7/30-day summaries and dated recent 30-day trend points at anchor/dashboard/home | Select anchor_dashboard separately; preserve metadata units, without converting Yinlang to CNY or claiming net wallet settlement income |
| Douyin mobile wallet (experimental) | Monthly pagination/reconciliation, explicit video/live labels, saved history, sync and Android native bridge code | Select wallet; web reuse and native identity/bills require real acceptance, and the App must allow WebView debugging; combined labels stay unsplit and posting dates differ from earning dates |
| Kuaishou video incentive | Personal member settlement bills for the creator incentive cooperation plan, with pagination and owner/month verification | One plan, not every advertising/task/Kuaijiedan program; selector starts at 2019-08, subject to permissions/migration |
| Kuaishou live | Daily gift-income analytics over custom date ranges, aggregated by natural month | Selector starts at 2019-04, ends yesterday, maximum 31 days per range; not after-tax net settlement, missing days are not zero |
| Channels live settlement | Native own-account handoff to the official wallet, reading visible monthly bills and business types | Requires a usable primary settlement subject, verification and bill access; additional studio subjects are not selected; complete history is not guaranteed |
| Channels video incentive | Desktop eligibility discovery and monthly/persistent normalized statement import | The verified desktop endpoint supplies mobile instructions/cards, not amounts; automatic acquisition reports REVENUE_VIDEO_INCENTIVE_MOBILE_REQUIRED |
| Earlier history | Retain future synchronized observations or import normalized statements | Login alone cannot recover history the platform does not expose; unavailable months stay missing |

Douyin categories are discovered dynamically. For parents with subcategories, only leaves are collected, preventing parent/child double-counting. The paid-video page has a different implementation and yields `REVENUE_CATEGORY_ENDPOINT_UNSUPPORTED`. Collection is bounded to 24 leaves by default; overflow reports `REVENUE_CATEGORY_LIMIT`. Label-based display classification is not evidence of settlement.

The default `creator_center` source reports `REVENUE_ANCHOR_NOT_REQUESTED` to identify the separate dashboard source. The adapter reads `earnScore` from the [official anchor data page](https://anchor.douyin.com/anchor/dashboard/home). Do not add it to creator-center totals or label it complete net live settlement income.

Every amount remains `provisional: true`, reflecting reported platform income rather than guaranteed after-tax payouts. Never add an aggregate to its breakdown or combine distinct scopes.

## Kuaishou and Channels integration

```sh
npm run start:revenue -- kuaishou 2026-01 2026-09
npm run start:revenue -- wechat_channels 2026-01 2026-09
```

Both use the default `creator_center` source. Kuaishou accepts up to 24 months per acquisition; merge bounded historical batches into the same ledger. Closed incentive months and live daily analytics remain separate. Current-month incentive settlements are not requested; live observations end yesterday. An allowed date range does not prove that an account can still retrieve its entire history. Missing periods remain gaps. Both personal incentive `allAccount` and live `receiveAmount` use yuan, unlike the cent-based formatter on other Kuaishou business pages.

Kuaishou verifies the numeric owner ID using its official self endpoint and invokes the page's native client for fixed read-only POSTs. Channels uses the official helper client to attach its current session parameters. No signing implementation or cookie is copied out. A handle-only Kuaishou follower binding requires a new revenue binding; numeric follower bindings are reused only after server verification. Channels binds the hash of the authenticated finderUsername.

Channels uses only the primary subject returned by `getRelatedMainPart`. Its short-lived handoff code stays inside the official navigation and never enters results, ledgers or host logs. A new wallet window must complete this handoff; an existing wallet session alone is insufficient. Creator identity and wallet cookie state are checked around the read. Required personal phone verification reports `REVENUE_ADDITIONAL_VERIFICATION_REQUIRED`. Company accounts report `REVENUE_COMPANY_SETTLEMENT_SUBJECT_SCOPE`: income belongs to the displayed settlement subject and is not proven exclusive to one creator. Additional studio accounts are not included.

Known monthly wallet businesses are live gifts, paid teams, paid live, Channels membership, paid courses and paid drama. The last three are not video incentives. `totalIncome` uses ten-thousandths of a yuan and is accepted only when exactly convertible to cents; otherwise `REVENUE_SUBCENT_PRECISION` prevents rounding. Unsettled balance `unaccountedIncome`, withdrawals and eligibility cards never produce revenue records. Complete coverage of a closed month is not proof of payment or after-tax income; the current month remains partial. Unknown categories, duplicate bills or schema changes reject the monthly batch atomically.

For Channels video incentives, reconcile monthly figures from the owner's mobile view or official statement, then import canonical CSV under `statement.video / video_incentive`. Its months stay separate from live settlement and remain available when automatic collection is unavailable. Hosts can use the [shared scheduler](REVENUE_SYNC.en.md) to refresh sources and persist history while their process runs; it installs no operating-system scheduled tasks.

## Run

```sh
npm ci
npm run demo:revenue
npm run start:revenue -- bilibili 2026-04 2026-09
npm run start:revenue -- douyin 2026-04 2026-09
npm run start:revenue -- douyin anchor_dashboard
```

The demo is offline and explicitly synthetic. The Electron example opens the official login page for the user to complete login/verification. It shares the follower example's application directory, owner and session partition. Normalized records are merged under the example's `userData/revenue/`, separated by platform and hashed identity. Output contains personal revenue; protect logs accordingly. This is an integration example, not a completed FUS private-product UI integration.

## Host API

Exports are available through `revenue/index.cjs` and `core/index.cjs`. Electron objects are host-supplied; ledger, CSV and offline operations work in plain Node.

```js
const { createCreatorRevenueBrowser, createRevenueLedger } = require('./revenue/index.cjs');
// Main process, after app.whenReady(). Host variables below belong to the application.
const revenue = createCreatorRevenueBrowser({ BrowserWindow, session,
  getAccount: () => currentHostAccount, // { accountId, kind }; signed-out is rejected
  partitionPrefix: 'liveconnect-followers' });
const snapshot = await revenue.lookup({ owner: currentHostAccount.accountId, platform: 'bilibili',
  expectedIdentity: followerBinding.accountId, identityKind: followerBinding.identityKind,
  fromMonth: '2026-04', toMonth: '2026-09' });
const ledger = createRevenueLedger({ platform: snapshot.platform, accountId: snapshot.accountId,
  state: previouslySavedLedger }); // undefined on first use; storage isolated by host owner
ledger.ingest(snapshot);
const monthly = ledger.months({ scope: 'bilibili.monthly', categoryId: 'total',
  fromMonth: '2026-04', toMonth: '2026-09' });
const allStoredMonths = ledger.months({ scope: 'bilibili.monthly' });
const rollingAndLifetime = ledger.metrics();
const persistable = ledger.export(); // Persist atomically in the host database/file.
revenue.dispose();
```

`connect({ owner, platform, ...range })` opens an interactive login and returns the same snapshot shape; follower cards are unnecessary. `lookup` is hidden and requires `expectedIdentity`. Supply both range endpoints or neither; the default covers the current month and preceding six. Omitting a ledger query range covers the earliest through latest stored month of that series, **not the account's complete lifetime**. Explicit ranges show gaps at either end as well.

Select the Douyin anchor source on the same reader, before disposing it:

```js
const anchorSnapshot = await revenue.lookup({
  owner: currentHostAccount.accountId, platform: 'douyin', source: 'anchor_dashboard',
  expectedIdentity: douyinBinding.accountId, identityKind: douyinBinding.identityKind
});
// Use this Douyin identity's ledger, not the Bilibili ledger above.
const douyinLedger = createRevenueLedger({ platform: 'douyin', accountId: anchorSnapshot.accountId,
  state: previouslySavedDouyinLedger });
douyinLedger.ingest(anchorSnapshot);
const nativeSummaries = douyinLedger.nativeMetrics();
const nativeMonthly = douyinLedger.nativeSeries().map(series => ({ ...series,
  months: douyinLedger.nativeMonths({ ...series, fromMonth: '2026-01', toMonth: '2026-12' })
}));
const savedDouyin = douyinLedger.export();
```

Today uses Asia/Shanghai. The rolling ranges end at the platform's produced-data date, `dataAsOf`, and span 7/30 calendar days. A requested month range cannot expand that window. Overlapping summaries are never added. Only trend points with explicit full dates become daily records; null points remain missing and today's running value stays `complete:false`. Subsequent synchronization can complete stored months. Persist `export()` and schedule collection in the host; the component installs no background task. Expired, unsaved history cannot be reconstructed.

If earnScore metadata explicitly declares 元, 人民币元 or CNY, amounts enter `records/metrics`. Other units, including Yinlang, enter `nativeRecords/nativeMetrics` with `currency:null`, a decimal-string `value` and no `amountMinor`. Query each unit through `nativeMetrics()`, `nativeSeries()` and `nativeMonths({scope, categoryId, unit, ...range})`. Missing months have null value/observedValue; partial months expose observedValue only. Missing units or ambiguous dates produce issues rather than inferred conversion rates or years. A snapshot containing only native-unit values also has top-level `currency:null`.

Session reuse requires the same Electron userData, owner and partitionPrefix. Raw cookies are not exported or copied to another partition. Serialize follower/revenue operations for the same platform. Dispose readers when the host signs out/switches accounts, creating a new reader afterward. Dispose closes owned windows without clearing shared login; existing follower disconnect handles platform unbinding. The host separately manages saved income.

Defaults: interactive deadline 180 seconds, hidden deadline 90 seconds, request deadline 8 seconds, request interval 150 milliseconds, response limit 2 MiB. Channels wallet handoff has a 30-second limit within the overall deadline. Only fixed official GET/read-only POST endpoints and native own-account login handoffs are invoked; there is no arbitrary URL, agency talent lookup, withdrawal, transfer or settlement-confirmation API. Windows disable Node/preload bridges and enable context isolation, sandbox and web security; navigation, permissions and downloads are constrained. Verification is completed by the user, never bypassed.

Bilibili also checks its server-authenticated self identity before and after acquisition, rejecting a mismatched UID rather than relying on the UID cookie alone.

## Data and money semantics

Snapshots include schemaVersion 1, platform, hashed accountId, identityKind, fetchedAt, records, metrics and issues; requestedMonths/categories/nativeRecords/nativeMetrics/dataAsOf depend on the source. Status is `ok/partial/unavailable` for this acquisition, not a declaration of full platform history. `historyComplete` is always false in this implementation.

A record is an aggregate for one scope/category/day or natural month, with `scope/categoryId/period/start/end/amountMinor/currency/complete/provisional/source/fetchedAt`. CNY `amountMinor` is an integer **cent string**, e.g. `"12345"` represents CNY 123.45. BigInt aggregation preserves large values and negative corrections. Rounded, absent or fractional-cent inputs cannot become zero/exact income.

| scope | Meaning |
| --- | --- |
| bilibili.monthly | Monthly reports; total or enum:platform-number; names from show_conf |
| bilibili.trend | Daily trend, aggregated only within its own coverage definition |
| bilibili.overview | Summary metrics; rolling year is not lifetime |
| douyin.category | Daily/category summaries; total and leaves remain separate |
| douyin.anchor | Dashboard earnScore; CNY and native units are stored separately, not added to creator-center income |
| douyin.wallet_cashflow | Monthly incoming cash movements, total; may include refunds/transfers and is not net income |
| douyin.wallet_income | Explicit live/video_incentive postings by month, ingested together with verified statements |
| kuaishou.incentive_settlement | Personal creator-incentive monthly bills; video_incentive category |
| kuaishou.live_trend | Daily gift-income analytics; live_gifts category; complete months require every calendar day |
| wechat_channels.live_settlement | Primary-subject monthly bills; live_gifts/live_team/live_paid/membership/paid_course/paid_drama categories |
| Custom, e.g. statement | Normalized imports, separate until their scope is reconciled |

Metrics preserve the latest today, previous_day, rolling_7_days, rolling_30_days, rolling_year or lifetime summary. Rolling/lifetime values are never split into daily records or added to records. The dashboard's explicit current-day value is also retained as an incomplete daily observation. Inspect fetchedAt for freshness after persistence.

Monthly output distinguishes:

- `complete`: a complete month record or an explicit observation for every calendar day; amountMinor is available but may still be provisional.
- `partial`: some days only, or a report with pending items; amountMinor is null and observedAmountMinor shows the partial amount.
- `missing`: no observations; both amount fields are null, never zero.

A direct monthly record takes precedence over daily records in the same scope. Identical imports are idempotent, newer fetchedAt replaces older values, and conflicting same-time values are rejected. Invalid batches and cross-account imports are rejected atomically across monetary and native-unit values. Calendar days use Asia/Shanghai. Their combined ledger limits are 50000 period records and 5000 summary metrics. Persistence, backup, scheduled synchronization and access protection belong to the host.

## Historical statement import

Reserved wallet scopes `douyin.wallet_cashflow/douyin.wallet_income` require reconciled monthly statements and cannot be overwritten directly by CSV. Use a separate `statement.*` scope for imports. See the [wallet guide](DOUYIN_WALLET.en.md) for statements and automatic synchronization.

This is a **canonical aggregate CSV importer**, not an unverified universal importer for platform Excel exports. Reconcile exported statements, units and categories before conversion. Each row must be a daily/monthly aggregate, not an individual gift or withdrawal. Duplicate scope/category/date rows are rejected rather than guessed to be additive.

```csv
period,date,scope,category_id,category_name,amount_yuan
month,2025-08,statement,total,Statement total,123.45
month,2025-09,statement,total,Statement total,0.00
day,2025-10-01,statement,video,Video incentive,-0.01
month,2025-10,statement.video,video_incentive,Reconciled Channels video incentive,20.00
```

```js
const { importRevenueCsv } = require('./revenue/index.cjs');
ledger.ingest(importRevenueCsv({ text: csvText, platform: snapshot.platform, accountId: snapshot.accountId }));
const history = ledger.months({ scope: 'statement', fromMonth: '2025-01', toMonth: '2025-12' });
```

UTF-8 BOM, quoted fields, CRLF and exact decimal-yuan conversion are supported. XLSX, arbitrary column mapping, transaction aggregation and settlement inference are not. Imports remain provisional. An explicitly reconciled statement may use the online scope/category IDs to correct a period; the host should show the proposed correction for review.

`examples/creator-revenue-electron.cjs` persists all four platforms in platform/identity-specific JSON ledgers. It restores prior state and atomically replaces it after merging. The example has a fixed local host owner; product integration must use real host ownership and isolated storage directories. Persist `ledger.export()` after manual imports too. Subsequent collection retains prior months. Enumerate `ledger.series()` and call `ledger.months({ ...series })` for all stored months in each scope/category.

## Failure behavior and verification

Host/platform account changes abort the whole acquisition. LOGIN_REQUIRED and VERIFICATION_REQUIRED require official-page interaction. REVENUE_COLLECTION_TIMEOUT, REVENUE_BUSY and LOGIN_CANCELLED denote timeout, a busy partition or a closed window. Rejected/malformed endpoints, mismatched months and history limits appear in issues while independent successful categories remain available. Empty or failed responses are never evidence of zero earnings.

```sh
npm run test:revenue
npm run test:revenue:electron
npm run test:creator:electron
npm run demo:revenue
```

Electron fixtures intercept every HTTPS request in their isolated partitions and verify real session/page-fetch behavior, zero handling, login/challenge, response bounds, deadlines, account switches, concurrency, cancellation and resource cleanup. These checks do not authenticate against real platforms. Real acceptance requires comparison to the owner's monthly/category/summary pages and recording the supported dates and missing categories. Never commit cookies, real responses, account data or official application bundles.

Anchor cases additionally cover fixed routing headers, produced-data dates, three summaries, later completion of stored months, open current days, unit isolation, null points, conflicting dates and expired login. The unauthenticated official endpoint was checked for routing and login errors only; real-account units, amounts and date formats remain unverified.

Additional cases cover Kuaishou institution pagination, owner/month verification, missing dates and invalid precision; Channels phone verification, ten-thousandth-yuan bills, unknown/duplicate categories, excluded balances and video incentive import. The second Electron suite verifies native clients, identity checks, fresh wallet authentication, expired/switched sessions and two-window cleanup. All financial values and handoff codes are independently synthetic.

## Protocol references, inspected 2026-10-30

Original adapters use field/endpoint facts from official public resources, without copying or redistributing the implementation: Bilibili [endpoint declarations](https://s1.hdslb.com/bfs/static/upi-mono/income/js/income.3479.d88b7179fb460161.js), [monthly query and selector](https://s1.hdslb.com/bfs/static/upi-mono/income/js/income.9463.788aecb27220304a.js), [30-day trend and scope](https://s1.hdslb.com/bfs/static/upi-mono/income/js/income.3234.59ff9b02c1a469e8.js), [overview state and rolling-year semantics](https://s1.hdslb.com/bfs/static/upi-mono/income/js/income.9028.8cb4eab5e3e3d274.js); Douyin [revenue detail page](https://lf-fe-creator.douyinstatic.com/obj/douyn-creator-scm-cdn/douyin_creator/fe/pc/static/js/revenue-detail.9397ab22.js). Website contracts may change; fixtures are independently invented from these field descriptions. See [third-party notices](../THIRD_PARTY_NOTICES.md).

Anchor references: [official page](https://anchor.douyin.com/anchor/dashboard/home), [date ranges and components](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/ife/anchor/dashboard/static/js/async/home/page.da785d2b.js), [summary/trend endpoints and earnScore](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/ife/anchor/dashboard/static/js/async/35.33cb9100.js), and [request routing configuration](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/ife/anchor/dashboard/static/js/async/840.4249be76.js). Fixed routing values are aid=477650, x-appid:3000 and x-sub-web-id:1116. An unauthenticated read with that routing returned status_code:20003. These values are not credentials; acquisition still needs the owner's official page session.

Kuaishou references: [creator platform](https://cp.kuaishou.com/profile), [incentive month fields](https://p66-plat.wskwai.com/kos/nlav11104/static/ks-cp/js/incomeEncourage.6fd8b96f.js), [live gift-income trends](https://p66-plat.wskwai.com/kos/nlav11104/static/ks-cp/js/statisticsLive.17cf273c.js), and [endpoints, date selector and native client](https://p66-plat.wskwai.com/kos/nlav11104/static/ks-cp/js/7565.ccc7dd62.js). Channels references: [income cards/mobile instructions](https://res.wx.qq.com/t/wx_fed/finder/helper/content/finder-helper-content/res/static/js/async/880.4945ce38.js), [primary live settlement subject and handoff](https://res.wx.qq.com/t/wx_fed/finder/helper/live/finder-helper-live/res/static/js/async/805.be559278.js), and [official wallet month bills/units](https://res.wxqcloud.qq.com.cn/t/wx_fed/base/wecoin/income-platform/income-main-page/res/js/index.f61bc63e.js). These website facts do not guarantee API stability or historical access for every account.
