"use client";

// • <ConstructionTimelineEditor> — building-specific milestones (label + date text + projected flag).
// • <FurniturePacksManager> — developer-GLOBAL, reusable furniture packs: author once (multi line
// items, flat or per-m²), then TICK which buildings each applies to ("if developer marked it so").
// • <BuildingFurniturePreview> — read-only, per building: the packs attached to it + the per-unit cost
// at the building's reference size (so the developer sees what the S&P will quote).
// All OFF-CHAIN, developer-authored. Furniture COST is never stored — computed from unit m² (lib/furniture),
// so a staged area change flows straight through to the S&P. Empty everywhere = the S&P renders its
// neutral fallbacks, exactly as before.

import { useCallback, useEffect, useState } from "react";
import { card, submitBtn, input, lbl } from "@/lib/ui";
import {
  fetchCatalog,
  envelopeLabel,
  type Building,
  type BuildingMilestone,
  type FurniturePack,
  type FurnitureItem,
  type SellerEntity,
  type PaymentOption,
  type PaymentMethodKind,
  type TermsEnvelope,
} from "@/lib/catalog-client";
import { furniturePackCost, furnitureItemBasisLabel } from "@/lib/furniture";
import { useMoney } from "@/lib/currency";
import BuildingHaltPanel from "@/components/BuildingHaltPanel";
import HaltImpactPanel from "@/components/HaltImpactPanel";

// ── Construction timeline (building-specific) ───────────────────────────────────────────────────────────

export function ConstructionTimelineEditor({ building, onSaved }: { building: Building; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<BuildingMilestone[]>(building.constructionTimeline ?? []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const has = (building.constructionTimeline ?? []).length > 0;

  function update(i: number, patch: Partial<BuildingMilestone>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function add() {
    setRows((rs) => [...rs, { label: "", when: "" }]);
  }
  function remove(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i));
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const clean = rows.filter((r) => r.label.trim() && r.when.trim());
      const res = await fetch("/api/catalog/building-extras", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ building: building.id, constructionTimeline: clean }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setMsg(j.error || "save failed");
      } else {
        setMsg("Timeline saved.");
        onSaved();
      }
    } catch {
      setMsg("network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ ...card, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>🏗️ Construction timeline</h3>
        <span style={{ fontSize: 12.5, opacity: 0.6 }}>
          {has ? `${(building.constructionTimeline ?? []).length} milestone(s) — shown on the S&P.` : "Not set — add the construction & handover schedule."}
        </span>
        <button type="button" onClick={() => setOpen((v) => !v)} style={{ ...pillBtn, marginLeft: "auto" }}>
          {open ? "Done" : has ? "Edit" : "Add timeline"}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          {rows.length === 0 && <div style={{ fontSize: 13, opacity: 0.55, marginBottom: 8 }}>No milestones yet.</div>}
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                value={r.label}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder="Phase (e.g. Topping out)"
                style={{ ...input, flex: 2, minWidth: 160 }}
              />
              <input
                value={r.when}
                onChange={(e) => update(i, { when: e.target.value })}
                placeholder="When (e.g. Q4 2027)"
                style={{ ...input, flex: 1, minWidth: 110 }}
              />
              <label style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 5, opacity: 0.85 }}>
                <input type="checkbox" checked={!!r.projected} onChange={(e) => update(i, { projected: e.target.checked })} />
                projected
              </label>
              <button type="button" onClick={() => remove(i)} style={ghostBtn}>
                ✕
              </button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={add} style={ghostBtn}>+ milestone</button>
            <button type="button" onClick={() => void save()} disabled={busy} style={{ ...submitBtn, padding: "7px 16px" }}>
              {busy ? "Saving…" : "Save timeline"}
            </button>
            {msg && <span style={{ fontSize: 13, opacity: 0.8 }}>{msg}</span>}
          </div>
          <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 6 }}>
            Tick “projected” for estimated (non-contractual) dates — the S&P states it plainly.
          </div>
        </div>
      )}
    </section>
  );
}

// A collapsible section that opens into tabs (Project / Physical / Fees / Land / Seller entity). Each tab
// saves INDEPENDENTLY (small section-scoped POSTs to /api/catalog/building-setup) so a half-filled setup never
// blocks and one section can't clobber another — the same posture as the geo/terms editors. Every field is
// optional + absent-safe: a building with none renders exactly as before, and the S&P keeps its neutral copy.
// The Fees tab also carries the terms-envelope (the developer's SOFT min–max commission band) — its
// authoring HOME moved here from DocumentsPanel (the design doc's plan); DocumentsPanel keeps a read-only view
// of the band so it's still visible where deal terms are surfaced. Same /api/catalog/terms endpoint, same
// soft-warning semantics (it flags, never blocks). Basics (name/floors/etc) already have their own editors
// elsewhere, so this editor focuses on the NEW groups; a "Basics" note points there rather than duplicating.

type SetupTab = "project" | "physical" | "fees" | "land" | "seller" | "directSale";

const SETUP_TABS: { id: SetupTab; label: string }[] = [
  { id: "project", label: "Project" },
  { id: "physical", label: "Physical" },
  { id: "fees", label: "Fees & terms" },
  { id: "land", label: "Land & legal" },
  { id: "seller", label: "Seller entity" },
  { id: "directSale", label: "Direct sale" },
];

