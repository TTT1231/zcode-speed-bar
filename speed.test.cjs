"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createSpeedMeter, rendererMain, VERSION } = require("./inject-main.cjs");
const head = (extra = {}) => ({ id: 1, turnId: "t1", kind: "turnHeader", state: "running", chars: 0, ...extra });
const text = (chars, extra = {}) => ({ id: 2, turnId: "t1", kind: "assistantText", chars, ...extra });
const snap = (chars, extra = {}) => ({ sessionId: "s1", epoch: "e1", generation: 1, phase: "running",
  rows: [head(), text(chars)], ...extra });

test("speed updates every 500ms from live snapshots without any DB event", () => {
  const meter = createSpeedMeter();
  assert.equal(meter.update(snap(0), 0).tps, null);
  assert.equal(meter.update(snap(100), 500).tps, 100);
  assert.equal(meter.update(snap(300), 1000).tps, 150);
  assert.equal(meter.update(snap(600), 1500).tps, 200);
  assert.equal(meter.update(snap(800), 2000).tps, 200);
});

test("unchanged snapshots decay to zero during a pause", () => {
  const meter = createSpeedMeter();
  meter.update(snap(0), 0);
  meter.update(snap(100), 500);
  for (const now of [1000, 1500, 2000]) meter.update(snap(100), now);
  assert.equal(meter.update(snap(100), 2500).tps, 0);
});

test("a foreground command or approval reports zero immediately and starts a fresh baseline", () => {
  const meter = createSpeedMeter();
  const call = (chars, status, extraRows = []) => snap(0, { rows: [head(),
    { id: 2, turnId: "t1", kind: "toolCall", chars, status }, ...extraRows] });
  meter.update(call(0, "inputStreaming"), 0);
  assert.equal(meter.update(call(200, "inputStreaming"), 500).tps, 200);
  assert.equal(meter.update(call(200, "running"), 1000).tps, 0);
  assert.equal(meter.update(call(200, "running"), 1500).tps, 0);
  assert.equal(meter.update(call(200, "pendingApproval"), 2000).tps, 0);
  const resumed = { id: 3, turnId: "t1", kind: "reasoning", state: "streaming", chars: 100 };
  assert.equal(meter.update(call(200, "success", [resumed]), 2500).tps, 100);
});

test("a running tool does not hide concurrently streaming model output", () => {
  const meter = createSpeedMeter();
  const withConcurrentOutput = chars => snap(0, { rows: [head(),
    { id: 2, turnId: "t1", kind: "toolCall", chars: 100, status: "running" },
    { id: 3, turnId: "t1", kind: "reasoning", chars, state: "streaming" }] });
  meter.update(withConcurrentOutput(0), 0);
  assert.equal(meter.update(withConcurrentOutput(100), 500).tps, 100);
  assert.equal(meter.update(withConcurrentOutput(200), 1000).tps, 100);
});

test("a backgrounded tool does not freeze speed samples", () => {
  const meter = createSpeedMeter();
  const backgroundTool = chars => snap(0, { rows: [head(),
    { id: 2, turnId: "t1", kind: "toolCall", chars: 100, status: "running", backgrounded: true },
    { id: 3, turnId: "t1", kind: "assistantText", chars }] });
  meter.update(backgroundTool(0), 0);
  assert.equal(meter.update(backgroundTool(100), 500).tps, 100);
});

test("background generation remains independent while another conversation waits for a tool", () => {
  const meter = createSpeedMeter();
  const active = chars => snap(0, { rows: [head(),
    { id: 2, turnId: "t1", kind: "reasoning", chars, state: "streaming" }] });
  const waiting = snap(0, { sessionId: "s2", rows: [head(),
    { id: 2, turnId: "t1", kind: "toolCall", chars: 300, status: "running" }] });
  meter.sampleAll([active(0), waiting], 0);
  assert.equal(meter.get("s2").tps, 0);
  meter.sampleAll([active(100), waiting], 500);
  assert.equal(meter.get("s1").tps, 100);
  meter.sampleAll([active(200), waiting], 1000);
  assert.equal(meter.get("s2").tps, 0);
  meter.sampleAll([active(300), waiting], 1500);
  assert.equal(meter.get("s1").tps, 100);
});

test("completion uses token truth and calibrates the next turn once", () => {
  const meter = createSpeedMeter();
  meter.update(snap(0), 0);
  const done = snap(400, { phase: "completedSuccess", rows: [
    head({ state: "completedSuccess", outputTokens: 100, modelDurationMs: 2000 }), text(400)] });
  assert.deepEqual(meter.update(done, 2000), {
    sessionId: "s1", turnId: "t1", est: false, mode: "final", tps: 50
  });
  meter.update(done, 2500);
  const next = chars => snap(chars, { rows: [head({ turnId: "t2" }), text(chars, { turnId: "t2" })] });
  meter.update(next(0), 3000);
  assert.equal(meter.update(next(200), 3500).tps, 100);
});

