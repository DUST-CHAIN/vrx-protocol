"use client";

// Shared building-load + status hook — the ONE place the developer, agent, and agency apps get their
// snapshot-first, per-floor-tap-to-load browsing behaviour. Extracted from the developer app
// full-building chunk-walk on every mount (re-fetching all ~200 units when you switched buildings and
// back, and bursting the RPC — the freeze from). Centralising it here means the three apps CAN'T
// drift and all get the same fix.
// The behaviour (identical to what /node shipped):
// • loadBuilding seeds the grid from the persisted SNAPSHOT in one call → known floors paint
// INSTANTLY, zero per-unit RPC reads on browse.
// • NO auto-fill: we never bulk-poll every unit. Floors within the staleness pref show straight from
// the snapshot; stale/unknown floors show a "tap to load latest" overlay and read ONLY on tap.
// • loadFloor(floor) reads just that floor's units on demand and marks it loaded (stays shown).
// • ensureUnitStatus(id) reads a single unit (when the user opens/selects it).
// • Live mode bakes the full fresh on-chain map (slower, authoritative) — opt-in.
// • refreshStatus busts the server cache and reloads.
// Every read is served from the shared server cache/snapshot, so it stays gentle on the RPC.
// PRIVACY: unchanged — the server derives opaque unit_keys; only hashes touch the chain.

import { useCallback, useEffect, useState } from "react";
import {
  fetchBuilding,
  fetchUnitsStatus,
  invalidateBuildingStatus,
  type Building,
  type BuildingImages,
} from "./catalog-client";
import { usePrefs } from "./prefs";
import { DEMO_MODE_FLAG } from "./dev-signer-fence";
import type { UnitStatus } from "@/components/StackingPlan";

export type BuildingData = {
  building: Building;
  images?: BuildingImages | null;
  snapshot?: { units: Record<string, number>; filledAt: number; unitAt?: Record<string, number> } | null;
};

export type UseBuildingStatus = {
  /** The loaded building + images, or null while loading / on error. */
  data: BuildingData | null;
  /** unitId → status code (0 open · 1 hold · 2 closed · 3 done · -1 not stamped/unknown). */
  status: UnitStatus;
  /** True while the initial building/snapshot load is in flight (drives the skeleton). */
  loading: boolean;
  /** True while a per-floor (or single-unit) live read is in flight (drives the small spinner). */
  filling: boolean;
  /** Set when the RPC was unreachable and we're serving the snapshot (UI: "network busy, as of …"). */
  busy: { asOf: number | null } | null;
  /** Live mode on? (full fresh bake vs snapshot-first lazy). */
  live: boolean;
  setLive: (v: boolean) => void;
  /** Show this floor's real status without a tap? (fresh snapshot OR live OR user already loaded it). */
  isFloorReady: (floor: number) => boolean;
  /** Did the USER explicitly load this floor this session? (drives the "just refreshed" green border). */
  isFloorFresh: (floor: number) => boolean;
  /** Load one floor's live status on demand (the tap-to-load action). */
  loadFloor: (floor: number) => Promise<void>;
  /** Ensure a single unit's status is loaded now (on select/open). Returns the freshly-read code. */
  ensureUnitStatus: (unitId: string) => Promise<number>;
  /** When THIS unit's status was last verified (epoch ms), or null if unknown. Per-unit freshness so the
   * UI can show "verified X ago" on the clicked unit instead of a building-wide time. */
  unitVerifiedAt: (unitId: string) => number | null;
  /** Bust the server cache + reload (Live: re-bake fresh; lazy: re-seed from latest snapshot). */
  refreshStatus: () => Promise<void>;
  /** Re-fetch the building's CATALOG (not on-chain status) so off-chain edits — off-market state, price
   * updates — show immediately, without disturbing the status snapshot. */
  reloadBuilding: () => Promise<void>;
  /** A NEWER snapshot is available on the server (filledAt advanced past what we're showing) — the
   * non-disruptive "status update available" signal. null = nothing newer. The UI shows a
   * dismissible prompt; the user chooses to apply (reload) or ignore (keep viewing/booking). */
  update: { at: number } | null;
  /** Apply the pending update (re-seed from the newer snapshot). Clears `update`. */
  applyUpdate: () => Promise<void>;
  /** Dismiss the pending update without reloading (keep working). */
  dismissUpdate: () => void;
};

