// Readiness / completeness report — an ADVISORY sweep of "what you haven't filled in yet", distinct
// from validate.ts (which flags what makes the EXPORTED pack schema-INVALID). A pack can be a perfectly valid export
// while still being incomplete (no images, no payment plan attached, blank developer fields, a floor with no units).
// This powers the right-pane completeness list so the author sees the holes at a glance — with a deep-link target so
// clicking one jumps the editor there. PURE + testable (no browser).

import type { Pack } from "./pack";
import { mediaCoverage } from "./media";

/** A jump target that mirrors the Rail's Selection shape (kept loose to avoid importing the app layer). */
export type ReadinessTarget =
  | { kind: "developer" }
  | { kind: "building"; id: string }
  | { kind: "units"; buildingId: string }
  | { kind: "terms"; id: string };

export interface ReadinessItem {
  /** "info" = nice-to-have, "attention" = likely wanted before handing to buyers (never blocks export — law #2). */
  level: "attention" | "info";
  label: string;        // short human line, e.g. "3 of 12 image slots filled"
  detail?: string;      // optional extra context
  target?: ReadinessTarget; // where clicking it should jump the editor
}

export interface ReadinessReport {
  items: ReadinessItem[];
  /** headline counts for the gauge: how many holes of each level. */
  counts: { attention: number; info: number };
}

/** Sweep the pack for unfilled / incomplete things. PURE. */
export function buildReadiness(pack: Pack): ReadinessReport {
  const items: ReadinessItem[] = [];

  // ── developer identity ──
  if (!pack.developer.name || pack.developer.name === "New Developer")
    items.push({ level: "attention", label: "Developer name not set", target: { kind: "developer" } });
  if (!pack.developer.holdingCompany)
    items.push({ level: "info", label: "No holding company", detail: "optional — the legal entity behind the developer", target: { kind: "developer" } });
  if (!pack.developer.nearAccount)
    items.push({ level: "info", label: "No NEAR account on the developer", detail: "optional — the on-chain VRX account", target: { kind: "developer" } });

  // ── per-building completeness ──
  for (const b of pack.buildings) {
    const where = { kind: "building" as const, id: b.id };
    const units = pack.buildingUnits[b.id] || [];
    const sellable = units.length;

    if (sellable === 0)
      items.push({ level: "attention", label: `${b.name}: no units placed yet`, detail: "paint the unit grid to add inventory", target: { kind: "units", buildingId: b.id } });

    // a FLOOR with no sellable unit (a gap in the stack — maybe intended, maybe a miss)
    const floorsWithUnits = new Set(units.map((u) => u.floor));
    const emptyFloors: number[] = [];
    for (let f = 1; f <= (b.stories || 0); f++) if (!floorsWithUnits.has(f)) emptyFloors.push(f);
    if (emptyFloors.length && sellable > 0)
      items.push({
        level: "info",
        label: `${b.name}: ${emptyFloors.length} floor${emptyFloors.length > 1 ? "s" : ""} with no units`,
        detail: `floor${emptyFloors.length > 1 ? "s" : ""} ${emptyFloors.slice(0, 8).join(", ")}${emptyFloors.length > 8 ? "…" : ""} — fine if intended (plant/amenity), otherwise paint them`,
        target: { kind: "units", buildingId: b.id },
      });

    // units missing a PRICE or SIZE (a half-filled cell)
    const noPrice = units.filter((u) => !(u.priceUsd > 0)).length;
    if (noPrice) items.push({ level: "attention", label: `${b.name}: ${noPrice} unit${noPrice > 1 ? "s" : ""} with no price`, target: { kind: "units", buildingId: b.id } });
    const noSqm = units.filter((u) => !(u.sqm > 0)).length;
    if (noSqm) items.push({ level: "attention", label: `${b.name}: ${noSqm} unit${noSqm > 1 ? "s" : ""} with no size (m²)`, target: { kind: "units", buildingId: b.id } });

    // no payment plan attached to the building
    if (!b.termsRef)
      items.push({ level: "attention", label: `${b.name}: no payment plan attached`, detail: "pick one under Fees & charges", target: where });

    // fees unset (soft — a presale usually has these)
    if (b.reservationFeeUsd == null && b.bookingDepositUsd == null)
      items.push({ level: "info", label: `${b.name}: reservation fee & booking deposit not set`, target: where });
  }

  // ── terms blocks that nothing references (orphan plans) ──
  const referenced = new Set(pack.buildings.map((b) => b.termsRef).filter(Boolean) as string[]);
  for (const t of pack.terms)
    if (!referenced.has(t.id))
      items.push({ level: "info", label: `Payment plan "${t.id}" is not used by any building`, target: { kind: "terms", id: t.id } });

  // ── images ──
  const media = mediaCoverage(pack);
  if (media.total > 0 && media.filled < media.total) {
    const missing = media.total - media.filled;
    // group empties by building so the line is actionable
    const byBuilding = new Map<string, number>();
    for (const s of media.empty) byBuilding.set(s.buildingId, (byBuilding.get(s.buildingId) || 0) + 1);
    const firstB = pack.buildings[0];
    items.push({
      level: "info",
      label: `${missing} of ${media.total} image slots empty`,
      detail: "empty slots export a labelled placeholder — fine to ship, but a real image is better",
      target: firstB ? { kind: "building", id: firstB.id } : undefined,
    });
  }

  // ── a sanity line when a building has zero units but the project otherwise looks set up ──
  if (pack.buildings.length === 0)
    items.push({ level: "attention", label: "No buildings yet", detail: "add a building to start", target: { kind: "developer" } });

  const counts = {
    attention: items.filter((i) => i.level === "attention").length,
    info: items.filter((i) => i.level === "info").length,
  };
  return { items, counts };
}