test("session, epoch and store changes discard another stream's samples", () => {
  for (const change of [{ sessionId: "s2" }, { epoch: "e2" }, { generation: 2 }]) {
    const meter = createSpeedMeter();
    meter.update(snap(100), 0);
    meter.update(snap(200), 500);
    assert.equal(meter.update(snap(10000, change), 1000).tps, null);
    assert.equal(meter.update(snap(10100, change), 1500).tps, 100);
  }
});

test("a long turn continues when its header/text leave the 60-row tail", () => {
  const meter = createSpeedMeter();
  meter.update(snap(0), 0);
  meter.update(snap(100), 500);
  assert.equal(meter.update(snap(0, { rows: [text(100, { id: 3 })] }), 1000).tps, 100);
  assert.equal(meter.update(snap(0, { rows: [text(200, { id: 3 })] }), 1500).tps, 100);
});

test("rewrites and reconnects do not create artificial rate spikes", () => {
  const meter = createSpeedMeter();
  meter.update(snap(100), 0);
  meter.update(snap(200), 500);
  assert.equal(meter.update(snap(10), 1000).tps, null);
  assert.equal(meter.update(snap(110), 1500).tps, 100);
  assert.equal(meter.update(null, 2000).tps, null);
  assert.equal(meter.update(snap(9999), 2500).tps, null);
});

test("invalid or implausible completion timing never produces a precise speed", () => {
  for (const ms of [undefined, null, 0, 199, 3600000, Infinity, NaN]) {
    const meter = createSpeedMeter();
    const result = meter.update(snap(5, { phase: "completedSuccess", rows: [
      head({ state: "completedSuccess", outputTokens: 100, modelDurationMs: ms }), text(5)] }), 0);
    assert.equal(result.tps, null);
  }
});

test("a newly observed stream waits for a baseline instead of claiming zero speed", () => {
  const meter = createSpeedMeter();
  assert.equal(meter.update(snap(9000), 0).tps, null);
  assert.equal(meter.update(snap(9100), 500).tps, 100);
});

test("connecting snapshots and recovered history do not become output-speed samples", () => {
  const meter = createSpeedMeter();
  meter.update(snap(0), 0);
  assert.equal(meter.update(snap(100), 500).tps, 100);
  assert.equal(meter.update(snap(10000, { status: "connecting", projectionReady: false }), 1000).tps, null);
  assert.equal(meter.update(snap(20000, { status: "live", projectionReady: true }), 1500).tps, null);
  assert.equal(meter.update(snap(20100, { status: "live", projectionReady: true }), 2000).tps, 100);
});

test("a stream not observed for several seconds restarts its baseline without a catch-up spike", () => {
  const meter = createSpeedMeter();
  meter.update(snap(0), 0);
  meter.update(snap(100), 500);
  assert.equal(meter.update(snap(10000), 6000).tps, null);
  assert.equal(meter.update(snap(10100), 6500).tps, 100);
});

test("background sampling still reports a genuine pause after switching", () => {
  const meter = createSpeedMeter();
  const batch = (a, b) => [snap(a), snap(b, { sessionId: "s2" })];
  meter.sampleAll(batch(0, 0), 0);
  meter.sampleAll(batch(100, 200), 500);
  for (const now of [1000, 1500, 2000, 2500]) meter.sampleAll(batch(now / 5, 200), now);
  assert.equal(meter.get("s1").tps, 100);
  assert.equal(meter.get("s2").tps, 0);
});

test("each conversation keeps its own token calibration when revisited", () => {
  const meter = createSpeedMeter();
  meter.update(snap(400, { phase: "completedSuccess", rows: [
    head({ state: "completedSuccess", outputTokens: 100, modelDurationMs: 2000 }), text(400)] }), 0);
  const nextA = chars => snap(chars, { rows: [head({ turnId: "t2" }), text(chars, { turnId: "t2" })] });
  meter.sampleAll([nextA(0), snap(0, { sessionId: "s2" })], 500);
  meter.sampleAll([nextA(200), snap(200, { sessionId: "s2" })], 1000);
  assert.equal(meter.get("s1").tps, 100);
  assert.equal(meter.get("s2").tps, 200);
  meter.sampleAll([nextA(400), snap(400, { sessionId: "s2" })], 1500);
  assert.equal(meter.get("s1").tps, 100);
});

