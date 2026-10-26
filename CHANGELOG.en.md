# Changelog

[中文](CHANGELOG.md)

## 0.7.3 — Unreleased

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
