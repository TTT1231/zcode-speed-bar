/* zspeed-bridge:v1 begin */
// Summarize renderer stores without exposing message text or store objects.
// Snapshots also contain session identifiers, states and agent links.
;(() => {
  const registry = __ZSPEED_REGISTRY__;
  const generations = new WeakMap(), counts = new WeakMap(), childLeases = new Map();
  const MAX_CHILD_LEASES = 64;
  let nextGeneration = 0;
  function codePoints(text, from = 0) {
    let length = 0;
    for (let index = from; index < text.length; index++) {
      if ((text.charCodeAt(index) & 0xFC00) === 0xD800 &&
          (text.charCodeAt(index + 1) & 0xFC00) === 0xDC00) index++;
      length++;
    }
    return length;
  }
  function characters(row) {
    const text = row.kind === "assistantText" || row.kind === "reasoning" ? row.text
      : row.kind === "toolCall" ? row.inputText : "";
    if (typeof text !== "string") return 0;
    const cached = counts.get(row);
    if (cached && cached.text === text) return cached.length;
    const previous = cached && cached.text;
    let length;
    // Streaming appends dominate; count only the new tail instead of rescanning the text.
    if (previous && text.length > previous.length && text.startsWith(previous) &&
        (previous.charCodeAt(previous.length - 1) & 0xFC00) !== 0xD800) {
      length = cached.length + codePoints(text, previous.length);
    } else {
      length = codePoints(text);
    }
    counts.set(row, { text, length });
    return length;
  }
  const sole = (list, match) => {
    const found = list.filter(match);
    return found.length === 1 ? found[0] : null;
  };
  function agentLinks(rows) {
    const calls = rows.filter(row => row.kind === "toolCall" &&
      typeof row.toolCallId === "string" && typeof row.turnId === "string");
    const children = rows.filter(row => row.kind === "subagent" &&
      typeof row.childSessionId === "string" && row.childSessionId && typeof row.turnId === "string");
    const links = calls.map(row => ({ rowId: row.rowId, toolCallId: row.toolCallId }));
    const claimed = new Set();
    // Exact parent-ID matching needs no tool name: the host writes parentToolCallId itself.
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const sameCall = calls.filter(row => row.turnId === call.turnId && row.toolCallId === call.toolCallId);
      const child = sole(children, row => row.turnId === call.turnId && row.parentToolCallId === call.toolCallId);
      if (sameCall.length === 1 && child &&
          sole(children, row => row.childSessionId === child.childSessionId) === child) {
        links[i].childSessionId = child.childSessionId;
        links[i].status = child.status;
        claimed.add(child);
      }
    }
    // Match ZCode's unambiguous single-agent fallback when no parent ID was supplied.
    // The heuristic guesses, so it stays restricted to the tools known to spawn agents.
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (links[i].childSessionId) continue;
      if (!["Agent", "Task", "subagent"].includes(call.toolName)) continue;
      const unlinked = calls.filter((row, index) => row.turnId === call.turnId && !links[index].childSessionId);
      const orphan = sole(children, row => row.turnId === call.turnId && !row.parentToolCallId && !claimed.has(row));
      const conflicting = children.some(row => row.turnId === call.turnId && row.parentToolCallId === call.toolCallId);
      if (!conflicting && unlinked.length === 1 && orphan &&
          sole(children, row => row.childSessionId === orphan.childSessionId) === orphan) {
        links[i].childSessionId = orphan.childSessionId;
        links[i].status = orphan.status;
        claimed.add(orphan);
      }
    }
    return links;
  }
  function releaseChildren() {
    for (const children of childLeases.values()) for (const lease of children.values()) {
      try { lease.release(); } catch (_) { /* The host may already have disposed its layer. */ }
    }
    childLeases.clear();
  }
  function syncChildren(stores) {
    const requested = new Map();
    for (const { layer, state, snapshot, agents } of stores) {
      if (state.projectionReady === false || (state.status && state.status !== "live")) continue;
      for (const agent of agents) {
        const sid = agent.childSessionId;
        if (!sid || sid === snapshot.sessionId) continue;
        const running = agent.status === "running";
        if (!running && !childLeases.get(layer)?.has(sid)) continue;
        let children = requested.get(layer);
        if (!children) requested.set(layer, children = new Map());
        children.set(sid, running || children.get(sid) === true);
      }
    }
    // Prefer active agents over retained completed ones when the limit is reached.
    const selected = new Map();
    let remaining = MAX_CHILD_LEASES;
    for (const running of [true, false]) for (const [layer, children] of requested) {
      for (const [sid, active] of children) {
        if (active !== running || remaining === 0) continue;
        let wanted = selected.get(layer);
        if (!wanted) selected.set(layer, wanted = new Set());
        wanted.add(sid);
        remaining--;
      }
    }
    for (const [layer, children] of childLeases) {
      for (const [sid, lease] of children) if (!selected.get(layer)?.has(sid)) {
        try { lease.release(); } catch (_) { /* The layer can close independently. */ }
        children.delete(sid);
      }
      if (!children.size) childLeases.delete(layer);
    }
    for (const [layer, children] of selected) for (const sid of children) {
      if (childLeases.get(layer)?.has(sid) || typeof layer.acquire !== "function") continue;
      try {
        // Use the host's session lease to observe a child even when its pane is closed.
        const lease = layer.acquire(sid);
        let held = childLeases.get(layer);
        if (!held) childLeases.set(layer, held = new Map());
        held.set(sid, lease);
      } catch (_) { /* An unavailable child remains unmeasured. */ }
    }
  }
  function readAll() {
    const found = new Map(), stores = new Map(), ambiguous = new Set();
    const live = [], seenLayers = new Set();
    for (const entry of registry.values()) {
      const layer = entry && entry.layer;
      if (!layer || layer.disposed || entry.stale || seenLayers.has(layer)) continue;
      seenLayers.add(layer);
      for (const session of Array.from(layer.entries.values())) {
        const store = session && session.store;
        if (!store || store.closed) continue;
        const state = store.getState();
        const snapshot = state?.snapshot;
        if (!snapshot || typeof snapshot.sessionId !== "string" || !Array.isArray(snapshot.rows?.window)) continue;
        const agents = agentLinks(snapshot.rows.window);
        live.push({ layer, store, state, snapshot, agents });
      }
    }
    syncChildren(live);
    for (const { store, state, snapshot, agents } of live) {
      const sid = snapshot.sessionId;
      if (ambiguous.has(sid)) continue;
      if (stores.has(sid)) {
        if (stores.get(sid) !== store) { found.delete(sid); ambiguous.add(sid); }
        continue;
      }
      stores.set(sid, store);
      if (!generations.has(store)) generations.set(store, ++nextGeneration);
      found.set(sid, {
        sessionId: snapshot.sessionId, epoch: snapshot.logEpoch, seq: snapshot.seq,
        generation: generations.get(store), phase: snapshot.control?.phase,
        connectionGeneration: store.generation, status: state.status, projectionReady: state.projectionReady,
        agents, rows: snapshot.rows.window.map(row => ({
          id: row.rowId, turnId: row.productTurnId || row.turnId, kind: row.kind,
          chars: characters(row), state: row.state,
          status: row.kind === "toolCall" ? row.status : undefined,
          backgrounded: row.kind === "toolCall" ? row.backgrounded : undefined,
          outputTokens: row.kind === "turnHeader" ? row.outputTokens : undefined,
          modelDurationMs: row.kind === "turnHeader" ? row.modelDurationMs : undefined
        }))
      });
    }
    return Array.from(found.values());
  }
  if (typeof globalThis.__ZSPEED_RELEASE_CHILDREN__ === "function") globalThis.__ZSPEED_RELEASE_CHILDREN__();
  globalThis.__ZSPEED_RELEASE_CHILDREN__ = releaseChildren;
  globalThis.__ZSPEED_READ_ALL__ = readAll;
  globalThis.__ZSPEED_READ__ = function (sid) {
    return readAll().find(snapshot => snapshot.sessionId === sid) || null;
  };
})();
/* zspeed-bridge:v1 end */
