# Four-platform automatic revenue sync and history

[中文](REVENUE_SYNC.md) · [Revenue sources](CREATOR_REVENUE.en.md) · [Android wallet](ANDROID_REVENUE.en.md)

`createCreatorRevenueSync` connects the existing four-platform readers to one scheduler with monthly checkpoints and persistence. Synthetic tests and Electron flows are verified; real revenue accounts are not. Sync can only preserve data available through an authorized platform session. WeChat Channels video incentives still lack a verified amount endpoint, and Douyin Android wallet authentication requires device acceptance.

## Collection windows

| Platform / source | Automatic collection | Gaps |
| --- | --- | --- |
| Bilibili | Recent 30-day trend, previous six closed calendar-month reports and overview | Older reports outside the page window; unpublished or unauthorized reports |
| Douyin creator center / anchor dashboard | Recent 30-day details and available summaries; saved daily data accumulates into months | Details already outside the window before first sync; native units are never converted to CNY |
| Douyin wallet | Recent three months and per-month history back to the server's earliest month | Valid wallet session required; mixed labels cannot be split into video/live; posting-month basis |
| Kuaishou | Recent three months of personal incentive bills and daily live gift analytics; bounded backfill to 2019-04 or configured start | Incentive selector starts at 2019-08; one supported incentive program; a selectable date does not guarantee access |
| WeChat Channels | All visible primary-settlement-subject bills, filtered to the requested range, including new and corrected months | Additional subjects, unreturned history, mobile-verification sessions and video incentive amount endpoint |

Default refresh is every six hours. Kuaishou and wallet backfill continues every 60 seconds, attempting at most six months per batch. Older checked months are rechecked after 30 days by default. Bilibili, Douyin rolling pages and the WeChat settlement page each read their supported window once per scheduled run. `fromMonth` narrows the window.

WeChat video incentives explicitly report `REVENUE_VIDEO_INCENTIVE_MOBILE_REQUIRED`. Membership, courses, drama or live receipts cannot substitute for them. Verified official monthly totals can be imported with the existing normalized CSV format in a separate `statement.video` scope. Imported history is queryable and persistent, but is not automatic collection.

## Electron integration

```js
const path = require('node:path');
const { createCreatorRevenueBrowser, createCreatorRevenueSync,
  createCreatorRevenueFileStore, createRevenueLedger } = require('./revenue/index.cjs');

// After app.whenReady(); the host supplies its active account, binding and UI.
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
  // Optional: fromMonth: '2026-01', batchMonths: 6,
  onStatus: status => updateSyncStatus(status)
});
await sync.start();
const ledger = createRevenueLedger({ platform: platformBinding.platform,
  accountId: platformBinding.accountId, state: sync.export() });
const saved = ledger.series().map(series => ({ ...series, months: ledger.months(series) }));
// On exit, host account change or collection shutdown: sync.dispose(); reader.dispose();
```

Bind interactively with `reader.connect({owner,platform})`, saving the returned `accountId/identityKind` and platform. Background sync uses `lookup` without opening login windows. Readers verify both the host account and platform identity. Account changes reject acquisition instead of attributing new data to the old ledger. Create one sync controller per platform; controllers may share a reader and store.

Douyin web identities default to `creator_center/anchor_dashboard/wallet`; other platforms use `creator_center`. `sources` may select a subset. Android `native_uid` identities support only `wallet` and require a bound `deviceId` plus an Android reader; see the [mobile guide](ANDROID_REVENUE.en.md). Native and web identities remain separate, without nickname-based merging.

## Scheduling and status

- `start()` enables scheduling and runs one batch immediately. Explicit calls also retry paused authentication sources.
- `syncNow({sources?})` runs one batch without enabling future timers. Concurrent calls on the same instance coalesce.
- `stop()` cancels future scheduling and rejects late reader results. An atomic save already in progress may finish.
- `dispose()` permanently disables the controller; dispose the shared reader separately. No work runs while the host process is closed or asleep; restart resumes persisted checkpoints.
- `status()/onStatus` return per-source status, timestamps, issue codes and `checkedMonths/pendingMonths`, without amounts, cookies or raw responses.

Authentication failure without usable data sets a source to `needs_login` and stops its automatic retries while other sources continue. After the owner logs in, explicitly call `start()` or `syncNow({sources:[...]})`. Network and temporary errors back off from 60 seconds up to the refresh interval. Offline devices also back off without opening login dialogs. Host/platform account changes, corrupt state or failed storage stop the controller; handle initial `start()/syncNow()` rejection and status errors.

A failed source normally appears in returned `sources[].state/lastErrorCode/issues` and does not necessarily reject `start()`. Promise fulfillment alone is not an all-sources-success signal. Partial snapshots can retain valid categories and expose their missing data.

`checkedMonths` counts distinct checked months; `pendingMonths:0` means no unchecked month remains in the chosen queue. Neither means complete lifetime history. `no_data` checkpoints do not create zero income or erase a valid wallet statement. Use ledger `coverage/complete/provisional` to display month coverage; summaries and daily/monthly records keep distinct scopes and cannot be added together. Rolling sources have no per-month backfill queue and report `pendingMonths:null`.

Options: `batchMonths` 1–24 (default 6), `intervalMs` (six hours), `backfillIntervalMs` (60 seconds), `historyRefreshMs` (30 days) and optional `fromMonth`. Refresh/backfill intervals must be at least one second. Historical refresh must be between the refresh interval and 365 days. `now/timers` are injectable for synthetic tests.

## Persistence and migration

`createCreatorRevenueFileStore({directory})` requires an absolute directory and isolates state by hashed host owner, platform, hashed account and identity kind. It stores the normalized ledger, issue codes, checkpoints and next-due time using a synced temporary file followed by same-directory replacement. Load revalidates the structure and statements; files are limited to 32 MiB. No raw responses or web credentials are stored. Financial data is not encrypted by this store: the host owns directory permissions, backup and encryption. Keep application data outside the source repository.

A database store may implement `load(binding)` and atomic `save(binding,state)`. The component prevents competing controllers for the same binding within one process; one host process must own each stored account. Saved months remain queryable after platform rolling windows expire.

New files use `creator-revenue-<hash>.json`, state schemaVersion 2. Legacy `createDouyinWalletSync/createRevenueFileStore` remains available; the ledger is still schemaVersion 1. Supply `initialLedger` to merge old ledgers and normalized CSV records idempotently. Mismatched bindings reject, newer records remain authoritative, and old files are retained. Do not run both schedulers against the same logical account.

```sh
npm run start:revenue:sync -- all --watch
npm run start:revenue:sync -- kuaishou --from=2026-01
npm run start:revenue:sync -- douyin --login --watch
```

The example uses the existing creator example's data directory and migrates matching ordinary revenue and legacy Douyin wallet ledgers into `revenue-sync`, retaining the originals. `--login` reopens official authentication; `--watch` keeps the process alive, otherwise each platform runs one batch. Output contains status and storage location only. `all` binds unconfigured platforms sequentially and requires the owner to complete their logins.

## Validation

`npm run test:revenue` covers four-platform scheduling, independent source pauses, resumable batches, date windows, retained imports, backoff, account switches, concurrency, cancellation and disk failures. Synthetic Electron tests exercise automatic persistence through actual isolated windows. No real revenue account was used; the [mobile guide](ANDROID_REVENUE.en.md) records remaining Android and WeChat video incentive work.
