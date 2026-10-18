'use strict';
const { spawn } = require('node:child_process');
const { root, java, classpath } = require('../scripts/java-runtime.cjs');
// Reads the first UTF-8 JSON line from stdin; subsequent lines keep the
// collector alive. EOF disconnects. Credentials never become process arguments.
const child = spawn(java, ['-cp', classpath, 'local.furryup.Collector'], {
  cwd: root, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true
});
child.on('error', () => { console.error('Java failed to start; check JAVA_HOME and run npm run build.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; process.stdin.unpipe(child.stdin); process.stdin.pause(); });
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(); });
