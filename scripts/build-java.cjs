'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Maven must be on PATH; JAVA_HOME must point to a JDK 21+ installation.
// Arguments are fixed here, never interpolated from room IDs or credentials.
const result = spawnSync(process.platform === 'win32' ? 'mvn.cmd' : 'mvn',
  ['-B', '-f', 'collector/pom.xml', 'package'],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
if (result.error) console.error('Could not start Maven. Install Maven 3.9+ and JDK 21+, and set PATH/JAVA_HOME.');
process.exitCode = result.status ?? 1;
