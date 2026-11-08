/* ZCode speed only, renderer-store edition (3.17.1).
 * Electron main-process clock: every 500ms, independent of DB writes.
 * Live: a 2s rolling window of assistant/reasoning/tool-input characters.
 * Finished: outputTokens / modelDurationMs from the host's turn summary.
 * Each available conversation is sampled in the background, including inactive tabs.
 * Main and auxiliary conversations each display a bar inside their own pane.
 * Bars drag horizontally inside their pane; main and side keep their own in-memory offsets.
 * repair-speed.cjs installs the small read-only bridge after a ZCode upgrade.
 * Reference: ByteRax/zcode-token-usage-statusbar, renderer bridge for 3.17.1.
 */
"use strict";
const VERSION = "store-speed-10";
const REFRESH_MS = 500;

// Self-contained: the same calculation runs in Electron and regression tests.
function createSpeedMeter(singleStream = false) {
  if (!singleStream) {
    // Sampling follows the stores. Changing the visible pane only selects a result.
    const streams = new Map(), active = new Map();
    function update(snapshot, now) {
      if (!snapshot || !Array.isArray(snapshot.rows)) {
        for (const entry of streams.values()) entry.meter.suspend();
        return { mode: "unavailable", tps: null };
      }
      const key = JSON.stringify([snapshot.sessionId, snapshot.epoch, snapshot.generation, snapshot.connectionGeneration]);
      const entry = streams.get(key) || { sid: snapshot.sessionId, meter: createSpeedMeter(true) };
      streams.delete(key);
      entry.at = now;
      const result = entry.meter.update(snapshot, now);
      streams.set(key, entry);
      for (const [oldKey, old] of streams) if (now - old.at > 60000) streams.delete(oldKey);
      while (streams.size > 128) streams.delete(streams.keys().next().value);
      return result;
    }
    function sampleAll(snapshots, now) {
      active.clear();
      const unique = new Map();
      for (const snapshot of snapshots) {
        if (!snapshot || typeof snapshot.sessionId !== "string" || !Array.isArray(snapshot.rows)) continue;
        if (unique.has(snapshot.sessionId)) unique.set(snapshot.sessionId, null);
        else unique.set(snapshot.sessionId, snapshot);
      }
      for (const [sid, snapshot] of unique) if (snapshot) active.set(sid, update(snapshot, now));
    }
    return {
      update, sampleAll,
      get: sid => active.get(sid) || { sessionId: sid || "", mode: "unavailable", tps: null },
      sessionIds: () => [...new Set(Array.from(streams.values(), entry => entry.sid))],
      reset() { streams.clear(); active.clear(); }
    };
  }
  const WINDOW_MS = 2000;
  const terminal = new Set(["completedSuccess", "completedInterrupted", "failed", "error"]);
  let identity = "", turnId = "", cpt = 2;
  let lengths = new Map(), total = 0, samples = [], header = null;
  let completeText = false, calibrated = false, lastFinal = null, lastEstimate = null;
  let observedGrowth = false, lastObserved = null;
  function suspend() { samples = []; observedGrowth = false; lastObserved = null; }
  function reset() {
    identity = ""; turnId = ""; cpt = 2; lengths.clear(); total = 0;
    header = null; completeText = false; calibrated = false;
    lastFinal = lastEstimate = null;
    suspend();
  }
  function update(snapshot, now) {
    if (!snapshot || !Array.isArray(snapshot.rows)) { reset(); return { mode: "unavailable", tps: null }; }
    const nextIdentity = JSON.stringify([snapshot.sessionId, snapshot.epoch, snapshot.generation]);
    if (nextIdentity !== identity) { reset(); identity = nextIdentity; }
    if (snapshot.projectionReady === false || (snapshot.status && snapshot.status !== "live")) {
      suspend();
      return { sessionId: snapshot.sessionId, mode: "loading", tps: null };
    }
    if (lastObserved !== null && now - lastObserved > WINDOW_MS) suspend();
    lastObserved = now;
    const rows = snapshot.rows;
    const latest = rows[rows.length - 1];
    const nextTurn = latest && latest.turnId;
    if (!nextTurn) return { mode: "idle", tps: null, sessionId: snapshot.sessionId };
    const ownRows = rows.filter(row => row.turnId === nextTurn);
    const currentHeader = ownRows.find(row => row.kind === "turnHeader");
    if (nextTurn !== turnId) {
      turnId = nextTurn; lengths.clear(); total = 0; samples = []; header = null;
      completeText = !!currentHeader; calibrated = false; lastEstimate = null;
      observedGrowth = false;
    }
    if (currentHeader) {
      header = currentHeader;
      if (total === 0) completeText = true;
    }
    let rewritten = false;
    for (const row of ownRows) {
      if (!Number.isSafeInteger(row.id) || !Number.isFinite(row.chars) || row.chars < 0) continue;
      const previous = lengths.get(row.id) || 0;
      if (row.chars < previous) rewritten = true;
      total += row.chars - previous;
      lengths.set(row.id, row.chars);
    }
    // Keep text that slid out of the host's 60-row tail window in the total.
    if (lengths.size > 2048) {
      const visible = new Set(ownRows.map(row => row.id));
      for (const id of lengths.keys()) if (!visible.has(id)) lengths.delete(id);
    }
    if (rewritten) { samples = []; completeText = false; observedGrowth = false; }
    samples.push({ at: now, chars: total });
    while (samples.length > 2 && samples[1].at <= now - WINDOW_MS) samples.shift();
    const running = snapshot.phase === "running" || snapshot.phase === "prewarming" ||
      (!terminal.has(snapshot.phase) && header && !terminal.has(header.state));
    const result = { sessionId: snapshot.sessionId, turnId, est: false };
    if (running) {
      // A foreground tool may take minutes while its turn remains "running".
      // Once input streaming has stopped, the previous model rate is no longer
      // current. Keep a fresh baseline so it cannot leak into the next request.
      const outputStreaming = ownRows.some(row =>
        ((row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming") ||
        (row.kind === "toolCall" && row.status === "inputStreaming"));
      const waitingForTool = !outputStreaming && ownRows.some(row => row.kind === "toolCall" &&
        row.backgrounded !== true && (row.status === "running" || row.status === "pendingApproval"));
      if (waitingForTool) {
        samples = [{ at: now, chars: total }];
        observedGrowth = true;
        return { ...result, mode: "live", est: true, tps: 0 };
      }
      const first = samples[0], elapsed = now - first.at;
      if (total > first.chars) observedGrowth = true;
      if (elapsed < 200 || (!observedGrowth && elapsed < WINDOW_MS)) {
        return { ...result, mode: "warming", est: true, tps: null };
      }
      const rate = Math.max(0, total - first.chars) * 1000 / elapsed / cpt;
      if (rate > 0) lastEstimate = rate;
      return { ...result, mode: "live", est: true, tps: rate };
    }
    const tokens = header && header.outputTokens, ms = header && header.modelDurationMs;
    if (header && terminal.has(header.state) && Number.isFinite(tokens) && tokens > 0 &&
        Number.isFinite(ms) && ms >= 200 && ms < 3600000) {
      lastFinal = tokens * 1000 / ms;
      if (!calibrated && completeText && total > 0) {
        cpt = Math.min(8, Math.max(0.5, total / tokens));
        calibrated = true;
      }
      return { ...result, mode: "final", tps: lastFinal };
    }
    if (lastEstimate !== null) return { ...result, mode: "last-estimate", est: true, tps: lastEstimate };
    return { ...result, mode: "idle", tps: lastFinal };
  }
  return { update, reset, suspend };
}

function rendererMain(makeMeter, version) {
  if (window.__ZSPEED_VERSION__ === version && window.__ZSPEED_TICK__) return window.__ZSPEED_TICK__();
  if (typeof window.__ZSPEED_DISPOSE__ === "function") window.__ZSPEED_DISPOSE__();
  window.__ZSPEED_VERSION__ = version;
  const meter = makeMeter();
  const bars = new Map(), agentBars = new Map();
  let lastPane = null;
  // Offsets are memory-only; drop keys written by older storage-backed builds.
  try {
    const storage = window.localStorage;
    if (storage) { storage.removeItem("zspeed-bar-offset"); storage.removeItem("zspeed-bar-offsets"); }
  } catch (_) {}
  const offsets = new Map();
  function offsetLimit(bar, pane) {
    try {
      const paneWidth = pane.getBoundingClientRect().width;
      const barWidth = bar.getBoundingClientRect().width;
      return Number.isFinite(paneWidth) && Number.isFinite(barWidth) && paneWidth > 0 && barWidth > 0
        ? Math.max(0, paneWidth / 2 - barWidth / 2 - 8) : null;
    } catch (_) { return null; }
  }
  function roleOf(pane) {
    return pane.getAttribute("data-testid") === "v4-session-pane-workspace-main" ? "main" : "side";
  }
  function applyOffset(bar, pane) {
    const raw = offsets.get(roleOf(pane)) || 0;
    // A zero offset is always inside the limit; skip the layout reads.
    const limit = raw === 0 ? 0 : offsetLimit(bar, pane);
    const x = limit === null ? raw : Math.max(-limit, Math.min(limit, raw));
    bar.style.transform = "translateX(calc(-50% + " + x + "px))";
  }
  function attachDrag(bar, pane) {
    bar.addEventListener("pointerdown", event => {
      if (event.isPrimary === false) return;
      event.preventDefault();
      event.stopPropagation();
      const role = roleOf(pane);
      const startX = event.clientX, startOffset = offsets.get(role) || 0;
      try { bar.setPointerCapture(event.pointerId); } catch (_) {}
      const move = e => {
        e.stopPropagation();
        const limit = offsetLimit(bar, pane);
        const next = startOffset + (e.clientX - startX);
        offsets.set(role, limit === null ? next : Math.max(-limit, Math.min(limit, next)));
        applyOffset(bar, pane);
      };
      const finish = e => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", finish);
        bar.removeEventListener("pointercancel", finish);
        try { bar.releasePointerCapture(event.pointerId); } catch (_) {}
        if (e && typeof e.stopPropagation === "function") e.stopPropagation();
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", finish);
      bar.addEventListener("pointercancel", finish);
    });
    bar.addEventListener("click", e => e.stopPropagation());
    bar.addEventListener("dblclick", e => {
      e.preventDefault();
      e.stopPropagation();
      offsets.delete(roleOf(pane));
      applyOffset(bar, pane);
    });
  }
  function visible(pane) {
    if (!pane || !pane.isConnected || !pane.getClientRects().length) return false;
    const rect = pane.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function paneOf(element) {
    return element && typeof element.closest === "function"
      ? element.closest('[data-testid^="v4-session-pane-"][data-session-id]') : null;
  }
  function rememberPane(event) {
    const pane = paneOf(event.target);
    if (visible(pane)) lastPane = pane;
  }
  function pickPane(panes) {
    const focused = paneOf(document.activeElement);
    if (panes.includes(focused)) return focused;
    if (panes.includes(lastPane)) return lastPane;
    return panes.find(pane => pane.getAttribute("data-testid") === "v4-session-pane-workspace-main") || panes[0] || null;
  }
  function ensure(pane) {
    const existing = bars.get(pane);
    if (existing && existing.bar.isConnected) return existing;
    const bar = document.createElement("div");
    bar.className = "zusage-speed-mini";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "off");
    bar.setAttribute("aria-atomic", "true");
    bar.style.cssText = "position:absolute;left:50%;transform:translateX(-50%);bottom:8px;z-index:2147483000;"
      + "display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;"
      + "box-sizing:border-box;border:1px solid var(--zs-border);"
      + "font:600 12px/16px var(--font-mono,ui-monospace,Consolas,monospace);"
      + "background:var(--zs-surface);color:var(--zs-text);box-shadow:var(--zs-shadow);"
      + "touch-action:none;user-select:none;white-space:nowrap;font-variant-numeric:tabular-nums;";
    const style = document.createElement("style");
    style.textContent = ".zusage-speed-mini,.zspeed-agent-mini{--zs-surface:#fff;--zs-text:#202834;--zs-muted:#616b79;"
      + "--zs-border:rgba(27,37,51,.13);--zs-shadow:0 1px 4px rgba(20,30,45,.08);"
      + "--zs-fast:#087b53;--zs-medium:#896008;--zs-slow:#b73d36}"
      + '.zusage-speed-mini[data-zspeed-theme="dark"],.zspeed-agent-mini[data-zspeed-theme="dark"]{--zs-surface:#27292e;--zs-text:#f0f2f5;'
      + "--zs-muted:#adb4c0;--zs-border:rgba(220,227,238,.14);--zs-shadow:0 1px 4px rgba(0,0,0,.14);"
      + "--zs-fast:#56d6a2;--zs-medium:#ebbf63;--zs-slow:#ff988e}"
      + ".zusage-speed-mini [data-tps]{min-width:5ch;text-align:right;transition:color 160ms ease}"
      + '.zusage-speed-mini[data-speed-band="fast"] [data-tps]{color:var(--zs-fast)}'
      + '.zusage-speed-mini[data-speed-band="medium"] [data-tps]{color:var(--zs-medium)}'
      + '.zusage-speed-mini[data-speed-band="slow"] [data-tps]{color:var(--zs-slow)}'
      + '.zspeed-agent-mini[data-speed-band="fast"]{color:var(--zs-fast)}'
      + '.zspeed-agent-mini[data-speed-band="medium"]{color:var(--zs-medium)}'
      + '.zspeed-agent-mini[data-speed-band="slow"]{color:var(--zs-slow)}'
      + ".zusage-speed-mini [data-speed-icon]{display:block;flex:none;width:12px;height:12px;color:var(--zs-muted)}"
      + ".zusage-speed-mini [data-speed-unit]{font:400 11px/16px system-ui,sans-serif;color:var(--zs-muted);margin-left:-2px}"
      + "@media(prefers-reduced-motion:reduce){.zusage-speed-mini [data-tps]{transition:none}}";
    const bolt = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    bolt.setAttribute("data-speed-icon", "");
    bolt.setAttribute("viewBox", "0 0 24 24");
    bolt.setAttribute("fill", "none");
    bolt.setAttribute("stroke", "currentColor");
    bolt.setAttribute("stroke-width", "1.8");
    bolt.setAttribute("stroke-linecap", "round");
    bolt.setAttribute("stroke-linejoin", "round");
    bolt.setAttribute("aria-hidden", "true");
    const glyph = document.createElementNS("http://www.w3.org/2000/svg", "path");
    glyph.setAttribute("d", "M13 3 4 14h7l-1 7 10-12h-7l1-6Z");
    bolt.appendChild(glyph);
    const value = document.createElement("span"); value.textContent = "—";
    value.setAttribute("data-tps", "");
    const unit = document.createElement("span"); unit.textContent = "t/s";
    unit.setAttribute("data-speed-unit", "");
    bar.append(bolt, value, unit, style);
    pane.appendChild(bar);
    attachDrag(bar, pane);
    applyOffset(bar, pane);
    const entry = { bar, value, signature: "" };
    bars.set(pane, entry);
    return entry;
  }
  function speedInfo(result) {
    const tps = Number.isFinite(result.tps) && result.tps >= 0 ? result.tps : null;
    const label = tps === null ? "—" : tps.toFixed(1);
    return { tps, label,
      band: tps === null || tps === 0 ? "idle" : tps >= 70 ? "fast" : tps >= 40 ? "medium" : "slow",
      title: tps === null ? "正在采样生成速度" : result.est ? "实时估算速度 · 每 0.5 秒刷新" : "最近完成一轮的生成速度",
      aria: tps === null ? "正在采样生成速度" : (result.est ? "生成速度约 " : "生成速度 ") + label + " token/s" };
  }
  function ensureAgent(summary) {
    const old = agentBars.get(summary);
    if (old && old.isConnected && old.parentElement === summary) return old;
    if (old) old.remove();
    const badge = document.createElement("span");
    badge.className = "zspeed-agent-mini";
    badge.setAttribute("role", "status");
    badge.setAttribute("aria-live", "off");
    badge.style.cssText = "display:inline-block;flex:none;white-space:nowrap;pointer-events:none;user-select:none;"
      + "font:600 .9em/1.4 var(--font-mono,ui-monospace,Consolas,monospace);font-variant-numeric:tabular-nums;"
      + "color:var(--zs-muted)";
    summary.appendChild(badge);
    agentBars.set(summary, badge);
    return badge;
  }
  function showAgents(pane, snapshot, theme, seen) {
    if (!snapshot || !Array.isArray(snapshot.agents)) return;
    const ready = snapshot.projectionReady !== false && (!snapshot.status || snapshot.status === "live");
    const byRow = new Map();
    for (const agent of snapshot.agents) {
      const key = JSON.stringify([String(agent.rowId), agent.toolCallId]);
      byRow.set(key, byRow.has(key) ? null : agent);
    }
    if (!byRow.size) return;  // Without agents even scanning tool blocks is wasted work.
    for (const block of pane.querySelectorAll('[data-tool-call-id][data-tool-name]')) {
      if (paneOf(block) !== pane) continue;
      const row = block.closest('[data-row-id]');
      const agent = row && byRow.get(JSON.stringify([row.getAttribute("data-row-id"), block.getAttribute("data-tool-call-id")]));
      if (!agent) continue;
      const summary = Array.from(block.querySelectorAll('[data-testid^="tool-summary-trigger-"], [data-testid^="v4-subagent-open-side-pane-"]'))
        .find(element => element.closest('[data-tool-call-id]') === block);
      if (!summary) continue;
      seen.add(summary);
      const badge = ensureAgent(summary);
      const result = ready ? meter.get(agent.childSessionId) : { tps: null };
      const info = speedInfo(result);
      // Band colors come from the shared stylesheet; skip writes while unchanged.
      const signature = [theme, info.band, info.label, result.est].join(":");
      if (badge.__zspeed === signature) continue;
      badge.__zspeed = signature;
      badge.textContent = info.label + " t/s";
      badge.setAttribute("data-speed-band", info.band);
      badge.setAttribute("data-zspeed-theme", theme);
      badge.title = info.title;
      badge.setAttribute("aria-label", info.aria);
    }
  }
  function tick() {
    const panes = Array.from(document.querySelectorAll('[data-testid^="v4-session-pane-"][data-session-id]')).filter(visible);
    const pane = pickPane(panes);
    const sid = pane && pane.getAttribute("data-session-id");
    const hasBridge = typeof window.__ZSPEED_READ__ === "function";
    let snapshots = [];
    if (typeof window.__ZSPEED_READ_ALL__ === "function") snapshots = window.__ZSPEED_READ_ALL__();
    else if (hasBridge) {
      // An older bridge can still keep previously visited conversations warm.
      const known = new Set(meter.sessionIds());
      for (const pane of panes) {
        const sessionId = pane.getAttribute("data-session-id");
        if (sessionId && sessionId !== "draft") known.add(sessionId);
      }
      snapshots = Array.from(known, sessionId => window.__ZSPEED_READ__(sessionId)).filter(Boolean);
    }
    meter.sampleAll(snapshots, performance.now());
    const bySession = new Map();
    for (const snapshot of snapshots) if (snapshot && typeof snapshot.sessionId === "string") {
      bySession.set(snapshot.sessionId, bySession.has(snapshot.sessionId) ? null : snapshot);
    }
    for (const [pane, entry] of bars) {
      if (!panes.includes(pane)) { entry.bar.remove(); bars.delete(pane); }
    }
    const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
    const seenAgents = new Set();
    for (const pane of panes) {
      const result = meter.get(pane.getAttribute("data-session-id"));
      const entry = ensure(pane), { bar, value } = entry;
      applyOffset(bar, pane);
      bar.setAttribute("data-zspeed-theme", theme);
      const info = speedInfo(result);
      const next = info.label + ":" + result.mode;
      if (next !== entry.signature) {
        entry.signature = next;
        value.textContent = info.label;
        bar.setAttribute("data-speed-band", info.band);
        bar.title = info.title + " · 可左右拖动，双击复位";
        bar.setAttribute("aria-label", info.aria);
      }
      showAgents(pane, bySession.get(pane.getAttribute("data-session-id")), theme, seenAgents);
    }
    for (const [summary, badge] of agentBars) if (!seenAgents.has(summary)) {
      badge.remove(); agentBars.delete(summary);
    }
    // Keep the existing diagnostic status focused on the selected conversation.
    return { ...meter.get(sid), bridge: hasBridge, tickAt: Date.now() };
  }
  document.addEventListener("pointerdown", rememberPane, true);
  document.addEventListener("focusin", rememberPane, true);
  window.__ZSPEED_TICK__ = tick;
  window.__ZSPEED_DISPOSE__ = function () {
    document.removeEventListener("pointerdown", rememberPane, true);
    document.removeEventListener("focusin", rememberPane, true);
    for (const entry of bars.values()) entry.bar.remove();
    for (const badge of agentBars.values()) badge.remove();
    bars.clear();
    agentBars.clear();
    lastPane = null;
    meter.reset();
    if (typeof window.__ZSPEED_RELEASE_CHILDREN__ === "function") window.__ZSPEED_RELEASE_CHILDREN__();
    delete window.__ZSPEED_TICK__; delete window.__ZSPEED_DISPOSE__;
    delete window.__ZSPEED_VERSION__;
  };
  return tick();
}

// Built once here so the regression tests exercise the exact injected payload.
function rendererSource() {
  return "(" + rendererMain.toString() + ")(" + createSpeedMeter.toString() + "," + JSON.stringify(VERSION) + ")";
}

function install() {
  if (globalThis.__ZSPEED_LOADED__ === VERSION) return;
  if (typeof globalThis.__ZSPEED_MAIN_DISPOSE__ === "function") globalThis.__ZSPEED_MAIN_DISPOSE__();
  globalThis.__ZSPEED_LOADED__ = VERSION;
  const electron = require("electron");
  const fs = require("fs");
  const path = require("path");
  const { fileURLToPath } = require("url");
  const source = rendererSource();
  // Constant per install(); rebuilding it every tick would churn ~15KB of strings.
  const js = "window.__ZSPEED_VERSION__ === " + JSON.stringify(VERSION)
    + " && typeof window.__ZSPEED_TICK__ === 'function' ? window.__ZSPEED_TICK__() : " + source;
  const hooks = new Map(), pending = new Map(), states = new Map();
  let lastStatus = 0, lastError = "", stopped = false;
  function log(message) {
    fs.appendFile(path.join(__dirname, "debug.log"), "[" + new Date().toISOString() + "] " + message + "\n", () => {});
  }
  function injectable(wc) {
    try {
      if (wc.isDestroyed() || wc.getType() !== "window" || !wc.getURL().startsWith("file:")) return false;
      const relative = path.relative(process.resourcesPath, fileURLToPath(wc.getURL()));
      return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
    } catch (_) { return false; }
  }
  function tickWindow(wc) {
    if (stopped || !injectable(wc)) return;
    const now = Date.now();
    if (pending.has(wc.id) && now - pending.get(wc.id) < 2000) return;
    pending.set(wc.id, now);
    Promise.resolve().then(() => wc.executeJavaScript(js, false)).then(state => {
      if (state) states.set(wc.id, state);
    }).catch(error => {
      if (error.message !== lastError) { lastError = error.message; log("renderer: " + lastError); }
    }).finally(() => { if (pending.get(wc.id) === now) pending.delete(wc.id); });
  }
  function hook(wc) {
    if (hooks.has(wc)) return;
    const refresh = () => tickWindow(wc);
    const closed = () => { hooks.delete(wc); pending.delete(wc.id); states.delete(wc.id); };
    hooks.set(wc, { refresh, closed });
    wc.on("dom-ready", refresh); wc.on("did-finish-load", refresh); wc.once("destroyed", closed);
    tickWindow(wc);
  }
  const created = (_event, wc) => hook(wc);
  electron.app.on("web-contents-created", created);
  for (const wc of electron.webContents.getAllWebContents()) hook(wc);
  const timer = setInterval(() => {
    for (const wc of electron.webContents.getAllWebContents()) tickWindow(wc);
    if (Date.now() - lastStatus >= 5000) {
      lastStatus = Date.now();
      const status = { version: VERSION, pid: process.pid, intervalMs: REFRESH_MS, updatedAt: lastStatus,
        windows: Array.from(states, ([id, state]) => ({ id, ...state })) };
      fs.writeFile(path.join(__dirname, "status.json"), JSON.stringify(status, null, 2), () => {});
    }
  }, REFRESH_MS);
  timer.unref();
  function dispose() {
    if (stopped) return;
    stopped = true; clearInterval(timer);
    electron.app.removeListener("web-contents-created", created);
    electron.app.removeListener("before-quit", dispose);
    for (const [wc, handlers] of hooks) {
      wc.removeListener("dom-ready", handlers.refresh); wc.removeListener("did-finish-load", handlers.refresh);
      wc.removeListener("destroyed", handlers.closed);
    }
    hooks.clear(); pending.clear(); states.clear();
    delete globalThis.__ZSPEED_LOADED__; delete globalThis.__ZSPEED_MAIN_DISPOSE__;
  }
  globalThis.__ZSPEED_MAIN_DISPOSE__ = dispose;
  electron.app.on("before-quit", dispose);
  log("loaded " + VERSION + " pid=" + process.pid + " refresh=" + REFRESH_MS + "ms source=renderer-store");
}

module.exports = { createSpeedMeter, rendererMain, rendererSource, install, VERSION, REFRESH_MS };
if (process.versions.electron && process.type === "browser") install();
