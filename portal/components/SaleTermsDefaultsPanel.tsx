"use client";

// HOUSE DEFAULT buyer-default / termination clause numbers: the figures that fill the §Default-and-Termination
// section of their buyers' S&P contracts (threshold %, cure-day floor, interest % p.a.).
// settlement terms (those are VRX-root-set, a separate surface). A developer sets a house default here; a
// specific building may override it on the building console (the 3-tier chain: building → this → code default).
// HOW "LEAVE BLANK = INHERIT" WORKS: an empty field is NOT saved as 0 — it falls through to the code default
// (12.5% / 30 days / 15% p.a., the real standard-SPA figures). The placeholder in each box shows the effective
// value currently in force, so "blank" reads honestly as "use the standard figure", not "zero".
// EFFECT: only NEW S&P contracts rendered from now on use the changed numbers; an already-sealed agreement
// keeps its frozen figures (same snapshot-at-signing discipline as every other per-developer term). The
// buyer-default advisory on the deal view reads the SAME resolved numbers, so the clause and the prompt agree.
// names or contract-speak. PRIVACY: off-chain; self-scoped through /api/developers (caller === me).

import { useCallback, useEffect, useState } from "react";
import { card, lbl, submitBtn, banner } from "@/lib/ui";
import { T } from "@/lib/theme";

type Terms = { defaultThresholdPct: number; cureDays: number; interestPctPerAnnum: number };

// What the developer typed. Empty string = "leave blank / inherit" (NOT zero).
type Draft = { defaultThresholdPct: string; cureDays: string; interestPctPerAnnum: string };

const EMPTY: Draft = { defaultThresholdPct: "", cureDays: "", interestPctPerAnnum: "" };

// Turn the stored partial override into editable text (absent field → "").
function draftFromStored(stored: Partial<Terms> | null | undefined): Draft {
  return {
    defaultThresholdPct: stored?.defaultThresholdPct != null ? String(stored.defaultThresholdPct) : "",
    cureDays: stored?.cureDays != null ? String(stored.cureDays) : "",
    interestPctPerAnnum: stored?.interestPctPerAnnum != null ? String(stored.interestPctPerAnnum) : "",
  };
}

// Parse a text field to a number for the POST body (blank/invalid → undefined so the server drops it).
function num(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

export default function SaleTermsDefaultsPanel({ me }: { me: string }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [stored, setStored] = useState<Partial<Terms> | null>(null);
  const [effective, setEffective] = useState<Terms | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!me) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/developers?account=${encodeURIComponent(me)}`);
      const data = await res.json();
      const tt = (data?.developer?.terminationTerms ?? null) as Partial<Terms> | null;
      setStored(tt);
      setDraft(draftFromStored(tt));
      setEffective((data?.effectiveTerminationTerms ?? null) as Terms | null);
    } catch {
      setMsg({ kind: "err", text: "Couldn't load your sale terms. Try again." });
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async () => {
    setSaving(true);
    setMsg(null);
    try {
      const terminationTerms = {
        defaultThresholdPct: num(draft.defaultThresholdPct),
        cureDays: num(draft.cureDays),
        interestPctPerAnnum: num(draft.interestPctPerAnnum),
      };
      const res = await fetch("/api/developers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caller: me, terminationTerms }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e?.error || "Save failed");
      }
      const data = await res.json();
      const tt = (data?.developer?.terminationTerms ?? null) as Partial<Terms> | null;
      setStored(tt);
      setDraft(draftFromStored(tt));
      setEffective((data?.effectiveTerminationTerms ?? null) as Terms | null);
      setMsg({ kind: "ok", text: "Saved. New sale contracts will use these figures." });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }, [draft, me]);

  const clearAll = useCallback(() => setDraft(EMPTY), []);

  const hasOverride =
    stored != null &&
    (stored.defaultThresholdPct != null || stored.cureDays != null || stored.interestPctPerAnnum != null);

  return (
    <section style={card}>
      <h2 style={{ fontSize: 18, margin: 0 }}>Your default sale terms</h2>
      <p style={{ opacity: 0.65, fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
        The standard figures that go into the <strong>Default and Termination</strong> part of your buyers&rsquo;
        sale &amp; purchase agreements — what happens if a buyer falls behind on payments. Leave a box blank to
        use the standard figure shown in grey. A building can set its own figures that override these.
      </p>

      {loading ? (
        <p style={{ opacity: 0.6, fontSize: 13 }}>Loading…</p>
      ) : (
        <>
          <div style={{ display: "grid", gap: 14, marginTop: 14, maxWidth: 560 }}>
            <Field
              label="When a buyer is in default"
              hint="The share of the price left unpaid that counts as a default (lets you serve a notice)."
              suffix="% of the price"
              value={draft.defaultThresholdPct}
              placeholder={effective ? String(effective.defaultThresholdPct) : "12.5"}
              onChange={(v) => setDraft((d) => ({ ...d, defaultThresholdPct: v }))}
            />
            <Field
              label="Time to put it right"
              hint="The least amount of time you&rsquo;ll give a buyer to fix a default after you serve notice."
              suffix="days (minimum)"
              value={draft.cureDays}
              placeholder={effective ? String(effective.cureDays) : "30"}
              onChange={(v) => setDraft((d) => ({ ...d, cureDays: v }))}
            />
            <Field
              label="Interest on overdue amounts"
              hint="The yearly interest you may charge on amounts a buyer has paid late."
              suffix="% per year"
              value={draft.interestPctPerAnnum}
              placeholder={effective ? String(effective.interestPctPerAnnum) : "15"}
              onChange={(v) => setDraft((d) => ({ ...d, interestPctPerAnnum: v }))}
            />
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={save} disabled={saving} style={{ ...submitBtn, padding: "7px 16px", fontSize: 13 }}>
              {saving ? "Saving…" : "Save"}
            </button>
            {(draft.defaultThresholdPct || draft.cureDays || draft.interestPctPerAnnum) && (
              <button
                type="button"
                onClick={clearAll}
                disabled={saving}
                style={{ ...submitBtn, padding: "7px 16px", fontSize: 13, background: T.panel2, color: T.dim }}
              >
                Clear (use standard figures)
              </button>
            )}
            <span style={{ fontSize: 12, opacity: 0.55 }}>
              {hasOverride ? "Using your own figures." : "Using the standard figures."}
            </span>
          </div>

          {msg && (
            <div
              style={{
                ...banner,
                marginTop: 14,
                fontSize: 13,
                borderColor: msg.kind === "ok" ? "rgba(56,211,159,0.4)" : "rgba(239,120,120,0.45)",
                color: msg.kind === "ok" ? T.vetted : "#ef9a9a",
              }}
            >
              {msg.text}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Field({
  label, hint, suffix, value, placeholder, onChange,
}: {
  label: string;
  hint: string;
  suffix: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ ...lbl, display: "block" }}>{label}</span>
      <span style={{ fontSize: 12, opacity: 0.55, display: "block", marginBottom: 6, lineHeight: 1.5 }}>{hint}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 120,
            padding: "7px 10px",
            borderRadius: 8,
            border: `1px solid ${T.border}`,
            background: T.panel2,
            color: T.text,
            fontSize: 14,
          }}
        />
        <span style={{ fontSize: 13, opacity: 0.6 }}>{suffix}</span>
      </span>
    </label>
  );
}
