# Five-platform profiles / 五平台主页与粉丝数

0.8.0 adds a separate [authenticated creator-center Electron reader](CREATOR_FOLLOWERS.en.md) ([中文](CREATOR_FOLLOWERS.md)), including Kuaishou and Channels automation through the user’s own local session. The table below describes the unchanged public-profile/OAuth client, not the new reader.

Version 0.5.0 originally provided profile/follower adapters for Bilibili, Douyin, Kuaishou, WeChat Channels and Xiaohongshu. The existing live collectors support four platforms. **There is no Xiaohongshu live collector.** Five identifiers do not mean five automatic count APIs.

| Platform | Acquisition | Requirement |
| --- | --- | --- |
| Bilibili | Experimental public API | Opt-in; matching response UID; full, mobile or b23.tv profile link |
| Douyin | Experimental rendered page, or official daily statistics | Browser path needs a host reader, no OAuth app; official path needs an approved app and user authorization |
| Kuaishou | Official user_info.fan | App and user authorization; share links can be identified, public browser collection is not implemented |
| Channels | Manual | No universal follower API implemented |
| Xiaohongshu | Experimental public homepage JSON | Opt-in; full profile URL, matching identity, exact integer |

A 2026-10-23 spot check succeeded for one Bilibili API account and one anonymous Douyin browser profile. Kuaishou presented a CAPTCHA; Xiaohongshu lacked a test account. This is not a sustained availability guarantee. Missing identity evidence, changed schemas and rounded values such as `1.2万` fail closed. No signature reverse engineering, challenge solving, automatic login or MediaCrawler code is included. All committed fixtures are synthetic.

## Profile client

```js
const { createFollowerClient, resolveProfile } = require('./profiles/index.cjs');
const client = createFollowerClient({ allowPublicBilibili: true });
const result = await client.lookup('https://space.bilibili.com/123');
// Only persist result.followerCount when result.status === 'ok'.
// Keep source, fetchedAt and dataAsOf with the count.
```

The core entry point also exports these APIs. `PLATFORMS` remains four live platforms; `PROFILE_PLATFORMS` has five account platforms. `identifyProfile` is synchronous and never fetches short links. `await resolveProfile(url)` accepts fixed b23.tv, v.douyin.com and v.kuaishou.com short-code paths: read one Location header, validate a same-platform homepage, discard tracking parameters. Never follow arbitrary redirects. Mobile Bilibili, iesdouyin share-user, c.kuaishou share-user and live.kuaishou profile aliases normalize to canonical identities. HTTPS, exact hosts and supported profile paths are required; credentials, ports and video links are rejected. Other short links still require a full profile URL.

`lookup(input, context)` accepts a URL or `{platform?, profileUrl}`. A provider must be enabled for automatic short-link resolution. Results contain only `platform, accountId, profileUrl, status, followerCount, attemptedAt` and, on success, `source, fetchedAt, dataAsOf`. Optional fields: `cached, errorCode`. Invalid inputs throw ProfileError. Unknown counts are null, never zero. Keep previous successful snapshots when refresh fails. This API does not publish or overwrite host records.

Statuses: `ok / authorization_required / manual_required / not_configured / unavailable / rate_limited`. Sources: `official_api / public_api / public_page`. IDs remain strings; exact counts are integers from zero to ten billion. Times are canonical UTC ISO strings. Douyin official dataAsOf is the reporting date at China midnight, not a realtime observation.

`capabilities()` returns platform, mode (`oauth / public_experimental / browser_experimental / manual`), configured and liveCollection:false. Configured means host options are supplied, not that an account is authorized.

## Optional Douyin browser reader

```js
const { readDouyinPage, createFollowerClient } = require('./profiles/index.cjs');
const client = createFollowerClient({
  allowPublicDouyin: true,
  readPublicProfile: async profile => {
    // Your host owns browser creation, fixed-URL navigation and a bounded
    // readiness wait. No browser is bundled or launched by this module.
    const page = await host.openProfilePage(profile.profileUrl);
    try { return await readDouyinPage(page, profile); }
    finally { await host.closeProfilePage(page); }
  }
});
```

The reader accepts an already loaded Playwright-like page with `evaluate`. It reads the visible profile's `data-e2e=user-info-fans` card, checks the actual page identity and accepts one exact integer. It does not read cookies or hidden application state. A challenge or missing/ambiguous card yields no count. This option takes precedence over OAuth for Douyin. Browser lifecycle, bounded readiness, rate limits, isolation and anti-SSRF resource policy belong to the host. The package does not deploy a browser service.

## Optional OAuth broker

`createProfileOAuth({platform, clientId, clientSecret, redirectUri, encryptionKey, store, request?, now?})` is server-only. Platforms: douyin or kuaishou. clientId means Douyin client_key or Kuaishou app_id. Register a controlled HTTPS callback without query/hash. encryptionKey must be a stable 32-byte Buffer from a secret manager; changing it makes stored grants unreadable. Never put keys in frontend state or source control.

