"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const sourceDir = path.join(__dirname, "skill", "zcode-speed-repair", "scripts");
const { createSpeedMeter, rendererSource, VERSION } = require(path.join(sourceDir, "inject-main.cjs"));
const head = (extra = {}) => ({ id: 1, turnId: "t1", kind: "turnHeader", state: "running", chars: 0, ...extra });
const text = (chars, extra = {}) => ({ id: 2, turnId: "t1", kind: "assistantText", chars, ...extra });
const snap = (chars, extra = {}) => ({ sessionId: "s1", epoch: "e1", generation: 1, phase: "running",
  rows: [head(), text(chars)], ...extra });
const pointer = (clientX, pointerId = 1) => ({ clientX, pointerId, isPrimary: true, preventDefault() {}, stopPropagation() {} });
const fire = (el, name, event) => el.listeners.get(name)(event);

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
  const source = fs.readFileSync(path.join(sourceDir, "speed-bridge.js"), "utf8")
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

function childStores(bridge, snapshots) {
  const layer = bridge.entry.layer, acquired = [], released = [];
  layer.acquire = sid => {
    const snapshot = snapshots.get(sid);
    if (!snapshot) throw new Error("unknown child");
    const key = "session:" + sid, existing = layer.entries.get(key);
    if (!existing) layer.entries.set(key, { store: { getState: () => ({ snapshot }) } });
    acquired.push(sid);
    return { release() { released.push(sid); if (!existing) layer.entries.delete(key); } };
  };
  return { acquired, released };
}

function childSnapshot(sid) {
  return { sessionId: sid, logEpoch: "e1", control: { phase: "running" }, rows: { window: [
    { rowId: 1, turnId: "t1", kind: "turnHeader", state: "running" },
    { rowId: 2, turnId: "t1", kind: "assistantText", state: "streaming", text: "" }
  ] } };
}

test("bridge links agent tool calls by turn and parent ID and releases child leases", () => {
  const f = bridgeFixture(), rows = f.snapshot.rows.window;
  rows.push(
    { rowId: 10, turnId: "t1", kind: "toolCall", toolName: "Agent", toolCallId: "call-a", inputText: "private prompt" },
    { rowId: 11, turnId: "t1", kind: "toolCall", toolName: "Agent", toolCallId: "call-b" },
    { rowId: 20, turnId: "t1", kind: "subagent", parentToolCallId: "call-b", childSessionId: "child-b", status: "running" },
    { rowId: 21, turnId: "t1", kind: "subagent", parentToolCallId: "call-a", childSessionId: "child-a", status: "running" }
  );
  const children = new Map([["child-a", childSnapshot("child-a")], ["child-b", childSnapshot("child-b")]]);
  const leases = childStores(f, children);
  const before = JSON.stringify(f.snapshot);
  const parent = f.context.__ZSPEED_READ__("s1");
  assert.deepEqual(Array.from(parent.agents, a => [a.toolCallId, a.childSessionId]), [["call-a", "child-a"], ["call-b", "child-b"]]);
  assert.deepEqual(leases.acquired, ["child-a", "child-b"]);
  assert.equal(JSON.stringify(f.snapshot), before);
  assert.doesNotMatch(JSON.stringify(parent), /private prompt|do not count|中|想/);
  assert.ok(f.context.__ZSPEED_READ__("child-a"));
  rows.find(row => row.childSessionId === "child-a").status = "completed";
  f.context.__ZSPEED_READ_ALL__();
  assert.deepEqual(leases.released, [], "a finished child's final result remains available while its row remains");
  rows.splice(rows.findIndex(row => row.childSessionId === "child-a"), 1);
  f.context.__ZSPEED_READ_ALL__();
  assert.deepEqual(leases.released, ["child-a"]);
  f.context.__ZSPEED_RELEASE_CHILDREN__();
  assert.deepEqual(leases.released, ["child-a", "child-b"]);
});

