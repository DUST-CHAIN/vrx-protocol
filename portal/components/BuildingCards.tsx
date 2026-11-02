"use client";

// availability, unit types, and price range, arranged as responsive tiles that lay out nicely on a
// phone. Tap a card → open that building's grid. Shared by the developer and (scoped) agency/agent
// views. Availability comes from the snapshot summary (instant, no chain reads).

import { useEffect, useState } from "react";
import { fetchSummary, timeAgo, CACHED_ORANGE, type BuildingSummary } from "@/lib/catalog-client";
import { useMoney } from "@/lib/currency";
import { displayPriceUsd } from "@/lib/price-rounding";
import BuildingLogo from "@/components/BuildingLogo";

// One quota side on a building card: "Freehold (49%) · 12% sold · 8,590 m² left". % sold in red;
// "fully allocated" when nothing's left. `estimate` marks the foreign figure as a guess (undeclared).
function QuotaRow({
  label,
  soldPct,
  availableSqm,
  estimate,
}: {
  label: string;
  soldPct: number;
  availableSqm: number;
  estimate?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#8fc4ff", flexWrap: "wrap" }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {soldPct > 0 && <span style={{ color: "#e0705a" }}>{soldPct}% sold</span>}
      <span style={{ opacity: 0.5 }}>·</span>
      {availableSqm > 0 ? (
        <span>
          <strong>{availableSqm.toLocaleString()} m²</strong> left{estimate ? "*" : ""}
        </span>
      ) : (
        <span style={{ color: "#e0953a" }}>fully allocated</span>
      )}
    </div>
  );
}

