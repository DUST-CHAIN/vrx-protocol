"use client";

// Unit-detail screen (A3) — the double-click target on the stacking-plan grid. Shows the unit's
// photos (carousel), full specs, effective payment terms, and a reserve action. Built as the CONTAINER
// the A4 payment-plan offer form will slot into next (the `footer` slot), so the flow becomes
// browse → open unit → see detail + terms → make an offer, all in one place (the pilot's offer/[id]).
//
// Read-only + presentational: it renders catalog data (off-chain) + the unit's live status; the actual
// booking write stays in the parent (/agent submit). VOCAB: the words, no contract jargon.

import { useState, useEffect } from "react";
import { useMoney } from "@/lib/currency";
import { displayPriceUsd } from "@/lib/price-rounding";
import Carousel from "@/components/Carousel";
import Lightbox from "@/components/Lightbox";
import PaymentCalculator, { type AssembledPlan } from "@/components/PaymentCalculator";
import { effectiveTerms, timeAgo, currentSqm, areaTrueUp, type Building, type Unit, type BuildingImages } from "@/lib/catalog-client";
import { priceForBuyer, bookableForBuyer, BUYER_TYPE_LABEL, type BuyerType, type FreeholdQuota } from "@/lib/freehold";
import { floorPlansFor } from "@/lib/floorplans";
import SitePlanMap from "@/components/SitePlanMap";

const STATUS_LABEL: Record<number, { text: string; color: string }> = {
  0: { text: "Available", color: "#38d39f" },
  1: { text: "On hold", color: "#ffb454" },
  2: { text: "Reserved", color: "#7aa2ff" },
  3: { text: "Sold", color: "#7aa2ff" },
};

