"use client";

// VRX-ROOT AI Sales Director panel (the design docs §6). The operator's place to GOVERN the
// AI that runs the direct-sales desk: the master on/off, each consequential action's toggle (reveal / concession
// / call-off / block), the concession bound, the PII-scrub switch, and the daily spend cap. Reads + writes
// /api/root/ai-desk-config (operator-gated, same x-vrx-operator posture as the sibling root panels).
//
// The toggles ARE the guardrail (: autonomous-by-default, each switchable here). canBlock is the one
// that defaults OFF — blocking is permanent + un-anonymizing, so it's opt-in. PRIVACY: config only, no PII.

import { useCallback, useEffect, useState } from "react";
import { T } from "@/lib/theme";
import { card } from "@/lib/ui";

type Config = {
  enabled: boolean;
  autoReply: boolean;
  canRequestReveal: boolean;
  canConcede: boolean;
  canCallOff: boolean;
  canBlock: boolean;
  canOpenUnit: boolean;
  maxConcessionPct: number;
  piiScrubChat: boolean;
  spendCapTokensPerDay: number;
  signingPosture: "soft_hold" | "vault" | "demo_key";
};

//  slice 9 — how a unit hold is signed. "soft_hold" (default) = an off-chain sealed soft-hold, no approval.
// "vault" = the AI needs a one-time human sign-off per hold (the signing-vault authorization core). "demo_key"
// is reserved for the V7 on-chain leg (not wired). Rendered as a small select, not a toggle (it's 3-way).
const SIGNING_POSTURES: Array<{ value: Config["signingPosture"]; label: string; hint: string; disabled?: boolean }> = [
  { value: "soft_hold", label: "Soft-hold (default)", hint: "An off-chain sealed reservation. No sign-off needed — a stalled hold auto-releases." },
  { value: "vault", label: "Vault — require a one-time sign-off", hint: "Each autonomous hold needs a one-time human approval scoped to that unit (the signing vault). Still off-chain until the on-chain leg ships." },
  { value: "demo_key", label: "On-chain demo key (not yet available)", hint: "Reserved: sign the real on-chain grant with a server-held demo key. Needs the V7 contract.", disabled: true },
];

const TOGGLES: Array<{ key: keyof Config; label: string; hint: string }> = [
  { key: "enabled", label: "AI Sales Director (master)", hint: "Off = scripted concierge reply. On = the AI negotiates." },
  { key: "autoReply", label: "Auto-reply in chat", hint: "The AI posts replies on its own." },
  { key: "canRequestReveal", label: "Can request buyer info", hint: "AI may ask the buyer to share profile fields (buyer still consents)." },
  { key: "canConcede", label: "Can offer concessions", hint: "AI may offer a bounded discount / furniture-pack combo." },
  { key: "canCallOff", label: "Can propose call-off", hint: "AI may propose ending a deal (never auto-agrees)." },
  { key: "canBlock", label: "Can hard-block", hint: "AI may block a scammer. Permanent + un-anonymizing — default off." },
  { key: "canOpenUnit", label: "Can hold units", hint: "AI may autonomously hold a unit when booking. Off = it proposes a hold for a human to confirm. A stalled hold auto-releases." },
];

// The PII guard is shown INVERTED: the switch reads "Remove PII (personal information) guard", so ON = guard
// removed = the buyer's typed contact info passes through to the AI. Default (switch OFF) = guard ON = scrub.
const PII_TOGGLE = {
  label: "Remove PII (personal information) guard",
  hint: "Default off = chat PII (name/phone/email/id) is stripped before the AI sees it. Turn on to let contact info pass through.",
};

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 42, height: 24, borderRadius: 12, border: `1px solid ${T.border}`, cursor: "pointer",
        background: on ? T.accent : T.panel2, position: "relative", transition: "background .15s", flex: "0 0 auto",
      }}
      aria-pressed={on}
    >
      <span style={{
        position: "absolute", top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: "50%",
        background: "#fff", transition: "left .15s",
      }} />
    </button>
  );
}

