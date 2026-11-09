"use strict";
/* Manage the speed bar injected into ZCode's app.asar.
 * Installation detects the renderer store from structural anchors. Ambiguous
 * anchors require a structurally verified --registry; missing store features
 * prevent installation. verify reports detection without changing files.
 * Pending replacement metadata preserves originalStamp's integer precision.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const { spawn, spawnSync } = require("child_process");

const SRC = __dirname;                                             // bundled files (source of truth)
let RUNTIME = path.join(os.homedir(), ".zcode", "zcode-speed");    // deployed copies + machine-local state
const MAIN = "out/main/index.js";
const BRIDGE_MARK = "zspeed-bridge:v1 begin";
const BRIDGE_RE = /\n?\/\* zspeed-bridge:v1 begin \*\/[\s\S]*?\/\* zspeed-bridge:v1 end \*\/\n?/g;
// Read the substituted registry binding from an injected bridge.
const REGISTRY_LINE_RE = /const registry = ([A-Za-z_$][\w$]*);/;
// Matches a zusage loader line from any runtime directory (the directory can
// move between installs), so a new install never leaves a stale line behind.
const LOADER_RE = /\n;import\("[^"]*inject-main\.cjs"\)\.then\(\(\) => null, \(e\) => console\.error\("\[zusage\] load failed", e\)\);\n?/g;
// Store-shape evidence a candidate bundle must still contain for the bridge to
// work (contract in speed-bridge.js). Generic keys are useless as a gate.
const FEATURES = ["productTurnId", "rowId", "logEpoch", "assistantText", "projectionReady"];
const BLOCK = 4194304;
const RUNTIME_FILES = ["inject-main.cjs", "speed-bridge.js", "repair-speed.cjs"];
const ESSENTIAL_FILES = ["inject-main.cjs", "speed-bridge.js"];
const FINAL_STATE = { install: "installed", remove: "removed" };
const COMMANDS = ["install", "remove", "check", "wait", "deploy", "verify"];

// Indirection points for tests: swap replaceFile to simulate the host's file
// lock, spawnWaiter to skip the background process, installRoots to inject
// candidate installation directories.
const hooks = {
  replaceFile: (from, to) => fs.renameSync(from, to),
  spawnWaiter: archive => startWaiter(archive),
  installRoots: platform => installRootsFor(platform),
};

function setRuntime(dir) { RUNTIME = path.resolve(dir); }

function sha(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const read = fs.readSync(fd, buffer, total, length - total, position + total);
    if (read <= 0) break;
    total += read;
  }
  return buffer.subarray(0, total);
}

function readHeader(fd) {
  const head = readAt(fd, 0, 16);
  if (head.length !== 16) throw new Error("Invalid ASAR header");
  const a = head.readUInt32LE(0), b = head.readUInt32LE(4), c = head.readUInt32LE(8), d = head.readUInt32LE(12);
  if (a !== 4 || d > b || b > 100000000) throw new Error("Invalid ASAR header");
  return [JSON.parse(readAt(fd, 16, d).toString("utf8")), 8 + b];
}

function listFiles(node, prefix = "") {
  const out = [];
  for (const [name, item] of Object.entries(node.files || {})) {
    const joined = prefix + name;
    if ("files" in item) out.push(...listFiles(item, joined + "/"));
    else out.push([joined, item]);
  }
  return out;
}

function readFileNode(fd, nodes, base, name) {
  const node = nodes[name];
  if (node.unpacked) throw new Error("Target is unpacked: " + name);
  const data = readAt(fd, base + Number(node.offset), node.size);
  if (data.length !== node.size) throw new Error("Truncated ASAR file: " + name);
  return data;
}

function stamp(target) {
  const info = fs.statSync(target, { bigint: true });
  return [info.size, info.mtimeNs, info.ino];
}

function stampEquals(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((value, index) => typeof value === "bigint" && value === b[index]);
}

function fileSha(target) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(target, "r");
  try {
    const buffer = Buffer.alloc(BLOCK);
    let position = 0, read;
    while ((read = fs.readSync(fd, buffer, 0, BLOCK, position)) > 0) {
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function asset(name) {
  return path.join(SRC, name);
}

function deploy() {
  // Sync the bundled files into the runtime directory; return what changed.
  if (path.resolve(SRC) === path.resolve(RUNTIME)) return [];
  fs.mkdirSync(RUNTIME, { recursive: true });
  const deployed = [];
  for (const name of RUNTIME_FILES) {
    const source = path.join(SRC, name), target = path.join(RUNTIME, name);
    const sourceMissing = !fs.existsSync(source) || !fs.statSync(source).isFile();
    const targetMissing = !fs.existsSync(target) || !fs.statSync(target).isFile();
    if (sourceMissing) {
      if (targetMissing && ESSENTIAL_FILES.includes(name))
        throw new Error(`${name} is missing from both ${SRC} and ${RUNTIME}`);
      continue; // the runtime copy may legitimately carry files this bundle lacks
    }
    if (targetMissing || !fs.readFileSync(target).equals(fs.readFileSync(source))) {
      fs.copyFileSync(source, target);
      deployed.push(name);
    }
  }
  return deployed;
}

function parseRegistryExport(text) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("HKEY_")) {
      current = { display: null, location: null };
      entries.push(current);
      continue;
    }
    const match = line.match(/^\s+(DisplayName|InstallLocation)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
    if (match && current) {
      if (match[1] === "DisplayName") current.display = match[2];
      else current.location = match[2];
    }
  }
  return entries
    .filter(entry => entry.display && entry.display.toLowerCase().includes("zcode") && entry.location)
    .map(entry => entry.location.trim());
}

function registryInstallRoots() {
  // Install roots advertised by ZCode's Windows uninstall entries.
  const roots = [];
  if (process.platform !== "win32") return roots;
  const key = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
  for (const hive of ["HKCU", "HKLM"]) {
    for (const view of ["/reg:32", "/reg:64"]) {
      let result;
      try {
        result = spawnSync("reg.exe", ["query", `${hive}\\${key}`, "/s", view],
          { encoding: "utf8", windowsHide: true });
      } catch (_) {
        continue;
      }
      if (result.status !== 0 || !result.stdout) continue;
      roots.push(...parseRegistryExport(result.stdout));
    }
  }
  return roots;
}

function installRootsFor(platform) {
  if (platform === "win32") {
    const roots = [...registryInstallRoots()];
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "Programs", "ZCode"));
    roots.push(path.join(os.homedir(), "AppData", "Local", "Programs", "ZCode"));
    for (const directory of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (directory) roots.push(path.join(directory, "ZCode"));
    }
    return roots;
  }
  if (platform === "darwin") {
    return ["/Applications/ZCode.app", path.join(os.homedir(), "Applications", "ZCode.app")];
  }
  const roots = [];
  try {
    for (const entry of fs.readdirSync("/opt")) {
      if (/^zcode/i.test(entry)) roots.push(path.join("/opt", entry));
    }
  } catch (_) { /* /opt may not exist. */ }
  roots.push("/usr/lib/zcode", "/usr/share/zcode", path.join(os.homedir(), ".local", "share", "zcode"));
  return roots;
}