test("bridge never guesses between multiple unmatched or conflicting agent calls", () => {
  const f = bridgeFixture(), rows = f.snapshot.rows.window;
  rows.push(
    { rowId: 10, turnId: "t1", kind: "toolCall", toolName: "Agent", toolCallId: "a" },
    { rowId: 11, turnId: "t1", kind: "toolCall", toolName: "Agent", toolCallId: "b" },
    { rowId: 20, turnId: "t1", kind: "subagent", childSessionId: "child-a", status: "running" },
    { rowId: 21, turnId: "t1", kind: "subagent", childSessionId: "child-b", status: "running" }
  );
  const leases = childStores(f, new Map([["child-a", childSnapshot("child-a")], ["child-b", childSnapshot("child-b")]]));
  let agents = f.context.__ZSPEED_READ__("s1").agents;
  assert.deepEqual(Array.from(agents, a => a.childSessionId), [undefined, undefined]);
  assert.deepEqual(leases.acquired, []);
  rows[rows.length - 2].parentToolCallId = "a";
  agents = f.context.__ZSPEED_READ__("s1").agents;
  assert.deepEqual(Array.from(agents, a => a.childSessionId), ["child-a", "child-b"]);
  rows.push({ rowId: 22, turnId: "t1", kind: "subagent", parentToolCallId: "a", childSessionId: "child-c", status: "running" });
  agents = f.context.__ZSPEED_READ__("s1").agents;
  assert.equal(agents[0].childSessionId, undefined);
  assert.deepEqual(leases.released, ["child-a", "child-b"]);
  f.entry.stale = true;
  f.context.__ZSPEED_READ_ALL__();
  assert.deepEqual(leases.released, ["child-a", "child-b"]);
});

test("exact parent-ID matching does not depend on the tool name", () => {
  const f = bridgeFixture(), rows = f.snapshot.rows.window;
  rows.push(
    { rowId: 10, turnId: "t1", kind: "toolCall", toolName: "CustomSpawn", toolCallId: "call-x" },
    { rowId: 20, turnId: "t1", kind: "subagent", parentToolCallId: "call-x", childSessionId: "child-x", status: "running" }
  );
  childStores(f, new Map([["child-x", childSnapshot("child-x")]]));
  const agents = f.context.__ZSPEED_READ__("s1").agents;
  assert.deepEqual(Array.from(agents, a => a.childSessionId), ["child-x"]);
});

test("child subscriptions follow a parent reconnect and are bounded in favor of running agents", () => {
  const f = bridgeFixture(), rows = f.snapshot.rows.window;
  const children = new Map();
  const add = i => {
    const sid = "child-" + i, toolId = "call-" + i;
    children.set(sid, childSnapshot(sid));
    rows.push({ rowId: 10 + i, turnId: "t1", kind: "toolCall", toolName: "Agent", toolCallId: toolId });
    rows.push({ rowId: 100 + i, turnId: "t1", kind: "subagent", parentToolCallId: toolId, childSessionId: sid, status: "running" });
  };
  for (let i = 0; i < 64; i++) add(i);
  const leases = childStores(f, children);
  f.context.__ZSPEED_READ_ALL__();
  assert.equal(leases.acquired.length, 64);
  rows.find(row => row.childSessionId === "child-0").status = "completed";
  add(64);
  f.context.__ZSPEED_READ_ALL__();
  assert.deepEqual(leases.released, ["child-0"]);
  assert.equal(leases.acquired.at(-1), "child-64");
  f.store.getState = () => ({ snapshot: f.snapshot, status: "connecting", projectionReady: false });
  f.context.__ZSPEED_READ_ALL__();
  assert.equal(leases.released.length, 65);
  f.store.getState = () => ({ snapshot: f.snapshot, status: "live", projectionReady: true });
  f.context.__ZSPEED_READ_ALL__();
  assert.equal(leases.acquired.length, 129);
  assert.equal(leases.acquired.at(-1), "child-64");
  f.context.__ZSPEED_RELEASE_CHILDREN__();
});

