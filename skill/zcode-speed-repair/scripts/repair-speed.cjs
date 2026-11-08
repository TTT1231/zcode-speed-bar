"use strict";
/* Manage the speed bar injected into ZCode's app.asar. The default command is check.
 *
 * The files beside this script are the source of truth. Machine-local state and deployed runtime
 * files live in ~/.zcode/zcode-speed. install and deploy sync the runtime files; remove
 * also syncs them before stripping the recognized bridge and loader. Removal
 * normally cleans the runtime directory, keeping backups/ after an unverified
 * --force strip. Running this script from inside that directory preserves it.
 *
 * app.asar is located automatically per platform: the Windows uninstall registry
 * (via reg.exe) and common install roots; on macOS and Linux the standard app
 * layouts. Pass --asar to override. Known versions live in targets.json next to
 * this script; add-version records a version with the registry variable supplied
 * by the caller and the platform it was verified on. Entries without a platform
 * predate the field and mean win32. The minimum supported ZCode version is
 * 3.17.1; registration and runtime compatibility still need separate validation.
 *
 * Registered renderer fingerprints are checked; mainSha256 is recorded but not
 * checked. Repacking verifies file contents, not whole-archive equality with an
 * official package. Pending metadata keeps originalStamp as a JSON number array
 * (size, mtimeNs, ino) so an older Python waiter can still read it; mtimeNs
 * exceeds Number precision, so it is serialized and parsed digit-exactly.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const SRC = __dirname;                                             // bundled files (source of truth)
let RUNTIME = path.join(os.homedir(), ".zcode", "zcode-speed");    // deployed copies + machine-local state
const TARGETS_PATH = path.join(SRC, "targets.json");
const MAIN = "out/main/index.js";
const BRIDGE_RE = /\n?\/\* zspeed-bridge:v1 begin \*\/[\s\S]*?\/\* zspeed-bridge:v1 end \*\/\n?/g;
// Matches a zusage loader line from any runtime directory (the directory can
// move between installs), so a new install never leaves a stale line behind.
const LOADER_RE = /\n;import\("[^"]*inject-main\.cjs"\)\.then\(\(\) => null, \(e\) => console\.error\("\[zusage\] load failed", e\)\);\n?/g;
// Store-shape evidence a candidate bundle must still contain for the bridge to
// work (contract in speed-bridge.js). Generic keys are useless as a gate.
const FEATURES = ["productTurnId", "rowId", "logEpoch", "assistantText", "projectionReady"];
const MIN_ZCODE_VERSION = [3, 17, 1];
const BLOCK = 4194304;
const RUNTIME_FILES = ["inject-main.cjs", "speed-bridge.js", "targets.json", "repair-speed.cjs"];
const ESSENTIAL_FILES = ["inject-main.cjs", "speed-bridge.js"];
const FINAL_STATE = { install: "installed", remove: "removed" };
const MIN_ZCODE_VERSION_TEXT = MIN_ZCODE_VERSION.join(".");
const COMMANDS = ["install", "remove", "check", "wait", "add-version", "deploy"];

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

function loadTargets(targetsPath, required = true) {
  let data = null;
  let text = null;
  try {
    text = fs.readFileSync(targetsPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (text !== null) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      if (required) throw new Error(`Version registry ${targetsPath} is corrupt: ${error.message}`);
      data = null;
    }
  }
  if (data === null) {
    if (required) throw new Error(`Version registry ${targetsPath} is missing; run add-version first`);
    return {};
  }
  if (typeof data !== "object" || Array.isArray(data) ||
      Object.values(data).some(value => typeof value !== "object" || value === null || Array.isArray(value))) {
    if (required) throw new Error(`Version registry ${targetsPath} is corrupt`);
    return {};
  }
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
  // The bundled source is the only baseline; deploy() keeps the runtime copies equal to it.
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
  // Install roots advertised by ZCode's Windows uninstall entries (NSIS writes these).
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
    roots.push(path.join(os.homedir(), "AppData", "Local", "Programs", "ZCode"),
      "C:\\Program Files\\ZCode", "C:\\Program Files (x86)\\ZCode", "D:\\soft\\ZCode");
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
  // Delete the runtime directory once nothing injected is left that might need restoring.
  if (!fs.existsSync(RUNTIME)) return "already absent";
  if (path.resolve(SRC) === path.resolve(RUNTIME))
    return "kept: this script runs inside it; delete the directory manually";
  if (keepBackups) {
    // Unverified strip: keep the backups for manual rollback, drop everything else.
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
  // the raw text digit-exactly. Both old Python and new Node metadata parse.
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
  // originalStamp must stay a JSON number array (an older Python waiter reads
  // it), but its digits exceed Number precision. Positional placeholders, one
  // strictly validated single-occurrence replacement each, no global dequoting.
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

const VERSION_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readVersion(fd, nodes, base) {
  try {
    return JSON.parse(readFileNode(fd, nodes, base, "package.json").toString("utf8")).version;
  } catch (error) {
    throw unsupportedVersion("unrecognized-version", "Cannot read the ZCode version from package.json");
  }
}

function unsupportedVersion(reason, message) {
  const error = new Error(message);
  error.reason = reason;
  return error;
}

function requireSupportedVersion(version) {
  // Reject releases below the minimum, including its prerelease versions.
  const minimum = MIN_ZCODE_VERSION_TEXT;
  const match = VERSION_RE.exec(typeof version === "string" ? version.replace(/^v/, "") : "");
  if (!match)
    throw unsupportedVersion("unrecognized-version",
      `Cannot determine whether ZCode version ${JSON.stringify(version)} meets the minimum ${minimum}`);
  const release = [Number(match[1]), Number(match[2]), Number(match[3])];
  const order = (a, b) => {
    for (let index = 0; index < 3; index++) {
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    return 0;
  };
  const comparison = order(release, MIN_ZCODE_VERSION);
  if (comparison < 0 || (comparison === 0 && match[4] !== undefined))
    throw unsupportedVersion("version-too-low",
      `ZCode ${version} is below the minimum supported version ${minimum}; the ASAR was not changed`);
}

function rendererAssets(nodes) {
  // Renderer bundle assets, largest first.
  return Object.keys(nodes)
    .filter(name => name.startsWith("out/renderer/assets/") && name.endsWith(".js"))
    .sort((a, b) => Number(nodes[b].size) - Number(nodes[a].size));
}

function scanBridgeAsset(fd, nodes, base) {
  // Find the asset carrying the bridge marker when the registry cannot point at it.
  for (const name of rendererAssets(nodes)) {
    if (readFileNode(fd, nodes, base, name).includes("zspeed-bridge:v1 begin")) return name;
  }
  return null;
}

function readRegisteredAsset(fd, nodes, base, assetPath) {
  if (!(assetPath in nodes))
    throw new Error(`Registered asset ${assetPath} is missing from the archive; the ASAR was not changed`);
  return readFileNode(fd, nodes, base, assetPath);
}

function toFileUri(archivePath) {
  // Byte-compatible replacement for Python's Path.as_uri(): quote everything
  // except A-Za-z0-9_.-~/ (and the drive colon), uppercase hex, UTF-8 bytes.
  // Node's pathToFileURL keeps ()'!$&+,;=: raw, which older installs never wrote.
  let p = String(archivePath).replace(/\\/g, "/");
  let prefix;
  if (p.startsWith("//")) { p = p.slice(2); prefix = "file://"; }
  else if (/^[A-Za-z]:/.test(p)) prefix = "file:///";
  else if (p.startsWith("/")) prefix = "file://";
  else throw new Error("relative path can't be expressed as a file URI");
  let out = "";
  let index = 0;
  for (const ch of p) {
    const keep = /[A-Za-z0-9_.\-~/]/.test(ch) || (index === 1 && ch === ":" && /^[A-Za-z]:/.test(p));
    if (keep) out += ch;
    else for (const byte of Buffer.from(ch, "utf8")) out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    index++;
  }
  return prefix + out;
}

function loaderLine(runtime = RUNTIME) {
  const url = toFileUri(path.join(runtime, "inject-main.cjs"));
  return "\n;import(" + JSON.stringify(url) + ").then(() => null, " +
    '(e) => console.error("[zusage] load failed", e));';
}

function installPlan(fd, nodes, base, targets, version, platform = process.platform) {
  if (!(version in targets))
    throw new Error(`ZCode ${version} has no verified speed bridge; compatibility must be ` +
      "checked before registering this version; the ASAR was not changed");
  const entry = targets[version];
  const entryPlatform = entry.platform || "win32"; // entries without a platform predate the field
  if (entryPlatform !== platform)
    throw new Error(`ZCode ${version}'s speed bridge was verified on ${entryPlatform}; ` +
      `${platform} builds must be adapted and registered separately; the ASAR was not changed`);
  const assetPath = entry.asset, expected = entry.assetSha256, registry = entry.registry;
  const oldAsset = readRegisteredAsset(fd, nodes, base, assetPath);
  const [clean, actual] = cleanAsset(oldAsset);
  if (actual !== expected)
    throw new Error(`Renderer fingerprint mismatch; the ASAR was not changed ` +
      `(registered ${expected.slice(0, 12)}, found ${actual.slice(0, 12)})`);
  const oldMain = readFileNode(fd, nodes, base, MAIN);
  const bridge = fs.readFileSync(asset("speed-bridge.js")).toString("latin1")
    .replaceAll("__ZSPEED_REGISTRY__", () => registry);
  const line = loaderLine();
  const oldMainText = oldMain.toString("latin1");
  // Already injected counts regardless of the trailing newline older tools left out.
  const found = [...oldMainText.matchAll(LOADER_RE)].map(match => match[0]);
  const loaderPresent = found.length === 1 && (found[0] === line || found[0] === line + "\n");
  const wantedAsset = clean + "\n" + bridge;
  return {
    assetPath,
    old: { [assetPath]: oldAsset, [MAIN]: oldMain },
    wanted: { [assetPath]: wantedAsset,
      // Loader lines from any runtime directory are dropped first.
      [MAIN]: loaderPresent ? oldMainText : oldMainText.replace(LOADER_RE, "") + line + "\n" },
    present: { bridge: oldAsset.equals(Buffer.from(wantedAsset, "latin1")), loader: loaderPresent },
  };
}

function removePlan(fd, nodes, base, targets, version, force) {
  const entry = targets[version];
  let assetPath = null, oldAsset = null, newAsset = null;
  if (entry) {
    assetPath = entry.asset;
    oldAsset = readRegisteredAsset(fd, nodes, base, assetPath);
    const [clean, actual] = cleanAsset(oldAsset);
    if (actual !== entry.assetSha256)
      throw new Error("Renderer does not match the registered clean fingerprint; the ASAR was not changed");
    newAsset = clean;
  } else {
    assetPath = scanBridgeAsset(fd, nodes, base);
    if (assetPath !== null && !force)
      throw new Error(`ZCode ${version} is not registered; re-run remove with --force to skip ` +
        "hash verification; the ASAR was not changed");
    if (assetPath !== null) {
      oldAsset = readFileNode(fd, nodes, base, assetPath);
      newAsset = stripBridge(oldAsset.toString("latin1"));
    }
  }
  const oldMain = readFileNode(fd, nodes, base, MAIN);
  const oldMainText = oldMain.toString("latin1");
  const old = { [MAIN]: oldMain };
  const wantedMain = oldMainText.replace(LOADER_RE, "");
  const wanted = { [MAIN]: wantedMain };
  if (assetPath !== null) {
    old[assetPath] = oldAsset;
    wanted[assetPath] = newAsset;
  }
  // Verified only when a registered fingerprint confirmed the clean result; an
  // unverified --force strip keeps the backups around for manual rollback.
  return {
    assetPath, old, wanted,
    verified: entry != null || assetPath === null,
    present: { bridge: assetPath !== null && oldAsset.toString("latin1") !== newAsset,
      loader: wantedMain !== oldMainText },
  };
}

function stripBridge(text) {
  return text.replace(BRIDGE_RE, "");
}

function cleanAsset(buffer) {
  // Registered fingerprints are computed over the bridge-stripped asset text.
  const text = stripBridge(buffer.toString("latin1"));
  return [text, sha(Buffer.from(text, "latin1"))];
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
    `-${intent === "install" ? "host" : "injected"}-${version}`);
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

function contextSnippets(data, radius = 100) {
  // Excerpts around each feature string to help locate the registry variable.
  const snippets = {};
  for (const feature of FEATURES) {
    const index = data.indexOf(feature);
    if (index >= 0)
      snippets[feature] = Buffer.from(data.slice(Math.max(0, index - radius), index + radius), "latin1").toString("utf8");
  }
  return snippets;
}

function addVersion(archive, args, write) {
  if (!args.registry || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(args.registry))
    throw new Error("--registry must name the bundle variable holding the store registry");
  const fd = fs.openSync(archive, "r");
  try {
    const [header, base] = readHeader(fd);
    const nodes = Object.fromEntries(listFiles(header));
    const version = readVersion(fd, nodes, base);
    requireSupportedVersion(version);
    let assetPath = args.asset;
    if (assetPath === undefined || assetPath === null) assetPath = rendererAssets(nodes)[0];
    if (!(assetPath in nodes)) throw new Error(`${assetPath} is not in the archive`);
    const [clean, assetSha256] = cleanAsset(readFileNode(fd, nodes, base, assetPath));
    const missing = FEATURES.filter(feature => !clean.includes(feature));
    if (missing.length)
      throw new Error(`${assetPath} lacks the store shape the bridge reads ` +
        `(${missing.join(", ")}); speed-bridge.js needs updating before ${version} can be registered`);
    const mainClean = readFileNode(fd, nodes, base, MAIN).toString("latin1").replace(LOADER_RE, "");
    const targets = loadTargets(args.targets || TARGETS_PATH, false);
    if (version in targets && !args.force)
      throw new Error(`${version} is already registered; re-run with --force to overwrite`);
    targets[version] = {
      asset: assetPath,
      assetSha256,
      main: MAIN,
      mainSha256: sha(Buffer.from(mainClean, "latin1")),
      registry: args.registry,
      platform: process.platform,
    };
    const sorted = Object.fromEntries(Object.keys(targets).sort().map(name => [name, targets[name]]));
    fs.writeFileSync(args.targets || TARGETS_PATH, JSON.stringify(sorted, null, 2) + "\n");
    write(JSON.stringify({
      registered: version, targets: String(args.targets || TARGETS_PATH), asset: assetPath,
      assetSha256,
      mainSha256: targets[version].mainSha256, registry: args.registry,
      platform: process.platform, featureContext: contextSnippets(clean),
    }, null, 2) + "\n");
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

function parseArgs(argv) {
  const args = { command: "check", force: false };
  let commandSeen = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--force") {
      args.force = true;
    } else if (["--asar", "--targets", "--registry", "--asset", "--runtime"].includes(arg)) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      args[arg.slice(2)] = value;
    } else if (!commandSeen && COMMANDS.includes(arg)) {
      args.command = arg;
      commandSeen = true;
    } else {
      throw new Error(`Unknown argument: ${arg}\n` +
        "Usage: repair-speed.cjs [install|remove|check|wait|add-version|deploy] " +
        "[--asar path] [--targets path] [--registry name] [--asset path] [--runtime dir] [--force]");
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
  if (args.command === "add-version") return addVersion(archive, args, write);
  // Plans only; the archive handle closes before any replacement is attempted,
  // so Windows never sees our own handle blocking the atomic rename.
  const fd = fs.openSync(archive, "r");
  let version = null;
  let deployed = [];
  let plan;
  try {
    const [header, base] = readHeader(fd);
    const nodes = Object.fromEntries(listFiles(header));
    try {
      version = readVersion(fd, nodes, base);
      if (args.command !== "remove") requireSupportedVersion(version);
    } catch (error) {
      if (error.reason === undefined || !["install", "deploy"].includes(args.command)) throw error;
      write(JSON.stringify({ state: "skipped", reason: error.reason, version: version ?? null,
        minimumVersion: MIN_ZCODE_VERSION_TEXT, asar: archive, message: error.message }, null, 2) + "\n");
      return 1;
    }
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
    const targets = loadTargets(args.targets || TARGETS_PATH, args.command !== "remove");
    if (args.command === "remove") plan = removePlan(fd, nodes, base, targets, version, args.force);
    else plan = installPlan(fd, nodes, base, targets, version);
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
  BLOCK, BRIDGE_RE, ESSENTIAL_FILES, FEATURES, FINAL_STATE, LOADER_RE, MAIN, MIN_ZCODE_VERSION,
  MIN_ZCODE_VERSION_TEXT, RUNTIME_FILES, TARGETS_PATH,
  hooks, setRuntime,
  sha, readHeader, listFiles, readFileNode, loadTargets, stamp, stampEquals, fileSha, asset, deploy,
  parseRegistryExport, registryInstallRoots, installRootsFor, asarInRoot, looksLikeZCodeRoot,
  findZcodeAsar, installationRoot, saveStatus, purgeRuntime, pendingPaths,
  parseMeta, serializeJsonWithStamp, ensureNoPending, waitForUnlock,
  winQuote, waiterArgv, waiterCommandLine, spawnDetachedWaiter, startWaiterCim, startWaiter,
  readVersion, requireSupportedVersion, rendererAssets, scanBridgeAsset, readRegisteredAsset,
  toFileUri, loaderLine, installPlan, removePlan, stripBridge, cleanAsset, syntaxCheck, integrity, repack,
  verifyRepack, apply, contextSnippets, addVersion, parseArgs, main,
};

if (require.main === module) {
  process.exitCode = main();
}