function asarInRoot(root, platform) {
  const parts = platform === "darwin" ? ["Contents", "Resources", "app.asar"] : ["resources", "app.asar"];
  return path.join(root, ...parts);
}

function looksLikeZCodeRoot(root, platform) {
  try {
    if (platform === "win32") return fs.statSync(path.join(root, "ZCode.exe")).isFile();
    if (platform === "darwin") {
      const macos = path.join(root, "Contents", "MacOS");
      return fs.statSync(macos).isDirectory() && fs.readdirSync(macos).length > 0;
    }
    return fs.readdirSync(root).some(entry => /^zcode/i.test(entry));
  } catch (_) {
    return false;
  }
}

function findZcodeAsar(platform = process.platform) {
  // Auto-locate app.asar: per-platform discovery roots, deduplicated.
  const tried = [], seen = new Set(), found = [];
  for (let root of hooks.installRoots(platform)) {
    try {
      root = path.resolve(root);
    } catch (_) {
      continue;
    }
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = asarInRoot(root, platform);
    tried.push(candidate);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && looksLikeZCodeRoot(root, platform))
      found.push(candidate);
  }
  if (found.length === 1) return found[0];
  if (found.length > 1)
    throw new Error("Multiple ZCode installations found; select one with --asar:\n  " +
      found.join("\n  "));
  throw new Error("Could not locate ZCode's app.asar automatically; tried:\n  " + tried.join("\n  ") +
    "\nPass the path explicitly: --asar \"<ZCode install>\\resources\\app.asar\"");
}

function installationRoot(archive) {
  // The directory that must contain the host executable for the given asar path.
  if (process.platform === "darwin") return path.resolve(archive, "..", "..", "..");
  return path.resolve(archive, "..", "..");
}

function saveStatus(fields) {
  fields.updatedAt = Date.now() / 1000;
  fs.writeFileSync(path.join(RUNTIME, "install-status.json"), JSON.stringify(fields, null, 2));
}

function purgeRuntime(keepBackups) {
  // Retain backups if pending metadata requests them for manual rollback.
  if (!fs.existsSync(RUNTIME)) return "already absent";
  if (path.resolve(SRC) === path.resolve(RUNTIME))
    return "kept: this script runs inside it; delete the directory manually";
  if (keepBackups) {
    for (const child of fs.readdirSync(RUNTIME)) {
      if (child === "backups") continue;
      const childPath = path.join(RUNTIME, child);
      fs.rmSync(childPath, { recursive: true, force: true });
    }
    return "cleared; backups/ kept for manual rollback (unverified --force strip)";
  }
  fs.rmSync(RUNTIME, { recursive: true, force: true });
  return fs.existsSync(RUNTIME) ? `not fully deleted; remove ${RUNTIME} manually` : "purged";
}

function pendingPaths(archive) {
  // The metadata and staged file that make up an unfinished replacement.
  return [path.join(RUNTIME, "pending-install.json"), archive + ".zspeed.pending"];
}

const ORIGINAL_STAMP_RE = /"originalStamp"\s*:\s*\[([^\]]*)\]/;

function parseMeta(text) {
  // JSON.parse alone loses mtimeNs precision, so originalStamp is re-read from
  // the raw text digit-exactly.
  const meta = JSON.parse(text);
  const match = text.match(ORIGINAL_STAMP_RE);
  if (!match) throw new Error("Pending metadata lacks originalStamp");
  const parts = match[1].split(",").map(part => part.trim());
  if (parts.length !== 3 || !parts.every(part => /^-?\d+$/.test(part)))
    throw new Error("Pending metadata originalStamp is invalid");
  meta.originalStamp = parts.map(BigInt);
  return meta;
}

