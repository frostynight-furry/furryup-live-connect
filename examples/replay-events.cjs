// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { SCENARIOS, createSyntheticScenario, replayScenario } = require('../testing/index.cjs');
function main(args = process.argv.slice(2), write = line => console.log(line)) {
  if (args.length > 1 || (args.length === 1 && !SCENARIOS.includes(args[0])))
    throw new TypeError(`Usage: node examples/replay-events.cjs [${SCENARIOS.join('|')}]`);
  for (const name of args.length ? args : SCENARIOS) write(JSON.stringify(replayScenario(createSyntheticScenario(name))));
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
