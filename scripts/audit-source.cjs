'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const allowed = new Set([
  'revenue/index.cjs', 'revenue/model.cjs', 'revenue/ledger.cjs', 'revenue/adapters.cjs', 'revenue/creator-electron.cjs',
  'revenue/douyin-anchor.cjs', 'test/revenue-anchor.test.cjs',
  'revenue/douyin-wallet.cjs', 'revenue/wallet-statement.cjs', 'revenue/wallet-sync.cjs',
  'test/revenue-wallet.test.cjs', 'test/revenue-wallet-sync.test.cjs', 'testing/revenue-wallet-fixtures.cjs',
  'examples/douyin-wallet-sync-electron.cjs',
  'docs/DOUYIN_WALLET.md', 'docs/DOUYIN_WALLET.en.md',
  'revenue/creator-sync.cjs', 'revenue/creator-sync-state.cjs', 'test/revenue-sync.test.cjs',
  'examples/creator-revenue-sync-electron.cjs',
  'revenue/android-device.cjs', 'revenue/douyin-wallet-android.cjs', 'test/revenue-android.test.cjs',
  'examples/douyin-wallet-android.cjs', 'docs/REVENUE_SYNC.md', 'docs/REVENUE_SYNC.en.md', 'docs/ANDROID_REVENUE.md', 'docs/ANDROID_REVENUE.en.md',
  'revenue/kuaishou.cjs', 'revenue/wechat-channels.cjs', 'revenue/page-transport.cjs', 'revenue/wechat-wallet-electron.cjs',
  'testing/revenue-extra-fixtures.cjs', 'test/revenue-extra.test.cjs', 'scripts/test-revenue-extra-electron.cjs',
  'testing/revenue-fixtures.cjs', 'test/revenue.test.cjs', 'scripts/test-revenue-electron.cjs',
  'examples/creator-revenue-electron.cjs', 'examples/revenue-demo.cjs', 'docs/CREATOR_REVENUE.md', 'docs/CREATOR_REVENUE.en.md',
  'profiles/creator-page.cjs', 'profiles/creator-electron.cjs', 'test/profiles-creator.test.cjs',
  'scripts/test-creator-electron.cjs', 'examples/creator-followers-electron.cjs', 'docs/CREATOR_FOLLOWERS.md', 'docs/CREATOR_FOLLOWERS.en.md',
  'core/user-badges.cjs', 'test/user-badges.test.cjs', 'schemas/live-event.v1.schema.json', 'testing/index.cjs', 'testing/replay.cjs', 'testing/scenarios.cjs',
  'examples/replay-events.cjs', 'test/event-contract.test.cjs', 'test/event-replay.test.cjs', 'test/source-audit.test.cjs',
  'docs/EVENTS.md', 'docs/EVENTS.en.md', 'docs/TESTING.md', 'docs/TESTING.en.md', 'CHANGELOG.en.md',
  'profiles/service-client.js', 'profiles/provider.js', 'test/profiles-service.test.cjs', 'scripts/test-profile-browser-fixture.cjs',
  'browser-service/server.js', 'browser-service/reader.js', 'browser-service/egress.js', 'browser-service/package.json', 'browser-service/package-lock.json',
  'browser-service/Dockerfile', 'docs/BROWSER_SERVICE.md', '.dockerignore',
  'profiles/index.cjs', 'profiles/model.js', 'profiles/client.js', 'profiles/transport.js',
  'profiles/resolver.js', 'profiles/browser.js', 'profiles/oauth.js', 'test/profiles-browser.test.cjs', 'test/profiles-oauth.test.cjs',
  'test/profiles.test.cjs', 'examples/profile-demo.cjs', 'docs/PROFILES.md',
  '.gitignore', '.gitattributes', '.github/workflows/test.yml', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md', 'SECURITY.md', 'README.en.md', 'CHANGELOG.md',
  'docs/API.md', 'docs/TROUBLESHOOTING.md', 'docs/ROADMAP.md', 'docs/SHOWCASE.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml', '.github/PULL_REQUEST_TEMPLATE.md',
  'package.json', 'package-lock.json', 'collector/pom.xml', 'collector/src/main/resources/logback.xml',
  'licenses/ORDINARYROAD-LICENSE.txt', 'licenses/BLIVEDM-LICENSE.txt', 'licenses/WXLIVESPY-LICENSE.txt',
  'wechat/wechat-collector.cjs', 'wechat/wechat-decoder.cjs', 'wechat/wechat-login-state.cjs', 'test/wechat.test.cjs',
  'wechat/wechat-gifts.cjs', 'wechat/wechat-viewers.cjs', 'test/wechat-gifts.test.cjs', 'test/wechat-viewers.test.cjs',
  'examples/java-stdin.cjs', 'examples/wechat-electron.cjs', 'examples/subscribe.cjs', 'examples/java-subscribe.cjs',
  'examples/offline-demo.cjs', 'examples/multi-platform.cjs', 'test/examples.test.cjs',
  'core/index.cjs', 'core/event-stream.cjs', 'core/avatar-cache.cjs', 'core/kuaishou-profile-avatars.cjs', 'core/emotes.cjs', 'core/java-collector.cjs',
  'test/core.test.cjs', 'test/core-avatar-cache.test.cjs', 'test/core-kuaishou-profile-avatars.test.cjs', 'test/core-java-collector.test.cjs',
  'test/core-capabilities.test.cjs',
  'scripts/audit-source.cjs', 'scripts/build-java.cjs', 'scripts/java-runtime.cjs', 'scripts/test.cjs', 'scripts/test-java.cjs'
]);
for (const name of ['UserBadges', 'BilibiliExtraEvents', 'BilibiliGiftV2', 'BilibiliInteractV2', 'Collector', 'ConnectionFailure', 'DouyinPkScores',
  'BilibiliAuthenticatedClient', 'DouyinAuthenticatedClient', 'KuaishouAvatarCache', 'KuaishouExtraEvents', 'MessageEmotes', 'PkEvents', 'ViewerSnapshots'])
  allowed.add(`collector/src/main/java/local/furryup/${name}.java`);