export function BuildingSetupEditor({
  developer,
  building,
  onSaved,
}: {
  developer: string;
  building: Building;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SetupTab>("project");
  // Part A3: a shared counter so asserting/lifting a halt refreshes the impact cockpit below it too.
  const [haltRefresh, setHaltRefresh] = useState(0);

  // Count the filled groups for the collapsed summary (honest "N of 5 set").
  const filled =
    (building.project ? 1 : 0) +
    (building.physical ? 1 : 0) +
    (building.fees || building.termsEnvelope ? 1 : 0) +
    (building.land ? 1 : 0) +
    (building.sellerEntityId ? 1 : 0) +
    (building.directSale?.visible ? 1 : 0);

  return (
    <section style={{ ...card, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>🏢 Building setup</h3>
        <span style={{ fontSize: 12.5, opacity: 0.6 }}>
          {filled > 0 ? `${filled} of 6 sections set — these feed the S&P and the building record.` : "Not set — construction, physical specs, fees, land & legal, seller entity, direct sale."}
        </span>
        <button type="button" onClick={() => setOpen((v) => !v)} style={{ ...pillBtn, marginLeft: "auto" }}>
          {open ? "Done" : filled > 0 ? "Edit" : "Set up"}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {SETUP_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                style={tab === t.id ? { ...pillBtn, background: "#1a2540", border: "1px solid #2b62ff", color: "#dfe5f5" } : pillBtn}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "project" && <ProjectTab building={building} onSaved={onSaved} />}
          {tab === "physical" && <PhysicalTab building={building} onSaved={onSaved} />}
          {tab === "fees" && <FeesTab building={building} onSaved={onSaved} />}
          {tab === "land" && <LandTab developer={developer} building={building} onSaved={onSaved} />}
          {tab === "seller" && <SellerEntityTab developer={developer} building={building} onSaved={onSaved} />}
          {tab === "directSale" && <DirectSaleTab building={building} onSaved={onSaved} />}

          <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 12, borderTop: "1px solid #1c2230", paddingTop: 8 }}>
            Name, floors, tagline &amp; description are edited in the building header. Each tab here saves on its own.
          </div>

          {/* Part A-finish: the building-HALT lever lives on the same per-building developer surface — a halt is
              a building-level transparency action (note + notify partners), distinct from the editable setup
              sections above, so it gets its own panel rather than a tab. */}
          <BuildingHaltPanel
            developer={developer}
            building={building.id}
            buildingName={building.name}
            onChanged={() => {
              onSaved();
              setHaltRefresh((n) => n + 1);
            }}
          />

          {/* Part A3: the developer's halt-IMPACT cockpit — the symmetric half of the lever above. Reads live
              (a pre-halt preview too), so it sits directly beneath the control it explains. */}
          <HaltImpactPanel developer={developer} building={building.id} buildingName={building.name} refreshKey={haltRefresh} />
        </div>
      )}
    </section>
  );
}

/** Error carrying the server's machine `code` so a tab can branch on it (e.g. LandTab steering an
 * `immutable_tier0` 409 to the VRX-correction path) instead of only showing the human message. */
class SaveError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** POST one building-setup section; throws a SaveError (with the server `code`) on a non-OK response. */
async function saveSection(buildingId: string, section: string, data: unknown): Promise<void> {
  const res = await fetch("/api/catalog/building-setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ building: buildingId, section, data }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new SaveError(j.error || "save failed", typeof j.code === "string" ? j.code : undefined);
  }
}

/** Shared save-state wiring for a tab form. Returns {busy, msg, run}. */
function useTabSave(onSaved: () => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = useCallback(
    async (doSave: () => Promise<void>, okMsg: string) => {
      setBusy(true);
      setMsg(null);
      try {
        await doSave();
        setMsg(okMsg);
        onSaved();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : "network error");
      } finally {
        setBusy(false);
      }
    },
    [onSaved]
  );
  return { busy, msg, run };
}

const fieldWrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 };
const fullInput: React.CSSProperties = { ...input, width: "100%", boxSizing: "border-box" };

function SaveRow({ busy, msg, onSave, label = "Save" }: { busy: boolean; msg: string | null; onSave: () => void; label?: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
      <button type="button" onClick={onSave} disabled={busy} style={{ ...submitBtn, padding: "7px 16px", opacity: busy ? 0.6 : 1 }}>
        {busy ? "Saving…" : label}
      </button>
      {msg && <span style={{ fontSize: 13, opacity: 0.8 }}>{msg}</span>}
    </div>
  );
}

function ProjectTab({ building, onSaved }: { building: Building; onSaved: () => void }) {
  const p = building.project ?? {};
  const [startConst, setStart] = useState(p.startConst ?? "");
  const [endConst, setEnd] = useState(p.endConst ?? "");
  const [months, setMonths] = useState(p.completeWithinMonths != null ? String(p.completeWithinMonths) : "");
  const [phase, setPhase] = useState(p.phase ?? "");
  const [status, setStatus] = useState<string>(p.status ?? "");
  const { busy, msg, run } = useTabSave(onSaved);

  const save = () =>
    run(
      () =>
        saveSection(building.id, "project", {
          startConst,
          endConst,
          completeWithinMonths: months,
          phase,
          status: status || undefined,
        }),
      "Project saved."
    );

  return (
    <div>
      <div style={fieldWrap}>
        <label style={lbl}>Construction start</label>
        <input value={startConst} onChange={(e) => setStart(e.target.value)} placeholder="e.g. Q1 2027 · Dec 2026 · a date" style={fullInput} />
      </div>
      <div style={fieldWrap}>
        <label style={lbl}>Construction end (target)</label>
        <input value={endConst} onChange={(e) => setEnd(e.target.value)} placeholder="e.g. Q4 2029" style={fullInput} />
      </div>
      <div style={fieldWrap}>
        <label style={lbl}>Complete within (months)</label>
        <input value={months} inputMode="numeric" onChange={(e) => setMonths(e.target.value.replace(/[^\d]/g, ""))} placeholder="e.g. 36 — the contractual completion window" style={{ ...fullInput, maxWidth: 220 }} />
        <span style={{ fontSize: 11.5, opacity: 0.6 }}>The contractual backstop around the construction-timeline milestones. Prints in the S&P (§4) as the Developer’s undertaking to complete within this many months of construction start, with the buyer’s remedy under the agreement’s default/termination terms.</span>
      </div>
      <div style={fieldWrap}>
        <label style={lbl}>Phase</label>
        <input value={phase} onChange={(e) => setPhase(e.target.value)} placeholder="e.g. Phase 2" style={{ ...fullInput, maxWidth: 220 }} />
      </div>
      <div style={fieldWrap}>
        <label style={lbl}>Project status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...input, width: 200 }}>
          <option value="">— not set —</option>
          <option value="planning">Planning</option>
          <option value="building">Building</option>
          <option value="complete">Complete</option>
        </select>
        <span style={{ fontSize: 11.5, opacity: 0.6 }}>Project-level status — distinct from each unit’s availability.</span>
      </div>
      <SaveRow busy={busy} msg={msg} onSave={save} label="Save project" />
    </div>
  );
}

