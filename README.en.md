# FurryUP LiveConnect

[中文](README.md) · [API reference (中文)](docs/API.md) · [Troubleshooting (中文)](docs/TROUBLESHOOTING.md) · [Roadmap](docs/ROADMAP.md)

Open-source **five-platform profile/follower adapters** for Bilibili, Douyin, Kuaishou, WeChat Channels and Xiaohongshu, alongside the existing four-platform livestream event API. Xiaohongshu has no live collector. Build profile pages, chat overlays, interactive pets and OBS components.

Version **0.4.0** · MIT license · Node.js **22.12+**. No FurryUP account or FurryUP Studio installation is required.

See [Profiles and followers](docs/PROFILES.md) for the new standalone module. Bilibili/Xiaohongshu public adapters are opt-in and experimental; Douyin supports a host-supplied browser reader; Douyin/Kuaishou also offer optional server OAuth; Channels remains manual. Five recognized platforms do not imply five automatic count APIs. `npm run demo:profiles` runs a synthetic offline example; `npm run test:profiles` runs its regression tests.

## Try the offline demo

```sh
git clone https://github.com/frostynight-furry/furryup-live-connect.git
cd furryup-live-connect
npm run demo
```

This uses explicitly labelled synthetic events for all four platforms. It demonstrates subscriptions, message deduplication and incremental gift counts without network access, credentials, Java or Electron. It does not verify live platform connectivity.

## Connect real collectors

| Platforms | Requirements | Entry point |
| --- | --- | --- |
| Bilibili, Douyin, Kuaishou | JDK 21+, Maven 3.9+, room IDs and any platform-required login cookies | `npm run build`, then `npm run start:java:subscribe` or `npm run start:multi` |
| WeChat Channels | Electron on a desktop, authorized login to your live management page | `npm ci`, then `npm run start:wechat` |

The Java adapters use OrdinaryRoad **1.5.8** from Maven Central. This repository is an independent integration; it does not vendor the complete OrdinaryRoad project. WeChat uses its own Electron collector and is limited to the logged-in operator's backend. It cannot collect arbitrary third-party rooms by ID.

The Java examples read connection JSON from the first stdin line. Keep stdin open until shutdown; do not use a one-shot `echo | ...` command. Credentials belong in a private process pipe, not command-line arguments, committed files or logs. EOF or Ctrl+C stops the example. See the [Chinese quick start](README.md#三平台-java-采集) for configurations.

The WeChat example does not remember login. Embedders that enable `remember` must supply encrypted credential storage. Version 0.2.1 saves a bounded versioned record containing cookies and four official account-selection localStorage fields, and can still read older cookie arrays. It does not export a browser profile or retain unrelated page data. Expired sessions and platform verification still require login; await `stop()` before exiting so the final state can be saved.

## Embed the event hub

```js
const { createLiveConnect } = require('./core/index.cjs');
const live = createLiveConnect();
const room = live.openRoom({ platform: 'bilibili', roomId: 'YOUR_ROOM_ID' });
const unsubscribe = live.subscribe(event => {
  // Send the fields you need to your application.
}, { eventTypes: ['comment', 'gift'] });

// Feed actual collector events into the session:
// room.ingest(message.event);

// Stop external collectors first, then unsubscribe and close the hub.
// unsubscribe(); live.close();
```

`openRoom` creates a processing session, not a network connection. Bind one session to each platform and room. `createJavaCollector` manages a Java subprocess with a finite retry budget; `WechatCollector` runs in an Electron main process. Both can feed the same hub.

Avatar updates are metadata, not repeated chat or gift events. Kuaishou profile lookup is optional, requires an explicitly supplied cookie, and excludes hidden identities. Downloading public avatar images does not forward login cookies.

## Scope and limitations

- Comments, viewer fields and gift events are normalized; optional fields vary by platform.
- Basic Bilibili PK now includes preparation, start, exact score strings, finish and opponent metadata. It does not infer winners or cover every battle mode.
- Douyin adds verified two-participant score updates and finish scores. Relative or blurred scores remain display text, and team/multi-party modes are not treated as ordinary pair totals.
- WeChat gift thumbnails are mapped from the authorized backend's observed gift catalog. Partial visible viewer snapshots are read from its online-member response; this is not a full audience list.
- Kuaishou/Douyin viewer snapshots preserve validated images and source ranks where supplied, while filtering hidden identities.
- Gift deltas, combo totals, room statistics and like signals have different meanings. Do not add snapshots to interaction counters.
- Full online viewer lists, complete PK data and disconnected-message backfill are not guaranteed. See the [capability table](README.md#当前数据能力).
- The roadmap distinguishes implemented adapters from unresolved protocol research. New adapters have synthetic regression coverage; live-room coverage still requires authorized validation. Platform changes may break community adapters.
- The SDK does not collect telemetry or install a background updater. Dependency upgrades require a rebuild and testing.

## Validate and contribute

```sh
npm run test:core
npm run test:wechat
npm run test:examples
npm run build
npm test
```

Tests use synthetic data and do not join live rooms. [Contribution guidelines](CONTRIBUTING.md), [security reporting](SECURITY.md), [third-party notices](THIRD_PARTY_NOTICES.md).

## FurryUP products

Develop your own tools with LiveConnect, or explore the complete [FurryUP Studio](https://github.com/frostynight-furry/furryup-studio-releases) application and [FurryUP desktop pet](https://github.com/frostynight-furry/furryup-desktop-pet-releases). [Official website](https://frostynight.top/furryup).

The standalone source in this repository is MIT licensed. FurryUP Studio's workbench, complete OBS workflow, assistant, character interactions and account services are outside this repository. Product branding and screenshots retain their separate rights.