for (const name of ['UserBadges', 'BilibiliHandshake', 'BilibiliGiftCombo', 'BilibiliExtraEvents', 'BilibiliGiftMetadata', 'BilibiliMainInteractions', 'BilibiliV2', 'CollectorWire', 'DouyinHandshake',
  'ExpandedEvent', 'KuaishouAvatar', 'KuaishouExtraEvents', 'PkEvents', 'PlatformEvent', 'ViewerSnapshots'])
  allowed.add(`collector/src/test/java/local/furryup/${name}Fixture.java`);
const skipped = new Set(['.git', 'node_modules', 'collector/target']);
function auditBytes(name, body) {
  const findings = [];
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { return ['Non UTF-8 source']; }
  if (body.includes(0)) findings.push('Binary content');
  if (name !== 'scripts/audit-source.cjs') {
    if (/(?:[A-Za-z]:[\\/]Users[\\/]|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/.test(text))
      findings.push('Local path or credential-like material');
    if (/(?:require\s*\(|from\s+)['"][^'"]*(?:apps\/furryup-studio|private-training|commerce-manager|plugin-runtime-loader)/.test(text))
      findings.push('Private product runtime import');
  }
  return findings;
}
function auditSource(directory = root, { tracked = false } = {}) {
  const findings = [], inventory = [];
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (skipped.has(name)) continue;
      if (entry.isSymbolicLink()) { findings.push(`Symlink not allowed: ${name}`); continue; }
      if (entry.isDirectory()) { walk(name); continue; }
      if (!allowed.has(name)) { findings.push(`Not in source allowlist: ${name}`); continue; }
      const body = fs.readFileSync(path.join(directory, name));
      findings.push(...auditBytes(name, body).map(reason => `${reason}: ${name}`));
      inventory.push({ path: name, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
    }
  }
  walk();
  for (const name of allowed) if (name !== 'package-lock.json' && !inventory.some(item => item.path === name))
    findings.push(`Required source missing: ${name}`);
  if (tracked) {
    const { execFileSync } = require('node:child_process');
    const git = args => execFileSync('git', args, { cwd: directory, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const entries = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean);
    const indexed = new Set();
    for (const entry of entries) {
      const match = /^(\d+) ([a-f0-9]+) (\d)\t(.+)$/.exec(entry);
      if (!match) { findings.push('Invalid Git index entry'); continue; }
      const [, mode, oid, stage, name] = match;
      indexed.add(name);
      if (!allowed.has(name)) { findings.push(`Tracked path outside source allowlist: ${name}`); continue; }
      if (!['100644', '100755'].includes(mode) || stage !== '0') { findings.push(`Invalid index mode/stage: ${name}`); continue; }
      // Inspect exact staged bytes; a clean working copy cannot hide an earlier staged secret.
      const body = git(['cat-file', 'blob', oid]);
      findings.push(...auditBytes(name, body).map(reason => `Staged ${reason}: ${name}`));
      const actual = inventory.find(item => item.path === name);
      if (!actual || actual.sha256 !== createHash('sha256').update(body).digest('hex'))
        findings.push(`Staged content differs from audited working copy: ${name}`);
    }
    for (const name of allowed) if (!indexed.has(name)) findings.push(`Required source not tracked: ${name}`);
  }
  return { findings, inventory: inventory.sort((a, b) => a.path.localeCompare(b.path)) };
}
if (require.main === module) {
  try {
    const { findings, inventory } = auditSource(root, { tracked: process.argv.includes('--tracked') });
    if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
    else console.log(`PASS source allowlist: ${inventory.length} UTF-8 files; no detected binaries, links, private imports, local user paths or token material.`);
    if (process.argv.includes('--inventory')) console.log(JSON.stringify(inventory, null, 2));
  } catch {
    console.error('Source audit could not complete; publication is blocked.');
    process.exitCode = 1;
  }
}
module.exports = { auditBytes, auditSource };