function PhysicalTab({ building, onSaved }: { building: Building; onSaved: () => void }) {
  const ph = building.physical ?? {};
  const [landArea, setLandArea] = useState(ph.landArea ?? "");
  const [carParks, setCarParks] = useState(ph.carParks != null ? String(ph.carParks) : "");
  const [ftc, setFtc] = useState(ph.floorToCeiling ?? "");
  const { busy, msg, run } = useTabSave(onSaved);

  const save = () => run(() => saveSection(building.id, "physical", { landArea, carParks, floorToCeiling: ftc }), "Physical specs saved.");

  return (
    <div>
      <div style={fieldWrap}>
        <label style={lbl}>Land area</label>
        <input value={landArea} onChange={(e) => setLandArea(e.target.value)} placeholder='e.g. "1 Rai 3 Ngan 81 Wah" — free text' style={fullInput} />
      </div>
      <div style={fieldWrap}>
        <label style={lbl}>Car parks</label>
        <input value={carParks} inputMode="numeric" onChange={(e) => setCarParks(e.target.value.replace(/[^\d]/g, ""))} placeholder="e.g. 120" style={{ ...fullInput, maxWidth: 180 }} />
      </div>
      <div style={fieldWrap}>
        <label style={lbl}>Floor-to-ceiling</label>
        <input value={ftc} onChange={(e) => setFtc(e.target.value)} placeholder='e.g. "2.8 m"' style={{ ...fullInput, maxWidth: 180 }} />
      </div>
      <SaveRow busy={busy} msg={msg} onSave={save} label="Save physical" />
    </div>
  );
}

function FeesTab({ building, onSaved }: { building: Building; onSaved: () => void }) {
  const f = building.fees ?? {};
  const [sinking, setSinking] = useState(f.sinkingFundPerSqmUsd != null ? String(f.sinkingFundPerSqmUsd) : (building.sinkingFundPerSqmUsd != null ? String(building.sinkingFundPerSqmUsd) : ""));
  const [cam, setCam] = useState(f.camAdvanceMonths != null ? String(f.camAdvanceMonths) : "");
  const { busy, msg, run } = useTabSave(onSaved);

  const save = () => run(() => saveSection(building.id, "fees", { sinkingFundPerSqmUsd: sinking, camAdvanceMonths: cam }), "Fees saved.");

  return (
    <div>
      <div style={fieldWrap}>
        <label style={lbl}>Sinking fund (USD / m²)</label>
        <input value={sinking} inputMode="numeric" onChange={(e) => setSinking(e.target.value.replace(/[^\d]/g, ""))} placeholder="one-off, per m²" style={{ ...fullInput, maxWidth: 200 }} />
      </div>
      <div style={fieldWrap}>
        <label style={lbl}>CAM advance (months)</label>
        <input value={cam} inputMode="numeric" onChange={(e) => setCam(e.target.value.replace(/[^\d]/g, ""))} placeholder="e.g. 12 — common-area maintenance paid in advance" style={{ ...fullInput, maxWidth: 200 }} />
      </div>
      <SaveRow busy={busy} msg={msg} onSave={save} label="Save fees" />

      {/* Acceptable-terms band — authoring home moved here from DocumentsPanel; same endpoint. */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #1c2230" }}>
        <TermsBandEditor building={building} onSaved={onSaved} />
      </div>

      {/* Per-building buyer-default / termination override (§config-surface). Overrides the
          developer's house default for THIS building's buyers' S&Ps. Leave blank to inherit. */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #1c2230" }}>
        <BuildingTerminationEditor building={building} onSaved={onSaved} />
      </div>
    </div>
  );
}

/** Per-building override of the buyer-default / termination clause numbers ( §config-surface). The TOP
 * tier of the 3-tier chain (building → developer house default → code default). Reads
 * building.terminationTerms directly; POSTs to /api/catalog/termination. A blank field inherits; "Clear"
 * removes the override entirely so the building falls back to the developer's house default. */
function BuildingTerminationEditor({ building, onSaved }: { building: Building; onSaved: () => void }) {
  const tt = building.terminationTerms ?? null;
  const [thr, setThr] = useState(tt?.defaultThresholdPct != null ? String(tt.defaultThresholdPct) : "");
  const [cure, setCure] = useState(tt?.cureDays != null ? String(tt.cureDays) : "");
  const [intr, setIntr] = useState(tt?.interestPctPerAnnum != null ? String(tt.interestPctPerAnnum) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const anySet = thr.trim() !== "" || cure.trim() !== "" || intr.trim() !== "";

  async function save(clear: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const terminationTerms = clear
        ? null
        : {
            defaultThresholdPct: thr.trim() === "" ? undefined : Number(thr),
            cureDays: cure.trim() === "" ? undefined : Number(cure),
            interestPctPerAnnum: intr.trim() === "" ? undefined : Number(intr),
          };
      const res = await fetch("/api/catalog/termination", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ building: building.id, terminationTerms }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "could not save");
      }
      if (clear) { setThr(""); setCure(""); setIntr(""); }
      setMsg(clear ? "Override cleared — this building uses your house default." : "Saved for this building.");
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "could not save");
    } finally {
      setBusy(false);
    }
  }

  const box: React.CSSProperties = {
    width: 72, padding: "6px 8px", borderRadius: 7, border: "1px solid #2a3350",
    background: "#0b0e16", color: "#dfe5f5", textAlign: "right",
  };

  return (
    <div>
      <label style={lbl}>Buyer-default terms for this building</label>
      <div style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.55, marginBottom: 8 }}>
        Override your house default (set on your main page) for <b>this building&rsquo;s</b> sale agreements only —
        what happens if a buyer falls behind. Leave a field blank to use your house default. Already-signed
        agreements stay frozen.
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5, display: "flex", flexDirection: "column", gap: 4 }}>
          Default at
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input value={thr} disabled={busy} inputMode="decimal" placeholder="—" onChange={(e) => setThr(e.target.value.replace(/[^\d.]/g, ""))} style={box} /> %
          </span>
        </label>
        <label style={{ fontSize: 12.5, display: "flex", flexDirection: "column", gap: 4 }}>
          Time to fix
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input value={cure} disabled={busy} inputMode="numeric" placeholder="—" onChange={(e) => setCure(e.target.value.replace(/[^\d]/g, ""))} style={box} /> days
          </span>
        </label>
        <label style={{ fontSize: 12.5, display: "flex", flexDirection: "column", gap: 4 }}>
          Interest
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input value={intr} disabled={busy} inputMode="decimal" placeholder="—" onChange={(e) => setIntr(e.target.value.replace(/[^\d.]/g, ""))} style={box} /> %/yr
          </span>
        </label>
        <button type="button" disabled={busy || !anySet} onClick={() => void save(false)}
          style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #2a3350", background: "#1a2540", color: "#dfe5f5", cursor: "pointer", fontSize: 13, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : "Save"}
        </button>
        {tt && (
          <button type="button" disabled={busy} onClick={() => void save(true)}
            style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid #3a2030", background: "#2a1420", color: "#e0a0a0", cursor: "pointer", fontSize: 13 }}>
            Clear
          </button>
        )}
      </div>
      {msg && <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

/** The developer's SOFT min–max commission band for NEW agreements. Reads building.termsEnvelope
 * directly; POSTs to /api/catalog/terms. Soft — it flags out-of-band rates elsewhere, it never blocks here. */
function TermsBandEditor({ building, onSaved }: { building: Building; onSaved: () => void }) {
  const env = building.termsEnvelope ?? null;
  const [min, setMin] = useState(env?.commissionMinPct != null ? String(env.commissionMinPct) : "");
  const [max, setMax] = useState(env?.commissionMaxPct != null ? String(env.commissionMaxPct) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(clear: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const envelope: TermsEnvelope | null = clear
        ? null
        : {
            commissionMinPct: min.trim() === "" ? undefined : Number(min),
            commissionMaxPct: max.trim() === "" ? undefined : Number(max),
          };
      const res = await fetch("/api/catalog/terms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ building: building.id, envelope }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "could not save");
      }
      if (clear) { setMin(""); setMax(""); }
      setMsg(clear ? "Band cleared." : "Band saved.");
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label style={lbl}>Acceptable commission band</label>
      <div style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.55, marginBottom: 8 }}>
        The commission band you’re willing to agree on <b>new</b> agreements here. A soft guide — it flags an
        out-of-band rate when you set terms, so you notice; it never blocks. Leave a field blank for an open end.
        Already-agreed terms stay frozen.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
          Min
          <input value={min} disabled={busy} inputMode="decimal" placeholder="—" onChange={(e) => setMin(e.target.value.replace(/[^\d.]/g, ""))}
            style={{ width: 64, padding: "6px 8px", borderRadius: 7, border: "1px solid #2a3350", background: "#0b0e16", color: "#dfe5f5", textAlign: "right" }} />
          %
        </label>
        <span style={{ opacity: 0.4 }}>–</span>
        <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
          Max
          <input value={max} disabled={busy} inputMode="decimal" placeholder="—" onChange={(e) => setMax(e.target.value.replace(/[^\d.]/g, ""))}
            style={{ width: 64, padding: "6px 8px", borderRadius: 7, border: "1px solid #2a3350", background: "#0b0e16", color: "#dfe5f5", textAlign: "right" }} />
          %
        </label>
        <button type="button" disabled={busy || (min.trim() === "" && max.trim() === "")} onClick={() => void save(false)}
          style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #2a3350", background: "#1a2540", color: "#dfe5f5", cursor: "pointer", fontSize: 13, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : "Save band"}
        </button>
        {env && (
          <button type="button" disabled={busy} onClick={() => void save(true)}
            style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid #3a2030", background: "#2a1420", color: "#e0a0a0", cursor: "pointer", fontSize: 13 }}>
            Clear
          </button>
        )}
      </div>
      {msg && <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 6 }}>{msg}</div>}
      {env && envelopeLabel(env) && <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>Current band: <b>{envelopeLabel(env)}</b>.</div>}
    </div>
  );
}