export default function AiDeskPanel({ headers }: { headers: Record<string, string> | undefined }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/root/ai-desk-config", { headers });
      if (r.ok) setCfg((await r.json()) as Config);
      else setErr("locked — enter the operator key");
    } catch {
      setErr("could not load");
    }
  }, [headers]);

  useEffect(() => { void load(); }, [load]);

  const patch = useCallback(async (p: Partial<Config>) => {
    setSaving(true); setErr(null);
    // optimistic
    setCfg((c) => (c ? { ...c, ...p } : c));
    try {
      const r = await fetch("/api/root/ai-desk-config", {
        method: "POST",
        headers: { ...(headers ?? {}), "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      if (r.ok) setCfg((await r.json()) as Config);
      else setErr("save failed");
    } catch {
      setErr("save failed");
    } finally {
      setSaving(false);
    }
  }, [headers]);

  if (!cfg) {
    return <div style={card}><div style={{ color: T.dim, fontSize: 13 }}>{err ?? "Loading AI desk config…"}</div></div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={card}>
        <div style={{ fontSize: 13, color: T.dim, marginBottom: 12 }}>
          Governs the AI Sales Director on direct-sale desks. Autonomous by default — flip any capability off here.
          {saving ? " · saving…" : ""} {err ? <span style={{ color: "#e66" }}> · {err}</span> : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {TOGGLES.map((t) => (
            <div key={t.key} style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, color: T.text, fontWeight: t.key === "enabled" ? 600 : 400 }}>{t.label}</div>
                <div style={{ fontSize: 12, color: T.dim }}>{t.hint}</div>
              </div>
              <Switch on={cfg[t.key] as boolean} onClick={() => patch({ [t.key]: !(cfg[t.key] as boolean) } as Partial<Config>)} />
            </div>
          ))}
          {/* PII guard, shown inverted: switch ON = guard removed = piiScrubChat false. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, color: T.text }}>{PII_TOGGLE.label}</div>
              <div style={{ fontSize: 12, color: T.dim }}>{PII_TOGGLE.hint}</div>
            </div>
            <Switch on={!cfg.piiScrubChat} onClick={() => patch({ piiScrubChat: cfg.piiScrubChat ? false : true } as Partial<Config>)} />
          </div>

          {/* Signing posture (slice 9) — 3-way, so a select rather than a toggle. Only shown when holds are on. */}
          {cfg.canOpenUnit ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, color: T.text }}>How holds are signed</div>
                <div style={{ fontSize: 12, color: T.dim }}>
                  {SIGNING_POSTURES.find((p) => p.value === cfg.signingPosture)?.hint ?? ""}
                </div>
              </div>
              <select
                value={cfg.signingPosture}
                onChange={(e) => patch({ signingPosture: e.target.value as Config["signingPosture"] })}
                style={{
                  background: T.panel2, color: T.text, border: `1px solid ${T.border}`, borderRadius: 8,
                  padding: "6px 8px", fontSize: 13, flex: "0 0 auto", maxWidth: 220,
                }}
              >
                {SIGNING_POSTURES.map((p) => (
                  <option key={p.value} value={p.value} disabled={p.disabled}>{p.label}</option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      </div>

      <div style={card}>
        <label style={{ fontSize: 14, color: T.text, display: "block", marginBottom: 6 }}>
          Max concession: <b>{Math.round(cfg.maxConcessionPct * 100)}%</b> of price
        </label>
        <input
          type="range" min={0} max={30} step={1} value={Math.round(cfg.maxConcessionPct * 100)}
          onChange={(e) => patch({ maxConcessionPct: Number(e.target.value) / 100 })}
          style={{ width: "100%" }}
        />
        <div style={{ fontSize: 12, color: T.dim, marginTop: 4 }}>
          The hard ceiling on what the AI can give away (discount + furniture-pack value). The real guardrail.
        </div>
      </div>

      <div style={card}>
        <label style={{ fontSize: 14, color: T.text, display: "block", marginBottom: 6 }}>Daily token spend cap</label>
        <input
          type="number" min={0} step={10000} value={cfg.spendCapTokensPerDay}
          onChange={(e) => patch({ spendCapTokensPerDay: Math.max(0, Number(e.target.value) || 0) })}
          style={{ width: 160, background: T.panel2, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 8px", fontSize: 13 }}
        />
        <div style={{ fontSize: 12, color: T.dim, marginTop: 4 }}>Fail-closed: over the cap, the desk falls back to the scripted reply.</div>
      </div>
    </div>
  );
}
