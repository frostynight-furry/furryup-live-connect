# Five-platform profiles / 五平台主页与粉丝数

Version 0.3.0 adds a standalone Node.js account module for Bilibili, Douyin, Kuaishou, WeChat Channels and Xiaohongshu. The existing live event collectors still support four platforms. **There is no Xiaohongshu live collector.** Five platform identifiers do not mean five automatic follower APIs.

| Platform | Count acquisition | Requirement |
| --- | --- | --- |
| Bilibili | Experimental public API | Explicit opt-in; full space URL; matching response UID |
| Douyin | Official daily statistics | Approved app/scope and current account-bound OAuth authorization; not realtime |
| Kuaishou | Official `user_info.fan` | Current account-bound OAuth authorization and app ID |
| WeChat Channels | Manual | Official source recognition only; no universal account ID/count API implemented |
| Xiaohongshu | Experimental public homepage | Explicit opt-in; full profile URL; matching account ID and exact fans count in page JSON |

The public adapters have synthetic regression coverage, not a live availability guarantee. Login/challenge pages, redirects, missing identity evidence, changed schemas and abbreviated counts such as `1.2万` produce an unavailable result. No login bypass, signature reverse engineering or challenge solving is implemented. No MediaCrawler code is included.

## Usage

```js
const { PROFILE_PLATFORMS, identifyProfile, createFollowerClient } = require('./profiles/index.cjs');
const client = createFollowerClient({ allowPublicBilibili: true });
const account = identifyProfile('https://space.bilibili.com/123');
// Only call on a user-authorized account with appropriate platform access.
const result = await client.lookup(account);
if (result.status === 'ok') {
  // Persist count + source + fetchedAt + dataAsOf together.
  // A successful read does not verify that the submitter owns this profile.
}
```

`require('./core/index.cjs')` also exports these functions. `PLATFORMS` remains the original four live-event platforms (with `wechat`); `PROFILE_PLATFORMS` contains five account platforms (with `wechat_channels`). Profile identification accepts `wechat` as an alias. It rejects non-HTTPS URLs, credentials, ports, unexpected hosts, video URLs and short links. Ask for a complete profile URL rather than fetching arbitrary share links.

`client.capabilities()` reports `platform`, `mode` (`oauth`, `public_experimental`, `manual`), `configured`, and `liveCollection: false` for this module. `configured` describes host options, not whether a particular user has authorized the account.

`lookup(input, context)` accepts a full URL or `{platform?, profileUrl}`. It returns only explicit account/count fields: `platform`, `accountId`, `profileUrl`, `status`, `followerCount`, `attemptedAt`, and on success `source`, `fetchedAt`, `dataAsOf`; cached responses may include `cached`. Failed results may include a safe `errorCode`. Invalid inputs throw a `ProfileError` before network access. An unavailable count is `null`, never zero. Hosts should retain their last successful snapshot separately and display its date when an update fails. This module does not automatically overwrite files, databases or published profiles.

Statuses: `ok`, `authorization_required`, `manual_required`, `not_configured`, `unavailable`, `rate_limited`. Source: `official_api`, `public_api`, `public_page`. Timestamps are canonical ISO UTC strings. Douyin `dataAsOf` represents the reporting date at midnight in China, not the fetch moment. All IDs stay strings; exact counts are integers from 0 through 10 billion.

## OAuth host integration

Use `resolveAuthorization(profile, context)` on a trusted server. It must verify the caller's relationship to the exact requested platform account and read the binding from encrypted host storage, returning:

```js
// Shape only; do not put real credentials in source files, URLs in logs, or frontend state.
{
  platform: 'douyin',
  accountId: 'MS4wLjABsynthetic', // the profile URL identity, NOT OAuth openId
  accessToken: 'FROM_HOST_SECURE_STORAGE',
  openId: 'OAUTH_ACCOUNT_ID',
  expiresAt: '2099-01-01T00:00:00.000Z'
  // Kuaishou also needs appId.
}
```

Establish the `accountId` ↔ `openId` binding during a verified platform authorization flow. Never accept this object directly from a client or reuse one token for unrelated submitted URLs. The client validates binding fields/expiry and rechecks authorization even when serving cached counts. It never reads browser cookies, environment tokens or account files on its own. OAuth screens, authorization-code exchange, encrypted storage and token refresh belong to the host and are not supplied here. `context` is passed only to the authorization resolver, never to the upstream request or result.

## Bounds and fallback

- Public adapters default off. Enable individually with `allowPublicBilibili` / `allowPublicXiaohongshu`.
- Default same-account cooldown/cache: 60 seconds, including failures; maximum 256 cache entries. `intervalMs` may be 0–86400000, `maxEntries` 1–4096; zero is intended for isolated tests. Same-account requests share in-flight I/O; at most four requests run at once. Different accounts on a platform are spaced by up to one second.
- Default HTTPS transport permits only fixed platform hosts/paths, refuses redirects, uses an eight-second deadline and caps response bodies at 1 MiB. Counts never require follower-list collection.
- `request({url, headers?, format?})` and `now()` may be injected for offline tests or a trusted host transport. A custom transport is responsible for equivalent timeouts, response limits, credential redaction and destination enforcement. Do not pass untrusted transport callbacks.
- Cache/limits are local to one client instance; use a host scheduler/quota layer across processes. There is no background polling or persistent credential/cache storage.

## Offline verification

```sh
npm run test:profiles
npm run demo:profiles
```

The demo is explicitly synthetic and never contacts platforms. Tests cover five-platform routing, identity binding, exact zero, invalid/rounded counts, authorization expiry/revocation, safe public page parsing, cache/in-flight behavior and redirect refusal. Existing live event tests remain unchanged.

Official references: [Douyin follower statistics](https://open.douyin.com/platform/resource/docs/openapi/data-open-service/user-data/get-user-fans-count), [Kuaishou public user information](https://open.kuaishou.com/platformDocs/openAbility/userInformation/publicInformation.html). MIT software licensing does not itself authorize platform access.
