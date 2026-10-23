# Douyin browser service

The optional `browser-service/` container turns a canonical Douyin profile URL into the visible exact follower count. It needs server capacity and a service secret, but no Douyin Open Platform application, user OAuth or login cookies. It is experimental: cloud egress may encounter verification or a page layout that cannot provide an exact number. This service does not bypass challenges.

## Server integration

```js
const { createFollowerClient, createBrowserServiceReader } = require('../profiles');
const client = createFollowerClient({
  allowPublicDouyin: true,
  readPublicProfile: createBrowserServiceReader({
    endpoint: process.env.FUP_BROWSER_SERVICE_URL,
    token: process.env.FUP_BROWSER_SERVICE_TOKEN
  })
});
// Gate this call with your existing trusted identity, membership and permissions.
const result = await client.lookup({ platform: 'douyin', profileUrl: submittedUrl });
// Update only a matching, unchanged draft with status === 'ok'.
// Keep command receipts and recheck permissions/version after external I/O.
```

`endpoint` must be HTTPS with path `/v1/douyin/followers` and no credentials, query, fragment or custom port. Generate a random 32+ byte base64url token in server-side secret storage and inject the same `FUP_BROWSER_SERVICE_TOKEN` into both services. The browser service is not a frontend API. Do not pass the secret to clients, place it in a Docker build argument, or log request headers.

`createConfiguredFollowerClient(env)` is a convenience factory: set `FUP_FOLLOWER_SYNC=enabled`, `FUP_FOLLOWER_DOUYIN_BROWSER=enabled`, `FUP_BROWSER_SERVICE_URL` and `FUP_BROWSER_SERVICE_TOKEN`. Bad optional browser configuration fails closed without preventing other configured platforms from working. OAuth remains optional and separate.

The authenticated endpoint accepts only `{profileUrl}` for a canonical `https://www.douyin.com/user/...` URL. Resolve share links via the client first. Responses are `{ok:true,data:{platform,accountId,profileUrl,followerCount,observedAt}}` or `{ok:false,errorCode}`. It never returns page HTML, cookies or tokens. HTTP 429 means retry later. The host adapter rejects wrong identities, non-integers, stale/future observations and unexpected responses; it never follows service redirects with a credential.

## Container

From this repository root:

```sh
docker build -f browser-service/Dockerfile -t furryup-follower-browser:0.1.0 .
```

The Docker context is restricted by `.dockerignore`. It contains only the worker and the portable profile model/DOM reader. Node 24, Playwright 1.64.0 and its matching Chromium are installed during build. The container runs as a non-root user with Chromium sandbox enabled. It requires a host supporting user namespaces; for Docker, use the [versioned Playwright seccomp profile](https://raw.githubusercontent.com/microsoft/playwright/v1.64.0/utils/docker/seccomp_profile.json) as described in [Playwright's container guidance](https://playwright.dev/docs/docker). Do not disable the sandbox to hide an incompatible host.

Expose port 8080 (`PORT` may override), terminate TLS at your gateway and configure `GET /healthz` for readiness. Start with one replica, platform concurrency one, an init process, 1 GiB memory and 256 MiB shared memory, then measure. The module does not deploy a service or provision paid resources. Verify the chosen host's sandbox support before enabling the provider. Keep all existing identity and database controls in the calling application.

Requests have a 12-second browser deadline plus up to one second for cleanup; the host HTTPS deadline is 15 seconds. Share resolution adds up to 8 seconds. Provision an enclosing request deadline with margin (for example 30 seconds). Cold starts may cause a first request to fail; warm the service before acceptance. Failures preserve existing counts in the host application; never write zero as a fallback. Stop/revoke access by disabling the provider before stopping the container.

## Isolation and limits

- One active browser job per instance, at least five seconds between starts, up to 16 accepted waiting requests. Same-account calls coalesce; success/failure caches last 60/15 seconds with a 256-entry bound. Preserve the original observation time when using cache.
- Every job gets a new anonymous browser context. Only the requested profile's unique visible fan card is used. Rounded values, login/verification, mismatched profiles and missing cards return no count.
- Downloads, Service Workers, WebSockets, subframe and popup navigation are blocked. HTTPS resource hosts are allowlisted. A local CONNECT proxy resolves only allowed hosts, rejects non-public addresses, and connects to the validated numeric IPv4 without a second DNS lookup. Media and fonts are blocked. No DevTools endpoint is exposed.
- Limits and caches are per instance. Keep maximum replicas at one initially; add shared quotas/cache before scaling. Apply host and gateway user/request quotas, including share-link resolution. Never expose the service as an anonymous open browser proxy.
- No stealth patches, signature reverse engineering, saved sessions or challenge solving. Public readability can change and does not verify account ownership. Xiaohongshu live collection is not supported.

CI builds the image and runs a synthetic Chromium/HTTP test; it does not access live accounts. `node --test test/profiles*.cjs` is also offline. Real account acceptance on the target cloud network is a separate required step.
