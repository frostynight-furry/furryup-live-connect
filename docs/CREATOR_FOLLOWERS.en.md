# Creator-center follower collection

[中文](CREATOR_FOLLOWERS.md)

Version 0.8.0 adds `createCreatorFollowerBrowser` alongside the existing profile client. An Electron host explicitly opens an official creator center, the user completes login, and the reader collects that account's follower metric. It requires neither FurryUP Studio nor a FurryUP account. Importing the module does not load Electron or connect to a platform: the host injects `BrowserWindow` and `session`. Existing public-profile, OAuth and manual client behavior remains unchanged.

| Platform | Metric and identity | Validation scope |
| --- | --- | --- |
| Bilibili | Creator-center total followers and own UID | Real authenticated-session read and fresh-process reuse passed before extraction; public-home login recovery has a synthetic test, but fresh first QR login was not repeated |
| Douyin | Creator-center follower card and own account identifier | Real read and fresh-process reuse passed before extraction |
| Kuaishou | Own `coreUserInfo.fansNum` and `userId`, with card fallback after official login | Real read and fresh-process reuse passed before extraction |
| WeChat Channels | Own `finderUser.fansCount` and `finderUsername`, with follower-card fallback | Real read and fresh-process reuse passed before extraction; HTTP 201 is accepted |
| Xiaohongshu | Creator follower card and allowlisted self-information response | Synthetic tests only; no available test account, authenticated fields and real retrieval remain unverified |

These live checks describe the implementation in its original host, not a guarantee for every account, future page revision or long session. Tests of the extracted component use entirely synthetic pages and responses. No account material or raw platform responses are committed. There is no Xiaohongshu livestream collector.

## Integration

```js
const { BrowserWindow, session } = require('electron');
const { createCreatorFollowerBrowser } = require('./profiles/index.cjs');
// Also exported from core/index.cjs. Call after app.whenReady().
let currentOwner = 'local-user-1'; // Host account ID, not a platform user ID.
const reader = createCreatorFollowerBrowser({
  BrowserWindow, session,
  getAccount: () => ({ accountId: currentOwner }),
  partitionPrefix: 'my-app-followers',
  applicationName: 'My App',
  userAgentProductTokens: ['my-app']
});
const binding = await reader.connect({ owner: currentOwner, platform: 'douyin' });
// The host persists this binding in its owner-scoped store.
const latest = await reader.lookup({ owner: currentOwner, platform: binding.platform,
  expectedIdentity: binding.accountId, identityKind: binding.identityKind });
// Explicit user-requested disconnection:
// await reader.disconnect({ owner: currentOwner, platform: binding.platform });
reader.dispose();
```

`getAccount()` must reflect the current host account, including account switches. It may return null or `{kind:'signed-out'}` after logout. The requested `owner` must match its `accountId`; a switch cancels active windows. Persistent sessions are isolated by owner and platform. The default partition prefix is `liveconnect-followers`; a custom prefix accepts 1–80 lowercase letters, digits, dots, underscores or hyphens. Existing hosts should retain their old prefix to preserve login sessions. `userAgentProductTokens` removes only specified application identifiers from the Channels UA, retaining browser and OS information.

`connect` opens a visible official login window and returns a new binding on success. `lookup` reads the same persistent session in a hidden window and checks `expectedIdentity` and `identityKind`. `disconnect` removes only the selected owner's platform session and cache. `dispose` closes active windows and clears the in-memory cache without deleting login storage. Binding persistence, old snapshots and stale/error UI belong to the host.

Options: `connectTimeoutMs` defaults to 180000, `refreshTimeoutMs` to 25000, and `cacheMs` to 60000. Acquisition timeouts must be positive; cache duration may be zero; each is bounded to 600000. Concurrent acquisition for one partition throws `FOLLOWERS_BUSY`. A hidden refresh that needs user interaction fails so the host can offer interactive login again.

## Results and failures

Results include `platform, accountId, identityKind, profileUrl, binding, displayName, status, precision, fetchedAt, dataAsOf`. `accountId` is a SHA-256 of platform, identity kind and platform identifier. It is not interchangeable with public-profile IDs or another identity kind. `binding` is `creator_session`; `profileUrl` is the fixed creator-center entry, not a public profile.

- Exact readings have `precision: 'exact'`, `status: 'ok'`, and `followerCount`; zero is valid.
- Rounded readings have `precision: 'approximate'`, `status: 'approximate'`, and the original `displayCount`, such as `1.2万`. They have no manufactured integer and must not enter exact totals or net-growth calculations.
- `source: 'public_page'` retains snapshot compatibility; `acquisition: 'creator_center'` identifies the authenticated creator-center route. Do not label it anonymous public data.
- `fetchedAt` and `dataAsOf` are retrieval time, not a guarantee of the platform's internal metric update time.

Operational errors expose codes: `INVALID_PROFILE_URL`, `ACCOUNT_CHANGED`, `FOLLOWERS_BUSY`, `LOGIN_REQUIRED`, `LOGIN_CANCELLED`, `VERIFICATION_REQUIRED`, `PLATFORM_ACCOUNT_CHANGED`, `IDENTITY_UNAVAILABLE`, `COUNT_UNAVAILABLE`, `AMBIGUOUS_COUNT`, `PAGE_CHANGED`, `NETWORK_ERROR`, `UNTRUSTED_PAGE`. Never convert errors to zero. Invalid configuration or missing Electron/identity providers throws TypeError.

Remote pages have no Node, preload or host IPC access. Permissions and downloads are denied; top-level navigation stays on allowlisted official hosts. CDP reads only allowlisted own-account response endpoints, with bounded body size, request count and navigation lifetime. Cookies stay in the local Electron session; necessary own-account identifiers are checked in memory, while tokens, cookies and raw responses are absent from results. Users complete platform login and verification themselves. The reader neither solves challenges nor estimates totals from viewer lists.

## Run and test

```sh
npm ci
npm run start:creator -- douyin
npm run test:profiles
npm run test:creator:electron
```

The last command intercepts HTTPS with synthetic fixtures and performs no platform login. Linux requires a display, such as `xvfb-run -a npm run test:creator:electron`. The example opens a window only with an explicit platform argument. Test output defaults to a system temporary directory; `LIVECONNECT_TEST_ARTIFACTS` may specify a private evidence directory. Do not commit browser profiles or runtime account records.

## Reuse and attribution

The 2026-10-26 research inspected QianFan Sync [social-auto-upload-web-ui](https://github.com/DevilJie/social-auto-upload-web-ui/tree/fbf79a49b639a1b762e4d5c4ec48c87094e860cd) for its five-platform `sync_profile` card locations. Its root MIT file and README use restrictions differ, so no Python implementation, publisher or stealth-browser dependency was copied. F2 (Apache-2.0) was considered for Douyin, but a downloader/signing stack is unnecessary for this metric. MediaCrawler's noncommercial restrictions exclude direct product reuse; the archived bilibili-api project was not selected as a new dependency. This implementation reuses Electron sessions and existing LiveConnect Channels UA compatibility.

The Channels `auth_data` field description was also checked against wordweb/Get-Tencent-Video-Live-Barrage-Gifts; none of its code was copied or executed. Own-account Kuaishou and Channels response fields were checked during host validation. Reference implementations, official page code, platform graphics and real account evidence are not redistributed. See [third-party notices](../THIRD_PARTY_NOTICES.md).