function rendererFixture() {
  let now = 0;
  const listeners = new Map();
  class Element {
    constructor(tag, attributes = {}) { this.tag = tag; this.attributes = attributes; this.style = {}; this.children = []; this.hidden = false; }
    get isConnected() { return this === body || !!this.parent?.isConnected; }
    get parentElement() { return this.parent || null; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key] || null; }
    append(...elements) { for (const el of elements) { el.parent = this; this.children.push(el); } }
    appendChild(element) { this.append(element); return element; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(el => el !== this); this.parent = null; }
    getClientRects() { return this.isConnected && !this.hidden ? [{}] : []; }
    getBoundingClientRect() {
      return this.className === "zusage-speed-mini" ? { width: 90, height: 28 } : { width: 500, height: 700 };
    }
    addEventListener(name, listener) { (this.listeners ||= new Map()).set(name, listener); }
    removeEventListener(name, listener) { if (this.listeners?.get(name) === listener) this.listeners.delete(name); }
    setPointerCapture() {}
    releasePointerCapture() {}
    closest(selector) {
      const key = selector.includes("data-session-id") ? "data-session-id"
        : selector.includes("data-row-id") ? "data-row-id" : "data-tool-call-id";
      return this.attributes[key] ? this : this.parent?.closest(selector) || null;
    }
    querySelectorAll(selector) {
      const found = [];
      const visit = element => {
        for (const child of element.children) {
          const id = child.getAttribute("data-testid") || "";
          if (selector.includes("data-tool-name")
            ? child.getAttribute("data-tool-call-id") && child.getAttribute("data-tool-name")
            : id.startsWith("tool-summary-trigger-") || id.startsWith("v4-subagent-open-side-pane-")) found.push(child);
          visit(child);
        }
      };
      visit(this);
      return found;
    }
  }
  const body = new Element("body");
  body.classList = { contains: () => false };
  const panes = [];
  function addPane(sid, paneId) {
    const pane = new Element("section", { "data-testid": "v4-session-pane-" + paneId, "data-session-id": sid });
    body.append(pane);
    panes.push(pane);
    return pane;
  }
  const pane = addPane("s1", "workspace-main");
  const document = { body, documentElement: body, activeElement: pane,
    createElement: tag => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag),
    querySelectorAll: () => panes.filter(pane => pane.isConnected),
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name) };
  const bridge = bridgeFixture();
  const store = new Map();
  const window = {
    __ZSPEED_READ__: sid => bridge.context.__ZSPEED_READ__(sid),
    __ZSPEED_READ_ALL__: () => bridge.context.__ZSPEED_READ_ALL__(),
    __ZSPEED_RELEASE_CHILDREN__: () => bridge.context.__ZSPEED_RELEASE_CHILDREN__(),
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: key => { store.delete(key); }
    }
  };
  const context = vm.createContext({ window, document, performance: { now: () => now } });
  const source = rendererSource();
  return { context, window, document, body, pane, bridge, source, listeners, addPane, Element, store,
    barFor: pane => pane.children.find(element => element.className === "zusage-speed-mini"),
    setNow: time => { now = time; } };
}

// Registers a cloned second conversation on the bridge; paneId also gives it its own pane.
function addConversation(f, sid, paneId) {
  const snapshot = structuredClone(f.bridge.snapshot);
  snapshot.sessionId = sid;
  f.bridge.entry.layer.entries.set("session:" + sid, { store: { getState: () => ({ snapshot }) } });
  return { snapshot, pane: paneId ? f.addPane(sid, paneId) : null };
}

test("renderer keeps one speed-only capsule per chat, updates in place and cleans up", () => {
  const f = rendererFixture();
  vm.runInContext(f.source, f.context);
  const capsule = f.barFor(f.pane);
  assert.equal(capsule.children.length, 4);
  assert.equal(capsule.children[2].textContent, "t/s");
  f.setNow(500);
  f.bridge.snapshot.rows.window[1].text += "a".repeat(100);
  assert.equal(f.window.__ZSPEED_TICK__().tps, 100);
  assert.equal(capsule.children[1].textContent, "100.0");
  vm.runInContext(f.source, f.context);
  assert.equal(f.pane.children.length, 1);
  assert.equal(f.barFor(f.pane), capsule);
  f.pane.attributes["data-session-id"] = "s2";
  assert.equal(f.window.__ZSPEED_TICK__().tps, null);
  assert.equal(capsule.children[1].textContent, "—");
  f.window.__ZSPEED_DISPOSE__();
  assert.equal(f.body.children.length, 1);
  assert.equal(f.pane.children.length, 0);
  assert.equal(f.listeners.size, 0);
});

