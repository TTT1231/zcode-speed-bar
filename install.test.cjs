"use strict";
/* Exercise the distributable skill against isolated synthetic ZCode installations. */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { test } = require("node:test");

const SKILL = path.join(__dirname, "skill", "zcode-speed-repair");
const ROOT_ENTRY = path.join(__dirname, "repair-speed.cjs");
const ASSET = "out/renderer/assets/bundle.js";
const MAIN = "out/main/index.js";
const VERSION = "3.17.1";
// A synthetic renderer store module: real shape, valid JS (the wanted bytes
// must survive `node --check`). One valid registry site for J1, plus the two
// decoy shapes seen in real bundles: a hook call site with `layer:new` but no
// stale flag or set, and a second registry whose secondary anchor is
// same-shaped but never holds a `layer:new` entry.
const STORE_ASSET = [
  "var J1=new Map;",
  "var Q1=class{constructor(t){this.transport=t;this.entries=new Map;this.disposed=!1}",
  "acquire(e){if(this.disposed)throw Error(`released`);let r={store:e,refCount:1};this.entries.set(e,r);return r}",
  "release(e){this.entries.delete(e)}};",
  "function conn(t,k){k=`w`;let s;(s={layer:new Q1(t),refCount:1,keepWarmTimer:null,stale:!1},J1.set(k,s));" +
    "J1.delete(k),s.stale=!0;return s}",
  "function hook(n){return{layer:new Q1({transport:n}),sendCommand:e=>e}};",
  "var uO=new Map;function scope(e){let t;(t={key:e,refCount:1,stale:!1},uO.set(e,t));" +
    "uO.delete(e),t.stale=!0;return t}",
  "var productTurnId=0,rowId=0,logEpoch=0,assistantText=0,projectionReady=0;",
].join("\n");
// A second fully valid registry site on the same class: detection must refuse.
const RIVAL_STORE_ASSET = STORE_ASSET + "\n" +
  "function conn2(t,k){k=`w`;let s;(s={layer:new Q1(t),refCount:1,keepWarmTimer:null,stale:!1},K2.set(k,s));" +
  "K2.delete(k),s.stale=!0;return s}\nvar K2=new Map;";
const ORIGINAL = {
  "package.json": Buffer.from(JSON.stringify({ version: VERSION })),
  [MAIN]: Buffer.from("console.log('synthetic main');"),
  [ASSET]: Buffer.from(STORE_ASSET),
  "unrelated/data.bin": Buffer.from([0x00, 0x01, ...Buffer.from("unchanged"), 0xff]),
};

// Expected Path.as_uri() output recorded from real Python (3.14) on this repo's
// target platforms. Node's pathToFileURL keeps ()'!$&+,;=: raw, so the loader
// line must be encoded through toFileUri instead to stay byte-identical.
const AS_URI_FIXTURES = [
  ["D:\\soft\\ZCode", "file:///D:/soft/ZCode"],
  ["D:\\soft\\ZCode Test", "file:///D:/soft/ZCode%20Test"],
  ["D:\\soft\\ZCode 目录", "file:///D:/soft/ZCode%20%E7%9B%AE%E5%BD%95"],
  ["D:\\a'b(c)!$&dir\\ZCode", "file:///D:/a%27b%28c%29%21%24%26dir/ZCode"],
  ["D:\\a#b%c\\ZCode", "file:///D:/a%23b%25c/ZCode"],
  ["\\\\server\\share\\ZCode", "file://server/share/ZCode"],
  ["D:\\plus+eq=semi;comma,at@dir\\ZCode", "file:///D:/plus%2Beq%3Dsemi%3Bcomma%2Cat%40dir/ZCode"],
  ["D:\\mid:path\\ZCode", "file:///D:/mid%3Apath/ZCode"],
  ["D:\\tilde~dot.dash-_dir\\ZCode", "file:///D:/tilde~dot.dash-_dir/ZCode"],
  ["D:\\caret^backtick`dir\\ZCode", "file:///D:/caret%5Ebacktick%60dir/ZCode"],
  ["C:\\Users\\someone\\.zcode\\zcode-speed", "file:///C:/Users/someone/.zcode/zcode-speed"],
];

