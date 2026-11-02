/* zspeed-bridge:v1 begin */
// Appended inside the verified renderer module by repair-speed.py. Only numeric
// row summaries cross this bridge; host stores and message text remain private.
;(() => {
  const registry = __ZSPEED_REGISTRY__;
  const generations = new WeakMap(), counts = new WeakMap();
  let nextGeneration = 0;
  function characters(row) {
    const text = row.kind === "assistantText" || row.kind === "reasoning" ? row.text
      : row.kind === "toolCall" ? row.inputText : "";
    if (typeof text !== "string") return 0;
    const cached = counts.get(row);
    if (cached && cached.text === text) return cached.length;
    let length = 0;
    for (const _character of text) length++;
    counts.set(row, { text, length });
    return length;
  }
  function readAll() {
    const found = new Map(), stores = new Map(), ambiguous = new Set();
    for (const entry of registry.values()) {
      const layer = entry && entry.layer;
      if (!layer || layer.disposed || entry.stale) continue;
      for (const session of layer.entries.values()) {
        const store = session && session.store;
        if (!store || store.closed) continue;
        const state = store.getState();
        const snapshot = state?.snapshot;
        if (!snapshot || typeof snapshot.sessionId !== "string" || !Array.isArray(snapshot.rows?.window)) continue;
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
          rows: snapshot.rows.window.map(row => ({
            id: row.rowId, turnId: row.productTurnId || row.turnId, kind: row.kind,
            chars: characters(row), state: row.state,
            status: row.kind === "toolCall" ? row.status : undefined,
            backgrounded: row.kind === "toolCall" ? row.backgrounded : undefined,
            outputTokens: row.kind === "turnHeader" ? row.outputTokens : undefined,
            modelDurationMs: row.kind === "turnHeader" ? row.modelDurationMs : undefined
          }))
        });
      }
    }
    return Array.from(found.values());
  }
  globalThis.__ZSPEED_READ_ALL__ = readAll;
  globalThis.__ZSPEED_READ__ = function (sid) {
    return readAll().find(snapshot => snapshot.sessionId === sid) || null;
  };
})();
/* zspeed-bridge:v1 end */
