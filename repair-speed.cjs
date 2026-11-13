"use strict";
// Root entry point: forwards to the self-contained skill script.

const path = require("path");

if (require.main === module) {
  const script = path.join(__dirname, "skill", "zcode-speed-repair", "scripts", "repair-speed.cjs");
  process.exitCode = require(script).runCli();
}
