# Changelog

[中文](CHANGELOG.md)

## Unreleased — 2026-10-31

Add `createCreatorRevenueSync/createCreatorRevenueFileStore` for shared four-platform refresh, independent source pauses, monthly checkpoints, legacy-ledger migration, restart recovery and historical corrections. Includes a persistent example and bilingual guides. Checked months do not imply complete history; missing, partial and complete coverage remain distinct.

Add experimental `createDouyinWalletAndroidReader` for native identity binding and fixed GET requests in an official App-debuggable wallet WebView, with per-request identity checks and owned-forward cleanup. Actual WebView availability, identity fields and real bills await device acceptance. USB debugging alone does not establish availability; no iPhone connector is implemented. Channels video incentives still lack a verified mobile amount contract and are not replaced by other income types.

Add experimental Douyin `source:'wallet'`: monthly posting-date pagination, explicit video/live classifications, statement/header reconciliation, idempotent history and corrections. Keep withdrawals, refunds and balances separate from earnings; combined creator/live income remains unsplit. Retain `createDouyinWalletSync/createRevenueFileStore` for bounded backfill, monthly checkpoints, default six-hour refresh, backoff and login pauses. Web reuse has only unauthenticated error evidence, with no real-account acceptance. Includes bilingual documentation, a persistent sync example and synthetic regression coverage.

Add `createCreatorRevenueBrowser` for Douyin/Bilibili, reusing own-account creator sessions without relying on follower cards. Bilibili reads natural-month reports within the page's six-month range and returned incentive/live categories. Douyin reads dynamic categories, supported category lifetime summaries and recent 30-day details. Kuaishou adds paginated personal incentive settlement months and daily live gift-income analysis with owner verification. Channels adds native wallet handoff and categorized monthly settlement bills. Both support monthly queries, history persistence and normalized imports. Automatic Channels video incentive amounts remain unverified and explicitly require mobile viewing/import.

Add Douyin source: 'anchor_dashboard' for today, rolling 7/30-day summaries and explicitly dated recent 30-day trend points, using the platform's produced-data date. Preserve native units in nativeRecords/nativeMetrics with monthly queries per unit; Yinlang is not converted to CNY. Later synchronization can complete stored months without treating open days or missing dates as complete.

Add `createRevenueLedger`, `importRevenueCsv`, exact cent strings, identity isolation, idempotent persistence and complete/partial/missing monthly coverage. Rolling metrics remain separate from periods; balances and gift spending are not income. Includes a persistent Electron example, offline demo, bilingual documentation and synthetic browser regressions. Earlier unavailable history cannot be recovered automatically; CSV uses normalized daily/monthly aggregates. No real revenue-account acceptance or FUS private-product changes are claimed.

## 0.8.0 — 2026-10-26

Add standalone `createCreatorFollowerBrowser`: five-platform own-account creator sessions, identity checks, exact/rounded values, bounded cancellation/cleanup, Bilibili/Kuaishou login recovery and Channels HTTP 201 statistics. Electron is injected by the host; existing profiles and live-event APIs remain compatible, with unchanged event schemaVersion.

Extract the previously validated host implementation, with configurable session prefixes, app names and UA product tokens; add an independent example, bilingual integration docs and synthetic Electron checks. The originating implementation passed four-platform live reads and fresh-process reuse; Xiaohongshu has no real-account validation. No long-term availability guarantee or private product/user/session material is included.

## 0.7.3 — 2026-10-26

Repair incomplete Bilibili web authentication in OrdinaryRoad 1.5.8: supply `platform: web`, `type: 2`, `scene: room` and ACK support, and negotiate the SDK's existing zlib protocol 2. The authentication frame itself remains uncompressed protocol 1. SDK room resolution, account, device and token handling are preserved.

Add actual SDK authentication and zlib gift replays: twenty individual V1/V2 flower transaction pairs and a replayed V2 batch of twenty both count exactly twenty. Cumulative `COMBO_SEND` notifications are not counted again as gift deltas. No live room was reconnected; offline checks do not confirm live recovery. Event schemaVersion 1 remains compatible.

## 0.7.2 — 2026-10-26

First public 0.7.x release, including all 0.7.0 and 0.7.1 changes below. Event schemaVersion 1 remains compatible. Validation covers offline component regressions; sustained delivery across all four live platforms remains unverified.

Recognize the explicit star-guardian resource on active Douyin fans badges and retain the club name and level in one badge. Named badge accessibility descriptions no longer create duplicate titles. Unknown assets, inactive status and mismatched levels cannot promote ordinary fans. Regression fixtures are synthetic; no platform images or private messages are included.

## 0.7.1 — first published with 0.7.2

Read preserved Kuaishou author-view protobuf segments, keep club name and level together, and recognize verified gold fans, annual diamond fans, guardian, honored guest, core audience and rank identifiers. No color/wealth-based identity inference or platform image redistribution.

Normalize Douyin administrator and level badge image descriptions into semantic badges, avoid duplicate honor/fans levels, and prefer an available fans club name. Synthetic regressions cover the reported shape without identity inference or permission changes.

## 0.7.0 — first published with 0.7.2

Message-local user_badges for multiple platform titles and levels. Uses existing OrdinaryRoad 1.5.8 models and official WeChat badgeInfos enums. Unknown labels remain absent; no permissions, image assets or identity cache are introduced. Real live delivery remains unverified.

## 0.6.0 — 2026-10-23

- Publish event contract v1 and a machine-readable JSON Schema covering all 14 normalized event variants, with matching Chinese and English semantics.
- Add a bounded offline replay toolkit and CLI for four-platform duplicate/out-of-order delivery, late old-room events, and reconnect/closed-handle boundaries. All fixtures are authored synthetic data; no collectors or accounts are used.
- Add contract, deduplication TTL/capacity, room-isolation and replay tests. Keep event schemaVersion 1 and existing live/profile APIs compatible.
- Audit exact staged Git blobs and file modes as well as the working source allowlist, with regression tests for staged secrets, ignored files and links. Do not include private broadcaster code or user data.
- Update both project introductions, testing guides and current release notes. Existing specialist Chinese-only docs remain explicitly labelled.
- Update the development-only Electron pin within major version 43 to 43.8.3 to address the advisories reported by dependency audit; no installed Studio runtime is changed.
- These are offline/component checks, not new real-platform, browser-account or long-running live acceptance claims. Cutout and model resources are outside this release.

## 0.5.0 — previous release

- Added the isolated Douyin public-page browser service and authenticated HTTPS host adapter, preserving observation timestamps and bounded public egress.
- Added Docker image and synthetic Chromium integration checks. Real cloud-account acceptance remains deployment-specific.

Earlier version records remain in the [original changelog](CHANGELOG.md).