function LandTab({ developer, building, onSaved }: { developer: string; building: Building; onSaved: () => void }) {
  const l = building.land ?? {};
  const [titleDeedNum, setDeed] = useState(l.titleDeedNum ?? "");
  const [surveyPageNum, setSurvey] = useState(l.surveyPageNum ?? "");
  const [landNumber, setLandNum] = useState(l.landNumber ?? "");
  const [address, setAddress] = useState(l.address ?? "");
  const [addressTH, setAddressTH] = useState(l.addressTH ?? "");
  const [clauseText, setClause] = useState(l.clauseText ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  //  Slice 7 — when the self-serve save is refused because the building is on contract (immutable_tier0),
  // we flip into correction mode: the ONLY legitimate path to change a legal anchor is a VRX-reviewed CORRECTION
  // (not self-serve), which notifies all parties with sealed evidence. The developer gives a reason and submits.
  const [needsCorrection, setNeedsCorrection] = useState(false);
  const [reason, setReason] = useState("");

  const anchors = { titleDeedNum, surveyPageNum, landNumber, address, addressTH };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    setNeedsCorrection(false);
    try {
      await saveSection(building.id, "land", { titleDeedNum, surveyPageNum, landNumber, address, addressTH, clauseText });
      setMsg("Land & legal saved.");
      onSaved();
    } catch (e) {
      if (e instanceof SaveError && e.code === "immutable_tier0") {
        // On contract — steer to the correction path instead of a dead-end error.
        setNeedsCorrection(true);
        setMsg(null);
      } else {
        setMsg(e instanceof Error ? e.message : "network error");
      }
    } finally {
      setBusy(false);
    }
  };

  const requestCorrection = async () => {
    if (!reason.trim()) { setMsg("Please say what needs correcting and why."); return; }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/catalog/tier0-correction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ building: building.id, by: developer, data: anchors, reason: reason.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(typeof j.error === "string" ? j.error : "Could not open the correction."); return; }
      setNeedsCorrection(false);
      setReason("");
      setMsg("Correction requested — VRX will review it and notify all parties with sealed evidence.");
    } catch {
      setMsg("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style={{ ...fieldWrap, flex: 1, minWidth: 140 }}>
          <label style={lbl}>Title deed no.</label>
          <input value={titleDeedNum} onChange={(e) => setDeed(e.target.value)} style={fullInput} />
        </div>
        <div style={{ ...fieldWrap, flex: 1, minWidth: 140 }}>
          <label style={lbl}>Survey page no.</label>
          <input value={surveyPageNum} onChange={(e) => setSurvey(e.target.value)} style={fullInput} />
        </div>
        <div style={{ ...fieldWrap, flex: 1, minWidth: 140 }}>
          <label style={lbl}>Land no.</label>
          <input value={landNumber} onChange={(e) => setLandNum(e.target.value)} style={fullInput} />
        </div>
      </div>
      <div style={fieldWrap}>
        <label style={lbl}>Land address</label>
        <input value={address} onChange={(e) => setAddress(e.target.value)} style={fullInput} />
      </div>
      <div style={fieldWrap}>
        <label style={lbl}>Land address (Thai)</label>
        <input value={addressTH} onChange={(e) => setAddressTH(e.target.value)} style={fullInput} />
      </div>
      <div style={fieldWrap}>
        <label style={lbl}>Legal clause text (→ S&P)</label>
        <textarea value={clauseText} onChange={(e) => setClause(e.target.value)} rows={4} placeholder="Permit / approval references, land terms & conditions — rendered into the Sale & Purchase agreement."
          style={{ ...fullInput, fontFamily: "inherit", resize: "vertical" }} />
        <span style={{ fontSize: 11.5, opacity: 0.6 }}>Prints verbatim as a “Land and Legal” section (§4A) in every S&P for this building; each line becomes a paragraph. Leave blank to omit the section.</span>
      </div>
      <div style={{ fontSize: 11.5, opacity: 0.6, marginBottom: 8 }}>
        The title-deed DOCUMENT upload &amp; “this is final” sealing is separate (Documents panel); these are the
        structured references beside it.
      </div>
      {needsCorrection ? (
        // On contract — a legal anchor can't be self-edited; it changes ONLY through a VRX-reviewed correction.
        <div style={{ ...fieldWrap, marginTop: 4, padding: 12, border: "1px solid #3a2a1a", borderRadius: 8, background: "#1c160d" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>This building is on contract</div>
          <p style={{ fontSize: 12, opacity: 0.8, margin: "0 0 8px", lineHeight: 1.5 }}>
            The title deed, survey page, land number and address are fixed once a building is on contract, so they
            can’t be edited here. To correct a genuine error, request a VRX review — your proposed correction, with
            a reason, is reviewed by VRX and all parties are notified with sealed before/after evidence.
          </p>
          <label style={lbl}>Why does this need correcting?</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
            placeholder="e.g. the survey page number was transcribed wrong at setup — the correct page is …"
            style={{ ...fullInput, fontFamily: "inherit", resize: "vertical", marginBottom: 8 }} />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" onClick={() => void requestCorrection()} disabled={busy}
              style={{ ...submitBtn, padding: "7px 16px", opacity: busy ? 0.6 : 1 }}>
              {busy ? "Requesting…" : "Request VRX correction"}
            </button>
            <button type="button" onClick={() => { setNeedsCorrection(false); setMsg(null); }} disabled={busy}
              style={{ ...pillBtn }}>
              Cancel
            </button>
            {msg && <span style={{ fontSize: 13, opacity: 0.8 }}>{msg}</span>}
          </div>
        </div>
      ) : (
        <SaveRow busy={busy} msg={msg} onSave={save} label="Save land & legal" />
      )}
    </div>
  );
}

// ── Direct-sale tab: flag the building visible to direct buyers + optional funnel copy ( §9 step 2) ───
function DirectSaleTab({ building, onSaved }: { building: Building; onSaved: () => void }) {
  const d = building.directSale ?? { visible: false };
  const [visible, setVisible] = useState(!!d.visible);
  const [funnelCopy, setCopy] = useState(d.funnelCopy ?? "");
  const { busy, msg, run } = useTabSave(onSaved);

  const save = () =>
    run(() => saveSection(building.id, "directSale", { visible, funnelCopy }), "Direct-sale visibility saved.");

  return (
    <div>
      <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", marginBottom: 6 }}>
        <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
        <span style={{ fontSize: 14 }}>Visible to direct buyers</span>
      </label>
      <p style={{ fontSize: 11.5, opacity: 0.65, marginTop: 0 }}>
        When on, a logged-in direct buyer can browse this building <strong>before</strong> talking to your
        desk — but only sees its <strong>photos, description, unit count and price range</strong>. No
        individual units, exact prices, availability or floor plans are shown until your operator opens
        specific units to that buyer from the chat. Off (the default) = the building is invisible to direct
        buyers entirely.
      </p>
      <div style={fieldWrap}>
        <label style={lbl}>Funnel copy (optional)</label>
        <textarea
          value={funnelCopy}
          onChange={(e) => setCopy(e.target.value)}
          rows={3}
          placeholder="A short pitch shown to direct buyers browsing this building before they reach your desk."
          style={{ ...fullInput, fontFamily: "inherit", resize: "vertical" }}
        />
      </div>
      <SaveRow busy={busy} msg={msg} onSave={save} label="Save direct-sale" />
    </div>
  );
}

// ── Seller-entity tab: pick/recall/author the reusable seller entity ( §3 Option A) ───────────────────
function SellerEntityTab({ developer, building, onSaved }: { developer: string; building: Building; onSaved: () => void }) {
  const [entities, setEntities] = useState<SellerEntity[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<SellerEntity | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const j = await fetch(`/api/seller-entities?developer=${encodeURIComponent(developer)}`).then((r) => r.json());
      setEntities(j.entities ?? []);
    } catch {
      /* leave as-is */
    } finally {
      setLoaded(true);
    }
  }, [developer]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function attach(id: string | null) {
    setBusy(true);
    setMsg(null);
    try {
      await saveSection(building.id, "sellerEntity", { sellerEntityId: id ?? "" });
      setMsg(id ? "Seller entity attached." : "Seller entity detached.");
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "could not save");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await fetch(`/api/seller-entities?developer=${encodeURIComponent(developer)}&id=${encodeURIComponent(id)}`, { method: "DELETE" });
    void refresh();
  }

  if (editing || creating) {
    return (
      <SellerEntityForm
        developer={developer}
        entity={editing}
        onClose={() => {
          setEditing(null);
          setCreating(false);
          void refresh();
        }}
      />
    );
  }

  const attachedId = building.sellerEntityId ?? null;

  return (
    <div>
      <div style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.55, marginBottom: 10 }}>
        The selling company for this building — the named “Seller” (Vendor) on every S&P for this building: its
        company name, director, tax ID and its accepted payment methods print into the agreement. Authored once
        and reusable: a company you saved before can be recalled for a new building. Each building can point at
        its own. Not attached → the S&P falls back to your developer legal name / account.
      </div>

      {!loaded && <div style={{ fontSize: 13, opacity: 0.6 }}>Loading…</div>}
      {loaded && entities.length === 0 && (
        <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 10 }}>No seller entities yet. Create one to attach it to this building.</div>
      )}

      {entities.map((e) => {
        const on = e.id === attachedId;
        return (
          <div key={e.id} style={{ border: `1px solid ${on ? "#2b62ff" : "#232838"}`, borderRadius: 10, padding: 12, marginBottom: 10, background: on ? "#141c2e" : "transparent" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{e.label}</div>
              <div style={{ fontSize: 12.5, opacity: 0.6 }}>{e.companyName}</div>
              <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                {on ? (
                  <button type="button" disabled={busy} onClick={() => void attach(null)} style={{ ...ghostBtn, border: "1px solid #2b62ff", color: "#9db4ff" }}>Attached ✓ — detach</button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => void attach(e.id)} style={ghostBtn}>Use for this building</button>
                )}
                <button type="button" onClick={() => setEditing(e)} style={ghostBtn}>Edit</button>
                <button type="button" onClick={() => void remove(e.id)} style={{ ...ghostBtn, color: "#e0a0a0", border: "1px solid #5a2a2a" }}>Delete</button>
              </div>
            </div>
            {(e.taxId || e.directorName) && (
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
                {e.directorName && <span style={{ marginRight: 12 }}>Director: {e.directorName}</span>}
                {e.taxId && <span>Tax ID: {e.taxId}</span>}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
        <button type="button" onClick={() => setCreating(true)} style={{ ...submitBtn, padding: "7px 16px" }}>+ New seller entity</button>
        {msg && <span style={{ fontSize: 13, opacity: 0.8 }}>{msg}</span>}
      </div>
    </div>
  );
}

// The create/edit form for one seller entity.
function SellerEntityForm({ developer, entity, onClose }: { developer: string; entity: SellerEntity | null; onClose: () => void }) {
  const [f, setF] = useState({
    label: entity?.label ?? "",
    companyName: entity?.companyName ?? "",
    companyNameTH: entity?.companyNameTH ?? "",
    address: entity?.address ?? "",
    addressTH: entity?.addressTH ?? "",
    email: entity?.email ?? "",
    telephone: entity?.telephone ?? "",
    taxId: entity?.taxId ?? "",
    directorName: entity?.directorName ?? "",
    bankPayable: entity?.bankPayable ?? "",
  });
  // A row with no label+destination is dropped on save; cleanSellerEntity validates/caps server-side and
  // migrates a legacy bankPayable if this list is empty. Local rows carry a temp id for React keys only —
  // a new row's real id is minted server-side (a blank id passes through to randomBytes).
  type OptRow = { id: string; kind: PaymentMethodKind; label: string; destination: string; instructions: string };
  const [opts, setOpts] = useState<OptRow[]>(
    (entity?.paymentOptions ?? []).map((o) => ({ id: o.id, kind: o.kind, label: o.label, destination: o.destination, instructions: o.instructions ?? "" }))
  );
  const addOpt = () => setOpts((p) => [...p, { id: `tmp-${Date.now()}-${p.length}`, kind: "bank", label: "", destination: "", instructions: "" }]);
  const setOpt = (i: number, k: keyof OptRow, v: string) => setOpts((p) => p.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const rmOpt = (i: number) => setOpts((p) => p.filter((_, j) => j !== i));

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      // Only send rows with a label + destination; strip the temp React id on NEW rows so the server mints a
      // stable one (an existing `pm-…` id is kept so edits don't churn the buyer's agreed pick).
      const paymentOptions = opts
        .filter((o) => o.label.trim() && o.destination.trim())
        .map((o) => ({
          ...(o.id.startsWith("tmp-") ? {} : { id: o.id }),
          kind: o.kind,
          label: o.label.trim(),
          destination: o.destination.trim(),
          ...(o.instructions.trim() ? { instructions: o.instructions.trim() } : {}),
        }));
      const res = await fetch("/api/seller-entities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ developer, id: entity?.id, ...f, paymentOptions }),
      });
      const j = await res.json();
      if (!res.ok) setErr(j.error || "save failed");
      else onClose();
    } catch {
      setErr("network error");
    } finally {
      setBusy(false);
    }
  }

  const Field = ({ k, label, ph }: { k: keyof typeof f; label: string; ph?: string }) => (
    <div style={{ ...fieldWrap, flex: 1, minWidth: 180 }}>
      <label style={lbl}>{label}</label>
      <input value={f[k]} onChange={set(k)} placeholder={ph} style={fullInput} />
    </div>
  );

  return (
    <div>
      <button type="button" onClick={onClose} style={{ ...ghostBtn, marginBottom: 12 }}>← Back to entities</button>
      <h4 style={{ fontSize: 15, margin: "0 0 12px" }}>{entity ? "Edit seller entity" : "New seller entity"}</h4>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field k="label" label="Label (how you pick it)" ph="e.g. Platinum Hill Co." />
        <Field k="companyName" label="Company name" ph="Registered company name" />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field k="companyNameTH" label="Company name (Thai)" />
        <Field k="taxId" label="Tax ID" />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field k="directorName" label="Director" />
        <Field k="bankPayable" label="Cheques payable to (legacy)" ph="optional — use payment methods below" />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field k="email" label="Email" />
        <Field k="telephone" label="Telephone" />
      </div>
      <Field k="address" label="Address" />
      <Field k="addressTH" label="Address (Thai)" />

      {/* accepted payment methods for this seller (per building's KYC). These print as the §2 payment
          term on the S&P; the buyer picks one. Any rail (bank / crypto / card / other) — a destination is the
          account/address to pay; VRX does not move the money, the buyer pays and records it. */}
      <div style={{ marginTop: 16, borderTop: "1px solid #232838", paddingTop: 14 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>Accepted payment methods</div>
        <div style={{ fontSize: 11.5, opacity: 0.65, lineHeight: 1.5, marginBottom: 10 }}>
          Where buyers of this building pay. These appear on the Sale &amp; Purchase agreement; the buyer chooses
          one. Add at least one before a deal can be marked ready to sign. A destination is your account / address
          / number — it is never published or placed on-chain.
        </div>
        {opts.map((o, i) => (
          <div key={o.id} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10, border: "1px solid #1d2332", borderRadius: 8, padding: 10 }}>
            <div style={{ ...fieldWrap, marginBottom: 0, minWidth: 120 }}>
              <label style={lbl}>Type</label>
              <select value={o.kind} onChange={(e) => setOpt(i, "kind", e.target.value)} style={{ ...fullInput, cursor: "pointer" }}>
                <option value="bank">Bank transfer</option>
                <option value="crypto">Crypto</option>
                <option value="card">Card</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div style={{ ...fieldWrap, marginBottom: 0, flex: 1, minWidth: 160 }}>
              <label style={lbl}>Label (buyer-facing)</label>
              <input value={o.label} onChange={(e) => setOpt(i, "label", e.target.value)} placeholder="e.g. Bangkok Bank (THB)" style={fullInput} />
            </div>
            <div style={{ ...fieldWrap, marginBottom: 0, flex: 1, minWidth: 160 }}>
              <label style={lbl}>Destination</label>
              <input value={o.destination} onChange={(e) => setOpt(i, "destination", e.target.value)} placeholder="account / address / number" style={fullInput} />
            </div>
            <div style={{ ...fieldWrap, marginBottom: 0, flex: 1, minWidth: 160 }}>
              <label style={lbl}>Instructions (optional)</label>
              <input value={o.instructions} onChange={(e) => setOpt(i, "instructions", e.target.value)} placeholder="e.g. reference your booking id" style={fullInput} />
            </div>
            <button type="button" onClick={() => rmOpt(i)} style={{ ...ghostBtn, color: "#e0a0a0", border: "1px solid #5a2a2a", marginBottom: 2 }}>Remove</button>
          </div>
        ))}
        <button type="button" onClick={addOpt} style={{ ...ghostBtn, padding: "6px 14px" }}>+ Add payment method</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
        <button type="button" onClick={() => void save()} disabled={busy || !f.label.trim() || !f.companyName.trim()} style={{ ...submitBtn, padding: "8px 18px", opacity: busy || !f.label.trim() || !f.companyName.trim() ? 0.6 : 1 }}>
          {busy ? "Saving…" : "Save entity"}
        </button>
        {err && <span style={{ fontSize: 13, color: "#e0a0a0" }}>{err}</span>}
      </div>
      <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 8 }}>Label &amp; company name are required; everything else is optional.</div>
    </div>
  );
}

// ── Furniture packs (developer-global, reusable) ────────────────────────────────────────────────────────

const REFERENCE_SQM = 50; // a neutral reference unit size for the library cost preview (per-m² × this).

export function FurniturePacksManager({ developer }: { developer: string }) {
  const money = useMoney();
  const [packs, setPacks] = useState<FurniturePack[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<FurniturePack | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [p, b] = await Promise.all([
        fetch(`/api/catalog/furniture-packs?developer=${encodeURIComponent(developer)}`).then((r) => r.json()),
        fetchCatalog(developer),
      ]);
      setPacks(p.packs ?? []);
      setBuildings(b);
    } catch {
      /* leave as-is */
    } finally {
      setLoaded(true);
    }
  }, [developer]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function remove(id: string) {
    await fetch(`/api/catalog/furniture-packs?developer=${encodeURIComponent(developer)}&id=${encodeURIComponent(id)}`, { method: "DELETE" });
    void refresh();
  }

  async function toggleBuilding(pack: FurniturePack, buildingId: string, attached: boolean) {
    await fetch("/api/catalog/furniture-packs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ developer, op: "attach", id: pack.id, building: buildingId, attached }),
    });
    void refresh();
  }

  if (editing || creating) {
    return (
      <PackEditor
        developer={developer}
        pack={editing}
        onClose={() => {
          setEditing(null);
          setCreating(false);
          void refresh();
        }}
      />
    );
  }

  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>🛋️ Furniture packs</h3>
        <span style={{ fontSize: 12.5, opacity: 0.6 }}>Reusable across your buildings — author once, offer on many.</span>
        <button type="button" onClick={() => setCreating(true)} style={{ ...submitBtn, padding: "6px 14px", marginLeft: "auto" }}>
          + New pack
        </button>
      </div>

      {!loaded && <div style={{ fontSize: 13, opacity: 0.6 }}>Loading…</div>}
      {loaded && packs.length === 0 && (
        <div style={{ fontSize: 13, opacity: 0.6 }}>No furniture packs yet. A pack is a set of priced items (flat or per-m²) you can offer on any building.</div>
      )}

      {packs.map((p) => (
        <div key={p.id} style={{ border: "1px solid #232838", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{p.label}</div>
            <div style={{ fontSize: 12.5, opacity: 0.6 }}>
              {p.items.length} item(s) · ≈ {money(furniturePackCost(p, REFERENCE_SQM))} for a {REFERENCE_SQM} m² unit
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button type="button" onClick={() => setEditing(p)} style={ghostBtn}>Edit</button>
              <button type="button" onClick={() => void remove(p.id)} style={{ ...ghostBtn, color: "#e0a0a0", border: "1px solid #5a2a2a" }}>Delete</button>
            </div>
          </div>
          <div style={{ fontSize: 12.5, opacity: 0.75, marginTop: 6 }}>
            {p.items.map((it, i) => (
              <span key={i} style={{ marginRight: 12 }}>
                {it.label} ({furnitureItemBasisLabel(it)}
                {it.basis === "flat" ? ` ${money(it.priceUsd)}` : ""})
              </span>
            ))}
          </div>

          {/* Attach: tick which buildings offer this pack. The "marked it so". */}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #1c2230" }}>
            <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 6 }}>Offered on:</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {buildings.map((b) => {
                const on = p.buildingIds.includes(b.id);
                return (
                  <label key={b.id} style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 5, opacity: on ? 1 : 0.7 }}>
                    <input type="checkbox" checked={on} onChange={(e) => void toggleBuilding(p, b.id, e.target.checked)} />
                    {b.name}
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

// The create/edit form for one pack.
function PackEditor({ developer, pack, onClose }: { developer: string; pack: FurniturePack | null; onClose: () => void }) {
  const money = useMoney();
  const [label, setLabel] = useState(pack?.label ?? "");
  const [items, setItems] = useState<FurnitureItem[]>(pack?.items ?? [{ label: "", basis: "per_sqm", ratePerSqmUsd: 0 }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function setItem(i: number, next: FurnitureItem) {
    setItems((its) => its.map((it, j) => (j === i ? next : it)));
  }
  function setBasis(i: number, basis: FurnitureItem["basis"]) {
    const cur = items[i];
    setItem(i, basis === "flat" ? { label: cur.label, basis: "flat", priceUsd: 0 } : { label: cur.label, basis: "per_sqm", ratePerSqmUsd: 0 });
  }
  function addItem() {
    setItems((its) => [...its, { label: "", basis: "flat", priceUsd: 0 }]);
  }
  function removeItem(i: number) {
    setItems((its) => its.filter((_, j) => j !== i));
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/catalog/furniture-packs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ developer, id: pack?.id, label, items, buildingIds: pack?.buildingIds ?? [] }),
      });
      const j = await res.json();
      if (!res.ok) setErr(j.error || "save failed");
      else onClose();
    } catch {
      setErr("network error");
    } finally {
      setBusy(false);
    }
  }

  const previewTotal = furniturePackCost({ items }, REFERENCE_SQM);

  return (
    <section style={card}>
      <button type="button" onClick={onClose} style={{ ...ghostBtn, marginBottom: 12 }}>← Back to packs</button>
      <h3 style={{ fontSize: 16, marginTop: 0 }}>{pack ? "Edit pack" : "New pack"}</h3>

      <label style={lbl}>Pack name</label>
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Full furnishing" style={{ ...input, marginBottom: 14, width: "100%", boxSizing: "border-box" }} />

      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Line items</div>
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={it.label}
            onChange={(e) => setItem(i, { ...it, label: e.target.value } as FurnitureItem)}
            placeholder="Item (e.g. Kitchen appliances)"
            style={{ ...input, flex: 2, minWidth: 150 }}
          />
          <select value={it.basis} onChange={(e) => setBasis(i, e.target.value as FurnitureItem["basis"])} style={{ ...input, width: 110 }}>
            <option value="flat">flat $</option>
            <option value="per_sqm">per m²</option>
          </select>
          {it.basis === "flat" ? (
            <input
              type="number"
              value={it.priceUsd || ""}
              onChange={(e) => setItem(i, { label: it.label, basis: "flat", priceUsd: Number(e.target.value) })}
              placeholder="USD"
              style={{ ...input, width: 110 }}
            />
          ) : (
            <input
              type="number"
              value={it.ratePerSqmUsd || ""}
              onChange={(e) => setItem(i, { label: it.label, basis: "per_sqm", ratePerSqmUsd: Number(e.target.value) })}
              placeholder="USD/m²"
              style={{ ...input, width: 110 }}
            />
          )}
          <button type="button" onClick={() => removeItem(i)} style={ghostBtn}>✕</button>
        </div>
      ))}
      <button type="button" onClick={addItem} style={ghostBtn}>+ item</button>

      <div style={{ marginTop: 14, fontSize: 13, opacity: 0.75 }}>
        Preview total for a {REFERENCE_SQM} m² unit: <b>{money(previewTotal)}</b>
        <span style={{ opacity: 0.6 }}> (per-m² items scale with each unit’s actual size)</span>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        <button type="button" onClick={() => void save()} disabled={busy || !label.trim()} style={{ ...submitBtn, padding: "8px 18px", opacity: busy || !label.trim() ? 0.6 : 1 }}>
          {busy ? "Saving…" : "Save pack"}
        </button>
        {err && <span style={{ fontSize: 13, color: "#e0a0a0" }}>{err}</span>}
      </div>
    </section>
  );
}