The required private store implements `transaction(key, work)`: atomically load the row, call the synchronous `work(currentOrNull)` to obtain `{record, result}`, save record and return result. Serialize across **all workers**. Recheck trusted application identity, current user, tenant membership and capability on every transaction. Do not expose database rows to clients. Network requests happen outside transaction callbacks.

Every method takes a trusted server-derived `{appId, tenantId, userId}` binding, never unchecked client values:

- `begin(binding, requestId)` returns authorizationUrl and expiry. A repeated pending request reuses the same encrypted random state; a new request supersedes the old pending state.
- `complete(binding, callbackUrl)` validates exact origin/path, duplicate parameters, state ownership and expiry; consumes state atomically before exchanging code. Successful callback retries do not exchange twice. Tokens and openId never appear in the result.
- `status(binding)` returns private nickname, status, expiry, revision and a reauthorization flag.
- `lookup(binding)` refreshes near-expiry credentials and returns authorized-account counts and dates, with **no public profile URL** and `profileBinding: unverified`.
- `disconnect(binding, expectedRevision)` removes local grants and pending state. Read revision from status. An old retry cannot revoke a newer authorization. This is not platform-side revocation.

State lasts ten minutes. Tokens use AES-256-GCM with storage-key AAD. Refresh is serialized by durable transaction markers. Rotated refresh tokens replace old ones; neither platform's original refresh expiry is extended. A lost refresh response or crashed refresh requires reauthorization instead of reusing a possibly consumed token. Hosts supply quotas, retention and cleanup policy; there is no background polling.

Douyin requests `user_info,data.external.user`; Kuaishou requests `user_info`. Applications and required scopes must be approved. Hosts provide the controlled HTTPS callback page, authenticated completion route/UI, and secure logging policy. It is also possible for the initiating user to paste the returned callback URL into their authenticated application. Avoid query logging, third-party scripts and Referer leakage on the completion page. Real sign-in was not validated for this release because application credentials were unavailable.

**OAuth openId is not the public profile URL ID.** The documented user-info APIs do not establish that mapping. Do not automatically assign an authorized account's count to an arbitrary submitted URL or mark ownership verified.

## Existing trusted authorization extension

`createFollowerClient({resolveAuthorization(profile, context)})` remains supported for hosts with independently verified URL-to-OAuth identity mappings. Return only from trusted server storage:

```js
{
  platform: 'douyin', accountId: 'MS4wLjABsynthetic',
  accessToken: 'FROM_SERVER_STORAGE', openId: 'OAUTH_SUBJECT',
  expiresAt: '2099-01-01T00:00:00.000Z'
  // Kuaishou additionally requires appId.
}
```

Never accept credentials or a claimed binding from a client. Authorization is rechecked before cache use. Context is passed only to trusted host callbacks, not upstream or into result DTOs.

## Limits and tests

- Public API/page adapters default off; enable allowPublicBilibili, allowPublicXiaohongshu, or allowPublicDouyin plus readPublicProfile.
- Follower cache/cooldown defaults to 60 seconds, at most 256 entries and four in-flight requests; same-account calls coalesce. Use host-wide limits across processes. Short-link resolution and the OAuth broker also require host request quotas.
- Default transport allows only fixed HTTPS endpoints, rejects redirects, uses an eight-second deadline and caps responses at 1 MiB. OAuth POST bodies are limited to 16 KiB. Never log Kuaishou upstream URLs: its documented GET API includes credentials in the query.
- Injected request transports must preserve these limits and redact credentials. Follower client now() returns ISO time; OAuth broker now() returns epoch milliseconds.
- `npm run test:profiles` and `npm run demo:profiles` are offline. Regression tests cover redirect attacks, page identity, rounded counts, tenant-bound state, replay, encryption, rotation and revocation races. They do not substitute for live OAuth or native client acceptance.

Official references: [Douyin exchange](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-access-token/), [Douyin refresh](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/refresh-access-token), [Douyin user info](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-account-open-info), [Douyin fans](https://open.douyin.com/platform/resource/docs/openapi/data-open-service/user-data/get-user-fans-count), [Kuaishou OAuth](https://open.kuaishou.com/platform/openApi?menu=13), [Kuaishou website flow](https://open.kuaishou.com/platformDocs/develop/web-app.html). MIT licensing does not itself authorize platform access.

## Cloud browser service (0.5.0)

A runnable isolated browser service and HTTPS host adapter are now included. See [browser service setup](BROWSER_SERVICE.md) for configuration, deadlines, cache timestamps, security limits and cloud acceptance. No Douyin application registration is required for this path.
