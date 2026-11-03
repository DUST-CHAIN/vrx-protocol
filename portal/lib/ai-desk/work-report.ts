// AI Sales Director — the WORK REPORT (slice 5b, the design docs §6). SERVER-ONLY. The
// DEVELOPER-facing read-model over the deal sidecars: "here is what your automated desk is working on" — per
// deal, where it stands (phase), which unit, the deadline (a live hold's auto-release), when it's expected to
// close, and the AI's own running summary. A read-model only: it READS the sidecar store + the developer
// registry and SHAPES them; it never mutates. This is the AI reporting to its boss.
//
// Privacy: a developer sees only THEIR OWN buildings' deals (scoped by the registry buildingIds). The
// summary is the AI's PII-free prose about the deal shape. No buyer identity, no cross-developer leakage.

import { getDeveloper } from "../developers";
import { sidecarsForBuildings, type DealSidecar } from "./deal-sidecar";

/** One line of the work report — a deal, reduced to what the developer needs to glance at. */
export type WorkReportItem = {
  dealId: string;
  buildingId: string;
  /** buyer | agent — who the desk is dealing with. */
  counterparty: "buyer" | "agent";
  /** Plain-words stage (from the phase). */
  stage: string;
  /** The unit in focus / held, if any. */
  unitId?: string;
  /** True if a unit is actively HELD (vs merely in focus). */
  held: boolean;
  /** The live hold's auto-release deadline (ms epoch), if a hold is active. */
  deadlineAt?: number;
  /** When the AI expects this to close (ms epoch), if it has formed a view. */
  expectedCloseAt?: number;
  /** The AI's running summary (its own words; PII-free). */
  summary: string;
  /** Last activity (ms epoch) — the report sorts newest-first. */
  updatedAt: number;
};

export type WorkReport = {
  developer: string;
  /** Deals in progress, newest-first. */
  items: WorkReportItem[];
  /** Quick counts for a header chip. */
  totals: { active: number; held: number };
};

/** Map a phase to a developer-facing plain-words stage. */
function stageOf(phase: DealSidecar["phase"]): string {
  switch (phase) {
    case "browse": return "Browsing inventory";
    case "qualify": return "Qualifying the buyer";
    case "negotiate": return "Negotiating terms";
    case "book": return "Booking a unit";
    case "deposit": return "Awaiting deposit";
    case "aftercare": return "Post-deposit";
    default: return "In progress";
  }
}

function toItem(s: DealSidecar): WorkReportItem {
  const held = !!s.heldUnitId;
  return {
    dealId: s.dealId,
    buildingId: s.buildingId,
    counterparty: s.counterparty,
    stage: stageOf(s.phase),
    unitId: s.heldUnitId ?? s.focusUnitId,
    held,
    ...(held && typeof s.releaseAt === "number" ? { deadlineAt: s.releaseAt } : {}),
    ...(typeof s.expectedCloseAt === "number" ? { expectedCloseAt: s.expectedCloseAt } : {}),
    summary: s.summary,
    updatedAt: s.updatedAt,
  };
}

/**
 * The work report for ONE developer — their buildings' live deals, reduced + scoped to them. Returns an empty
 * report (not null) for an unknown developer or one with no buildings/deals, so a caller can always render it.
 */
export async function developerWorkReport(developer: string): Promise<WorkReport> {
  const dev = await getDeveloper(developer);
  const buildingIds = dev?.buildingIds ?? [];
  if (buildingIds.length === 0) return { developer, items: [], totals: { active: 0, held: 0 } };

  const sidecars = await sidecarsForBuildings(buildingIds); // already newest-first
  const items = sidecars.map(toItem);
  return {
    developer,
    items,
    totals: { active: items.length, held: items.filter((i) => i.held).length },
  };
}