export default function UnitDetail({
  building,
  unit,
  images,
  status,
  verifiedAt,
  buyerType = null,
  quota = null,
  onClose,
  onReserve,
  onPlanChange,
}: {
  building: Building;
  unit: Unit;
  images: BuildingImages | null;
  status: number | undefined;
  verifiedAt: number | null;
  /** Chosen buyer type — drives the price shown + eligibility. null = no quota / not chosen. */
  buyerType?: BuyerType | null;
  /** The building's freehold quota; null = building has no quota. */
  quota?: FreeholdQuota | null;
  onClose: () => void;
  /** Called when the agent wants to reserve THIS unit (parent selects it + shows the offer flow). */
  onReserve?: () => void;
  /** The assembled payment plan (A4) whenever the customer changes it — parent hashes it into open_claim. */
  onPlanChange?: (plan: AssembledPlan) => void;
}) {
  const money = useMoney();
  const terms = effectiveTerms(building, unit);
  const st = status ?? -1;
  const badge = STATUS_LABEL[st] ?? { text: "Not listed", color: "#6a7288" };
  const open = st === 0;
  const [tab, setTab] = useState<"overview" | "plan" | "floorplan" | "site">("overview");
  // Buyer-aware price: freehold vs company differ. Falls back to headline price with no buyer.
  const shownPrice = buyerType ? priceForBuyer(unit, buyerType) : unit.priceUsd;
  const areaSqm = currentSqm(unit.sqmStages, unit.sqm);
  const pricePerSqm = Math.round(shownPrice / Math.max(1, areaSqm));
  // Area true-up at transfer — computable once the final (Land-Office) m² is set.
  const trueUp = areaTrueUp(unit, pricePerSqm);
  const quotaOn = !!quota?.enabled;
  // Freehold quota block: a foreign-freehold buyer can't take a unit that would breach the cap.
  const quotaBlocked = quotaOn && !!quota && buyerType === "freehold" && !bookableForBuyer(unit, "freehold", quota);
  const canReserve = open && !quotaBlocked;

  // Per-unit floor plans: the unit floor plan (by type+subtype) then the level plan (by floor).
  const plans = floorPlansFor(building.id, unit);

  // Site-plan map (layer 3): the unit's OWN location if it has one (villa/townhouse/plot),
  // else the building's. Absent-safe — no location set → no Site plan tab. Renders the richer SitePlanMap
  // (land/footprint polygons + orientation) read-only, same map the developer authors and the agent sees.
  const siteGeo = unit.geo ?? building.geo;

  // TWO galleries: the MAIN view = the actual unit renderings (interior + exterior) WITH the
  // floor plans at the end — these belong together. The building FACILITIES (lobby/gym/pool) are kept
  // SEPARATE and only shown when the "Facilities" button is pressed (they'd otherwise dilute the unit).
  // The "Floor plan" button jumps to the first plan WITHIN the main view. Filenames carry only a category
  // (r_int-/r_fac-), not a room name, so we label by category, not "Gym" vs "Lobby" — honest with the data.
  // Keep each gallery SMALL (: ~6 images, not 30-40). MAIN = a few unit INTERIORS + this unit's
  // FLOOR PLANS. FACILITIES = a few building EXTERIORS + FACILITIES (lobby/gym/pool). The big inherited
  // complex sets are trimmed hard so the reel stays scannable (6 + 6, not a huge dotted strip).
  const unitPhotos = (images?.interior ?? []).slice(0, 5);
  // ONLY this unit's plans (its type plan + its own floor's level plan, from floorPlansFor). Do NOT add
  // images.floorplans — that bucket holds EVERY level of the building (: unit 2704 showed all
  // floors, not just 27). floorPlansFor already resolves the right ones.
  const planUrls = plans.map((p) => p.url);
  const mainPhotos = [...unitPhotos, ...planUrls];
  const firstPlanIndex = planUrls.length ? unitPhotos.length : -1; // where the plans start in the main reel
  const facilityPhotos = [...(images?.exterior ?? []).slice(0, 2), ...(images?.facilities ?? []).slice(0, 5)].slice(0, 6);

  type GalleryKey = "main" | "facilities";
  const [gal, setGal] = useState<GalleryKey>("main");
  const [carouselIndex, setCarouselIndex] = useState(0);
  // The full-screen lightbox (: tap an image to pop it out). null = closed.
  const [lightbox, setLightbox] = useState<number | null>(null);

  // Graceful fallback: a unit with no interiors AND no plans falls back to the building/facilities set in
  // the main view, so it's never an empty "No photos".
  const mainImages = mainPhotos.length ? mainPhotos : facilityPhotos;
  const active =
    gal === "facilities"
      ? { images: facilityPhotos, label: "Building & facilities" }
      : {
          images: mainImages,
          label:
            mainPhotos.length && firstPlanIndex >= 0 && carouselIndex >= firstPlanIndex
              ? "Floor plan"
              : mainPhotos.length
              ? "Unit view"
              : "Building & facilities",
        };
  const switchGallery = (k: GalleryKey) => {
    setGal(k);
    setCarouselIndex(0);
  };

  const unitLabel = unit.id.replace(/^unit-/, "Unit ");

  return (
    <div className="vrx-fade-in">
      <button
        type="button"
        onClick={onClose}
        style={{ padding: "5px 11px", fontSize: 13, background: "#18202f", color: "#c7cde0", border: "1px solid #2a3350", borderRadius: 7, cursor: "pointer", marginBottom: 14 }}
      >
        ← Back to units
      </button>

      {/* Buttons ABOVE the image, out of the photo: Facilities on the LEFT switches to the
          separate misc gallery; Floor plan on the RIGHT jumps to the plans within the MAIN view (unit
          renderings + plans live together). Each shown only when it has images. */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8, minHeight: 34 }}>
        <div>
          {facilityPhotos.length > 0 && (
            <GalleryTab active={gal === "facilities"} onClick={() => switchGallery(gal === "facilities" ? "main" : "facilities")}>
              ❖ Facilities
            </GalleryTab>
          )}
        </div>
        <div>
          {firstPlanIndex >= 0 && (
            <GalleryTab
              active={gal === "main" && carouselIndex >= firstPlanIndex}
              onClick={() => {
                setGal("main");
                setCarouselIndex(firstPlanIndex);
              }}
            >
              ▦ Floor plan
            </GalleryTab>
          )}
        </div>
      </div>

      {/* The active gallery. Tap/swipe handled inside; tapping pops the full-screen lightbox. */}
      <div style={{ position: "relative" }}>
        <Carousel
          images={active.images}
          alt={`${building.name} ${unitLabel} — ${active.label}`}
          aspectRatio="3 / 2"
          fit="contain"
          index={carouselIndex}
          onIndexChange={setCarouselIndex}
          onImageClick={(k) => setLightbox(k)}
        />
        {/* What you're looking at — a small category tag (we only know the category, not the room name).
            Hidden for the default "Unit view" (the title below already says the unit); shown for Floor
            plan + Facility so a popped/scrolled image still says what it is. */}
        {active.label !== "Unit view" && (
          <span
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              fontSize: 11.5,
              fontWeight: 600,
              color: "#fff",
              background: "rgba(0,0,0,0.55)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 999,
              padding: "3px 10px",
              backdropFilter: "blur(2px)",
            }}
          >
            {active.label}
          </span>
        )}
      </div>

      {lightbox != null && (
        <Lightbox
          images={active.images}
          start={lightbox}
          caption={`${unitLabel} · ${active.label}`}
          onClose={() => setLightbox(null)}
        />
      )}

      {/* Title + status */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{unitLabel}</div>
          <div style={{ fontSize: 13, opacity: 0.6 }}>
            {building.name} · {unit.subtype || unit.type?.toUpperCase()}
            {unit.view ? ` · ${unit.view}${/view/i.test(unit.view) ? "" : " view"}` : ""}
          </div>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: badge.color }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: badge.color, display: "inline-block" }} />
          {badge.text}
        </span>
      </div>

      {/* Price — buyer-type-aware when a quota building has a chosen buyer type. HEADLINE quote only,
 so it gets the developer's display rounding; the per-m² + plan figures below stay EXACT. */}
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 10 }}>{money(displayPriceUsd(shownPrice, building.priceRounding))}</div>
      {buyerType && quotaOn && (
        <div style={{ fontSize: 12.5, opacity: 0.65, marginTop: 2 }}>{BUYER_TYPE_LABEL[buyerType]} price</div>
      )}
      {verifiedAt && (
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }} title={new Date(verifiedAt).toLocaleString()}>
          availability verified {timeAgo(verifiedAt)}
        </div>
      )}

      {/* Tabs — the reservation flow is tabbed (: the payment plan is one TAB in the reservation
          screen). Overview = specs + description; Payment plan = the interactive calculator (A4). */}
      {/* PILLS (mobile): flat underline-tabs ran off-screen on a phone (the last "Payment plan" tab
          was half-clipped) and didn't read as tappable on the dark ground. Rounded pills WRAP to fit any
          width and are obviously clickable — active = filled accent, inactive = outlined. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 18 }}>
        {([
          ["overview", "Overview"],
          ...(plans.length ? ([["floorplan", "Floor plan"]] as const) : []),
          ...(siteGeo ? ([["site", "Site plan"]] as const) : []),
          ["plan", "Payment plan"],
        ] as const).map(([key, label]) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={active}
              style={{
                padding: "7px 14px",
                fontSize: 13.5,
                fontWeight: 600,
                borderRadius: 999,
                background: active ? "#2f6bff" : "#141a28",
                border: `1px solid ${active ? "#2f6bff" : "#2a3350"}`,
                color: active ? "#ffffff" : "#c7cde0",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 }}>
            <Spec label="Type" value={unit.subtype || unit.type?.toUpperCase()} />
            <Spec label="Size" value={`${areaSqm} m²`} />
            <Spec label="Floor" value={unit.floor ? String(unit.floor) : "—"} />
            {unit.baths ? <Spec label="Baths" value={String(unit.baths)} /> : null}
            {unit.view ? <Spec label="View" value={unit.view} /> : null}
            {unit.corner ? <Spec label="Position" value="Corner" /> : null}
            <Spec label="Price / m²" value={money(pricePerSqm)} />
          </div>
          {unit.note && <p style={{ fontSize: 14, opacity: 0.8, marginTop: 14, lineHeight: 1.5 }}>{unit.note}</p>}

          {/* Location moved to its own "Site plan" tab (layer 3) — the full SitePlanMap
              (polygons + orientation) rather than a cramped Overview thumbnail. */}

          {/* Staged floor-area + Land-Office true-up — shown only when a final survey exists.
              Explains, in plain words, the small settlement that squares off area vs contracted size. */}
          {trueUp && unit.sqmStages && (
            <div style={{ marginTop: 16, padding: "10px 12px", borderRadius: 9, background: "#101a26", border: "1px solid #1d3350" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Final area &amp; transfer settlement</div>
              <div style={{ fontSize: 13, opacity: 0.85, lineHeight: 1.6 }}>
                Contracted size <strong>{unit.sqmStages.beforeBuilding} m²</strong>, final surveyed size{" "}
                <strong>{unit.sqmStages.final} m²</strong>{" "}
                ({trueUp.deltaSqm > 0 ? "+" : ""}{trueUp.deltaSqm} m²).{" "}
                {trueUp.payer === "buyer" && (
                  <>At transfer the buyer tops up <strong>{money(trueUp.amountUsd)}</strong> for the extra area.</>
                )}
                {trueUp.payer === "developer" && (
                  <>At transfer the developer refunds <strong>{money(Math.abs(trueUp.amountUsd))}</strong> for the smaller area.</>
                )}
                {trueUp.payer === "none" && <>No area adjustment is due at transfer.</>}
              </div>
            </div>
          )}

          {terms && <TermsBlock terms={terms} building={building} money={money} />}
        </div>
      )}

      {tab === "floorplan" && (
        <div style={{ marginTop: 16 }}>
          {plans.map((p) => (
            <div key={p.url} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.75, marginBottom: 8 }}>{p.label}</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.url}
                alt={`${unitLabel} — ${p.label}`}
                style={{
                  width: "100%",
                  maxHeight: 620,
                  objectFit: "contain",
                  background: "#0e1119",
                  border: "1px solid #1c2130",
                  borderRadius: 12,
                  display: "block",
                }}
              />
            </div>
          ))}
          <p style={{ fontSize: 11.5, opacity: 0.6, marginTop: 2 }}>
            Indicative plan for this unit type. Layout and dimensions may vary by floor and final survey.
          </p>
        </div>
      )}

      {tab === "site" && siteGeo && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>📍 Location &amp; access</div>
          <SitePlanMap geo={siteGeo} height={420} />
          {unit.geo && (
            <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 6 }}>This unit has its own marked location.</div>
          )}
          <p style={{ fontSize: 11.5, opacity: 0.6, marginTop: 6 }}>
            Site plan, access roads and orientation are indicative; confirm boundaries against the title survey.
          </p>
        </div>
      )}

      {tab === "plan" && (
        <div style={{ marginTop: 16 }}>
          {!terms ? (
            <p style={{ opacity: 0.6, fontSize: 14 }}>This developer hasn&apos;t published payment terms for this unit yet.</p>
          ) : canReserve ? (
            // Bookable → the interactive plan designer.
            <PaymentCalculator building={building} unit={unit} terms={terms} onChange={onPlanChange} />
          ) : (
            // Not bookable (sold / on hold / quota-full): hide the interactive form entirely —
            // show only the developer's published plan, read-only, so there's nothing to fiddle with.
            <>
              <p style={{ fontSize: 13, color: "#e0a05a", marginBottom: 12 }}>
                This unit isn&apos;t available to book right now — showing the developer&apos;s published plan.
              </p>
              <TermsBlock terms={terms} building={building} money={money} />
            </>
          )}
        </div>
      )}

      {/* Reserve action — enabled only when the unit is open AND (for a foreign-freehold buyer) still
 within the building's quota. */}
      {onReserve && (
        <button
          type="button"
          onClick={onReserve}
          disabled={!canReserve}
          style={{
            marginTop: 20,
            padding: "10px 18px",
            borderRadius: 9,
            border: "none",
            background: canReserve ? "#2f6bff" : "#2a3350",
            color: "#fff",
            fontSize: 15,
            fontWeight: 600,
            cursor: canReserve ? "pointer" : "default",
            opacity: canReserve ? 1 : 0.6,
          }}
        >
          {canReserve
            ? tab === "plan"
              ? "Reserve with this plan"
              : "Reserve this unit"
            : quotaBlocked
            ? "Freehold quota full — choose Company or Private"
            : `${badge.text} — not available`}
        </button>
      )}
    </div>
  );
}

