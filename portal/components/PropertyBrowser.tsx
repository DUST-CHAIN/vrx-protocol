"use client";

// PropertyBrowser — a READ-ONLY property browse (cards → summary + grid), scoped to a set of
// building ids. Used by the agency view (see what your agents can offer) and reusable anywhere a
// read-only look at availability is wanted. No booking/stamp actions — purely informational. Status is
// served from the snapshot (instant); tapping a unit or floor loads its live status on demand.

import { useState } from "react";
import BuildingCards from "@/components/BuildingCards";
import { BuildingSummaryBlock, FloorAvailabilityList } from "@/components/BuildingSummary";
import { StackingPlan } from "@/components/StackingPlan";
import LoadingUnits from "@/components/LoadingUnits";
import { useBuildingStatus } from "@/lib/useBuildingStatus";
import { hideOffMarketInStatus } from "@/lib/offmarket";
import { useMoney } from "@/lib/currency";
import { card, submitBtn } from "@/lib/ui";
import SitePlanMap from "@/components/SitePlanMap";

export default function PropertyBrowser({
  filterIds,
  heading = "Properties",
  /** Security Pass #3 — the agency/agent VIEWER account, so the scoped catalog reads server-side
   *  resolve this agency's gated buildings. god-mode (localnet) returns all regardless. */
  account,
}: {
  filterIds?: string[] | null;
  heading?: string;
  account?: string | null;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (openId) {
    return (
      <section style={card}>
        <button
          type="button"
          onClick={() => setOpenId(null)}
          style={{ ...submitBtn, padding: "5px 11px", fontSize: 13, background: "#18202f", color: "#c7cde0", marginBottom: 14 }}
        >
          ← All properties
        </button>
        <ReadOnlyBuilding buildingId={openId} account={account} />
      </section>
    );
  }

  return (
    <section style={card}>
      <BuildingCards heading={heading} filterIds={filterIds} account={account} onOpen={(id) => setOpenId(id)} />
    </section>
  );
}

function ReadOnlyBuilding({ buildingId, account }: { buildingId: string; account?: string | null }) {
  const money = useMoney();
  // Same shared snapshot-first + per-floor tap-to-load pattern as the developer/agent apps —
  // read-only here (no stamp/book), just browse. The hook seeds from the snapshot instantly.
  const bs = useBuildingStatus(buildingId, account);

  if (!bs.data) return <LoadingUnits />;
  const { building } = bs.data;
  // Off-market units are developer-only — hide them from this buyer-facing read-only view by
  // forcing them "unavailable" in the status map (they can't be booked; the reason stays with the dev).
  const status = hideOffMarketInStatus(building.inventory, bs.status);
  // KILLED units (regulatory removal) don't exist for an agency — strip them entirely (like a pricelist
  // that simply omits them). BLOCKED units stay but read unavailable (see the agent view for the rationale).
  const visibleInventory = building.inventory.filter((u) => u.offMarket?.state !== "killed");

  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 2 }}>{building.name}</div>
      <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 12 }}>
        {building.area} · {building.stories} floors
      </div>
      <BuildingSummaryBlock building={building} status={status} money={money} />
      {/* Location + access roads — hidden when the developer hasn't set a location (absent-safe). */}
      {building.geo && (
        <div style={{ margin: "14px 0" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>📍 Location & access</div>
          <SitePlanMap geo={building.geo} height={220} />
        </div>
      )}
      <StackingPlan
        units={visibleInventory}
        status={status}
        formatPrice={money}
        isFloorReady={bs.isFloorReady}
        isFloorFresh={bs.isFloorFresh}
        onLoadFloor={(f) => void bs.loadFloor(f)}
        onSelect={(u) => void bs.ensureUnitStatus(u.id)}
      />
      <FloorAvailabilityList building={building} status={status} />
    </div>
  );
}