test("the speed capsule drags horizontally, keeps its place per run and recenters on double click", () => {
  const f = rendererFixture();
  f.store.set("zspeed-bar-offset", "50");
  vm.runInContext(f.source, f.context);
  assert.equal(f.store.has("zspeed-bar-offset"), false);
  const capsule = f.barFor(f.pane);
  assert.equal(capsule.style.transform, "translateX(calc(-50% + 0px))");
  assert.ok(capsule.title.includes("可左右拖动，双击复位"));
  fire(capsule, "pointerdown", pointer(250));
  fire(capsule, "pointermove", pointer(447));
  assert.equal(capsule.style.transform, "translateX(calc(-50% + 197px))");
  fire(capsule, "pointermove", pointer(900));
  assert.equal(capsule.style.transform, "translateX(calc(-50% + 197px))");
  fire(capsule, "pointerup", pointer(447));
  capsule.remove();
  f.window.__ZSPEED_TICK__();
  const rebuilt = f.barFor(f.pane);
  assert.notEqual(rebuilt, capsule);
  assert.equal(rebuilt.style.transform, "translateX(calc(-50% + 197px))");
  fire(rebuilt, "dblclick", { preventDefault() {}, stopPropagation() {} });
  assert.equal(rebuilt.style.transform, "translateX(calc(-50% + 0px))");
  fire(rebuilt, "pointerdown", pointer(0));
  fire(rebuilt, "pointermove", pointer(-100));
  fire(rebuilt, "pointerup", pointer(-100));
  f.window.__ZSPEED_DISPOSE__();
  vm.runInContext(f.source, f.context);
  assert.equal(f.barFor(f.pane).style.transform, "translateX(calc(-50% + 0px))");
  f.window.__ZSPEED_DISPOSE__();
  assert.equal(f.pane.children.length, 0);
});

test("side and main panes drag their bars independently", () => {
  const f = rendererFixture();
  const side = f.addPane("s2", "workspace-side-1");
  vm.runInContext(f.source, f.context);
  const mainBar = f.barFor(f.pane), sideBar = f.barFor(side);
  fire(sideBar, "pointerdown", pointer(250));
  fire(sideBar, "pointermove", pointer(350));
  fire(sideBar, "pointerup", pointer(350));
  assert.equal(sideBar.style.transform, "translateX(calc(-50% + 100px))");
  assert.equal(mainBar.style.transform, "translateX(calc(-50% + 0px))");
  f.window.__ZSPEED_TICK__();
  assert.equal(f.barFor(side).style.transform, "translateX(calc(-50% + 100px))");
  assert.equal(f.barFor(f.pane).style.transform, "translateX(calc(-50% + 0px))");
  side.attributes["data-session-id"] = "s3";
  f.window.__ZSPEED_TICK__();
  assert.equal(f.barFor(side).style.transform, "translateX(calc(-50% + 100px))");
  fire(sideBar, "dblclick", { preventDefault() {}, stopPropagation() {} });
  assert.equal(sideBar.style.transform, "translateX(calc(-50% + 0px))");
  assert.equal(f.store.size, 0);
  f.window.__ZSPEED_DISPOSE__();
});

test("three subagents show their own live, waiting and final rates beside the correct task", () => {
  const f = rendererFixture(), rows = f.bridge.snapshot.rows.window;
  rows.splice(2);
  rows[1].text = "";
  rows[1].state = "streaming";
  const children = new Map(), summaries = [], blocks = [], subRows = [];
  for (const [index, sid] of ["child-a", "child-b", "child-c"].entries()) {
    const toolId = "call-" + index, rowId = 10 + index;
    rows.push({ rowId, turnId: "t1", kind: "toolCall", toolName: "Agent", toolCallId: toolId, status: "running" });
    const sub = { rowId: 20 + index, turnId: "t1", kind: "subagent", parentToolCallId: toolId, childSessionId: sid, status: "running" };
    rows.push(sub); subRows.push(sub);
    const child = childSnapshot(sid); children.set(sid, child);
    const row = new f.Element("div", { "data-row-id": String(rowId) });
    const block = new f.Element("div", { "data-tool-call-id": toolId, "data-tool-name": "Agent" });
    const summary = new f.Element("div", { "data-testid": "v4-subagent-open-side-pane-" + sid });
    f.pane.append(row); row.append(block); block.append(summary);
    summaries.push(summary); blocks.push(block);
  }
  const waiting = children.get("child-c");
  waiting.rows.window[1].state = "completed";
  waiting.rows.window.push({ rowId: 3, turnId: "t1", kind: "toolCall", status: "running", inputText: "{}" });
  const leases = childStores(f.bridge, children);
  vm.runInContext(f.source, f.context);
  assert.equal(summaries[0].children[0].textContent, "— t/s");
  f.setNow(500); rows[1].text += "m".repeat(100); f.window.__ZSPEED_TICK__();
  assert.equal(summaries[2].children[0].textContent, "0.0 t/s");
  f.setNow(1000); rows[1].text += "m".repeat(100);
  children.get("child-a").rows.window[1].text += "a".repeat(80);
  children.get("child-b").rows.window[1].text += "b".repeat(45);
  f.window.__ZSPEED_TICK__();
  assert.equal(f.barFor(f.pane).children[1].textContent, "100.0");
  assert.deepEqual(summaries.map(summary => summary.children[0].textContent), ["80.0 t/s", "45.0 t/s", "0.0 t/s"]);
  assert.equal(summaries[0].children[0].getAttribute("data-speed-band"), "fast");
  assert.equal(summaries[1].children[0].getAttribute("data-speed-band"), "medium");
  rows[1].state = "completed";
  const finished = children.get("child-b");
  finished.control.phase = "completedSuccess";
  Object.assign(finished.rows.window[0], { state: "completedSuccess", outputTokens: 100, modelDurationMs: 2000 });
  subRows[1].status = "completed";
  f.setNow(1500); children.get("child-a").rows.window[1].text += "a".repeat(80); f.window.__ZSPEED_TICK__();
  assert.equal(f.barFor(f.pane).children[1].textContent, "0.0");
  assert.deepEqual(summaries.map(summary => summary.children[0].textContent), ["80.0 t/s", "50.0 t/s", "0.0 t/s"]);
  const oldBadge = summaries[0].children[0];
  summaries[0].remove();
  const replacement = new f.Element("div", { "data-testid": "v4-subagent-open-side-pane-child-a" });
  blocks[0].append(replacement);
  f.setNow(2000); children.get("child-a").rows.window[1].text += "a".repeat(80); f.window.__ZSPEED_TICK__();
  assert.equal(oldBadge.isConnected, false);
  assert.equal(replacement.children[0].textContent, "80.0 t/s");
  rows.splice(rows.indexOf(subRows[0]), 1);
  blocks[0].parentElement.remove();
  f.window.__ZSPEED_TICK__();
  assert.ok(leases.released.includes("child-a"));
  f.window.__ZSPEED_DISPOSE__();
  assert.equal(replacement.children.length, 0);
  assert.equal(summaries[1].children.length, 0);
  assert.deepEqual(leases.released, ["child-a", "child-b", "child-c"]);
});

