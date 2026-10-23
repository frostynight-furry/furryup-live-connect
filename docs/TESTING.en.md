# Offline testing and synthetic replay

[中文](TESTING.md) · [Event contract](EVENTS.en.md)

Replay needs no Java, Electron, account or network. It runs the public core with authored synthetic data and never starts a collector. The CLI accepts scenario names, not file paths or daily user data.

```sh
npm run replay
npm run replay -- delivery
npm run replay -- room-switch
npm run replay -- reconnect
```

Each line is a JSON report containing fixtureVersion=1, synthetic=true, the scenario name, accepted/duplicate/rejected counts, per-room totals, selected rooms and a step trace. received_at is excluded from trace events to avoid wall-clock differences; explicit synthetic timestamps, IDs, sequences and operation order remain. Reports are test evidence, never input to real gift/payment/action services.

| Scenario | Expected outcome |
| --- | --- |
| delivery | Four concurrent platforms; 20 accepted, 8 duplicates; each room has 2 comments, gift deltas 2+3=5 and explicit viewer count 0. Late messages retain arrival order. |
| room-switch | 3 accepted and 1 rejected after closure; old-room gifts total 14, the selected new room stays at 2. Late events do not switch the selected room back. |
| reconnect | Same-session redelivery deduplicates; closing/recreating permits the same ID again; the old handle rejects input. 2 accepted, 1 duplicate, 1 rejected. |

Use in your own offline tests:

```js
const { createSyntheticScenario, replayScenario } = require('./testing/index.cjs');
const report = replayScenario(createSyntheticScenario('room-switch'));
if (report.activeRooms[0].gifts !== 2) throw new Error('Room isolation regressed');
```

Each call creates a fresh fixture. Replay permits at most 10000 steps and the core's default 16 simultaneous rooms. Envelope/operation/event keys are allowlisted, IDs start with synthetic-, and text must explicitly identify itself as synthetic. URLs, file paths, email addresses and extra credential fields are rejected. These misuse guards are not a general anonymization certification.

## Verification commands and limits

Use Node.js 22.12+; full Java checks also require JDK 21+ and Maven 3.9+. Install locked test dependencies first. ignore-scripts avoids downloading Electron just for offline tests; real Electron examples still need their documented runtime installation.

```sh
npm ci --ignore-scripts
npm run test:events
npm run build
npm test
npm run replay
npm run demo
npm run demo:profiles
```

Event tests strictly compile the public Schema with Ajv, checking all 14 variants, malformed envelopes, count modes, unknown values, TTL/capacity boundaries, routing, replay and adversarial source audits. Ajv is development-only; core/replay runtime has no Ajv dependency. Full npm test retains core, WeChat, profile/follower and Java fixtures. CI retains Windows/Linux, Node 22/24 and isolated browser-service tests. Synthetic fixtures do not certify real accounts, platform availability or long-running live sessions.

## Before publication

```sh
npm run audit
git add <reviewed-files>
node scripts/audit-source.cjs --tracked
```

The per-file allowlist rejects unlisted material, binaries, links and detected local-user paths/tokens/private-product runtime imports. Tracked mode reads the exact staged blobs and modes and requires byte agreement with the audited working copy. Cleaning a working file cannot hide an older staged secret. New files require explicit allowlist entries, never broad directory wildcards.

Passing automation still requires diff and provenance review. Retain an inventory and audit the actual Git source archive again. Keep logs, generated test output, real account data and private acceptance receipts outside the repository. Never import private Studio, model or cutout modules to make this repository's tests pass.

## Bilingual maintenance

Maintain Chinese and English README, event contract, testing guide and current-version release notes with language links. Both languages share the same Schema, implementation, fixtures and CI, not separate protocol branches. Keep field names/enums in English and update both semantic descriptions for behavior changes. Existing Chinese-only specialist documents are labelled as such in English navigation.
