# Third-party notices

FurryUP LiveConnect contains original integration code and protocol adapters released under the [MIT License](LICENSE). It does not vendor the complete OrdinaryRoad or wxlivespy projects, dependency JARs, a Java runtime, or Electron binaries. The following upstream licenses and notices remain unchanged and applicable to their respective material.

## OrdinaryRoad

The Maven build uses these unmodified Maven Central coordinates at version **1.5.8**:

- `tech.ordinaryroad:live-chat-client-bilibili`
- `tech.ordinaryroad:live-chat-client-douyin`
- `tech.ordinaryroad:live-chat-client-kuaishou`

OrdinaryRoad: MIT, Copyright (c) 2023 OrdinaryRoad. Full text: [licenses/ORDINARYROAD-LICENSE.txt](licenses/ORDINARYROAD-LICENSE.txt).

`DouyinAuthenticatedClient` adapts the WebSocket handshake setup in OrdinaryRoad 1.5.8's `DouyinLiveChatClient.initConnectionHandler`, preserving the configured login cookie alongside the initialized `ttwid`. The original repository was unavailable during the earlier inspection; a preserved source copy was inspected at [KByteArray/ordinaryroad-live-chat-client, commit 6786f7906d5669fa8a5333354658e8daec00feba](https://github.com/KByteArray/ordinaryroad-live-chat-client/tree/6786f7906d5669fa8a5333354658e8daec00feba). Executable dependencies are resolved from Maven Central, not that copy's binaries.

## blivedm

The local `BilibiliGiftV2`, `BilibiliInteractV2`, and `BilibiliExtraEvents` adapters use the protobuf/JSON field descriptions in [xfgryujk/blivedm, commit 3bf17fe862b8c2fc6bc04c81c3f0c5db95de93d6](https://github.com/xfgryujk/blivedm/tree/3bf17fe862b8c2fc6bc04c81c3f0c5db95de93d6), including `blivedm/models/pb.py` and `models/web.py`.

blivedm: MIT, Copyright (c) 2018 xfgryujk. Full text: [licenses/BLIVEDM-LICENSE.txt](licenses/BLIVEDM-LICENSE.txt). These decoders are local implementations; blivedm itself is not bundled.

Legacy membership/entry shapes were checked against the preserved [bilibili-api-collect documentation](https://github.com/alittlehuaji/bilibili-api-collect-mirror/blob/cfc5fddcc8a94b74d91970bb5b4eaeb349addc47/docs/live/message_stream.md). No source code from that documentation mirror is copied. Unknown legacy `op_type` meanings are not inferred.

## wxlivespy and WeChat protocol references

The video-account message decoder uses message type descriptions from [fire4nt/wxlivespy, commit 10351334a5dd48f7e9cd06482cf91fde066176a6](https://github.com/fire4nt/wxlivespy/tree/10351334a5dd48f7e9cd06482cf91fde066176a6). Its MIT license text, including the upstream attribution to Electron React Boilerplate, is preserved verbatim in [licenses/WXLIVESPY-LICENSE.txt](licenses/WXLIVESPY-LICENSE.txt). This repository provides its own Electron collector and decoder rather than a full copy of wxlivespy.

## Kuaishou profile adapter

The profile-avatar adapter is an original implementation of Kuaishou's HTTPS endpoint at `live.kuaishou.com/live_api/baseuser/userinfo/byid`. It validates the returned user ID and image host, respects hidden identities, and bounds requests, caching and retries. It does not redistribute Kuaishou web application code or third-party scraper implementations. The endpoint is not a guaranteed public developer API.

Newer message endpoints and notice/live-status shapes were also checked against the official video-account assistant JavaScript build `26092402`, module `44704` / `updateAppList`: [official reference asset](https://res.wx.qq.com/t/wx_fed/finder/helper/live/finder-helper-live/res/static/js/async/969.9949886a.js). The upstream web application source and assets are not redistributed.

## Protocol references added in 0.2.0

The Bilibili PK adapter is an original implementation of wire-field descriptions checked against [qydysky/bili_danmu, commit 76304fa1c5e337d20837a2b346a3c2a90c680996](https://github.com/qydysky/bili_danmu/tree/76304fa1c5e337d20837a2b346a3c2a90c680996/Reply/ws_msg) and [ShmilyChen/bilive_client, commit c0d70369ef5b3128309201ffb0f65522b31d5444](https://github.com/ShmilyChen/bilive_client/blob/c0d70369ef5b3128309201ffb0f65522b31d5444/bilive/%40types/danmaku.d.ts). Both repositories declare MIT licenses. No upstream implementation is vendored.

WeChat gift-catalog and visible-viewer fields were checked against the official assistant's public static resources: [794.72f12fb9.js](https://res.wx.qq.com/t/wx_fed/finder/helper/live/finder-helper-live/res/static/js/async/794.72f12fb9.js), [805.b6dd9a5a.js](https://res.wx.qq.com/t/wx_fed/finder/helper/live/finder-helper-live/res/static/js/async/805.b6dd9a5a.js), and [185.50f45423.js](https://res.wx.qq.com/t/wx_fed/finder/helper/live/finder-helper-live/res/static/js/async/185.50f45423.js). Their code, assets and live responses are not redistributed. The older `wordweb/Get-Tencent-Video-Live-Barrage-Gifts` repository was used only as an endpoint lead; no license was found and no code was copied from it.

The Kuaishou viewer changes use OrdinaryRoad's existing protocol classes, cross-checked against the official public `app.1241f9804c38413b871f.js` and `liveRoom.1241f9804c38413b871f.js` resources under `https://p2-game.kskwai.com/udata/pkg/KS-GAME-WEB/pc-live-next/js/`. No official source, runtime asset or account data is bundled.

The Douyin pair-score adapter independently reads the wire fields and UPDATE discriminator confirmed by the official public [live-schema-im.e322bd8a.js](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/chunks/live-schema-im.e322bd8a.js), [PKViewPlugin.de2e4662.js](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/chunks/PKViewPlugin.de2e4662.js), and [client-entry~1.28f20eec.js](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/client-entry~1.28f20eec.js). Official code and assets are not redistributed. TikTok's same-named messages are not used as evidence of Douyin compatibility.

## Downloaded build/runtime dependencies

Maven and npm resolve transitive dependencies separately under their respective licenses. Electron is used only as a development/runtime dependency for the example. Consult dependency POMs and the JAR `META-INF` license/notice files and Electron notices before redistributing any binaries. No Java runtime, source archive, or dependency binary is distributed by this source repository.
