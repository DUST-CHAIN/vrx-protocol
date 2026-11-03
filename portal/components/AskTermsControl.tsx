"use client";

// AskTermsControl — the overlay FORM affordance for a buyer who wants payment terms OUTSIDE the
// developer's published range. In-range plans the buyer sets themselves on the sliders (self-serve, deterministic,
// no AI). This is the ONE thing the sliders can't express: a figure beyond the caps or a bespoke structure. It
// files a /api/term-requests directly — NO AI turn, no confabulation risk — and the developer sees it on /node.
//
// Thin + buyer-authorized: the buyer names only their own account + the building; the server resolves the owning
// developer and (for a structured ask) range-checks it, refusing to file a pointless request for an in-range
// figure (telling the buyer to use the sliders instead). A free-text note always files. Quiet link → a small form.

import { useState } from "react";
import { T } from "@/lib/theme";

type Milestone = "depositPct" | "onContractPct" | "onKeyPct" | "instalments";

const MILESTONE_OPTS: { key: Milestone; label: string; unit: string }[] = [
  { key: "depositPct", label: "Deposit", unit: "%" },
  { key: "onContractPct", label: "On contract", unit: "%" },
  { key: "onKeyPct", label: "On handover", unit: "%" },
  { key: "instalments", label: "Instalments", unit: "" },
];

export default function AskTermsControl({
  account,
  building,
  onFiled,
}: {
  account: string;
  building: string;
  onFiled?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [milestone, setMilestone] = useState<Milestone | "">("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | "filed" | "inRange">(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    const askedValue = value.trim() === "" ? undefined : Number(value);
    if (milestone && (askedValue == null || !isFinite(askedValue))) {
      setErr("Enter the figure you'd like.");
      return;
    }
    if (!milestone && !note.trim()) {
      setErr("Describe the terms you'd like, or pick a figure above.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/term-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account,
          building,
          ...(milestone ? { milestone } : {}),
          ...(askedValue != null ? { askedValue } : {}),
          note: note.trim() || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.inRange) {
        setDone("inRange"); // the figure is within range — the buyer should just use the sliders
      } else if (j.filed) {
        setDone("filed");
        onFiled?.();
      } else {
        setErr(j.error || "Could not send — try again.");
      }
    } catch {
      setErr("Could not send — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done === "filed") {
    return (
      <div style={{ marginTop: 10, fontSize: 12, color: T.vetted, lineHeight: 1.5 }}>
        ✓ Sent to the developer. They&apos;ll review your request and reply in your chat with the desk.
      </div>
    );
  }
  if (done === "inRange") {
    return (
      <div style={{ marginTop: 10, fontSize: 12, color: T.dim, lineHeight: 1.5 }}>
        That figure is within the developer&apos;s published range — just set it on the plan above, no request needed.
      </div>
    );
  }

  const linkBtn = { background: "none", border: "none", color: T.faint, fontSize: 11.5, cursor: "pointer", padding: 0, textDecoration: "underline" } as const;
  const field = { fontSize: 12.5, padding: "6px 9px", borderRadius: 7, border: `1px solid ${T.border}`, background: T.bg2, color: T.text } as const;
  const activeMs = MILESTONE_OPTS.find((m) => m.key === milestone);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ ...linkBtn, marginTop: 10 }}>
        Need terms outside this range? Ask the developer →
      </button>
    );
  }

  return (
    <div style={{ marginTop: 12, padding: "11px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.bg2 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text, marginBottom: 8 }}>Ask the developer for different terms</div>
      <div style={{ fontSize: 11.5, color: T.dim, marginBottom: 10, lineHeight: 1.5 }}>
        Pick a figure beyond the published range, and/or describe what you&apos;d like. It goes straight to the developer to consider.
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <select value={milestone} onChange={(e) => setMilestone(e.target.value as Milestone | "")} style={{ ...field, flex: "1 1 140px" }}>
          <option value="">(a specific figure…)</option>
          {MILESTONE_OPTS.map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>
        {milestone ? (
          <input
            type="number"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={activeMs?.unit === "%" ? "e.g. 2" : "e.g. 36"}
            style={{ ...field, width: 110 }}
          />
        ) : null}
        {activeMs?.unit ? <span style={{ fontSize: 12.5, color: T.dim, alignSelf: "center" }}>{activeMs.unit}</span> : null}
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Anything to add? (e.g. 'I'd like to spread the balance over 3 years')"
        rows={2}
        style={{ ...field, width: "100%", resize: "vertical", marginBottom: 8, fontFamily: "inherit" }}
      />

      {err ? <div style={{ fontSize: 11.5, color: T.danger, marginBottom: 8 }}>{err}</div> : null}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          style={{ background: "none", border: `1px solid ${T.border}`, color: T.text, fontSize: 11.5, cursor: "pointer", padding: "5px 12px", borderRadius: 7 }}
        >
          {busy ? "Sending…" : "Send to developer"}
        </button>
        <button type="button" onClick={() => setOpen(false)} style={linkBtn}>Cancel</button>
      </div>
    </div>
  );
}