function bridgeFixture() {
  let snapshot = { sessionId: "s1", logEpoch: "e1", seq: 1, control: { phase: "running" }, rows: { window: [
    { rowId: 1, turnId: "t1", kind: "turnHeader", state: "running" },
    { rowId: 2, turnId: "t1", kind: "assistantText", text: "中😀a" },
    { rowId: 3, turnId: "t1", kind: "reasoning", text: "想想" },
    { rowId: 4, turnId: "t1", kind: "toolCall", inputText: "{}", status: "success", output: "do not count me" },
    { rowId: 5, turnId: "t1", kind: "userInput", text: "do not count me either" }
  ] } };
  const store = { closed: false, getState: () => ({ snapshot }) };
  const entry = { layer: { disposed: false, entries: new Map([["session:s1", { store }]]) } };
  const registry = new Map([["workspace", entry]]);
  const context = vm.createContext({ np: registry });
  const source = fs.readFileSync(path.join(__dirname, "speed-bridge.js"), "utf8")
    .replace("__ZSPEED_REGISTRY__", "np");
  vm.runInContext(source, context);
  return { context, store, entry, registry, get snapshot() { return snapshot; }, set snapshot(s) { snapshot = s; } };
}

test("bridge counts Unicode, reasoning and tool input while excluding user/tool output", () => {
  const f = bridgeFixture();
  f.snapshot.rows.window[3].status = "running";
  f.snapshot.rows.window[3].backgrounded = false;
  const original = JSON.stringify(f.snapshot);
  const projection = f.context.__ZSPEED_READ__("s1");
  assert.deepEqual(Array.from(projection.rows, row => row.chars), [0, 3, 2, 2, 0]);
  assert.equal(projection.rows[3].status, "running");
  assert.equal(projection.rows[3].backgrounded, false);
  assert.equal(JSON.stringify(f.snapshot), original);
  assert.doesNotMatch(JSON.stringify(projection), /do not count|中|想/);
  f.snapshot.rows.window[1].text = "中😀abcd";
  assert.equal(f.context.__ZSPEED_READ__("s1").rows[1].chars, 6);
});

test("bridge ignores stale/closed stores and rejects ambiguous sessions", () => {
  const f = bridgeFixture();
  assert.equal(f.context.__ZSPEED_READ__("other"), null);
  f.entry.stale = true;
  assert.equal(f.context.__ZSPEED_READ__("s1"), null);
  f.entry.stale = false;
  f.store.closed = true;
  assert.equal(f.context.__ZSPEED_READ__("s1"), null);
  f.store.closed = false;
  f.registry.set("duplicate", { layer: { entries: new Map([["session:s1", {
    store: { getState: () => ({ snapshot: f.snapshot }) }
  }]]) } });
  assert.equal(f.context.__ZSPEED_READ__("s1"), null);
});

function rendererFixture() {
  let now = 0;
  const listeners = new Map();
  class Element {
    constructor(tag, attributes = {}) { this.tag = tag; this.attributes = attributes; this.style = {}; this.children = []; this.isConnected = false; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key] || null; }
    append(...elements) { for (const el of elements) { el.parent = this; el.isConnected = true; this.children.push(el); } }
    appendChild(element) { this.append(element); return element; }
    remove() { this.isConnected = false; this.parent.children = this.parent.children.filter(el => el !== this); }
    getClientRects() { return this.isConnected ? [{}] : []; }
    getBoundingClientRect() { return { width: 500, height: 700 }; }
    closest() { return this.attributes["data-session-id"] ? this : this.parent?.closest(); }
  }
  const body = new Element("body"); body.isConnected = true;
  body.classList = { contains: () => false };
  const pane = new Element("section", { "data-testid": "v4-session-pane-workspace-main", "data-session-id": "s1" });
  body.append(pane);
  const document = { body, documentElement: body, activeElement: pane,
    createElement: tag => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag), querySelectorAll: () => [pane],
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name) };
  const bridge = bridgeFixture();
  const window = {
    __ZSPEED_READ__: sid => bridge.context.__ZSPEED_READ__(sid),
    __ZSPEED_READ_ALL__: () => bridge.context.__ZSPEED_READ_ALL__()
  };
  const context = vm.createContext({ window, document, performance: { now: () => now } });
  const source = "(" + rendererMain.toString() + ")(" + createSpeedMeter.toString() + "," + JSON.stringify(VERSION) + ")";
  return { context, window, document, body, pane, bridge, source, listeners, setNow: time => { now = time; } };
}