function serializeJsonWithStamp(meta) {
  // Write full-precision integer digits as JSON numbers without global dequoting.
  const stampValues = meta.originalStamp;
  if (!Array.isArray(stampValues) || stampValues.length !== 3 ||
      !stampValues.every(value => typeof value === "bigint"))
    throw new Error("originalStamp must be three integers");
  let text = JSON.stringify({ ...meta, originalStamp: ["@@0@@", "@@1@@", "@@2@@"] }, null, 2);
  for (let index = 0; index < 3; index++) {
    const token = `"@@${index}@@"`;
    if (text.split(token).length - 1 !== 1) throw new Error("originalStamp placeholder collision");
    text = text.replace(token, stampValues[index].toString());
  }
  if (!stampEquals(parseMeta(text).originalStamp, stampValues))
    throw new Error("originalStamp serialization mismatch");
  return text;
}

function ensureNoPending(archive) {
  const [metaPath, pending] = pendingPaths(archive);
  if (fs.existsSync(metaPath) || fs.existsSync(pending))
    throw new Error(
      "An unfinished pending replacement exists. Fully exit ZCode and wait for " +
      "the existing operation to finish; do not start another one. If it does " +
      `not finish, inspect ${metaPath} and install-status.json before changing ${pending}.`);
}

function waitForUnlock(archive) {
  // Finish this specific, verified repair when the running app releases ASAR.
  archive = path.resolve(archive);
  const [metaPath] = pendingPaths(archive);
  const meta = parseMeta(fs.readFileSync(metaPath, "utf8"));
  const pending = meta.pending;
  if (path.resolve(meta.asar) !== archive || path.resolve(meta.runtime) !== path.resolve(RUNTIME) ||
      path.dirname(pending) !== path.dirname(archive) ||
      path.basename(pending) !== path.basename(archive) + ".zspeed.pending")
    throw new Error("Pending repair does not belong to this installation");
  const final = FINAL_STATE[meta.intent || "install"];
  const pendingStamp = stamp(pending);
  if (fileSha(pending) !== meta.sha256) throw new Error("Pending repair integrity mismatch");
  const deadline = Date.now() + 24 * 3600 * 1000;
  while (Date.now() < deadline) {
    let currentStamp;
    try {
      currentStamp = stamp(pending);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      saveStatus({ state: "cancelled", reason: "Pending repair was deleted; old files were kept" });
      return 1;
    }
    if (!stampEquals(stamp(archive), meta.originalStamp) || !stampEquals(currentStamp, pendingStamp)) {
      saveStatus({ state: "cancelled", reason: "ZCode or the pending repair changed; old files were not applied" });
      return 1;
    }
    try {
      hooks.replaceFile(pending, archive);
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EBUSY") throw error;
      sleepSync(500);
      continue;
    }
    saveStatus({ state: final, version: meta.version, verifiedFiles: meta.verifiedFiles,
      backup: meta.backup, restartRequired: true });
    fs.rmSync(metaPath, { force: true });
    const purge = meta.purge;
    if (purge && meta.intent === "remove") purgeRuntime(purge.keepBackups);
    return 0;
  }
  saveStatus({ state: "waiting-expired", reason: "ZCode did not release the file within 24 hours" });
  return 1;
}

function winQuote(arg) {
  // The standard Windows argv quoting: double quotes around arguments with
  // whitespace or quotes; n backslashes before a quote become 2n+1, trailing
  // n backslashes become 2n before the closing quote.
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"', backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") { backslashes++; continue; }
    if (ch === '"') out += "\\".repeat(backslashes * 2 + 1) + '"';
    else out += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  return out + "\\".repeat(backslashes * 2) + '"';
}

function waiterArgv(archive, script = __filename) {
  return [script, "wait", "--asar", String(archive), "--runtime", RUNTIME];
}

function waiterCommandLine(archive, script = __filename, program = process.execPath) {
  return [program, ...waiterArgv(archive, script)].map(winQuote).join(" ");
}

function spawnDetachedWaiter(archive) {
  const child = spawn(process.execPath, waiterArgv(archive),
    { stdio: "ignore", windowsHide: true, detached: true });
  child.unref();
  return child.pid;
}