// ── Building read-only preview: which packs apply here + per-unit cost at the reference size ─────────────

export function BuildingFurniturePreview({ developer, building }: { developer: string; building: Building }) {
  const money = useMoney();
  const [packs, setPacks] = useState<FurniturePack[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/catalog/furniture-packs?developer=${encodeURIComponent(developer)}`)
      .then((r) => r.json())
      .then((j: { packs?: FurniturePack[] }) => {
        if (live) setPacks((j.packs ?? []).filter((p) => p.buildingIds.includes(building.id)));
      })
      .catch(() => {})
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [developer, building.id]);

  if (!loaded || packs.length === 0) return null; // absent-safe: nothing until packs are attached here

  // Reference unit size for the preview = the building's smallest unit-type min, or a neutral 50.
  const refSqm = building.unitTypes?.[0]?.sqmMin ?? REFERENCE_SQM;

  return (
    <section style={{ ...card, marginBottom: 16 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>🛋️ Furniture offered here</h3>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 10 }}>
        Manage packs in the Furniture packs menu. Costs below are for a {refSqm} m² unit; each unit’s S&P quotes its own size.
      </div>
      {packs.map((p) => (
        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderTop: "1px solid #1c2230" }}>
          <div style={{ fontSize: 14 }}>{p.label}</div>
          <div style={{ fontSize: 12.5, opacity: 0.6 }}>{p.items.length} item(s)</div>
          <div style={{ marginLeft: "auto", fontSize: 14, fontWeight: 600 }}>{money(furniturePackCost(p, refSqm))}</div>
        </div>
      ))}
    </section>
  );
}

// Local button styles (dark theme, matching the node console pills/ghosts).
const pillBtn: React.CSSProperties = {
  padding: "2px 11px",
  borderRadius: 999,
  fontSize: 12.5,
  cursor: "pointer",
  border: "1px solid #2a3350",
  background: "#18202f",
  color: "#c7cde0",
};
const ghostBtn: React.CSSProperties = {
  padding: "5px 11px",
  borderRadius: 7,
  fontSize: 12.5,
  cursor: "pointer",
  border: "1px solid #2a3350",
  background: "transparent",
  color: "#aab3c8",
};

// ── Per-booking furniture SELECTION ─────────────────────────────────────────────
// The buyer (via their agent) chooses ONE furniture pack for this booking. Drives off /api/claims/sp, which
// returns `furniturePick` (the packs offered on this building + the per-unit cost for THIS unit's m²) and the
// current `selectedPackId` — participant-scoped. Saves via /api/offers/furniture. Absent-safe: renders nothing
// when no packs are offered on the building. The chosen pack then shows as [selected] + a total on the S&P.

type PickOption = { packId: string; label: string; costUsd: number };

export function FurnitureSelector({ requestId, viewer }: { requestId: string; viewer: string }) {
  const money = useMoney();
  const [options, setOptions] = useState<PickOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/claims/sp?requestId=${encodeURIComponent(requestId)}&viewer=${encodeURIComponent(viewer)}`, { cache: "no-store" });
      if (!r.ok) {
        setLoaded(true);
        return;
      }
      const j = (await r.json()) as { furniturePick?: PickOption[]; selectedPackId?: string | null };
      setOptions(j.furniturePick ?? []);
      setSelected(j.selectedPackId ?? null);
    } catch {
      /* leave empty */
    } finally {
      setLoaded(true);
    }
  }, [requestId, viewer]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function choose(packId: string | null) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/offers/furniture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, viewer, packId: packId ?? "" }),
      });
      const j = await r.json();
      if (!r.ok) setMsg(j.error || "could not save");
      else {
        setSelected(packId);
        setMsg(packId ? "Furniture selected." : "Furniture cleared.");
      }
    } catch {
      setMsg("network error");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded || options.length === 0) return null; // absent-safe: no packs offered on this building

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid #1c2230` }}>
      <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 8 }}>Furniture package (optional)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={furnRow(selected === null)}>
          <input type="radio" name={`furn-${requestId}`} checked={selected === null} disabled={busy} onChange={() => void choose(null)} />
          <span>None</span>
        </label>
        {options.map((o) => (
          <label key={o.packId} style={furnRow(selected === o.packId)}>
            <input type="radio" name={`furn-${requestId}`} checked={selected === o.packId} disabled={busy} onChange={() => void choose(o.packId)} />
            <span style={{ flex: 1 }}>{o.label}</span>
            <span style={{ fontWeight: 600 }}>{money(o.costUsd)}</span>
          </label>
        ))}
      </div>
      {msg && <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>{msg}</div>}
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>Shown on the Sale &amp; Purchase agreement; priced for this unit’s size.</div>
    </div>
  );
}

function furnRow(on: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    padding: "6px 8px",
    borderRadius: 7,
    border: `1px solid ${on ? "#2b62ff" : "#232838"}`,
    background: on ? "#141c2e" : "transparent",
    cursor: "pointer",
  };
}