test("renderer keeps one speed-only capsule, updates in place and cleans up", () => {
  const f = rendererFixture();
  vm.runInContext(f.source, f.context);
  const capsule = f.body.children[1];
  assert.equal(capsule.children.length, 4);
  assert.equal(capsule.children[2].textContent, "t/s");
  f.setNow(500);
  f.bridge.snapshot.rows.window[1].text += "a".repeat(100);
  assert.equal(f.window.__ZSPEED_TICK__().tps, 100);
  assert.equal(capsule.children[1].textContent, "100.0");
  vm.runInContext(f.source, f.context);
  assert.equal(f.body.children.length, 2);
  f.pane.attributes["data-session-id"] = "s2";
  assert.equal(f.window.__ZSPEED_TICK__().tps, null);
  assert.equal(capsule.children[1].textContent, "—");
  f.window.__ZSPEED_DISPOSE__();
  assert.equal(f.body.children.length, 1);
  assert.equal(f.listeners.size, 0);
});

test("A to B to A keeps independent live speeds while both conversations generate", () => {
  const f = rendererFixture();
  const other = structuredClone(f.bridge.snapshot);
  other.sessionId = "s2";
  f.bridge.entry.layer.entries.set("session:s2", { store: { getState: () => ({ snapshot: other }) } });
  vm.runInContext(f.source, f.context);
  for (const [now, sid, expected] of [[500, "s1", 100], [1000, "s2", 200], [1500, "s1", 100], [2000, "s2", 200]]) {
    f.setNow(now);
    f.bridge.snapshot.rows.window[1].text += "a".repeat(100);
    other.rows.window[1].text += "b".repeat(200);
    f.pane.attributes["data-session-id"] = sid;
    const result = f.window.__ZSPEED_TICK__();
    assert.equal(result.sessionId, sid);
    assert.equal(result.tps, expected, `switch to ${sid} at ${now}ms`);
  }
});

test("older bridges keep sampling previously visited conversations", () => {
  const f = rendererFixture();
  delete f.window.__ZSPEED_READ_ALL__;
  const other = structuredClone(f.bridge.snapshot);
  other.sessionId = "s2";
  f.bridge.entry.layer.entries.set("session:s2", { store: { getState: () => ({ snapshot: other }) } });
  vm.runInContext(f.source, f.context);
  f.pane.attributes["data-session-id"] = "s2";
  f.setNow(500); f.window.__ZSPEED_TICK__();
  f.pane.attributes["data-session-id"] = "s1";
  f.setNow(1000); other.rows.window[1].text += "b".repeat(200); f.window.__ZSPEED_TICK__();
  f.pane.attributes["data-session-id"] = "s2";
  f.setNow(1500); other.rows.window[1].text += "b".repeat(200);
  assert.equal(f.window.__ZSPEED_TICK__().tps, 200);
});

test("main clock drives 500ms renderer sampling and only injects local host windows", async () => {
  const f = rendererFixture();
  const app = new EventEmitter();
  let callback, interval, reads = 0;
  const mainWindow = new EventEmitter();
  Object.assign(mainWindow, { id: 1, isDestroyed: () => false, getType: () => "window",
    getURL: () => "file:///D:/soft/ZCode/resources/app.asar/out/renderer/index.html",
    executeJavaScript: async source => { reads++; return vm.runInContext(source, f.context); } });
  const external = new EventEmitter();
  Object.assign(external, { ...mainWindow, id: 2, getURL: () => "https://example.org/",
    executeJavaScript: () => { throw new Error("must not inject external page"); } });
  const outside = new EventEmitter();
  Object.assign(outside, { ...mainWindow, id: 3, getURL: () => "file:///D:/soft/ZCode/resources-other/private.html",
    executeJavaScript: () => { throw new Error("must not inject outside resources"); } });
  const mockProcess = { versions: {}, type: "browser", resourcesPath: "D:\\soft\\ZCode\\resources", pid: 1 };
  const context = vm.createContext({ module: { exports: {} }, process: mockProcess, __dirname,
    require: name => name === "electron" ? { app, webContents: { getAllWebContents: () => [mainWindow, external, outside] } }
      : name === "fs" ? { appendFile: (_p, _s, done) => done(), writeFile: (_p, _s, done) => done() } : require(name),
    setInterval: (fn, ms) => { callback = fn; interval = ms; return { unref() {} }; }, clearInterval() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "inject-main.cjs"), "utf8"), context);
  context.module.exports.install();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  assert.equal(interval, 500);
  assert.equal(reads, 1);
  for (const time of [500, 1000, 1500, 2000]) {
    f.setNow(time); f.bridge.snapshot.rows.window[1].text += "a".repeat(100);
    callback(); await flush();
    assert.equal(f.body.children[1].children[1].textContent, "100.0");
  }
  assert.equal(reads, 5);
  app.emit("before-quit");
  assert.equal(app.listenerCount("web-contents-created"), 0);
});