function startWaiterCim(archive) {
  // Create the waiter outside this process tree via WMI: the new process is a
  // child of WmiPrvSE, so a Windows job object reaping this tool cannot kill it.
  const commandLine = waiterCommandLine(archive);
  const script = "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments " +
    "@{CommandLine='" + commandLine.replace(/'/g, "''") +
    "'} | Select-Object -Property ReturnValue,ProcessId | ConvertTo-Json -Compress";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    { encoding: "utf8", windowsHide: true, timeout: 60000 });
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0)
    throw new Error(`powershell exit ${result.status}: ${String(result.stderr).trim()}`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Unreadable CIM result: ${String(result.stdout).trim()}`);
  }
  if (parsed.ReturnValue !== 0 || !Number.isInteger(parsed.ProcessId) || parsed.ProcessId <= 0)
    throw new Error(`Win32_Process.Create ReturnValue=${JSON.stringify(parsed.ReturnValue)}`);
  return parsed.ProcessId;
}

function startWaiter(archive) {
  if (process.platform === "win32") {
    try {
      return { pid: startWaiterCim(archive), mode: "cim" };
    } catch (error) {
      // Degraded mode: the waiter stays inside this job tree and may be reaped
      // with it. The pending metadata stays valid; report the manual command.
      return { pid: spawnDetachedWaiter(archive), mode: "detached-fallback", error: error.message };
    }
  }
  return { pid: spawnDetachedWaiter(archive), mode: "detached" };
}

function readVersion(fd, nodes, base) {
  try {
    const version = JSON.parse(readFileNode(fd, nodes, base, "package.json").toString("utf8"))?.version;
    return typeof version === "string" && version ? version : null;
  } catch (_) {
    return null;
  }
}

function rendererAssets(nodes) {
  // Renderer bundle assets, largest first.
  return Object.keys(nodes)
    .filter(name => name.startsWith("out/renderer/assets/") && name.endsWith(".js"))
    .sort((a, b) => Number(nodes[b].size) - Number(nodes[a].size));
}

function contextSnippets(data, radius = 100) {
  // Excerpts around each feature string to help locate where the shape moved.
  const snippets = {};
  for (const feature of FEATURES) {
    const index = data.indexOf(feature);
    if (index >= 0)
      snippets[feature] = Buffer.from(String(data).slice(Math.max(0, index - radius), index + radius), "latin1").toString("utf8");
  }
  return snippets;
}

function stripBridge(text) {
  return text.replace(BRIDGE_RE, "");
}

function bridgeFor(registry) {
  // Substitute the registry selected by structural detection.
  return fs.readFileSync(asset("speed-bridge.js")).toString("latin1")
    .replaceAll("__ZSPEED_REGISTRY__", () => registry);
}

function escapeIdent(name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`Not an identifier: ${JSON.stringify(name)}`);
  return name.replace(/\$/g, "\\$");
}

function findObjectClose(text, from, limit) {
  // Walk forward from a position inside an object literal to the `}` that
  // closes it; strings holding braces can skew the count, accepted for the
  // short windows involved. Returns the index of that `}`, or -1.
  let depth = 1; // `from` sits inside the object, next to its properties
  const end = Math.min(text.length, from + limit);
  for (let index = from; index < end; index++) {
    const ch = text[index];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findObjectOpen(text, from, limit) {
  // Walk backward to the `{` opening the object containing `from`; returns
  // { open, owner } where owner is the identifier the literal is assigned to,
  // or null when the object is not directly assigned.
  let depth = 0;
  const start = Math.max(0, from - limit);
  for (let index = from; index >= start; index--) {
    const ch = text[index];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        const owner = /([A-Za-z_$][\w$]*)=$/.exec(text.slice(Math.max(0, index - 200), index));
        return { open: index, owner: owner ? owner[1] : null };
      }
      depth--;
    }
  }
  return null;
}

// One `layer:new X(` site becomes a candidate only when it sits in an object
// that is flagged `stale:!1` and stored via `R.set` — the exact lifecycle the
// bridge depends on. The flag may sit anywhere in the object, and the store
// may pass an assigned entry (`...},R.set(key,owner)` / `...};R.set(...)`) or
// an inline literal (`R.set(key,{...})`). Call sites in hooks or components
// (no flag, no set) fail here instead of producing false candidates. Property
// order and minified identifier names are free to change between releases.
function validateAnchorSite(text, index, layerClass, failures) {
  const fail = reason => {
    if (failures && !failures.reason) failures.reason = reason;
    return null;
  };
  const close = findObjectClose(text, index, 600);
  if (close < 0) return fail("no object close after `layer:new`");
  const open = findObjectOpen(text, index, 600);
  if (!open) return fail("no object open before `layer:new`");
  if (!text.slice(open.open, close + 1).includes("stale:!1"))
    return fail("no `stale:!1` object holding `layer:new`");
  const rest = text.slice(close + 1, close + 120);
  let registry = null;
  const stored = /^([,;])([A-Za-z_$][\w$]*)\.set\(([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?),([A-Za-z_$][\w$]*)\)/.exec(rest);
  if (stored) {
    if (open.owner && stored[4] !== open.owner)
      return fail(`\`${stored[2]}.set(\` stores a different object than the \`${layerClass}\` entry`);
    registry = stored[2];
  } else if (rest[0] === ")") {
    // Inline literal: the `R.set(key,` call opens immediately before the object.
    const inline = /([A-Za-z_$][\w$]*)\.set\([^,]{1,60},$/.exec(text.slice(Math.max(0, open.open - 120), open.open));
    if (inline) registry = inline[1];
  }
  if (!registry) return fail("the entry object is not stored via `R.set(`");
  const esc = escapeIdent(registry);
  if (!new RegExp("(?:^|[^\\w$])" + esc + "=new Map\\b").test(text))
    return fail(`\`${registry}\` has no \`=new Map\` declaration`);
  if (!new RegExp("(?:^|[^\\w$])" + esc + "\\.delete\\([A-Za-z_$][\\w$]*\\),[A-Za-z_$][\\w$]*\\.stale=!0").test(text))
    return fail(`\`${registry}\` has no \`delete(...),x.stale=!0\` lifecycle`);
  const classDecl = new RegExp("(?:^|[^\\w$])(?:" + escapeIdent(layerClass) +
    "\\s*=\\s*class[\\s{(;]|class\\s+" + escapeIdent(layerClass) + "(?![\\w$]))").exec(text);
  if (!classDecl) return fail(`\`${layerClass}\` is not a class declaration`);
  const classBody = text.slice(classDecl.index, classDecl.index + 4000);
  for (const token of ["acquire(", "disposed", "entries", "store:"]) {
    if (!classBody.includes(token))
      return fail(`class \`${layerClass}\` lacks \`${token}\``);
  }
  return { registry, layerClass };
}

