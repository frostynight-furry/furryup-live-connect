'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { auditBytes, auditSource } = require('../scripts/audit-source.cjs');

test('source byte checks reject binary, token, local-path and private-runtime imports', () => {
  const samples = [Buffer.from([0xff]), Buffer.from('bad\0binary'),
    Buffer.from('gh' + 'p_' + 'x'.repeat(36)), Buffer.from('C:/' + 'Users/synthetic/private'),
    Buffer.from('require(' + "'../apps/" + "furryup-studio/desktop/main.cjs')")];
  for (const bytes of samples) assert.ok(auditBytes('core/index.cjs', bytes).length > 0);
  assert.deepEqual(auditBytes('README.md', Buffer.from('合成 / Synthetic documentation')), []);
});

test('staged bytes cannot be hidden by a clean working copy or an ignored path', t => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'liveconnect-source-audit-'));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(temporaryRoot + path.sep));
    assert.ok(path.basename(directory).startsWith('liveconnect-source-audit-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const git = (args, input) => execFileSync('git', args, { cwd: directory, input, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  git(['init', '--quiet']); git(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(directory, 'README.md'), 'gh' + 'p_' + 'x'.repeat(36));
  git(['add', 'README.md']);
  fs.writeFileSync(path.join(directory, 'README.md'), 'Clean synthetic documentation');
  let result = auditSource(directory, { tracked: true });
  assert.ok(result.findings.some(value => value.startsWith('Staged Local path or credential-like material: README.md')));
  assert.ok(result.findings.includes('Staged content differs from audited working copy: README.md'));
  fs.mkdirSync(path.join(directory, 'node_modules'));
  fs.writeFileSync(path.join(directory, 'node_modules', 'synthetic-data.json'), '{}');
  git(['add', '--force', 'node_modules/synthetic-data.json']);
  const oid = git(['hash-object', '-w', '--stdin'], Buffer.from('../synthetic-outside')).toString().trim();
  git(['update-index', '--add', '--cacheinfo', `120000,${oid},core/index.cjs`]);
  result = auditSource(directory, { tracked: true });
  assert.ok(result.findings.includes('Tracked path outside source allowlist: node_modules/synthetic-data.json'));
  assert.ok(result.findings.includes('Invalid index mode/stage: core/index.cjs'));
});
