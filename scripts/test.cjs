'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const nodeTests = fs.readdirSync(path.resolve(__dirname, '../test')).filter(name => name.endsWith('.test.cjs')).sort().map(name => `test/${name}`);
for (const args of [['--test', ...nodeTests], ['scripts/test-java.cjs'], ['scripts/audit-source.cjs']]) {
  const result = spawnSync(process.execPath, args, { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
