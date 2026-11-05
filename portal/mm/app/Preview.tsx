"use client";

// PREVIEW face — the acceptance test. Renders the authored pack's building EXACTLY as the VRX
// DEVELOPER view shows it (: "the real test — what users see when the pack is imported"). Uses the
// PORTED real VRX components (StackingPlan proportional grid + Carousel) so Preview can't drift from truth.
//
// DEV VIEW FIRST: developer sees their OWN building — all units, full specs, stacking plan, images,
// terms. Agent view = a scoped subset (later). Live-chain bits are STUBBED here (status = all available,
// simple USD formatter) — Preview is static; it proves the DATA + LAYOUT, not the booking engine.
//
// A lean inline UnitDetail (specs + photos + terms summary) stands in for the heavy portal UnitDetail (which
// drags PaymentCalculator/Lightbox/SitePlanMap/freehold) — OWED: port the full interactive detail later.

import { useMemo, useState } from "react";
import type { PackApi } from "./usePack";
import { packToPreview, type PreviewImages, type PreviewModel, type PreviewUnit } from "@/lib/preview";
import { MIRACLE_TOWER_ID, MIRACLE_TOWER_IMAGES } from "@/lib/from-catalog";
import { StackingPlan } from "@/components/StackingPlan";
import Carousel from "@/components/Carousel";

const usd = (n: number) =>
  "$" + Math.round(n).toLocaleString("en-US");

/** Images for the previewed building. For the Miracle Tower demo we have the real set; otherwise none
 *  (the real pipeline will resolve pack.media[] here — OWED, tied to the ZIP round-trip). */
function imagesForBuilding(buildingId: string): PreviewImages {
  if (buildingId === MIRACLE_TOWER_ID) return MIRACLE_TOWER_IMAGES;
  return { exterior: [], interior: [], facilities: [], floorplans: [] };
}

