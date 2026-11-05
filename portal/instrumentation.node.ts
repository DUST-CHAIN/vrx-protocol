// Node-only instrumentation body (split). Next.js compiles instrumentation.ts for BOTH the edge AND
// node runtimes; even a dynamic import inside a NEXT_RUNTIME guard still gets its dependency graph traced
// for the edge bundle — so importing lib/catalog → status-cache → rpc-usage (which uses `fs`/`path`) from
// instrumentation.ts broke the production build with "Module not found: Can't resolve 'fs'" in the edge
// variant (the indexer regression). The fix (Next's own documented pattern): keep the Node-only
// graph in THIS separate module and import it only from the `NEXT_RUNTIME === 'nodejs'` branch, so webpack
// never traces it for edge. This file is only ever loaded in the Node server process.

export async function registerNode() {
  // Seller auto-responder — independent of the indexer. Self-gates on VRX_AUTORESPONDER inside
  // ensureResponder (OFF by default), and is seed-safe + chain-stubbed, so starting it here is inert unless
  // deliberately armed. Started FIRST so it runs even when the indexer is off.
  const { ensureResponder, isArmed } = await import("./lib/seller-autoresponder");
  ensureResponder();
  if (isArmed()) console.log("[vrx][autoresponder] seller desk auto-responder started (VRX_AUTORESPONDER=1)");

  if (process.env.VRX_INDEXER !== "1") return;

  const { startPoller } = await import("./lib/indexer-poller");
  const { getCatalog } = await import("./lib/catalog");
  const { getBuildingStatus } = await import("./lib/status-cache");

  startPoller({
    // Walk every catalog building (id + its unit ids). The catalog is the authoritative list of what
    // exists — we never enumerate the chain blindly (INDEXER_DESIGN §view surface).
    listBuildings: async () => {
      const catalog = await getCatalog();
      return catalog.map((b) => ({ id: b.id, unitIds: b.inventory.map((u) => u.id) }));
    },
    // Poll one building = a FORCED status read: reads the chain + persists into the snapshot (via
    // status-cache → status-store), applying the Slice-1 effective-status derive. force=true so we
    // refresh even units the snapshot already "knows" — that's the whole point of the background loop.
    pollBuilding: async (id, unitIds) => {
      const { status } = await getBuildingStatus(id, unitIds, true);
      return status;
    },
    now: () => Date.now(),
    onPoll: (id, changed, cadenceMs) => {
      if (changed) console.log(`[vrx][indexer] ${id} changed → cadence ${Math.round(cadenceMs / 1000)}s`);
    },
  });
  console.log("[vrx][indexer] background availability poller started (VRX_INDEXER=1)");
}