test("A to B to A keeps independent live speeds while both conversations generate", () => {
  const f = rendererFixture();
  const other = addConversation(f, "s2").snapshot;
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

test("main and auxiliary chats run in parallel and keep their own bars after the main chat finishes", () => {
  const f = rendererFixture();
  const { snapshot: auxiliary, pane: auxiliaryPane } =
    addConversation(f, "child", "selection-side-chat:workspace:s1:child");
  vm.runInContext(f.source, f.context);
  const mainBar = f.barFor(f.pane), auxiliaryBar = f.barFor(auxiliaryPane);
  assert.ok(mainBar, "the main chat must own its bar");
  assert.ok(auxiliaryBar, "the auxiliary chat must own its bar");
  assert.notEqual(mainBar, auxiliaryBar);
  for (const now of [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]) {
    f.setNow(now);
    if (now < 3000) f.bridge.snapshot.rows.window[1].text += "a".repeat(100);
    else {
      f.bridge.snapshot.control.phase = "completedSuccess";
      Object.assign(f.bridge.snapshot.rows.window[0], { state: "completedSuccess", outputTokens: 100, modelDurationMs: 2000 });
    }
    auxiliary.rows.window[1].text += "b".repeat(200);
    f.document.activeElement = now % 1000 === 0 ? auxiliaryPane : f.pane;
    f.window.__ZSPEED_TICK__();
    assert.equal(mainBar.children[1].textContent, now < 3000 ? "100.0" : "50.0");
    assert.equal(auxiliaryBar.children[1].textContent, "200.0");
    assert.equal(f.barFor(f.pane), mainBar);
    assert.equal(f.barFor(auxiliaryPane), auxiliaryBar);
  }
});

test("an auxiliary chat can finish while the main chat keeps generating independently", () => {
  const f = rendererFixture();
  const { snapshot: auxiliary, pane: auxiliaryPane } =
    addConversation(f, "child", "selection-side-chat:workspace:s1:child");
  vm.runInContext(f.source, f.context);
  for (const now of [500, 1000, 1500, 2000]) {
    f.setNow(now);
    f.bridge.snapshot.rows.window[1].text += "a".repeat(100);
    if (now < 1500) auxiliary.rows.window[1].text += "b".repeat(200);
    else {
      auxiliary.control.phase = "completedSuccess";
      Object.assign(auxiliary.rows.window[0], { state: "completedSuccess", outputTokens: 100, modelDurationMs: 4000 });
    }
    f.document.activeElement = auxiliaryPane;
    f.window.__ZSPEED_TICK__();
    assert.equal(f.barFor(f.pane).children[1].textContent, "100.0");
    assert.equal(f.barFor(auxiliaryPane).children[1].textContent, now < 1500 ? "200.0" : "25.0");
  }
});

test("auxiliary bars follow tab visibility and closing without replacing the main bar", () => {
  const f = rendererFixture();
  const { snapshot: auxiliary, pane: auxiliaryPane } =
    addConversation(f, "child", "selection-side-chat:workspace:s1:child");
  vm.runInContext(f.source, f.context);
  const mainBar = f.barFor(f.pane), auxiliaryBar = f.barFor(auxiliaryPane);
  assert.ok(mainBar);
  assert.ok(auxiliaryBar);
  auxiliaryPane.hidden = true;
  f.setNow(500); auxiliary.rows.window[1].text += "b".repeat(200);
  f.window.__ZSPEED_TICK__();
  assert.equal(auxiliaryBar.isConnected, false);
  assert.equal(f.barFor(f.pane), mainBar);
  auxiliaryPane.hidden = false;
  f.setNow(1000); auxiliary.rows.window[1].text += "b".repeat(200);
  f.window.__ZSPEED_TICK__();
  assert.equal(f.barFor(auxiliaryPane).children[1].textContent, "200.0");
  auxiliaryPane.attributes["data-session-id"] = "unavailable-child";
  f.window.__ZSPEED_TICK__();
  assert.equal(f.barFor(auxiliaryPane).children[1].textContent, "—");
  auxiliaryPane.remove();
  f.window.__ZSPEED_TICK__();
  assert.equal(auxiliaryPane.children.length, 0);
  assert.equal(f.barFor(f.pane), mainBar);
  f.window.__ZSPEED_DISPOSE__();
  assert.equal(f.pane.children.length, 0);
  assert.equal(f.listeners.size, 0);
});

test("older bridges sample an auxiliary chat before it receives focus", () => {
  const f = rendererFixture();
  delete f.window.__ZSPEED_READ_ALL__;
  const { snapshot: auxiliary, pane: auxiliaryPane } =
    addConversation(f, "child", "selection-side-chat:workspace:s1:child");
  vm.runInContext(f.source, f.context);
  f.setNow(500);
  f.bridge.snapshot.rows.window[1].text += "a".repeat(100);
  auxiliary.rows.window[1].text += "b".repeat(200);
  f.window.__ZSPEED_TICK__();
  assert.equal(f.barFor(f.pane)?.children[1].textContent, "100.0");
  assert.equal(f.barFor(auxiliaryPane)?.children[1].textContent, "200.0");
});

test("replacing a renderer version disposes every conversation's old bar", () => {
  const f = rendererFixture();
  const auxiliaryPane = f.addPane("child", "selection-side-chat:workspace:s1:child");
  vm.runInContext(f.source, f.context);
  const oldMainBar = f.barFor(f.pane), oldAuxiliaryBar = f.barFor(auxiliaryPane);
  f.window.__ZSPEED_VERSION__ = "old-version";
  vm.runInContext(f.source, f.context);
  assert.equal(oldMainBar.isConnected, false);
  assert.equal(oldAuxiliaryBar.isConnected, false);
  assert.equal(f.pane.children.length, 1);
  assert.equal(auxiliaryPane.children.length, 1);
  assert.equal(f.listeners.size, 2);
  f.window.__ZSPEED_DISPOSE__();
  assert.equal(f.pane.children.length, 0);
  assert.equal(auxiliaryPane.children.length, 0);
  assert.equal(f.listeners.size, 0);
});

test("older bridges keep sampling previously visited conversations", () => {
  const f = rendererFixture();
  delete f.window.__ZSPEED_READ_ALL__;
  const other = addConversation(f, "s2").snapshot;
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
  vm.runInContext(fs.readFileSync(path.join(sourceDir, "inject-main.cjs"), "utf8"), context);
  context.module.exports.install();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  assert.equal(interval, 500);
  assert.equal(reads, 1);
  for (const time of [500, 1000, 1500, 2000]) {
    f.setNow(time); f.bridge.snapshot.rows.window[1].text += "a".repeat(100);
    callback(); await flush();
    assert.equal(f.barFor(f.pane).children[1].textContent, "100.0");
  }
  assert.equal(reads, 5);
  app.emit("before-quit");
  assert.equal(app.listenerCount("web-contents-created"), 0);
});
