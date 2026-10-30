# Android Douyin wallet connector — device acceptance pending

[中文](ANDROID_REVENUE.md) · [Four-platform sync](REVENUE_SYNC.en.md) · [Wallet semantics](DOUYIN_WALLET.en.md)

`createDouyinWalletAndroidReader` attempts native identity and read-only request bridging inside the owner's official Douyin income-bill WebView, then reuses monthly pagination, reconciliation and persistence. Synthetic tests pass. **An actual device connection, native identity response and real statement have not been verified.** This conditional experimental implementation is not a proven mobile authentication solution.

## Prerequisites

The owner must authorize USB debugging on their Android device, sign into official Douyin, and have an App wallet WebView that allows debugging. Supply an absolute path to the existing [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools) `adb` executable and a private authorization directory.

[Android's documentation](https://developer.android.com/develop/ui/views/layout/webapps/debug-chrome-devtools) requires the App to allow WebView debugging. **USB debugging alone does not make a Douyin wallet page inspectable.** Without that App-provided channel the connector returns `REVENUE_MOBILE_WEBVIEW_UNAVAILABLE` and is unusable. It does not patch the App, force-enable debugging, elevate privileges, read private databases, export cookies or bypass verification. No iPhone connector is implemented.

The phone must remain online with its official wallet page available. Background sync never opens the page, prompts for login or unlocks the phone. Offline or missing-page errors back off. Continued operation while a particular phone is locked is unverified.

## Verified registrations and unverified response shape

The [official bill-page resource](https://lf1-cdn-tos.bytegoofy.com/goofy/ies/live/webcast_douyin/res/pages/wallet/bill/index.4eb76c.js), inspected on 2026-10-30, uses `app.fetch` for income bills. The [official SDK registration resource](https://lf1-cdn-tos.bytegoofy.com/goofy/ies/live/webcast_douyin/res/common/vendor.684694.js) maps that to `ToutiaoJSBridge.call('fetch',...)` and registers `userInfo` and `openLive` login-panel methods. These are interface observations; no official implementation is copied or redistributed.

The fixed page is `https://webcast.amemv.com/falcon/webcast_douyin/page/wallet/bill/index.html?bill_type=income`. The fixed request is `GET https://wallet-activity.amemv.com/webcast/wallet_api/get_billing_list/`; parameters, pagination and money handling match the [wallet guide](DOUYIN_WALLET.en.md). The App request wrapper owns its session. The connector does not generate mobile signatures or persist authentication data.

The public registration does not establish the actual device's `userInfo` callback shape. Candidate `uid/user_id/userId` fields are strictly checked: one consistent, nonzero decimal identity is required; unsafe precision, absent or conflicting values reject. The identity is hashed inside the phone page and returned as `identityKind:'native_uid'`; raw UID does not leave the page. This response handling has synthetic evidence only and must be checked on the owner's device before upgrading acceptance status.

Web `account-cookie-uid_tt` and Android `native_uid` identities have different meanings. **Account hashes and financial records are not automatically shared or merged.** Even for the same person's Douyin account, keep sources distinct until a reliable mapping exists. Do not associate by nickname or add duplicate income across them.

## API and persistence

```js
const path = require('node:path');
const { createDouyinWalletAndroidReader, createCreatorRevenueSync,
  createCreatorRevenueFileStore } = require('./revenue/index.cjs');

// The host configures absolute sdkAdbPath / privateDataDirectory values.
const reader = createDouyinWalletAndroidReader({
  adbPath: sdkAdbPath,
  authDirectory: path.join(privateDataDirectory, 'android-auth'),
  getAccount: () => currentHostAccount
});
const devices = await reader.inspect({ owner: currentHostAccount.accountId });
// The owner selects a device; selection is mandatory when multiple devices exist.
const snapshot = await reader.connect({ owner: currentHostAccount.accountId,
  deviceId: selectedDeviceId, openPage: true, fromMonth: '2026-09', toMonth: '2026-09' });
const binding = { accountId: snapshot.accountId, identityKind: snapshot.identityKind,
  deviceId: snapshot.deviceId };
// Persist binding in the host. Later processes can restore it without connect.
const sync = createCreatorRevenueSync({
  owner: currentHostAccount.accountId, platform: 'douyin', ...binding,
  getAccount: () => currentHostAccount, reader, initialLedger: snapshot,
  store: createCreatorRevenueFileStore({ directory: path.join(privateDataDirectory, 'revenue-sync') }),
  onStatus: status => updateSyncStatus(status)
});
await sync.start();
// On shutdown: sync.dispose(); await reader.dispose();
```

`inspect` returns device hashes, models and authorization status without raw serial numbers. `connect` establishes an interactive binding; `openPage:true` opens only the fixed official income page. An explicit logged-out bridge response may request the App's own login panel; the owner completes it and calls `connect` again. A slow or not-yet-ready page also requires retry after it opens. `lookup` requires `expectedIdentity/identityKind/deviceId` and never opens a page or authentication UI.

Host identity, native identity and page location are checked before and after acquisition, with identity checks surrounding each bill request. Navigation, account changes, disconnection and timeouts reject acquisition; unreconciled months are not stored. Limits are 100 pages per month and 2 MiB per response, with mandatory monthly reconciliation. Snapshots carry `binding:'native_session'`, `sessionReuse:'android_native_bridge'` and `authenticationValidation:'synthetic_only'`; the last value describes adapter validation, not whether returned data is synthetic.

Only WebView sockets belonging to official `com.ss.android.ugc.aweme` processes are selected, through local loopback forwarding. One reader may collect from a device at a time. Multiple eligible wallet pages reject instead of guessing. Completion/failure closes owned connections and removes owned forwards without closing the App or other ADB sessions. [CDP Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) and [Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/) support fixed script evaluation and navigation guards; no arbitrary endpoint is exposed.

Native requests default to an eight-second timeout and collection to 90 seconds. Device discovery/attachment has separate bounded command timeouts. `adbPort` defaults to 5037 and may select a dedicated server. ADB may create standard authorization keys in the private auth directory; these never enter the ledger or logs and must stay outside source packages.

## Standalone example

```sh
# Replace these absolute paths with the local SDK and a private directory outside the repository.
npm run start:revenue:android -- --adb=/absolute/sdk/platform-tools/adb --data=/absolute/private-data --inspect
npm run start:revenue:android -- --adb=/absolute/sdk/platform-tools/adb --data=/absolute/private-data --connect --watch
# Later processes restore the established binding:
npm run start:revenue:android -- --adb=/absolute/sdk/platform-tools/adb --data=/absolute/private-data --watch
```

On Windows use drive-qualified absolute paths and quote an entire `--adb=...` or `--data=...` argument containing spaces. Optional flags: `--device=<hash returned by inspect>`, `--port=5049` and `--from=YYYY-MM`. Without `--watch`, one batch runs; Ctrl+C stops the process. Electron is not required. Run one instance per data directory. Logs contain status, progress and directory, never amounts or raw statements.

## Remaining WeChat video incentive gap

The [official desktop income card](https://res.wx.qq.com/t/wx_fed/finder/helper/content/finder-helper-content/res/static/js/async/880.4945ce38.js) links to `https://channels.weixin.qq.com/assistant-support/pages/creator-home/income` with the authenticated creator identifier. This is not a verified amount API. An unauthenticated visit returns page-validation failure. [Official Tencent Ads guidance](https://training.tencentads.com/uploads/202406/lUKWuerT_DtCfUk.pdf) shows mobile creator-center advertising income / revenue sharing, without a reusable statement API contract.

No guessed amount endpoint, private WeChat database reader or membership-income substitute has been added. Shared four-platform scheduling and history persistence are implemented; automatic WeChat video incentive collection still needs the real mobile entry, identity and monthly response shape. Inspect those while the owner opens the relevant page, then implement the adapter and independent synthetic fixtures. Existing WeChat live settlement collection is separate; see the [source matrix](CREATOR_REVENUE.en.md).

## Device acceptance

First confirm whether the official App exposes the required page and whether native identity reliably binds the owner. Compare one closed month's video incentives, live receipts and totals with the official display; verify pagination, posting dates, earliest history and labels. Then check restart, disconnection, expired login and account changes for correct isolation. Record pass/fail, field shapes and coverage only. Do not commit cookies, device serials, raw UIDs, order IDs, real amounts or official page bundles.

`test/revenue-android.test.cjs` currently exercises synthetic native bridging, fixed endpoints, conflicting identity, page changes, login boundaries, timeouts, device locks, App-owned ADB sockets, loopback forwarding/cleanup and integration with the shared monthly scheduler. Passing these tests does not replace device acceptance.
