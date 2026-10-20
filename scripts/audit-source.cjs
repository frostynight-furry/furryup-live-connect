'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const allowed = new Set([
  '.gitignore', '.gitattributes', '.github/workflows/test.yml', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md', 'SECURITY.md', 'README.en.md', 'CHANGELOG.md',
  'docs/API.md', 'docs/TROUBLESHOOTING.md', 'docs/ROADMAP.md', 'docs/SHOWCASE.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml', '.github/PULL_REQUEST_TEMPLATE.md',
  'package.json', 'package-lock.json', 'collector/pom.xml', 'collector/src/main/resources/logback.xml',
  'licenses/ORDINARYROAD-LICENSE.txt', 'licenses/BLIVEDM-LICENSE.txt', 'licenses/WXLIVESPY-LICENSE.txt',
  'wechat/wechat-collector.cjs', 'wechat/wechat-decoder.cjs', 'test/wechat.test.cjs',
  'examples/java-stdin.cjs', 'examples/wechat-electron.cjs', 'examples/subscribe.cjs', 'examples/java-subscribe.cjs',
  'examples/offline-demo.cjs', 'examples/multi-platform.cjs', 'test/examples.test.cjs',
  'core/index.cjs', 'core/event-stream.cjs', 'core/avatar-cache.cjs', 'core/kuaishou-profile-avatars.cjs', 'core/emotes.cjs', 'core/java-collector.cjs',
  'test/core.test.cjs', 'test/core-avatar-cache.test.cjs', 'test/core-kuaishou-profile-avatars.test.cjs', 'test/core-java-collector.test.cjs',
  'scripts/audit-source.cjs', 'scripts/build-java.cjs', 'scripts/java-runtime.cjs', 'scripts/test.cjs', 'scripts/test-java.cjs'
]);
for (const name of ['BilibiliExtraEvents', 'BilibiliGiftV2', 'BilibiliInteractV2', 'Collector', 'ConnectionFailure',
  'DouyinAuthenticatedClient', 'KuaishouAvatarCache', 'KuaishouExtraEvents', 'MessageEmotes', 'PkEvents', 'ViewerSnapshots'])
  allowed.add(`collector/src/main/java/local/furryup/${name}.java`);
for (const name of ['BilibiliExtraEvents', 'BilibiliGiftMetadata', 'BilibiliMainInteractions', 'BilibiliV2', 'CollectorWire', 'DouyinHandshake',
  'ExpandedEvent', 'KuaishouAvatar', 'KuaishouExtraEvents', 'PkEvents', 'PlatformEvent', 'ViewerSnapshots'])
  allowed.add(`collector/src/test/java/local/furryup/${name}Fixture.java`);
const skipped = new Set(['.git', 'node_modules', 'collector/target']);
const findings = [], inventory = [];
function walk(relative = '') {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (skipped.has(name)) continue;
    if (entry.isSymbolicLink()) { findings.push(`Symlink not allowed: ${name}`); continue; }
    if (entry.isDirectory()) { walk(name); continue; }
    if (!allowed.has(name)) { findings.push(`Not in source allowlist: ${name}`); continue; }
    const body = fs.readFileSync(path.join(root, name));
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
    catch { findings.push(`Non UTF-8 source: ${name}`); continue; }
    if (body.includes(0)) findings.push(`Binary content: ${name}`);
    if (name !== 'scripts/audit-source.cjs' && /(?:[A-Za-z]:[\\/]Users[\\/]|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/.test(text))
      findings.push(`Local path or credential-like material: ${name}`);
    inventory.push({ path: name, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  }
}
walk();
// Before publishing, also check the actual Git index, including ignored paths.
if (process.argv.includes('--tracked')) {
  const { execFileSync } = require('node:child_process');
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  for (const name of tracked) if (!allowed.has(name)) findings.push(`Tracked path outside source allowlist: ${name}`);
  for (const name of allowed) if (!tracked.includes(name)) findings.push(`Required source not tracked: ${name}`);
}
for (const name of allowed) if (name !== 'package-lock.json' && !inventory.some(item => item.path === name)) findings.push(`Required source missing: ${name}`);
if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
else console.log(`PASS source allowlist: ${inventory.length} UTF-8 files, no bundled binaries, symlinks, local user paths or detected token material.`);
if (process.argv.includes('--inventory')) console.log(JSON.stringify(inventory.sort((a, b) => a.path.localeCompare(b.path)), null, 2));