function detectStoreAsset(text) {
  // Stage machine over one renderer asset:
  //   injected  - our marker is present; the registry is read back from the
  //               bridge template line so the install can be rebuilt or upgraded.
  //   ready     - the store shape and one consistent set of anchors are found.
  //   features  - the store shape is missing; upstream may have refactored.
  //   anchors   - shape present but no site passed the structural checks.
  //   ambiguous - several verified candidate registries; --registry can decide.
  const missing = FEATURES.filter(feature => !text.includes(feature));
  if (missing.length)
    return { stage: "features", missing, snippets: contextSnippets(text) };
  const failures = { reason: "" };
  const seen = new Set(), candidates = [];
  for (const match of text.matchAll(/layer:new ([A-Za-z_$][\w$]*)\(/g)) {
    const site = validateAnchorSite(text, match.index, match[1], failures);
    if (site) {
      const key = site.registry + "\u0000" + site.layerClass;
      if (!seen.has(key)) { seen.add(key); candidates.push(site); }
    }
  }
  if (candidates.length === 1) return { stage: "ready", ...candidates[0] };
  if (candidates.length > 1) return { stage: "ambiguous", candidates };
  return { stage: "anchors", reason: failures.reason || "no `layer:new` site found" };
}

function verifyRegistryCandidate(text, registry) {
  // Structural checks for a manually supplied --registry: the same evidence
  // detection would have used, minus the site walk.
  try {
    const esc = escapeIdent(registry);
    return new RegExp("(?:^|[^\\w$])" + esc + "=new Map\\b").test(text) &&
      text.includes("stale:!1}," + registry + ".set(") &&
      new RegExp("(?:^|[^\\w$])" + esc + "\\.delete\\([A-Za-z_$][\\w$]*\\),[A-Za-z_$][\\w$]*\\.stale=!0").test(text);
  } catch (_) {
    return false;
  }
}

function scanRendererStore(fd, nodes, base) {
  // One pass over the renderer assets: marker and store shape are decided on
  // the same read. Largest assets come first, so the first ready hit wins.
  const scan = { injected: [], ready: [], ambiguous: [], anchorFailed: null, featuresMissing: null };
  for (const name of rendererAssets(nodes)) {
    const text = readFileNode(fd, nodes, base, name).toString("latin1");
    if (text.includes(BRIDGE_MARK)) { scan.injected.push(name); continue; }
    const detection = detectStoreAsset(text);
    if (detection.stage === "ready") scan.ready.push({ asset: name, text, ...detection });
    else if (detection.stage === "ambiguous") scan.ambiguous.push({ asset: name, text, ...detection });
    else if (detection.stage === "anchors" && !scan.anchorFailed)
      scan.anchorFailed = { asset: name, ...detection };
    else if (detection.stage === "features" && !scan.featuresMissing)
      scan.featuresMissing = { asset: name, ...detection };
  }
  // Ready assets must agree on the registry; otherwise they are ambiguous too.
  if (scan.ready.length > 1) {
    const registries = new Set(scan.ready.map(entry => entry.registry));
    if (registries.size > 1) {
      scan.ambiguous.unshift({
        asset: scan.ready[0].asset, text: scan.ready[0].text, stage: "ambiguous",
        candidates: scan.ready.map(entry => ({ registry: entry.registry, layerClass: entry.layerClass })),
      });
      scan.ready = [];
    } else scan.ready = [scan.ready[0]];
  }
  return scan;
}

function unsupportedStoreError(scan, manualRegistry) {
  // --registry can resolve ambiguous candidates only after structural checks.
  if (scan.featuresMissing) {
    const missing = scan.featuresMissing.missing.join(", ");
    return new Error("The renderer store shape was not found (missing: " + missing +
      "); upstream may have refactored and speed-bridge.js needs updating; " +
      "the ASAR was not changed");
  }
  if (scan.ambiguous.length) {
    const names = scan.ambiguous[0].candidates.map(candidate =>
      candidate.registry + " (class " + candidate.layerClass + ")").join(", ");
    return new Error("Ambiguous registry candidates: " + names +
      "; re-run with --registry <name> to pick one; the chosen name must still " +
      "pass the structural checks; the ASAR was not changed");
  }
  let message = "The store registry anchors were not recognized (" +
    (scan.anchorFailed ? scan.anchorFailed.reason : "no candidate site") +
    "); run verify for diagnostics; the ASAR was not changed";
  if (manualRegistry) message += "; --registry " + manualRegistry + " was given but its " +
    "structural checks did not pass either";
  return new Error(message);
}

function extractInjectedRegistry(text) {
  // Read the variable back from our own bridge template inside the injected block.
  const marker = text.indexOf(BRIDGE_MARK);
  if (marker < 0) return null;
  const match = REGISTRY_LINE_RE.exec(text.slice(marker, marker + 500));
  return match ? match[1] : null;
}

function loaderLine(runtime = RUNTIME) {
  const url = pathToFileURL(path.join(runtime, "inject-main.cjs")).href;
  return "\n;import(" + JSON.stringify(url) + ").then(() => null, " +
    '(e) => console.error("[zusage] load failed", e));';
}

function installPlan(fd, nodes, base, manualRegistry) {
  const scan = scanRendererStore(fd, nodes, base);
  if (scan.injected.length > 1)
    throw new Error("Multiple injected renderer assets found; refusing to guess; the ASAR was not changed");
  const oldMain = readFileNode(fd, nodes, base, MAIN);
  const oldMainText = oldMain.toString("latin1");
  const line = loaderLine();
  // Accept the loader with or without its trailing newline.
  const found = [...oldMainText.matchAll(LOADER_RE)].map(match => match[0]);
  const loaderPresent = found.length === 1 && (found[0] === line || found[0] === line + "\n");
  const wantedMain = loaderPresent ? oldMainText : oldMainText.replace(LOADER_RE, "") + line + "\n";
  let assetPath, oldAsset, wantedAsset, presentBridge;
  if (scan.injected.length === 1) {
    // Rebuild from the clean part with the bundled bridge so a bridge source
    // upgrade rewrites the injected copy in place.
    assetPath = scan.injected[0];
    oldAsset = readFileNode(fd, nodes, base, assetPath);
    const text = oldAsset.toString("latin1");
    let registry = extractInjectedRegistry(text);
    if (registry === null) {
      const detected = detectStoreAsset(stripBridge(text));
      if (detected.stage === "ready") registry = detected.registry;
    }
    if (registry === null)
      throw new Error("The injected bridge marker is present but its registry variable cannot " +
        "be identified; run verify for diagnostics; the ASAR was not changed");
    wantedAsset = stripBridge(text) + "\n" + bridgeFor(registry);
    presentBridge = oldAsset.equals(Buffer.from(wantedAsset, "latin1"));
  } else {
    let entry = scan.ready[0] || null;
    if (!entry && scan.ambiguous.length && manualRegistry &&
        verifyRegistryCandidate(scan.ambiguous[0].text, manualRegistry))
      entry = { asset: scan.ambiguous[0].asset, text: scan.ambiguous[0].text, registry: manualRegistry };
    if (!entry) throw unsupportedStoreError(scan, manualRegistry);
    assetPath = entry.asset;
    oldAsset = readFileNode(fd, nodes, base, assetPath);
    wantedAsset = entry.text + "\n" + bridgeFor(entry.registry);
    presentBridge = false;
  }
  return {
    assetPath,
    old: { [assetPath]: oldAsset, [MAIN]: oldMain },
    wanted: { [assetPath]: wantedAsset, [MAIN]: wantedMain },
    present: { bridge: presentBridge, loader: loaderPresent },
  };
}

function removePlan(fd, nodes, base) {
  // The bridge marker is the proof of our injection; no registry or force is
  // needed to strip it, whatever else changed in the asset since.
  let assetPath = null, oldAsset = null;
  for (const name of rendererAssets(nodes)) {
    const data = readFileNode(fd, nodes, base, name);
    if (data.toString("latin1").includes(BRIDGE_MARK)) { assetPath = name; oldAsset = data; break; }
  }
  const oldMain = readFileNode(fd, nodes, base, MAIN);
  const oldMainText = oldMain.toString("latin1");
  const wantedMain = oldMainText.replace(LOADER_RE, "");
  const old = { [MAIN]: oldMain }, wanted = { [MAIN]: wantedMain };
  if (assetPath !== null) {
    old[assetPath] = oldAsset;
    wanted[assetPath] = Buffer.from(stripBridge(oldAsset.toString("latin1")), "latin1");
  }
  return {
    assetPath, old, wanted, verified: true,
    present: { bridge: assetPath !== null && !old[assetPath].equals(wanted[assetPath]),
      loader: wantedMain !== oldMainText },
  };
}

function syntaxCheck(contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zspeed-check-"));
  try {
    let index = 0;
    for (const [name, content] of Object.entries(contents)) {
      const target = path.join(directory, `${index}.${name.endsWith(".cjs") ? "cjs" : "mjs"}`);
      fs.writeFileSync(target, content);
      const check = spawnSync(process.execPath, ["--check", target],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      if (check.status !== 0)
        throw new Error("Syntax check failed: " + String(check.stderr).trim());
      index++;
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function integrity(data) {
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += BLOCK) {
    blocks.push(sha(data.subarray(offset, offset + BLOCK)));
  }
  return { algorithm: "SHA256", hash: sha(data), blockSize: BLOCK, blocks };
}

function repack(source, destination, changes) {
  const src = fs.openSync(source, "r");
  try {
    const [original, base] = readHeader(src);
    const header = structuredClone(original);
    const oldNodes = Object.fromEntries(listFiles(original));
    const newNodes = Object.fromEntries(listFiles(header));
    let offset = 0;
    for (const [name, node] of Object.entries(newNodes)) {
      if (node.unpacked || "link" in node) continue;
      if (name in changes) {
        node.size = changes[name].length;
        node.integrity = integrity(changes[name]);
      }
      node.offset = String(offset);
      offset += node.size;
    }
    const encoded = Buffer.from(JSON.stringify(header), "utf8");
    const aligned = Math.floor((encoded.length + 4 + 3) / 4) * 4;
    const dst = fs.openSync(destination, "wx");
    try {
      const prefix = Buffer.alloc(16);
      prefix.writeUInt32LE(4, 0);
      prefix.writeUInt32LE(aligned + 4, 4);
      prefix.writeUInt32LE(aligned, 8);
      prefix.writeUInt32LE(encoded.length, 12);
      fs.writeSync(dst, prefix);
      fs.writeSync(dst, encoded);
      const padding = aligned - 4 - encoded.length;
      if (padding > 0) fs.writeSync(dst, Buffer.alloc(padding));
      for (const [name, node] of Object.entries(newNodes)) {
        if (node.unpacked || "link" in node) continue;
        if (name in changes) {
          fs.writeSync(dst, changes[name]);
        } else {
          let remaining = oldNodes[name].size;
          let position = base + Number(oldNodes[name].offset);
          const buffer = Buffer.alloc(BLOCK);
          while (remaining > 0) {
            const read = fs.readSync(src, buffer, 0, Math.min(BLOCK, remaining), position);
            if (read <= 0) throw new Error("Truncated ASAR payload");
            fs.writeSync(dst, buffer.subarray(0, read));
            position += read;
            remaining -= read;
          }
        }
      }
      fs.fsyncSync(dst);
    } finally {
      fs.closeSync(dst);
    }
  } finally {
    fs.closeSync(src);
  }
}

function verifyRepack(source, destination, changes) {
  // Compare every packed file, including the bytes we did not edit.
  const src = fs.openSync(source, "r");
  const dst = fs.openSync(destination, "r");
  try {
    const [oldHeader, oldBase] = readHeader(src);
    const [newHeader, newBase] = readHeader(dst);
    const oldNodes = Object.fromEntries(listFiles(oldHeader));
    const newNodes = Object.fromEntries(listFiles(newHeader));
    const oldNames = Object.keys(oldNodes), newNames = Object.keys(newNodes);
    if (oldNames.length !== newNames.length || !oldNames.every(name => name in newNodes))
      throw new Error("Repack changed the file list");
    let checked = 0;
    for (const [name, node] of Object.entries(oldNodes)) {
      if (node.unpacked || "link" in node) {
        if (JSON.stringify(node) !== JSON.stringify(newNodes[name]))
          throw new Error("Repack changed an unpacked file");
        continue;
      }
      const actual = readFileNode(dst, newNodes, newBase, name);
      const expected = name in changes ? changes[name] : readFileNode(src, oldNodes, oldBase, name);
      if (!actual.equals(expected))
        throw new Error("Repack verification failed: " + name);
      if (name in changes) {
        const recorded = newNodes[name].integrity, computed = integrity(actual);
        if (JSON.stringify(recorded) !== JSON.stringify(computed))
          throw new Error("Modified file integrity mismatch: " + name);
      }
      checked++;
    }
    return checked;
  } finally {
    fs.closeSync(src);
    fs.closeSync(dst);
  }
}

function apply(archive, intent, version, old, changes, report, purgeAfter, write) {
  // Shared install/remove pipeline: backup, repack, verify, replace or pend.
  const originalStamp = stamp(archive);
  const now = new Date();
  const pad2 = value => String(value).padStart(2, "0");
  const backup = path.join(RUNTIME, "backups",
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-` +
    `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}-` +
    `${String(now.getMilliseconds()).padStart(3, "0")}` +
    `-${intent === "install" ? "host" : "injected"}`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.mkdirSync(backup);
  for (const name of Object.keys(changes)) {
    const target = path.join(backup, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, old[name]);
  }
  fs.writeFileSync(path.join(backup, "manifest.json"), serializeJsonWithStamp({
    intent, asar: archive, version, originalStamp,
    files: Object.fromEntries(Object.keys(changes).map(name => [name, sha(old[name])])),
  }));
  const [metaPath, pending] = pendingPaths(archive);
  let keepPending = false;
  let checked;
  try {
    repack(archive, pending, changes);
    checked = verifyRepack(archive, pending, changes);
    if (!stampEquals(stamp(archive), originalStamp))
      throw new Error("ZCode updated during repair; current app was left untouched");
    try {
      hooks.replaceFile(pending, archive);
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EBUSY") throw error;
      const metadata = {
        intent, version, asar: archive, runtime: RUNTIME,
        originalStamp, pending, sha256: fileSha(pending),
        verifiedFiles: checked, backup, purge: purgeAfter,
      };
      fs.writeFileSync(metaPath, serializeJsonWithStamp(metadata));
      keepPending = true;
      saveStatus({ state: "pending", intent, version, verifiedFiles: checked, backup });
      const waiter = hooks.spawnWaiter(archive);
      // The manual command deliberately targets the runtime copy, which outlives this process.
      const manualContinue = waiterCommandLine(archive, path.join(RUNTIME, "repair-speed.cjs"), "node");
      Object.assign(report, { state: "pending-until-ZCode-exits", intent,
        verifiedFiles: checked, backup, monitorPid: waiter.pid, pending: true,
        waiter: waiter.mode || "default", manualContinue });
      if (waiter.mode === "detached-fallback") {
        report.waiterError = waiter.error;
        report.waiterWarning = "the waiter could not leave the current job tree; if this tool's " +
          "process group is reaped before ZCode exits, run manualContinue yourself";
      }
      if (purgeAfter !== null && purgeAfter !== undefined)
        report.runtimeDir = "deleted automatically once the pending removal completes";
      write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
  } finally {
    if (!keepPending) fs.rmSync(pending, { force: true });
  }
  const finalState = { state: FINAL_STATE[intent], version, verifiedFiles: checked, backup,
    restartRequired: true };
  saveStatus(finalState);
  report.bridge = report.loader = intent === "install";
  if (purgeAfter !== null && purgeAfter !== undefined)
    report.runtimeDir = purgeRuntime(purgeAfter.keepBackups);
  Object.assign(report, finalState);
  write(JSON.stringify(report, null, 2) + "\n");
  return 0;
}

function verifyCommand(archive, write) {
  // Report structural detection without deploying files or checking pending work.
  const report = { asar: archive, command: "verify" };
  const fd = fs.openSync(archive, "r");
  try {
    const [header, base] = readHeader(fd);
    const nodes = Object.fromEntries(listFiles(header));
    report.version = readVersion(fd, nodes, base);
    const scan = scanRendererStore(fd, nodes, base);
    if (scan.injected.length) {
      report.stage = "injected";
      report.injectedAssets = scan.injected;
      const registry = extractInjectedRegistry(
        readFileNode(fd, nodes, base, scan.injected[0]).toString("latin1"));
      if (registry !== null) report.registry = registry;
      report.ok = true;
    } else if (scan.ready.length) {
      report.stage = "ready";
      report.asset = scan.ready[0].asset;
      report.registry = scan.ready[0].registry;
      report.layerClass = scan.ready[0].layerClass;
      report.ok = true;
    } else {
      report.ok = false;
      if (scan.ambiguous.length) {
        report.stage = "ambiguous";
        report.asset = scan.ambiguous[0].asset;
        report.candidates = scan.ambiguous[0].candidates;
      } else if (scan.anchorFailed) {
        report.stage = "anchors";
        report.asset = scan.anchorFailed.asset;
        report.reason = scan.anchorFailed.reason;
      } else {
        report.stage = "features";
        report.asset = scan.featuresMissing ? scan.featuresMissing.asset : null;
        report.missing = scan.featuresMissing ? scan.featuresMissing.missing : FEATURES;
        if (scan.featuresMissing) report.snippets = scan.featuresMissing.snippets;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  write(JSON.stringify(report, null, 2) + "\n");
  return report.ok ? 0 : 1;
}

function parseArgs(argv) {
  const args = { command: "check", force: false };
  let commandSeen = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--force") {
      args.force = true; // accepted for compatibility; removal no longer needs it
    } else if (["--asar", "--registry", "--runtime"].includes(arg)) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      args[arg.slice(2)] = value;
    } else if (!commandSeen && COMMANDS.includes(arg)) {
      args.command = arg;
      commandSeen = true;
    } else {
      throw new Error(`Unknown argument: ${arg}\n` +
        "Usage: repair-speed.cjs [install|remove|check|wait|deploy|verify] " +
        "[--asar path] [--runtime dir] [--registry name] [--force]\n" +
        "--registry overrides detection only for ambiguous anchors; --force is accepted but no longer needed.");
    }
  }
  return args;
}

function main(argv = process.argv.slice(2), write = text => process.stdout.write(text)) {
  const args = parseArgs(argv);
  if (args.runtime) setRuntime(args.runtime);
  const archive = path.resolve(args.asar || findZcodeAsar());
  if (!looksLikeZCodeRoot(installationRoot(archive), process.platform))
    throw new Error("Target is not a ZCode installation");
  if (args.command === "wait") return waitForUnlock(archive);
  if (args.command === "verify") return verifyCommand(archive, write);
  // Plans only; the archive handle closes before any replacement is attempted,
  // so Windows never sees our own handle blocking the atomic rename.
  const fd = fs.openSync(archive, "r");
  let version = null;
  let deployed = [];
  let plan;
  try {
    const [header, base] = readHeader(fd);
    const nodes = Object.fromEntries(listFiles(header));
    version = readVersion(fd, nodes, base);
    if (args.command !== "check") {
      // deploy, install and remove all refuse to race a pending replacement.
      ensureNoPending(archive);
      if (args.command === "deploy") {
        write(JSON.stringify({ version, asar: archive, source: SRC, runtime: RUNTIME,
          deployed: deploy() }, null, 2) + "\n");
        return 0;
      }
      deployed = deploy();
    }
    if (args.command === "remove") plan = removePlan(fd, nodes, base);
    else plan = installPlan(fd, nodes, base, args.registry);
  } finally {
    fs.closeSync(fd);
  }
  const { old, wanted, present, verified = true } = plan;
  const wantedBytes = Object.fromEntries(Object.entries(wanted).map(([name, data]) =>
    [name, Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1")]));
  const changes = Object.fromEntries(Object.keys(wanted)
    .filter(name => !old[name].equals(wantedBytes[name]))
    .map(name => [name, wantedBytes[name]]));
  const report = { version, asar: archive, runtime: RUNTIME };
  if (deployed.length) report.deployed = deployed;
  report.bridge = present.bridge;
  report.loader = present.loader;
  if (Object.keys(changes).length) { // bytes that are never written skip the child-process check
    syntaxCheck({ ...wantedBytes, "inject-main.cjs": fs.readFileSync(asset("inject-main.cjs")) });
    report.syntax = "ok";
  }
  if (args.command === "check") {
    const [metaPath, pending] = pendingPaths(archive);
    report.pending = fs.existsSync(metaPath) || fs.existsSync(pending);
    write(JSON.stringify(report, null, 2) + "\n");
    return !Object.keys(changes).length && !report.pending ? 0 : 1;
  }
  report.pending = false;
  if (!Object.keys(changes).length) { // install: already injected; remove: already clean
    if (args.command === "remove") {
      saveStatus({ state: "removed", version });
      Object.assign(report, { state: "removed", alreadyClean: true, restartRequired: true });
      report.runtimeDir = purgeRuntime(!verified);
    } else {
      Object.assign(report, { state: "installed", alreadyInstalled: true, restartRequired: true });
    }
    write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }
  const purgeAfter = args.command === "remove" ? { keepBackups: !verified } : null;
  return apply(archive, args.command, version, old, changes, report, purgeAfter, write);
}

module.exports = {
  BLOCK, BRIDGE_MARK, BRIDGE_RE, ESSENTIAL_FILES, FEATURES, FINAL_STATE, LOADER_RE, MAIN,
  RUNTIME_FILES,
  hooks, setRuntime,
  sha, readHeader, listFiles, readFileNode, stamp, stampEquals, fileSha, asset, deploy,
  parseRegistryExport, registryInstallRoots, installRootsFor, asarInRoot, looksLikeZCodeRoot,
  findZcodeAsar, installationRoot, saveStatus, purgeRuntime, pendingPaths,
  parseMeta, serializeJsonWithStamp, ensureNoPending, waitForUnlock,
  winQuote, waiterArgv, waiterCommandLine, spawnDetachedWaiter, startWaiterCim, startWaiter,
  readVersion, rendererAssets, contextSnippets,
  loaderLine, stripBridge, bridgeFor, detectStoreAsset, verifyRegistryCandidate, scanRendererStore,
  installPlan, removePlan, syntaxCheck, integrity, repack,
  verifyRepack, apply, verifyCommand, parseArgs, main,
};

if (require.main === module) {
  process.exitCode = main();
}
