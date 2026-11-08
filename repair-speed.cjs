"use strict";
// Compatibility entry point for the self-contained ZCode speed skill.

const path = require("path");

if (require.main === module) {
  const script = path.join(__dirname, "skill", "zcode-speed-repair", "scripts", "repair-speed.cjs");
  process.exitCode = require(script).main();
}
