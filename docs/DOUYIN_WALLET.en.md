# Douyin mobile wallet: monthly history and synchronization (experimental)

[中文](DOUYIN_WALLET.md) · [Four-platform revenue](CREATOR_REVENUE.en.md)

This source implements monthly pagination, explicit video/live posting categories, reconciled statements and saved history. New additions are an [Android native bridge reader](ANDROID_REVENUE.en.md) and [shared four-platform scheduler](REVENUE_SYNC.en.md). **Real-account acceptance, authenticated web reuse and native Android identity remain unverified.** `source:'wallet'` is experimental; working phone authentication is not claimed, and iPhone support is not implemented.

## Verified contract and authentication boundary

The [official mobile income-bill page](https://webcast.amemv.com/falcon/webcast_douyin/page/wallet/bill/index.html?bill_type=income) and its [public frontend asset](https://lf1-cdn-tos.bytegoofy.com/goofy/ies/live/webcast_douyin/res/pages/wallet/bill/index.4eb76c.js), inspected on 2026-10-30, establish:

- The App's native request bridge invokes `GET https://wallet-activity.amemv.com/webcast/wallet_api/get_billing_list/`.
- `start_time=YYYYMM`, `page`, `count=20`, and `last_max_time` control pagination; the next cursor is the final bill's `txn_time`. Income view uses `type=0&need_summary=1&is_income_record=1`.
- Responses contain `billing_types`, `end_time`, `has_more`, and `bill_list` groups with `period/income/outcome/bills`. `end_time` is the calendar's earliest month, not the last queryable month or the account creation date.
- Money fields are displayed as cents. Signs 0/1/2 display minus/plus/no sign. Posting timestamps cannot establish when a video earned its revenue.

An unauthenticated probe of the same path on `creator.douyin.com` returned `status_code:20003`. This is evidence of a candidate route's login error, **not proof of authenticated web-wallet access**. The web reader attempts that fixed route in the creator page and reports `sessionReuse:'experimental_creator_origin'`. The new Android reader attempts native bridging in the official phone wallet page and reports `sessionReuse:'android_native_bridge'`, with an independent identity binding. It requires an App-debuggable WebView and real device validation. Neither reader exports cookies, recreates mobile signatures or installs interception tools.

Code 20003 throws `REVENUE_WALLET_SESSION_REQUIRED`, preserving history and pausing synchronization. The owner may refresh official creator login; if this still fails, show that mobile wallet authentication is required and automatic synchronization is unavailable. Do not poll indefinitely or report success. Reconciled mobile statements can be imported through canonical CSV under a separate `statement.*` scope.

## Queries and financial semantics

Use `createCreatorRevenueBrowser` with `platform:'douyin', source:'wallet'`, the bound `expectedIdentity`, and `identityKind:'account-cookie-uid_tt'`. Handles are rejected. Supply both `fromMonth/toMonth` or neither; default is the current and preceding six months, with a 24-month acquisition limit. Host identity, platform identity and navigation are checked around requests; identity changes abort acquisition.

```sh
npm run start:revenue -- douyin wallet 2026-01 2026-09
npm run start:revenue:wallet
npm run start:revenue:wallet -- --watch
npm run start:revenue:wallet -- --watch --login
```

The first command uses the general persistent revenue example. The remaining commands use a separate wallet synchronization directory and checkpoints, binding creator login on first use. Without `--watch` they run one batch; with it the process keeps running. `--login` opens creator login again. The two example storage directories are not automatically merged. Both examples have a fixed local host owner; production must use real host ownership. No system task or mobile background service is installed; closing the process stops synchronization.

| scope / categoryId | Meaning |
| --- | --- |
| `douyin.wallet_cashflow / total` | Monthly incoming cash movements, potentially including refunds/transfers; neither net earnings nor the sum of video/live income |
| `douyin.wallet_income / live` | Positive postings explicitly labelled as live/gift income |
| `douyin.wallet_income / video_incentive` | Positive postings explicitly labelled as video incentives or creator incentive plans |

Classification uses returned category names and bill labels, never guessed numeric enums. Generic video income is not necessarily an incentive. Combined live/creator income stays `creator_unsplit`; other unresolved income stays `unknown`. Withdrawals, transfers, top-ups, refunds and balances are excluded from the two earnings categories and are not silently applied as earnings adjustments. An absent category does not produce a zero. Any unclassified positive posting keeps category totals partial even if cash-flow totals reconcile.

Each month is limited to 100 pages/2000 bills. Pagination must end or cross into an older month; incoming/outgoing transaction sums must separately equal the group's income/outcome headers. Changed headers, categories, cursors, periods or mismatched amounts prevent the entire month from being stored. The current month remains partial. A complete closed month means the observed statement reconciles, not final settlement, after-tax payout or immunity to future corrections. All records stay provisional and historyComplete remains false.

`snapshot.statements` stores normalized monthly headers, posting-time basis, completeness flags, fetchedAt and transactions. A transaction contains a hashed ID, date/seconds, type code, direction, cent string, classification and platform category name. Raw order IDs, balances, descriptions, credentials and raw responses are excluded. Ledger ingestion validates statement/projection agreement atomically. A newer statement replaces that month and removes stale category projections without adding duplicate amounts. Limits are 1200 months and 50000 transactions per ledger.

`ledger.statements({fromMonth,toMonth})` returns deep copies; omitting the range returns every saved statement. Query the two earnings categories separately through `ledger.months({scope:'douyin.wallet_income',categoryId:'live'})` and `video_incentive`. These are posting months and must not be added to creator-center earning-date trends. The two wallet scopes are reserved for verified statements; CSV corrections must use a separate `statement.*` scope.

## Host synchronization

The original wallet-only coordinator below remains compatible. New integrations can use the [shared four-platform scheduler](REVENUE_SYNC.en.md), including an Android reader and explicit legacy-ledger migration. A web binding cannot serve as an Android native identity.

```js
const path = require('node:path');
const { createCreatorRevenueBrowser, createDouyinWalletSync, createRevenueFileStore,
  createRevenueLedger } = require('./revenue/index.cjs');
// Main process after app.whenReady(); account, binding and UI callbacks are host-owned.
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
const status = sync.status();
const ledger = createRevenueLedger({ platform: 'douyin', accountId: douyinBinding.accountId,
  state: sync.export() });
const months = ledger.months({ scope: 'douyin.wallet_income', categoryId: 'live' });
// On host logout/account switching or application shutdown, not immediately after start:
// sync.dispose(); reader.dispose();
```

Defaults refresh the recent three months every six hours, process unfinished history every 60 seconds, and attempt at most six months per batch. History starts at the server's end_time; optional fromMonth can narrow this range, never expand access. Saved older months are revisited after 30 days for adjustments. Configuration names are `intervalMs/backfillIntervalMs/historyRefreshMs/batchMonths/fromMonth`.

Every successful month is atomically checkpointed; restart resumes, and failed months remain retryable. An absent/fallback month becomes a no_data checkpoint rather than zero, and cannot erase a saved statement. pendingMonths zero means the selected range was checked, not that all history exists. Network errors use bounded backoff. Login/identity failures pause until the host explicitly calls start after login. syncNow refreshes recent months and continues one batch. Calls on one instance coalesce; same-binding coordinators within one process are mutually exclusive.

stop cancels scheduling and prevents delayed reads from starting new writes; an atomic save already in progress may finish. dispose permanently disables the synchronizer but does not dispose a shared reader. status/onStatus contain only states, times, error codes and progress. export returns the latest committed ledger copy, without checkpoints or sessions. Timer failures are reported through onStatus; initial start/syncNow also reject on failure and must be handled.

The file store separates host-owner hashes and platform identities, flushes a same-directory temporary file, and atomically replaces the target. Loaded state is revalidated. Normal files contain financial data and checkpoints only, without credentials. Files are not encrypted; directory access, backups and encryption are host responsibilities. Only one host process should write a given account in a directory; the component's lock is process-local. Custom `store.load(binding)` and atomic `store.save(binding,state)` can use a database. Do not send the entire state as telemetry.

## Acceptance limits

Revenue unit tests exercise pagination, deduplication, exact cents, exclusions, ambiguous categories, reconciliation, corrections, isolation, resume, backoff, pause, cancellation and disk failures. Electron tests intercept every HTTPS request, verifying real window/session behavior, wallet GETs, persistence and automatic pause using invented data. No actual income or Android/iOS authentication is claimed validated.

Before product use, compare one closed month's video/live postings, dates and headers with the owner's wallet; verify labels, account scope, history bounds and pagination. A web 20003 response may lead to testing the new Android reader on a compatible device. Without device acceptance or an App-debuggable page, do not claim successful automatic collection. Keep credentials, order IDs, personal amounts and official assets out of the repository. Official resources provide protocol facts only; their code is not redistributed.