export function Preview({ api }: { api: PackApi }) {
  // Which building to preview: the current selection if it's a building, else the first one.
  const selectedBuildingId =
    api.selection.kind === "building"
      ? api.selection.id
      : api.selection.kind === "units"
        ? api.selection.buildingId
        : api.pack.buildings[0]?.id;

  const [openUnitId, setOpenUnitId] = useState<string | null>(null);

  const model: PreviewModel | null = useMemo(() => {
    if (!selectedBuildingId) return null;
    return packToPreview(api.pack, selectedBuildingId, imagesForBuilding(selectedBuildingId));
  }, [api.pack, selectedBuildingId]);

  if (!model) {
    return (
      <div className="mm-preview">
        <div className="mm-empty">
          No building to preview yet. Add a building (Structured face) or load the demo — then this shows the
          exact VRX developer view.
        </div>
      </div>
    );
  }

  const { building, units, images } = model;
  // Preview stub: every unit reads "available" (status 0). No live chain here.
  const status = Object.fromEntries(units.map((u) => [u.id, 0]));
  const openUnit = openUnitId ? units.find((u) => u.id === openUnitId) || null : null;
  const available = units.length; // all available in preview

  return (
    <div className="mm-preview">
      <div className="mm-preview__banner">
        <span className="mm-preview__eye">👁</span>
        <span>
          <strong>Preview — VRX developer view.</strong> This is exactly what the developer sees once the pack
          is imported. All units show “available” (live availability comes from the chain in the real app).
        </span>
      </div>

      {openUnit ? (
        <UnitDetailLean building={building} unit={openUnit} images={images} onClose={() => setOpenUnitId(null)} />
      ) : (
        <>
          {/* Building header + hero gallery */}
          <div className="mm-preview__head">
            <div className="mm-preview__title">
              <h1>{building.name}</h1>
              {building.tagline && <p className="mm-preview__tagline">{building.tagline}</p>}
              <p className="mm-preview__meta">
                {[building.developer, building.area, building.address].filter(Boolean).join(" · ")}
              </p>
            </div>
          </div>

          {images.exterior.length > 0 && (
            <div className="mm-preview__hero">
              <Carousel images={images.exterior} alt={`${building.name} exterior`} aspectRatio="16 / 9" />
            </div>
          )}

          {/* Key specs */}
          <div className="mm-preview__specs">
            <Spec label="Type" value={building.type} />
            <Spec label="Stories" value={String(building.stories)} />
            <Spec label="Units" value={String(building.units)} />
            <Spec label="Available" value={String(available)} />
            {building.completion && <Spec label="Completion" value={building.completion} />}
            {building.reservationFeeUsd ? <Spec label="Reservation" value={usd(building.reservationFeeUsd)} /> : null}
          </div>

          {building.amenities.length > 0 && (
            <div className="mm-preview__amenities">
              {building.amenities.map((a) => (
                <span key={a} className="mm-preview__chip">{a}</span>
              ))}
            </div>
          )}

          {/* The stacking plan — the real VRX proportional grid (width ∝ m²). */}
          <div className="mm-card">
            <h3>Stacking plan ({units.length} units)</h3>
            <p style={{ color: "var(--ink-dim)", fontSize: 12, marginTop: -6 }}>
              Each box is a unit; width is proportional to its size (m²), top floor first — the real VRX grid.
              Click a unit to see its detail.
            </p>
            <StackingPlan
              units={units}
              status={status}
              formatPrice={usd}
              onOpen={(u) => setOpenUnitId(u.id)}
            />
          </div>

          {/* Facilities gallery */}
          {images.facilities.length > 0 && (
            <div className="mm-card">
              <h3>Facilities</h3>
              <Carousel images={images.facilities} alt={`${building.name} facilities`} aspectRatio="16 / 9" />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A lean read-only unit detail (specs + photos + published terms) — stands in for the heavy portal detail. */
function UnitDetailLean({
  building,
  unit,
  images,
  onClose,
}: {
  building: PreviewModel["building"];
  unit: PreviewUnit;
  images: PreviewImages;
  onClose: () => void;
}) {
  const unitLabel = unit.id.replace(/^unit-/, "Unit ");
  const pricePerSqm = Math.round(unit.priceUsd / Math.max(1, unit.sqm));
  // The unit gallery = interiors (+ floorplans at the end), same spirit as the real UnitDetail.
  const photos = [...images.interior, ...images.floorplans];

  return (
    <div className="mm-preview__detail">
      <button className="mm-btn" onClick={onClose} style={{ marginBottom: 14 }}>← Back to units</button>

      {photos.length > 0 && (
        <Carousel images={photos} alt={`${building.name} ${unitLabel}`} aspectRatio="3 / 2" fit="contain" />
      )}

      <div className="mm-preview__detail-head">
        <div>
          <div className="mm-preview__detail-title">{unitLabel}</div>
          <div className="mm-preview__detail-sub">
            {building.name} · {unit.subtype || unit.type?.toUpperCase()}
            {unit.view ? ` · ${unit.view}` : ""}
          </div>
        </div>
        <span className="mm-preview__status">● Available</span>
      </div>

      <div className="mm-preview__price">{usd(unit.priceUsd)}</div>

      <div className="mm-preview__specs" style={{ marginTop: 14 }}>
        <Spec label="Type" value={unit.subtype || unit.type?.toUpperCase()} />
        <Spec label="Size" value={`${unit.sqm} m²`} />
        <Spec label="Floor" value={unit.floor ? String(unit.floor) : "—"} />
        {unit.baths ? <Spec label="Baths" value={String(unit.baths)} /> : null}
        {unit.view ? <Spec label="View" value={unit.view} /> : null}
        {unit.corner ? <Spec label="Position" value="Corner" /> : null}
        <Spec label="Price / m²" value={usd(pricePerSqm)} />
      </div>

      {unit.note && <p style={{ fontSize: 14, color: "var(--ink-dim)", marginTop: 14, lineHeight: 1.5 }}>{unit.note}</p>}

      {building.terms && <TermsSummary terms={building.terms} reservationFeeUsd={building.reservationFeeUsd} />}
    </div>
  );
}

function TermsSummary({ terms, reservationFeeUsd }: { terms: Record<string, unknown>; reservationFeeUsd?: number }) {
  const first = (a: unknown): unknown => (Array.isArray(a) ? a[0] : a);
  const rows: Array<{ label: string; value: string }> = [];
  const bf = first(terms.bookingFee);
  if (typeof bf === "number") rows.push({ label: "Booking fee", value: usd(bf) });
  const dep = first(terms.depositPct);
  if (typeof dep === "number") rows.push({ label: "Deposit", value: `${dep}%` });
  const oc = first(terms.onContract) as { installments?: number; amountPct?: number } | undefined;
  if (oc?.amountPct != null) rows.push({ label: "On contract", value: `${oc.installments} × ${oc.amountPct}%` });
  const og = first(terms.ongoing) as { installments?: number; amountPct?: number } | undefined;
  if (og?.amountPct != null) rows.push({ label: "Instalments", value: `${og.installments} × ${og.amountPct}%` });
  const ok = first(terms.onKeyPct);
  if (typeof ok === "number") rows.push({ label: "On handover", value: `${ok}%` });
  if (reservationFeeUsd) rows.push({ label: "Reservation", value: usd(reservationFeeUsd) });
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-dim)", marginBottom: 8 }}>Payment plan</div>
      <div className="mm-preview__terms">
        {rows.map((r) => (
          <div key={r.label} className="mm-preview__term">
            <span>{r.label}</span>
            <strong>{r.value}</strong>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 11.5, color: "var(--ink-dim)", marginTop: 6 }}>
        Indicative plan published by the developer.
      </p>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className="mm-preview__spec">
      <div className="mm-preview__spec-label">{label}</div>
      <div className="mm-preview__spec-value">{value}</div>
    </div>
  );
}