function sha(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function makeAsar(target, contents) {
  const header = { files: {} };
  const chunks = [];
  let payloadLength = 0;
  for (const [name, data] of Object.entries(contents)) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
    const parts = name.split("/");
    let node = header;
    for (const part of parts.slice(0, -1)) node = node.files[part] ||= { files: {} };
    node.files[parts[parts.length - 1]] = { size: buffer.length, offset: String(payloadLength) };
    chunks.push(buffer);
    payloadLength += buffer.length;
  }
  const encoded = Buffer.from(JSON.stringify(header), "utf8");
  const aligned = Math.floor((encoded.length + 7) / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(aligned + 4, 4);
  prefix.writeUInt32LE(aligned, 8);
  prefix.writeUInt32LE(encoded.length, 12);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.concat([
    prefix, encoded, Buffer.alloc(aligned - 4 - encoded.length), ...chunks,
  ]));
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

function unpackAsar(target) {
  const fd = fs.openSync(target, "r");
  try {
    const head = readAt(fd, 0, 16);
    const header = JSON.parse(readAt(fd, 16, head.readUInt32LE(12)).toString("utf8"));
    const base = 8 + head.readUInt32LE(4);
    const contents = {};
    (function visit(node, prefix = "") {
      for (const [name, item] of Object.entries(node.files || {})) {
        const joined = prefix + name;
        if ("files" in item) visit(item, joined + "/");
        else contents[joined] = readAt(fd, base + Number(item.offset), item.size);
      }
    })(header);
    return contents;
  } finally {
    fs.closeSync(fd);
  }
}

function assertArchiveEquals(archive, expected) {
  const actual = unpackAsar(archive);
  assert.deepStrictEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const [name, buffer] of Object.entries(expected)) {
    assert.ok(actual[name].equals(buffer), `file content mismatch: ${name}`);
  }
}

// A fresh module instance per call, the way the Python suite re-imported it.
function loadScript(skillDir) {
  const script = path.join(skillDir, "scripts", "repair-speed.cjs");
  const source = fs.readFileSync(script, "utf8");
  const module_ = { exports: {} };
  new Function("exports", "require", "module", "__filename", "__dirname", source)(
    module_.exports, require, module_, script, path.dirname(script));
  return module_.exports;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zspeed-tests-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skill = path.join(root, "standalone skill");
  fs.cpSync(SKILL, skill, { recursive: true });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const runtime = path.join(home, ".zcode", "zcode-speed");
  const installation = path.join(root, "synthetic ZCode");
  fs.mkdirSync(installation, { recursive: true });
  fs.writeFileSync(path.join(installation, "ZCode.exe"), "");
  const archive = path.join(installation, "resources", "app.asar");
  makeAsar(archive, ORIGINAL);
  return { root, skill, home, runtime, installation, archive };
}

