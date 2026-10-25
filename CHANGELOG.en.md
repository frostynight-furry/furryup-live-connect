## 0.7.1 — local candidate

Normalize Douyin administrator and level badge image descriptions into semantic badges, avoid duplicate honor/fans levels, and prefer an available fans club name. Synthetic regressions cover the reported shape without identity inference or permission changes.

## 0.7.0 — local candidate

Message-local user_badges for multiple platform titles and levels. Uses existing OrdinaryRoad 1.5.8 models and official WeChat badgeInfos enums. Unknown labels remain absent; no permissions, image assets or identity cache are introduced. Real live delivery remains unverified.

# Changelog

[中文](CHANGELOG.md)

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
