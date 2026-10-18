'use strict';
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const java = process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : 'java';
const classpath = [path.join(root, 'collector/target/test-classes'),
  path.join(root, 'collector/target/collector.jar'), path.join(root, 'collector/target/lib/*')].join(path.delimiter);
module.exports = { root, java, classpath };