export default function BuildingCards({
  onOpen,
  /** Optional building-id scope. `undefined` = NO filter (show every building — the back-compat default).
   * An ARRAY = show only those ids (an agent's gated buildings; a developer's own buildingIds). `null` =
   * scope is KNOWN-EMPTY / still LOADING → show nothing (never flash the whole catalog while a scoped caller
   * is resolving its ids). The distinction matters: a scoped caller passes `null` until it has the ids. */
  filterIds,
  heading = "Buildings",
  /** Security Pass #3 — the VIEWER's account, so the summary read is scoped server-side to the
   * buildings they're entitled to (own ∪ gated). god-mode (localnet) returns all regardless. Absent =
   * legacy unscoped call (server returns nothing for a non-god caller). */
  account,
}: {
  onOpen: (buildingId: string) => void;
  filterIds?: string[] | null;
  heading?: string;
  account?: string | null;
}) {
  const money = useMoney();
  const [summaries, setSummaries] = useState<BuildingSummary[] | null>(null);

  useEffect(() => {
    fetchSummary(account)
      .then(setSummaries)
      .catch(() => setSummaries([]));
  }, [account]);

  // undefined → no filter (all). null → show nothing (loading/empty scope). array → only those ids.
  const shown =
    filterIds === undefined
      ? summaries
      : filterIds === null
        ? []
        : (summaries?.filter((b) => filterIds.includes(b.id)) ?? null);

  // too subtle — show an explicit spinner + label beside the heading while the summary fetch is in flight
  // (summaries === null = the real "still loading" signal, independent of how filterIds resolves).
  const loading = summaries === null;

  return (
    <div>
      <h2 style={{ fontSize: 18, margin: "0 0 12px", display: "flex", alignItems: "center", gap: 10 }}>
        {heading}
        {loading && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 400, opacity: 0.75 }}>
            <span className="vrx-spin" style={{ color: "#38d39f" }} />
            Loading…
          </span>
        )}
      </h2>
      <div
        style={{
          display: "grid",
          // Responsive tiles: as many ~250px columns as fit; a single column on a narrow phone.
          gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 250px), 1fr))",
          gap: 12,
        }}
      >
        {shown === null &&
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="vrx-working" style={{ height: 132, borderRadius: 2, background: "#151b28", border: "1px solid #1c2434" }} />
          ))}
        {shown?.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onOpen(b.id)}
            style={{
              textAlign: "left",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: 14,
              overflow: "hidden",
              borderRadius: 2,
              border: "1px solid #232838",
              background: "#0e1119",
              color: "#e8ecf4",
              cursor: "pointer",
              minHeight: 0,
            }}
          >
            {/* Representative photo banner — breaks out of the card padding with negative margins so
                it sits flush to the rounded edges. Omitted entirely when the building has no media yet, so
                the logo+name row below keeps the card clean. */}
            {b.heroImage && (
              <div
                style={{
                  // width instead of fixed-cropping. 21/9 was too slim ("missing vertical space"); 16/10 gives
                  // the tower room to read while still scaling cleanly on a narrow phone card.
                  aspectRatio: "16 / 10",
                  minHeight: 140,
                  background: "#0b0e16",
                  margin: "-14px -14px 0",
                  flexShrink: 0,
                  overflow: "hidden",
                  // as a clean edge-to-edge band, not a pill.
                  borderRadius: 2,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={b.heroImage}
                  alt={b.name}
                  loading="lazy"
                  // objectPosition "top": building shots read best anchored to the top (keep the tower, let the
                  // foreground/street crop away) rather than centre-cropping into the middle floors.
                  style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top", display: "block" }}
                />
              </div>
            )}
            <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
              <BuildingLogo id={b.id} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {b.name}
                </div>
                <div style={{ fontSize: 12, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {b.area} · {b.stories} floors
                  {b.hasGeo ? <span style={{ marginLeft: 6, color: "#8fc4ff" }}>📍 on map</span> : null}
                </div>
              </div>
            </div>

            {/* c (: "more orderly, columns-wise") — availability + price sit on ONE aligned row,
                availability left / price right, instead of two separate stacked lines. A labelled two-column
                stat row reads as a tidy spec block rather than a loose vertical list. */}
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.6 }}>Availability</span>
                {b.hasSnapshot ? (
                  <span style={{ fontSize: 13, whiteSpace: "nowrap" }}>
                    <span style={{ color: "#7ce0a0", fontWeight: 600 }}>{b.available}</span>
                    <span style={{ opacity: 0.6 }}> of {b.total}</span>
                    <span style={{ opacity: 0.4 }}> · </span>
                    <span style={{ opacity: 0.6 }}>{b.sold} sold</span>
                  </span>
                ) : (
                  <span style={{ fontSize: 12.5, opacity: 0.55 }}>Tap to load</span>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-end", textAlign: "right", flexShrink: 0 }}>
                <span style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.6 }}>Price range</span>
                {/* HEADLINE card quote → developer display rounding; stored figures stay exact. */}
                <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
                  {money(displayPriceUsd(b.priceMinUsd, b.priceRounding ?? undefined))}
                  <span style={{ opacity: 0.4, fontWeight: 400 }}> – </span>
                  {money(displayPriceUsd(b.priceMaxUsd, b.priceRounding ?? undefined))}
                </span>
              </div>
            </div>

            {/* Type chips */}
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {b.types.map((t) => (
                <span
                  key={t.key}
                  style={{ fontSize: 11, padding: "2px 7px", borderRadius: 5, background: "#151b28", border: "1px solid #2a2f40", opacity: 0.9 }}
                >
                  {t.label} · {t.sqmMin === t.sqmMax ? `${t.sqmMin}` : `${t.sqmMin}–${t.sqmMax}`}m²
                </span>
              ))}
            </div>

            {/* Quota — only for buildings the developer configured. Two sides: Foreign (the
                49% freehold cap) + Local (the ≥51%, Company + Private grouped). Each shows % sold in
                red + m² left. An undeclared floating pool flags the foreign figure as an estimate. */}
            {b.freehold && (
              <div
                style={{
                  fontSize: 11.5,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: "#101a26",
                  border: "1px solid #1d3350",
                }}
              >
                <QuotaRow
                  label={`Freehold (${b.freehold.pct}%)`}
                  soldPct={b.freehold.foreign.soldPct}
                  availableSqm={b.freehold.foreign.availableSqm}
                  estimate={b.freehold.foreignIsEstimate}
                />
                <QuotaRow
                  label={`Local (${100 - b.freehold.pct}%)`}
                  soldPct={b.freehold.local.soldPct}
                  availableSqm={b.freehold.local.availableSqm}
                />
                {b.freehold.undeclaredUnits > 0 && (
                  <div style={{ fontSize: 10.5, color: "#e0953a", opacity: 0.9 }}>
                    ⚠ {b.freehold.undeclaredUnits} unit{b.freehold.undeclaredUnits === 1 ? "" : "s"} not yet assigned
                  </div>
                )}
              </div>
            )}

            {b.hasSnapshot && b.snapshotAt && (
              <div style={{ fontSize: 11, color: CACHED_ORANGE, opacity: 0.85 }}>last cached {timeAgo(b.snapshotAt)}</div>
            )}
          </button>
        ))}
        {/* S159c: only show the empty message once the fetch has actually RESOLVED (not while summaries are
            still loading and a scoped filter is momentarily resolving to []) — otherwise "No buildings to show"
 flashes under the spinner before the real cards arrive (the race saw). */}
        {!loading && shown?.length === 0 && <p style={{ opacity: 0.6, fontSize: 14 }}>No buildings to show.</p>}
      </div>
    </div>
  );
}
