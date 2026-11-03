"use client";

// Developer dashboard section (Phase 3) — "Buyer requirements": the developer chooses WHICH buyer-profile
// fields a direct buyer must provide (and seal) before making an offer on THIS developer's units. Writes
// Developer.requiredProfileFields via /api/developer/profile-requirements; the readiness resolver
// (lib/buyers-direct) already reads it, so ticking a box here immediately changes the buyer-side nudge +
// red-card "verification needed" cues for this developer (per-developer by design — §9).
//
// The DEFAULT set (full legal name, nationality, phone) is the FLOOR — always required, shown locked-on. A
// developer can only ADD fields (passport, national ID, address, email), never drop below the floor. All
// OFF-CHAIN; no PII here (this is which-fields config, not the values).

import { useCallback, useEffect, useState } from "react";
import { card, submitBtn } from "@/lib/ui";
import { T } from "@/lib/theme";

// Human labels for the profile field KEYS (mirror of the buyer page PROFILE_FIELDS / lib PROFILE_FIELD_KEYS).
const FIELD_LABEL: Record<string, string> = {
  legalName: "Full legal name",
  nationality: "Nationality",
  phone: "Phone",
  email: "Email",
  passportNo: "Passport no.",
  idCardNo: "National ID no.",
  address: "Residential address",
};
// Order shown in the panel (matches lib PROFILE_FIELD_KEYS).
const ALL_FIELDS = ["legalName", "nationality", "phone", "email", "passportNo", "idCardNo", "address"];

export default function BuyerRequirements({ me }: { me: string }) {
  const [required, setRequired] = useState<string[] | null>(null);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await fetch(`/api/developer/profile-requirements?developer=${encodeURIComponent(me)}`).then((r) => r.json());
      setRequired(j.required ?? []);
      setDefaults(j.defaults ?? []);
    } catch {
      setRequired([]);
    }
  }, [me]);

  useEffect(() => {
    void load();
  }, [load]);

  const isDefault = (k: string) => defaults.includes(k);
  const isOn = (k: string) => !!required?.includes(k);

  function toggle(k: string) {
    if (isDefault(k)) return; // the floor can't be turned off
    setRequired((prev) => {
      const set = new Set(prev ?? []);
      if (set.has(k)) set.delete(k);
      else set.add(k);
      return [...set];
    });
    setMsg(null);
  }

  async function save() {
    if (!required) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/developer/profile-requirements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ developer: me, fields: required }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not save");
      setRequired(j.required ?? required);
      setMsg("Saved — buyers will be asked for these before they can make an offer.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const extrasOn = (required ?? []).filter((k) => !isDefault(k)).length;

  return (
    <section style={card}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Buyer requirements</h2>
      <p style={{ fontSize: 13.5, opacity: 0.75, lineHeight: 1.55, margin: "0 0 16px", maxWidth: 620 }}>
        Choose what a buyer must provide (and seal in their profile) before they can make an offer on your units.
        Full legal name, nationality and phone are always required — you can ask for more. Changes apply
        immediately to how buyers are prompted on your developments.
      </p>

      {required === null ? (
        <p style={{ opacity: 0.6, fontSize: 13.5 }}>Loading…</p>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
            {ALL_FIELDS.map((k) => {
              const locked = isDefault(k);
              const on = isOn(k);
              return (
                <label
                  key={k}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 9,
                    border: `1px solid ${on ? T.accentSoft : T.border}`,
                    background: on ? "rgba(61,125,255,0.07)" : T.bg2,
                    cursor: locked ? "default" : "pointer",
                    opacity: locked ? 0.85 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={locked}
                    onChange={() => toggle(k)}
                    style={{ width: 16, height: 16, accentColor: T.accent, cursor: locked ? "default" : "pointer" }}
                  />
                  <span style={{ fontSize: 14 }}>{FIELD_LABEL[k] ?? k}</span>
                  {locked && (
                    <span style={{ marginLeft: "auto", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, color: T.faint }}>
                      always
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
            <button onClick={() => void save()} disabled={busy} style={submitBtn}>
              {busy ? "Saving…" : "Save requirements"}
            </button>
            <span style={{ fontSize: 12.5, opacity: 0.6 }}>
              {extrasOn === 0 ? "Using the standard set." : `${extrasOn} extra field${extrasOn === 1 ? "" : "s"} required.`}
            </span>
            {msg && <span style={{ fontSize: 13, opacity: 0.8 }}>{msg}</span>}
          </div>
        </>
      )}
    </section>
  );
}
