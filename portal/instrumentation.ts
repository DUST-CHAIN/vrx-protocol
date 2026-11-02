// Next.js server bootstrap (runs ONCE when the server process starts — the official seam for background
// work). We use it to optionally start the availability indexer poller (Slice 3, INDEXER_DESIGN.md).
// DELIBERATELY, never by default — on the free FastNEAR keys an always-on loop is exactly the kind of load
// we want to enable on purpose (the Coolify box, or a dev explicitly testing it), not every `npm run dev`.
// Set VRX_INDEXER=1 to enable. Off → the module + its tested logic still ship; only the live loop is idle.
// Node runtime only (the poller uses crypto/timers) — guarded by NEXT_RUNTIME so the edge runtime skips it.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.VRX_INDEXER !== "1") return;

  // Dynamic import: keep these server-only modules out of any edge/client bundle, and only load them when
  // the poller is actually enabled.
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
