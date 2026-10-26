# Livestream event contract v1

[中文](EVENTS.md) · [Testing and replay](TESTING.en.md) · [JSON Schema](../schemas/live-event.v1.schema.json)

Applies to LiveConnect 0.7.3; event `schemaVersion` remains **1**. Profile/follower snapshots are a separate API, not livestream interactions. Live platforms are `bilibili`, `douyin`, `kuaishou` and `wechat`; there is no Xiaohongshu live collector.

Optional `user_badges` contains at most 16 `{kind, label, level?}` entries. Kinds are `role`, `membership`, `fans`, `wealth`, `level` and `title`; labels are at most 64 characters and levels are integers 1–1000. Missing values remain absent; legacy `badge_name` / `badge_level` stay compatible. Badges belong only to the current sender/message: never cache them across users or rooms or treat them as permissions or proof of current membership. Only explicit fields and verified resource identifiers are recognized; platform images are not redistributed and unknown image meanings are not inferred.

## Input, output and compatibility

Feed collector input to its owning `room.ingest(raw)`; unwrap Java's `{kind:'event', event:raw}` first. Accepted output is frozen, a duplicate returns null, and invalid input throws. Never ingest an already normalized event: its identity would be wrapped again.

The Schema validates normalized output, not wire input or anonymization. It checks public structure, required fields and count modes, allowing future optional additions. Protocol provenance, routing and monetary meaning require the adapters, core and consumer. Do not render arbitrary fields as HTML or publish them blindly.

| Field | Contract |
| --- | --- |
| `schemaVersion` | Currently 1. Breaking fields or semantics require a contract version change; the three-part product version is separate. |
| `event_id` | `live:<platform>:<encoded room>:<encoded source ID>`; low-level previews use `preview:`. Valid raw event_id takes precedence over source_msg_id; absent/invalid IDs fall back to a fresh UUID. |
| `source_msg_id` | Original ID or empty string. Preserve string precision; numeric inputs must be safe integers. Never deduplicate by message text or nickname. |
| `platform` / `room_id` | Bound by the room session; incoming fields cannot override routing. Room/user IDs are opaque strings. |
| `sequence` | Acceptance order within one stream, present in subscriptions but absent from low-level normalizeEvent output. Not a platform-global cursor. |
| `timestamp` / `received_at` | Milliseconds. Valid input time is preserved, otherwise local time is used; received_at is local receipt time, not a synchronized cross-platform clock. |
| `source` / `preview` | Provenance label and simulation flag. openRoom rejects preview:true. Offline replay instead labels its outer report synthetic:true and never claims a platform connection. |
| `user_id` / `user_name` | Missing ID is an empty string; the display-name fallback is “一位朋友”. A nickname is not an identity or deduplication key. |
| `count` / `count_mode` | Delta, snapshot or signal; use the type-specific rules below. |
| `value` | Always null currently; not a monetary conversion. |

See the [API reference (Chinese)](API.md) and Schema for optional fields, avatars/emotes, PK and visible-viewer shapes. Keep long integer IDs, exact scores and price strings as strings. Missing does not mean zero.

## Event semantics

| Type | Consumer rule |
| --- | --- |
| comment | Display content as text, never execute embedded HTML. |
| gift | count equals gift_count: a per-message increment of 1–1000000. Adapters handle cumulative combo counters; consumers must not sum those totals again. |
| like | Known increments on Java platforms. WeChat Channels uses signal: count=1 does not establish exactly one additional like. |
| enter / follow / share | Protocol-supported actions only; do not infer them from viewer-count or nickname changes. |
| notice / entry_effect | Notices and effects are not automatically follows, ordinary joins or paid gifts. |
| super_chat | Bilibili paid messages with known IDs and raw monetary fields. |
| super_chat_delete | Bilibili withdrawal IDs: remove corresponding displayed/persisted messages; do not increment interaction totals. |
| room_stats | snapshot, count=0. Keep current viewers, cumulative viewers and cumulative likes separate. Missing is omitted; explicit zero is preserved. |
| viewer_snapshot | snapshot, count=0. Visible fragments/contributor ranks are not complete online lists; do not derive joins, leaves or dwell time. |
| pk_status | snapshot, count=0. Only use protocol-supported battle identities, participants and scores; do not invent winners. |
| live_status | Platform broadcast state is separate from collector connection state; a disconnect does not imply the broadcast ended. |

A delta label is not permission to count every event as a business action: also inspect event_type. Interpret raw gift prices per platform/unit; do not universally multiply by quantity or infer cross-platform revenue.

## Deduplication, ordering and room lifecycle

- Deduplication uses the routed event ID, isolated by platform and room. Entries expire strictly after **600000 ms** from receipt, with at most **20000** IDs. Eviction, expiry, process restart or room closure can allow an old event again.
- A duplicate returns null without advancing sequence or replaying gifts. Missing reliable IDs receive fresh UUIDs, so replay deduplication is not guaranteed.
- Output follows **arrival order**, not timestamp order. Late events have newer sequences and older timestamps. Consumers define their own event-time windows; this does not recover messages never received during an upstream outage.
- A transport reconnect retaining the same room object retains deduplication. close clears that room's dedup/history/avatar state; a replacement room does not inherit it. Ingesting through a closed handle throws.
- Route callbacks by their actual source room. Late old-room actions may remain in old-room history but must not reset or overwrite the selected room. Reject callbacks after closing the old session; the current UI selection is not a routing authority.
- History holds 100 events across the instance, not 100 per room. The three snapshot types and withdrawals are not replayable history actions; withdrawal also removes matching paid messages. Subscriptions do not replay history automatically.
- Avatar hydration is metadata, not another gift/count action. Observer failures are isolated; asynchronous callbacks are not awaited. Bounded consumer queues, persistence and cross-restart idempotency remain the host's responsibility.

## Public-data boundary

New fixtures are independently authored/generated with synthetic identifiers; they do not read Studio, login sessions, viewer records or captured live traffic. No FurryUP account is needed. A schema or synthetic label cannot establish anonymization of arbitrary external data. Review provenance rather than renaming real captures. Cutout, model resources and private broadcaster modules are outside this change.