/**
 * Snapshot-first building loader shared by all browsing apps. Resets + reloads whenever `buildingId`
 * or the Live toggle changes. Pass an empty `buildingId` when nothing is selected (returns idle state).
 */
export function useBuildingStatus(buildingId: string, account?: string | null): UseBuildingStatus {
  const [data, setData] = useState<BuildingData | null>(null);
  const [status, setStatus] = useState<UnitStatus>({});
  const [loading, setLoading] = useState(false);
  const [filling, setFilling] = useState(false);
  const [busy, setBusy] = useState<{ asOf: number | null } | null>(null);
  const [live, setLive] = useState(false);
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  const [loadedFloors, setLoadedFloors] = useState<Set<number>>(new Set());
  const [update, setUpdate] = useState<{ at: number } | null>(null);
  // Per-unit verified-at: unitId → epoch ms. Seeded from the snapshot's unitAt; a live read of a unit or
  // floor stamps it "now". null-fallback to the building snapshot time keeps old snapshots working.
  const [unitAt, setUnitAt] = useState<Record<string, number>>({});
  const { prefs } = usePrefs();

  const loadBuilding = useCallback(
    async (opts: { live?: boolean; fresh?: boolean } = {}) => {
      if (!buildingId) return;
      setLoading(true);
      try {
        const d = await fetchBuilding(buildingId, { ...opts, account });
        setData(d);
        const seeded: UnitStatus = {};
        // Live mode bakes status onto inventory; lazy mode carries the snapshot map.
        for (const u of d.building.inventory) if (u.status !== undefined) seeded[u.id] = u.status;
        if (d.snapshot) for (const [id, s] of Object.entries(d.snapshot.units)) seeded[id] = s;
        setStatus(seeded);
        setSnapshotAt(d.snapshot?.filledAt ?? (opts.live ? Date.now() : null));
        // Seed per-unit freshness from the snapshot (or, in Live mode, treat the whole bake as "now").
        if (opts.live) {
          const nowAt: Record<string, number> = {};
          for (const u of d.building.inventory) nowAt[u.id] = Date.now();
          setUnitAt(nowAt);
        } else {
          setUnitAt({ ...(d.snapshot?.unitAt ?? {}) });
        }
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [buildingId, account]
  );

  const loadFloor = useCallback(
    async (floor: number) => {
      if (!data) return;
      const ids = data.building.inventory.filter((u) => u.floor === floor).map((u) => u.id);
      if (ids.length === 0) return;
      setFilling(true);
      try {
        // A floor-tap is an EXPLICIT "show me this floor's latest" — force a fresh chain read so a unit
        // the snapshot already knows (e.g. one the developer just stamped) reflects the truth, not the
        // sticky snapshot value. Bounded to this floor's units, so it stays gentle on the RPC.
        const { status: got, busy: rpcBusy, asOf, source } = await fetchUnitsStatus(buildingId, ids, true, account);
        setStatus((prev) => {
          const next = { ...prev };
          for (const id of ids) if (got[id] !== undefined) next[id] = got[id];
          return next;
        });
        if (rpcBusy) setBusy({ asOf });
        // Stamp per-unit freshness only for units actually verified against the chain (not snapshot-served).
        if (source === "chain") {
          const now = Date.now();
          setUnitAt((prev) => {
            const next = { ...prev };
            for (const id of ids) if (got[id] !== undefined) next[id] = now;
            return next;
          });
        }
        setLoadedFloors((prev) => new Set(prev).add(floor));
      } finally {
        setFilling(false);
      }
    },
    [data, buildingId, account]
  );

  const ensureUnitStatus = useCallback(
    async (unitId: string): Promise<number> => {
      // DEMO MODE (NEXT_PUBLIC_VRX_DEMO=1): the seeded world's on-chain stamps are STUBBED — never
      // chain read of a seed unit returns -1 "not listed" even though the OFF-CHAIN snapshot (what the grid
      // paints from) correctly shows it open. That split made a GREEN tile open to a "not available" detail
      // same source the grid used) and skip the clobbering chain read. The live probe stays ON for real /
      // localnet, where a fresh per-unit chain read is the right "verify this one now" behaviour.
      if (DEMO_MODE_FLAG) {
        return await new Promise<number>((resolve) => {
          setStatus((prev) => {
            resolve(prev[unitId] ?? -1);
            return prev; // no change — the snapshot already holds the demo truth
          });
        });
      }
      // Selecting a unit is an explicit "verify this one now" — force a fresh chain read, so a
      // just-stamped unit shows its real status rather than the sticky snapshot value.
      const { status: got, source } = await fetchUnitsStatus(buildingId, [unitId], true, account);
      const code = got[unitId] ?? -1;
      setStatus((prev) => ({ ...prev, [unitId]: code }));
      // A clicked unit read live against the chain is "verified now" — the freshest signal we can show.
      if (source === "chain") setUnitAt((prev) => ({ ...prev, [unitId]: Date.now() }));
      return code;
    },
    [buildingId, account]
  );

  const refreshStatus = useCallback(async () => {
    await invalidateBuildingStatus(buildingId);
    // Remember which floors the user had open — a Refresh should return them FRESH, not blank them back
    // to the snapshot. (In Live mode the whole building is re-baked, so this is moot.)
    const wasLoaded = live ? [] : [...loadedFloors];
    setLoadedFloors(new Set());
    await loadBuilding({ live, fresh: live });
    // Force a real chain re-read of the floors that were open, overwriting any sticky snapshot value —
    // this is what makes the developer's own just-stamped units finally show as available on Refresh.
    for (const f of wasLoaded) await loadFloor(f);
  }, [buildingId, live, loadBuilding, loadFloor, loadedFloors]);

  const staleMs = prefs.staleMinutes * 60_000;
  const snapshotFresh = snapshotAt !== null && Date.now() - snapshotAt < staleMs;
  const isFloorReady = useCallback(
    (floor: number) => live || snapshotFresh || loadedFloors.has(floor),
    [live, snapshotFresh, loadedFloors]
  );
  const isFloorFresh = useCallback((floor: number) => loadedFloors.has(floor), [loadedFloors]);
  // Per-unit verified-at: the unit's own timestamp if we have one, else fall back to the building
  // snapshot time (old snapshots / units never individually read), else null.
  const unitVerifiedAt = useCallback(
    (unitId: string): number | null => unitAt[unitId] ?? snapshotAt ?? null,
    [unitAt, snapshotAt]
  );

  // Reset + reload whenever the building or Live toggle changes. (No auto-fill: floors paint from the
  // snapshot instantly; stale/unknown floors load on tap — this is what stops the RPC stampede.)
  useEffect(() => {
    setData(null);
    setStatus({});
    setBusy(null);
    setLoadedFloors(new Set());
    setUpdate(null);
    setUnitAt({});
    if (buildingId) void loadBuilding({ live });
  }, [buildingId, live, loadBuilding]);

  // background (prioritize-on-open). Here we POLL the snapshot's filledAt cheaply — /api/catalog is
  // snapshot-served (NO chain read, so this is safe to poll) — and if it advanced past what we're
  // showing, raise `update`. The UI shows a dismissible prompt; we NEVER auto-reload mid-action.
  useEffect(() => {
    if (!buildingId || !data) return;
    let cancelled = false;
    const POLL_MS = 30_000;
    const t = setInterval(async () => {
      try {
        const d = await fetchBuilding(buildingId, { account }); // lazy → snapshot only, no chain read
        const newAt = d.snapshot?.filledAt ?? null;
        if (!cancelled && newAt && snapshotAt && newAt > snapshotAt) {
          setUpdate({ at: newAt });
        }
      } catch {
        /* ignore poll errors — best-effort freshness */
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [buildingId, data, snapshotAt, account]);

  const applyUpdate = useCallback(async () => {
    setUpdate(null);
    await loadBuilding({ live });
  }, [loadBuilding, live]);

  const dismissUpdate = useCallback(() => setUpdate(null), []);

  return {
    data,
    status,
    loading,
    filling,
    busy,
    live,
    setLive,
    isFloorReady,
    isFloorFresh,
    loadFloor,
    ensureUnitStatus,
    unitVerifiedAt,
    refreshStatus,
    reloadBuilding: () => loadBuilding({ live }),
    update,
    applyUpdate,
    dismissUpdate,
  };
}