// A pill button above the gallery that switches to a secondary image set (Facilities / Floor plan).
function GalleryTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "6px 13px",
        fontSize: 12.5,
        fontWeight: 600,
        background: active ? "#2f6bff" : "#18202f",
        color: active ? "#fff" : "#c7cde0",
        border: `1px solid ${active ? "#2f6bff" : "#2a3350"}`,
        borderRadius: 999,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {children}
    </button>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#0e1119", border: "1px solid #1c2130", borderRadius: 9, padding: "8px 10px" }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.6 }}>{label}</div>
      <div style={{ fontSize: 14.5, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// A readable summary of the developer's payment plan (shape). Shows the FIRST published option of
// each category as the headline structure; the A4 form will let the agent pick among all options.
function TermsBlock({
  terms,
  building,
  money,
}: {
  terms: import("@/lib/catalog-client").PaymentTerms;
  building: Building;
  money: (usd: number) => string;
}) {
  const first = <T,>(a: T[]): T | undefined => a?.[0];
  const rows: { label: string; value: string }[] = [];
  const bf = first(terms.bookingFee);
  if (bf != null) rows.push({ label: "Booking fee", value: money(bf) });
  const dep = first(terms.depositPct);
  if (dep != null) rows.push({ label: "Deposit", value: `${dep}%` });
  const oc = first(terms.onContract);
  if (oc) rows.push({ label: "On contract", value: `${oc.installments} × ${oc.amountPct}%` });
  const og = first(terms.ongoing);
  if (og) rows.push({ label: "Instalments", value: `${og.installments} × ${og.amountPct}%` });
  const fr = first(terms.frequencyDays);
  if (fr != null) rows.push({ label: "Frequency", value: `every ${fr} days` });
  const ok = first(terms.onKeyPct);
  if (ok != null) rows.push({ label: "On handover", value: `${ok}%` });
  const tx = first(terms.taxPct);
  if (tx != null) rows.push({ label: "Tax", value: `${tx}%` });
  if (building.reservationFeeUsd) rows.push({ label: "Reservation", value: money(building.reservationFeeUsd) });

  if (rows.length === 0) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.8, marginBottom: 8 }}>Payment plan</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, background: "#0e1119", border: "1px solid #1c2130", borderRadius: 8, padding: "7px 10px" }}>
            <span style={{ opacity: 0.6 }}>{r.label}</span>
            <span style={{ fontWeight: 600 }}>{r.value}</span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 11.5, opacity: 0.6, marginTop: 6 }}>
        Indicative plan published by the developer. You&apos;ll confirm the exact terms when you make an offer.
      </p>
    </div>
  );
}