function cli(f, command, extraArgs = [], expected = 0,
    script = path.join(f.skill, "scripts", "repair-speed.cjs")) {
  const result = spawnSync(process.execPath, [script, command, "--asar", f.archive, ...extraArgs], {
    cwd: f.root,
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home },
    encoding: "utf8",
  });
  assert.strictEqual(result.status, expected,
    `exit ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result;
}

// Run a command whose archive replacement hits the simulated file lock; returns
// the loaded module and its report. Restore hooks.replaceFile before waiting.
function startPending(f, command) {
  if (command === "remove") cli(f, "install");
  const mod = loadScript(f.skill);
  mod.setRuntime(f.runtime);
  let output = "";
  mod.hooks.replaceFile = () => {
    throw Object.assign(new Error("simulated lock"), { code: "EPERM" });
  };
  mod.hooks.spawnWaiter = () => ({ pid: 1234, mode: "test" });
  const code = mod.main([command, "--asar", f.archive], text => { output += text; });
  assert.strictEqual(code, 0, output);
  return [mod, JSON.parse(output), () => {
    mod.hooks.replaceFile = (from, to) => fs.renameSync(from, to);
  }];
}

test("copied skill installs, checks and removes without the repository", t => {
  const f = fixture(t);
  cli(f, "check", [], 1);
  const installed = JSON.parse(cli(f, "install").stdout);
  assert.deepStrictEqual([installed.state, installed.pending], ["installed", false]);
  assert.ok(installed.bridge && installed.loader);
  const patched = unpackAsar(f.archive);
  assert.ok(patched["unrelated/data.bin"].equals(ORIGINAL["unrelated/data.bin"]));
  assert.ok(patched[ASSET].includes("zspeed-bridge:v1 begin"));
  assert.ok(patched[ASSET].includes("const registry = J1;"), "the detected registry must be bound");
  assert.ok(patched[MAIN].includes("inject-main.cjs"));
  const backups = fs.readdirSync(path.join(f.runtime, "backups")).filter(name => name.includes("-host-"));
  assert.strictEqual(backups.length, 1);
  assert.ok(fs.readFileSync(path.join(f.runtime, "backups", backups[0], ASSET)).equals(ORIGINAL[ASSET]));
  const afterInstall = fs.readFileSync(f.archive);
  const again = JSON.parse(cli(f, "install").stdout);
  assert.ok(again.alreadyInstalled);
  assert.ok(fs.readFileSync(f.archive).equals(afterInstall));
  const checked = JSON.parse(cli(f, "check").stdout);
  assert.ok(checked.bridge && checked.loader && !checked.pending);
  const removed = JSON.parse(cli(f, "remove").stdout);
  assert.deepStrictEqual([removed.state, removed.pending], ["removed", false]);
  assert.ok(!removed.bridge && !removed.loader);
  assertArchiveEquals(f.archive, ORIGINAL);
  assert.strictEqual(fs.existsSync(f.runtime), false);
  cli(f, "check", [], 1);
  assert.ok(JSON.parse(cli(f, "remove").stdout).alreadyClean);
  assert.strictEqual(fs.existsSync(f.runtime), false);
});

test("a renderer without the store shape never changes the archive", t => {
  const f = fixture(t);
  makeAsar(f.archive, { ...ORIGINAL, [ASSET]: Buffer.from("var x = 1;") });
  const before = fs.readFileSync(f.archive);
  const result = cli(f, "install", [], 1);
  assert.ok(result.stderr.includes("store shape was not found"), result.stderr);
  assert.ok(result.stderr.includes("productTurnId"), result.stderr);
  assert.ok(fs.readFileSync(f.archive).equals(before));
});

test("minimum version uses numeric and prerelease ordering", t => {
  const f = fixture(t);
  const mod = loadScript(f.skill);
  for (const version of ["3.17.1", "v3.17.1", "3.17.1+build.1", "3.17.2-rc.1", "3.18.0", "4.0.0"]) {
    mod.requireSupportedVersion(version);
  }
  for (const version of ["2.99.99", "3.16.99", "3.17.0", "3.17.1-rc.1", "unknown", null]) {
    assert.throws(() => mod.requireSupportedVersion(version), Error, `version ${version}`);
  }
});

test("old version cannot be installed or checked", t => {
  const f = fixture(t);
  const oldVersion = "3.17.0";
  makeAsar(f.archive, { ...ORIGINAL,
    "package.json": Buffer.from(JSON.stringify({ version: oldVersion })) });
  const beforeArchive = fs.readFileSync(f.archive);
  for (const [command, args] of [["install", ["--force"]], ["deploy", []], ["check", []]]) {
    const result = cli(f, command, args, 1);
    if (command === "install" || command === "deploy") {
      const report = JSON.parse(result.stdout);
      assert.deepStrictEqual([report.state, report.reason], ["skipped", "version-too-low"]);
      assert.deepStrictEqual([report.version, report.minimumVersion], [oldVersion, "3.17.1"]);
    } else {
      assert.ok(result.stderr.includes("below the minimum supported version 3.17.1"), result.stderr);
    }
    assert.ok(fs.readFileSync(f.archive).equals(beforeArchive), command);
    assert.strictEqual(fs.existsSync(f.runtime), false, command);
  }
});

test("preflight preserves the existing runtime for prerelease and unknown versions", t => {
  const f = fixture(t);
  fs.mkdirSync(f.runtime, { recursive: true });
  const runtimeFile = path.join(f.runtime, "inject-main.cjs");
  fs.writeFileSync(runtimeFile, "existing runtime file");
  for (const [version, reason] of [["3.17.1-rc.1", "version-too-low"], ["unknown", "unrecognized-version"]]) {
    makeAsar(f.archive, { ...ORIGINAL,
      "package.json": Buffer.from(JSON.stringify({ version })) });
    const before = fs.readFileSync(f.archive);
    for (const command of ["install", "deploy"]) {
      const report = JSON.parse(cli(f, command, [], 1).stdout);
      assert.deepStrictEqual([report.state, report.reason], ["skipped", reason]);
      assert.ok(fs.readFileSync(f.archive).equals(before), `${command} ${version}`);
      assert.strictEqual(fs.readFileSync(runtimeFile, "utf8"), "existing runtime file");
      assert.deepStrictEqual(fs.readdirSync(f.runtime), ["inject-main.cjs"]);
    }
  }
});

test("missing or unreadable version skips without writing", t => {
  const f = fixture(t);
  for (const packageJson of [null, "{}", "not json", "null"]) {
    const contents = { ...ORIGINAL };
    if (packageJson === null) delete contents["package.json"];
    else contents["package.json"] = Buffer.from(packageJson);
    makeAsar(f.archive, contents);
    const before = fs.readFileSync(f.archive);
    for (const command of ["install", "deploy"]) {
      const report = JSON.parse(cli(f, command, [], 1).stdout);
      assert.deepStrictEqual([report.state, report.reason], ["skipped", "unrecognized-version"]);
      assert.strictEqual(report.version, null);
      assert.ok(fs.readFileSync(f.archive).equals(before), `${command} ${packageJson}`);
      assert.strictEqual(fs.existsSync(f.runtime), false);
    }
  }
});

test("deploy checks the version before copying runtime files", t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.archive);
  const report = JSON.parse(cli(f, "deploy").stdout);
  assert.strictEqual(report.version, VERSION);
  assert.ok(report.deployed.includes("inject-main.cjs"));
  assert.ok(fs.readFileSync(f.archive).equals(before));
  assert.ok(fs.readFileSync(path.join(f.runtime, "inject-main.cjs"))
    .equals(fs.readFileSync(path.join(f.skill, "scripts", "inject-main.cjs"))));
});

test("newer versions install from the same store shape without registration", t => {
  const f = fixture(t);
  makeAsar(f.archive, { ...ORIGINAL,
    "package.json": Buffer.from(JSON.stringify({ version: "3.18.0" })) });
  const installed = JSON.parse(cli(f, "install").stdout);
  assert.deepStrictEqual([installed.state, installed.pending], ["installed", false]);
  assert.ok(unpackAsar(f.archive)[ASSET].includes("const registry = J1;"));
});

test("verify reports the adaptation read-only", t => {
  const f = fixture(t);
  const ready = JSON.parse(cli(f, "verify").stdout);
  assert.strictEqual(ready.stage, "ready");
  assert.strictEqual(ready.registry, "J1");
  assert.strictEqual(ready.layerClass, "Q1");
  assert.strictEqual(ready.ok, true);
  makeAsar(f.archive, { ...ORIGINAL, [ASSET]: Buffer.from("var x = 1;") });
  const noShape = JSON.parse(cli(f, "verify", [], 1).stdout);
  assert.strictEqual(noShape.stage, "features");
  assert.deepStrictEqual(noShape.missing.sort(), [..."productTurnId,rowId,logEpoch,assistantText,projectionReady".split(",")].sort());
  assert.strictEqual(noShape.ok, false);
  assert.strictEqual(fs.existsSync(f.runtime), false, "verify must not deploy");
  makeAsar(f.archive, ORIGINAL);
  cli(f, "install");
  const injected = JSON.parse(cli(f, "verify").stdout);
  assert.strictEqual(injected.stage, "injected");
  assert.strictEqual(injected.registry, "J1");
  assert.strictEqual(injected.ok, true);
});

test("ambiguous anchors refuse, --registry rescues only with valid structure", t => {
  const f = fixture(t);
  makeAsar(f.archive, { ...ORIGINAL, [ASSET]: Buffer.from(RIVAL_STORE_ASSET) });
  const before = fs.readFileSync(f.archive);
  const refused = cli(f, "install", [], 1);
  assert.ok(refused.stderr.includes("Ambiguous registry candidates"), refused.stderr);
  assert.ok(refused.stderr.includes("J1") && refused.stderr.includes("K2"), refused.stderr);
  assert.ok(fs.readFileSync(f.archive).equals(before));
  const badName = cli(f, "install", ["--registry", "NOPE"], 1);
  assert.ok(badName.stderr.includes("Ambiguous registry candidates"), badName.stderr);
  assert.ok(fs.readFileSync(f.archive).equals(before));
  const installed = JSON.parse(cli(f, "install", ["--registry", "J1"]).stdout);
  assert.strictEqual(installed.state, "installed");
  assert.ok(unpackAsar(f.archive)[ASSET].includes("const registry = J1;"));
});

test("detection accepts declaration-form classes and older-version shapes", t => {
  const f = fixture(t);
  const mod = loadScript(f.skill);
  // 3.17.1-era bundles may declare the layer as `class X` instead of `X=class`.
  const declared = [
    "var J1=new Map;",
    "class Q1{constructor(t){this.transport=t;this.entries=new Map;this.disposed=!1}",
    "acquire(e){if(this.disposed)throw Error(`x`);let r={store:e,refCount:1};this.entries.set(e,r);return r}}",
    "function conn(t,k){k=`w`;let s;(s={layer:new Q1(t),refCount:1,keepWarmTimer:null,stale:!1},J1.set(k,s));" +
      "J1.delete(k),s.stale=!0;return s}",
    "var productTurnId=0,rowId=0,logEpoch=0,assistantText=0,projectionReady=0;",
  ].join("\n");
  const result = mod.detectStoreAsset(declared);
  assert.deepStrictEqual(
    { stage: result.stage, registry: result.registry, layerClass: result.layerClass },
    { stage: "ready", registry: "J1", layerClass: "Q1" });
});

// A hypothetical next release: new identifier allocation, `class extends`,
// reordered entry properties, statement separator and an inline literal store.
// An a1->a2 upgrade must adapt from the structure alone, with no registration.
const FUTURE_STORE_ASSET = [
  "const zw=new Map;",
  "var Qk=class extends Object{constructor(r){super();this.transport=r;this.entries=new Map;this.disposed=!1}",
  "lookup(e){return this.entries.get(e)}",
  "acquire(e){if(this.disposed)throw Error(`no`);let r={store:e,refCount:1};this.entries.set(e,r);return r}",
  "drop(e){this.entries.delete(e)}};",
  "var k=`conn`;",
  "function wire(r){let e={layer:new Qk(r),stale:!1,refCount:1};zw.set(k,e);return e}",
  "function arm(r){return zw.set(k,{layer:new Qk(r),refCount:1,stale:!1})}",
  "function reap(key){let e=zw.get(key);zw.delete(key),e.stale=!0}",
  "function hook(r){return{layer:new Qk({transport:r}),send:(...a)=>a}};",
  "var productTurnId=0,rowId=0,logEpoch=0,assistantText=0,projectionReady=0;",
].join("\n");

test("a future-version upgrade adapts from the structure alone", t => {
  const f = fixture(t);
  makeAsar(f.archive, { ...ORIGINAL,
    "package.json": Buffer.from(JSON.stringify({ version: "4.2.0" })),
    [ASSET]: Buffer.from(FUTURE_STORE_ASSET) });
  const installed = JSON.parse(cli(f, "install").stdout);
  assert.deepStrictEqual([installed.state, installed.pending], ["installed", false]);
  assert.ok(unpackAsar(f.archive)[ASSET].includes("const registry = zw;"),
    "the new release's registry variable must be bound");
  const removed = JSON.parse(cli(f, "remove").stdout);
  assert.strictEqual(removed.state, "removed");
  assert.ok(!unpackAsar(f.archive)[ASSET].toString("latin1").includes("zspeed-bridge:v1 begin"));
});

test("a genuine store refactor refuses safely with diagnostics", t => {
  const f = fixture(t);
  makeAsar(f.archive, { ...ORIGINAL,
    "package.json": Buffer.from(JSON.stringify({ version: "4.2.0" })),
    [ASSET]: Buffer.from(FUTURE_STORE_ASSET.replace("productTurnId", "turnRef")) });
  const before = fs.readFileSync(f.archive);
  const result = cli(f, "install", [], 1);
  assert.ok(result.stderr.includes("store shape was not found"), result.stderr);
  assert.ok(result.stderr.includes("productTurnId"), result.stderr);
  assert.ok(fs.readFileSync(f.archive).equals(before));
  const report = JSON.parse(cli(f, "verify", [], 1).stdout);
  assert.strictEqual(report.stage, "features");
  assert.deepStrictEqual(report.missing, ["productTurnId"]);
  assert.ok(report.snippets && report.snippets.rowId, "context snippets aid the port");
});

test("removal can clean an older version", t => {
  const f = fixture(t);
  cli(f, "install");
  const contents = unpackAsar(f.archive);
  contents["package.json"] = Buffer.from(JSON.stringify({ version: "3.17.0" }));
  makeAsar(f.archive, contents);
  assert.strictEqual(JSON.parse(cli(f, "remove").stdout).state, "removed");
  assertArchiveEquals(f.archive, { ...ORIGINAL, "package.json": contents["package.json"] });
  assert.strictEqual(fs.existsSync(f.runtime), false);
});

test("root compatibility entry installs without extra arguments", t => {
  const f = fixture(t);
  const result = cli(f, "install", [], 0, ROOT_ENTRY);
  assert.strictEqual(JSON.parse(result.stdout).state, "installed");
  assert.ok(unpackAsar(f.archive)[ASSET].includes("zspeed-bridge:v1 begin"));
});

test("remove works after the renderer changed post-install", t => {
  const f = fixture(t);
  cli(f, "install");
  const changed = unpackAsar(f.archive);
  changed[ASSET] = Buffer.concat([changed[ASSET], Buffer.from("\n// unexpected host modification")]);
  makeAsar(f.archive, changed);
  const removed = JSON.parse(cli(f, "remove", ["--force"]).stdout);
  assert.deepStrictEqual([removed.state, removed.pending], ["removed", false]);
  const cleaned = unpackAsar(f.archive)[ASSET].toString("latin1");
  assert.ok(!cleaned.includes("zspeed-bridge:v1 begin"), "the marker must be stripped");
  assert.ok(cleaned.includes("unexpected host modification"), "foreign bytes stay untouched");
  assert.ok(!unpackAsar(f.archive)[MAIN].toString("latin1").includes("inject-main.cjs"));
  assert.strictEqual(fs.existsSync(f.runtime), false);
});

test("pending remove reports the current state and cleans only after replace", t => {
  const f = fixture(t);
  const [mod, report, restoreReplace] = startPending(f, "remove");
  assert.deepStrictEqual([report.state, report.pending], ["pending-until-ZCode-exits", true]);
  assert.ok(report.bridge && report.loader);
  assert.strictEqual(fs.existsSync(f.runtime), true);
  assert.ok(unpackAsar(f.archive)[ASSET].includes("zspeed-bridge:v1 begin"));
  const checked = JSON.parse(cli(f, "check", [], 1).stdout);
  assert.ok(checked.pending);
  cli(f, "remove", [], 1);
  assert.strictEqual(fs.existsSync(f.runtime), true);
  restoreReplace();
  assert.strictEqual(mod.waitForUnlock(f.archive), 0);
  assertArchiveEquals(f.archive, ORIGINAL);
  assert.strictEqual(fs.existsSync(f.runtime), false);
});

test("pending install reports the current state until replacement", t => {
  const f = fixture(t);
  const [mod, report, restoreReplace] = startPending(f, "install");
  assert.ok(report.pending);
  assert.ok(!report.bridge && !report.loader);
  assertArchiveEquals(f.archive, ORIGINAL);
  restoreReplace();
  assert.strictEqual(mod.waitForUnlock(f.archive), 0);
  const checked = JSON.parse(cli(f, "check").stdout);
  assert.ok(checked.bridge && checked.loader && !checked.pending);
});

test("tampered pending file is not applied", t => {
  const f = fixture(t);
  const [mod, , restoreReplace] = startPending(f, "remove");
  const before = fs.readFileSync(f.archive);
  const pending = f.archive + ".zspeed.pending";
  fs.writeFileSync(pending, Buffer.concat([fs.readFileSync(pending), Buffer.from("tampered")]));
  restoreReplace();
  assert.throws(() => mod.waitForUnlock(f.archive), /integrity mismatch/);
  assert.ok(fs.readFileSync(f.archive).equals(before));
  assert.strictEqual(fs.existsSync(pending), true);
  assert.strictEqual(fs.existsSync(f.runtime), true);
});

test("pending is cancelled if the original archive changes", t => {
  const f = fixture(t);
  const [mod, , restoreReplace] = startPending(f, "remove");
  fs.writeFileSync(f.archive, Buffer.concat([fs.readFileSync(f.archive), Buffer.from("host updated")]));
  const changed = fs.readFileSync(f.archive);
  restoreReplace();
  assert.strictEqual(mod.waitForUnlock(f.archive), 1);
  assert.ok(fs.readFileSync(f.archive).equals(changed));
  assert.strictEqual(fs.existsSync(f.runtime), true);
  const status = JSON.parse(fs.readFileSync(path.join(f.runtime, "install-status.json"), "utf8"));
  assert.strictEqual(status.state, "cancelled");
});

test("removal from the runtime directory preserves its own files", t => {
  const f = fixture(t);
  cli(f, "install");
  const runtimeScript = path.join(f.runtime, "repair-speed.cjs");
  const result = cli(f, "remove", [], 0, runtimeScript);
  assert.ok(JSON.parse(result.stdout).runtimeDir.includes("kept: this script runs inside it"));
  assertArchiveEquals(f.archive, ORIGINAL);
  assert.strictEqual(fs.existsSync(runtimeScript), true);
  assert.strictEqual(fs.existsSync(path.join(f.runtime, "backups")), true);
});

test("check detects an orphaned pending file", t => {
  const f = fixture(t);
  cli(f, "install");
  const before = fs.readFileSync(f.archive);
  const pending = f.archive + ".zspeed.pending";
  fs.writeFileSync(pending, "unfinished");
  const report = JSON.parse(cli(f, "check", [], 1).stdout);
  assert.ok(report.pending);
  cli(f, "install", [], 1);
  cli(f, "remove", [], 1);
  cli(f, "deploy", [], 1);
  assert.ok(fs.readFileSync(f.archive).equals(before));
  assert.strictEqual(fs.readFileSync(pending, "utf8"), "unfinished");
});

test("automatic discovery refuses multiple installations", t => {
  const f = fixture(t);
  const other = path.join(f.root, "other ZCode");
  fs.mkdirSync(path.join(other, "resources"), { recursive: true });
  fs.writeFileSync(path.join(other, "resources", "app.asar"), "");
  fs.writeFileSync(path.join(other, "ZCode.exe"), "");
  const mod = loadScript(f.skill);
  mod.hooks.installRoots = () => [f.installation, other];
  assert.throws(() => mod.findZcodeAsar(), error => {
    assert.ok(/Multiple ZCode installations/.test(error.message), error.message);
    assert.ok(error.message.includes(f.archive), error.message);
    assert.ok(error.message.includes(path.join(other, "resources", "app.asar")), error.message);
    return true;
  });
});

// --- Port additions: cross-version artifacts, encoding, platforms, quoting ---

test("file URI encoding matches Python as_uri byte for byte", t => {
  const f = fixture(t);
  const mod = loadScript(f.skill);
  for (const [input, expected] of AS_URI_FIXTURES) {
    assert.strictEqual(mod.toFileUri(input), expected, input);
  }
});

test("pending metadata keeps full stamp precision and reads Python-format files", t => {
  const f = fixture(t);
  const mod = loadScript(f.skill);
  const huge = 1761900000123456789n; // 19 digits, beyond Number.MAX_SAFE_INTEGER
  const serialized = mod.serializeJsonWithStamp({
    intent: "install", originalStamp: [404n, huge, 562949953421312n],
  });
  assert.ok(serialized.includes(`"originalStamp": [\n    404,\n    ${huge},`), serialized);
  const parsed = mod.parseMeta(serialized);
  assert.deepStrictEqual(parsed.originalStamp, [404n, huge, 562949953421312n]);
  // A Python-style single-line metadata file parses digit-exactly as well.
  const pythonStyle = '{"originalStamp": [404, ' + huge.toString() + ', 562949953421312], "intent": "install"}';
  assert.deepStrictEqual(mod.parseMeta(pythonStyle).originalStamp, [404n, huge, 562949953421312n]);
  // A placeholder-looking substring elsewhere must not corrupt serialization.
  const tricky = mod.serializeJsonWithStamp({
    intent: "install", asar: 'D:\\weird "@@1@@" path', originalStamp: [1n, 2n, 3n],
  });
  assert.deepStrictEqual(mod.parseMeta(tricky).originalStamp, [1n, 2n, 3n]);
});

test("a pending repair with an altered stamp digit is cancelled, not applied", t => {
  const f = fixture(t);
  const [mod, , restoreReplace] = startPending(f, "install");
  const metaPath = path.join(f.runtime, "pending-install.json");
  const meta = mod.parseMeta(fs.readFileSync(metaPath, "utf8"));
  assert.deepStrictEqual(meta.originalStamp, mod.stamp(f.archive));
  const tampered = [...meta.originalStamp];
  tampered[1] = tampered[1] + 1n;
  fs.writeFileSync(metaPath, mod.serializeJsonWithStamp({ ...meta, originalStamp: tampered }));
  restoreReplace();
  assert.strictEqual(mod.waitForUnlock(f.archive), 1);
  assertArchiveEquals(f.archive, ORIGINAL);
  const status = JSON.parse(fs.readFileSync(path.join(f.runtime, "install-status.json"), "utf8"));
  assert.strictEqual(status.state, "cancelled");
});

test("an install written by the old Python tool is recognized, upgraded and removed verified", t => {
  const f = fixture(t);
  const mod = loadScript(f.skill);
  const clean = Buffer.from("var np = new Map();");
  const bridge = fs.readFileSync(path.join(f.skill, "scripts", "speed-bridge.js"))
    .toString("latin1").replaceAll("__ZSPEED_REGISTRY__", () => "np");
  // A loader line exactly as the Python installer wrote it for an exotic runtime
  // path (the expected URI comes from the recorded Python as_uri fixture table).
  const legacyRuntime = "D:\\a'b(c)!$&dir\\ZCode";
  const legacyUrl = "file:///D:/a%27b%28c%29%21%24%26dir/ZCode/inject-main.cjs";
  assert.strictEqual(mod.toFileUri(legacyRuntime + "\\inject-main.cjs"), legacyUrl);
  const legacyLine = "\n;import(" + JSON.stringify(legacyUrl) +
    ').then(() => null, (e) => console.error("[zusage] load failed", e));';
  makeAsar(f.archive, {
    "package.json": Buffer.from(JSON.stringify({ version: VERSION })),
    [MAIN]: Buffer.from("console.log('synthetic main');" + legacyLine + "\n", "latin1"),
    [ASSET]: Buffer.concat([clean, Buffer.from("\n" + bridge, "latin1")]),
    "unrelated/data.bin": ORIGINAL["unrelated/data.bin"],
  });
  const checked = JSON.parse(cli(f, "check", [], 1).stdout);
  assert.ok(checked.bridge && !checked.loader && !checked.pending);
  const installed = JSON.parse(cli(f, "install").stdout);
  assert.deepStrictEqual([installed.state, installed.pending], ["installed", false]);
  const mainText = unpackAsar(f.archive)[MAIN].toString("latin1");
  assert.strictEqual([...mainText.matchAll(/;import\("/g)].length, 1);
  assert.ok(!mainText.includes("%27"), "the stale foreign loader line must be dropped");
  const stable = fs.readFileSync(f.archive);
  assert.ok(JSON.parse(cli(f, "install").stdout).alreadyInstalled);
  assert.ok(fs.readFileSync(f.archive).equals(stable));
  const removed = JSON.parse(cli(f, "remove").stdout);
  assert.strictEqual(removed.state, "removed");
  assertArchiveEquals(f.archive, { ...ORIGINAL, [ASSET]: clean });
});

test("darwin and linux layouts are discovered", t => {
  const f = fixture(t);
  const mod = loadScript(f.skill);
  const darwinRoot = path.join(f.root, "ZCode.app");
  fs.mkdirSync(path.join(darwinRoot, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(darwinRoot, "Contents", "MacOS", "ZCode"), "");
  const darwinAsar = path.join(darwinRoot, "Contents", "Resources", "app.asar");
  makeAsar(darwinAsar, ORIGINAL);
  mod.hooks.installRoots = platform => platform === "darwin" ? [darwinRoot] : [];
  assert.strictEqual(mod.findZcodeAsar("darwin"), darwinAsar);
  assert.strictEqual(mod.looksLikeZCodeRoot(darwinRoot, "darwin"), true);
  const linuxRoot = path.join(f.root, "zcode-linux");
  fs.mkdirSync(path.join(linuxRoot, "resources"), { recursive: true });
  fs.writeFileSync(path.join(linuxRoot, "zcode"), "");
  const linuxAsar = path.join(linuxRoot, "resources", "app.asar");
  makeAsar(linuxAsar, ORIGINAL);
  mod.hooks.installRoots = platform => platform === "linux" ? [linuxRoot] : [];
  assert.strictEqual(mod.findZcodeAsar("linux"), linuxAsar);
  assert.strictEqual(mod.looksLikeZCodeRoot(linuxRoot, "linux"), true);
});

test("reg.exe export parsing picks zcode install locations in any value order", t => {
  const f = fixture(t);
  const mod = loadScript(f.skill);
  const sample = [
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{AAA}",
    "    DisplayName    REG_SZ    ZCode",
    "    InstallLocation    REG_SZ    D:\\soft\\ZCode\\",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{BBB}",
    "    DisplayName    REG_SZ    Something Else",
    "    InstallLocation    REG_SZ    C:\\Elsewhere",
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{CCC}",
    "    InstallLocation    REG_SZ    E:\\ZCodeOrderIrrelevant",
    "    DisplayName    REG_SZ    ZCode Editor",
    "",
  ].join("\r\n");
  assert.deepStrictEqual(mod.parseRegistryExport(sample), ["D:\\soft\\ZCode\\", "E:\\ZCodeOrderIrrelevant"]);
});

test("windows command-line quoting follows the Microsoft argv rules", t => {
  const f = fixture(t);
  const mod = loadScript(f.skill);
  assert.strictEqual(mod.winQuote("C:\\tools\\node.exe"), "C:\\tools\\node.exe");
  assert.strictEqual(mod.winQuote("C:\\Program Files\\node.exe"), '"C:\\Program Files\\node.exe"');
  assert.strictEqual(mod.winQuote("C:\\Program Files\\"), '"C:\\Program Files\\\\"');
  assert.strictEqual(mod.winQuote('a "quoted" path'), '"a \\"quoted\\" path"');
  assert.strictEqual(mod.winQuote(""), '""');
  assert.strictEqual(mod.winQuote("plain"), "plain");
});
