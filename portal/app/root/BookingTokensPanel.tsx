"use client";

// VRX-ROOT booking-token ISSUANCE console (slice 7a). The operator surface for the two VRX-root-only
// powers over booking tokens: (1) set a developer's negotiable issuance-FEE config (per_token | allotment,
// with the scarcity cap), and (2) issue an allotment of fresh tokens against that cap. A sibling of the VRX
// terms editors (protocol fee / settlement window) — same operator-gated posture, same honest-fee framing.
//
// Design: the design docs §Issuance & monetization (decision #6). VRX is the SOLE ISSUER; the
// developer cannot mint. The fee is shown transparently (like the V5 protocol fee). Plain words: the
// operator sees "capacity", "fee", "issue" — no contract/hash mechanics.
//
// Reads/writes /api/root/booking-tokens (operator-gated, fail-closed). Plain fetch + useState idiom, matching
// the other root panels (PaymentsPanel / InventoryOversightPanel). `headers` carries the operator secret.

import { useCallback, useEffect, useMemo, useState } from "react";
import { T } from "@/lib/theme";
import { card, input } from "@/lib/ui";

type FeeModel = "per_token" | "allotment";
type Economics = "stake" | "prepaid" | "permission";

type Config = {
  developer: string; // "*" = house default
  developerName: string | null;
  model: FeeModel;
  feeMinor: number;
  currency: string;
  allotmentCap?: number;
  cap: number | null;
  liveCount: number | null; // null for the house default (no single developer to count)
  at: number;
};
type DevRow = { account: string; name: string };
type Resp = { configs: Config[]; developers: DevRow[] };

// Minor-unit money in the config's OWN currency (NEAR / USDC / THB …) — NOT the USD-base buyer display rail
// (lib/currency is the buyer system). The issuance fee is a B2B figure VRX sets per developer, so it formats in
// the operator-chosen currency. 2 decimal places (the common minor-unit scale); plain thousands separators.
function fmtMinor(amountMinor: number, currency: string): string {
  const major = amountMinor / 100;
  return `${major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

const refreshBtn: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  background: T.panel2,
  color: T.text,
  cursor: "pointer",
  fontSize: 12,
  padding: "3px 14px",
  minHeight: 26,
  height: 26,
  lineHeight: 1,
  borderRadius: 999,
};

const btnPrimary: React.CSSProperties = {
  background: T.accent,
  border: "none",
  color: "#fff",
  cursor: "pointer",
  fontSize: 13.5,
  padding: "8px 16px",
  borderRadius: 8,
};

export default function BookingTokensPanel({ headers }: { headers: Record<string, string> | undefined }) {
  const [resp, setResp] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/root/booking-tokens", { headers });
      if (res.status === 401) {
        setErr("Operator secret required (set it in ⚙ Settings).");
        setResp(null);
        return;
      }
      if (!res.ok) throw new Error(`Failed (${res.status}).`);
      setResp((await res.json()) as Resp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    load();
  }, [load]);

  if (err) {
    return (
      <section style={card}>
        <p style={{ color: T.danger, fontSize: 13 }}>{err}</p>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>
          {loading ? "…" : "Retry"}
        </button>
      </section>
    );
  }
  if (!resp) return <section style={card}><p style={{ opacity: 0.5, fontSize: 14 }}>{loading ? "Loading…" : "—"}</p></section>;

  const house = resp.configs.find((c) => c.developer === "*") ?? null;
  const overrides = resp.configs.filter((c) => c.developer !== "*").sort((a, b) => (a.developerName || a.developer).localeCompare(b.developerName || b.developer));

  return (
    <section style={{ ...card }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 0 }}>Booking tokens</h2>
        <button type="button" onClick={load} disabled={loading} style={refreshBtn}>{loading ? "…" : "Refresh"}</button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.65, lineHeight: 1.5, margin: "6px 0 16px", maxWidth: 680 }}>
        VRX issues scarce booking tokens to developers — metered reservation capacity they hand down to their
        agencies and field agents. Set each developer&rsquo;s issuance fee and capacity cap, then issue their
        allotment. The fee is shown to the developer transparently, like the protocol fee.
      </p>

      {/* ── Issuance-fee config (house default + per-developer overrides) ───────────────────────────── */}
      <div style={{ display: "grid", gap: 14 }}>
        <ConfigEditor
          title="House default"
          sub="Applies to any developer without their own rate. Required before issuing."
          existing={house}
          developers={resp.developers}
          scopeLocked="*"
          headers={headers}
          onSaved={load}
        />

        {overrides.length > 0 && (
          <div>
            <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.55, margin: "8px 0 6px" }}>
              Per-developer rates
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {overrides.map((c) => (
                <ConfigRow key={c.developer} c={c} developers={resp.developers} headers={headers} onSaved={load} />
              ))}
            </div>
          </div>
        )}

        <ConfigEditor
          title="Set a developer rate"
          sub="A negotiated rate overrides the house default for one developer (volume pricing for a big developer)."
          existing={null}
          developers={resp.developers}
          headers={headers}
          onSaved={load}
        />

        {/* ── Issue tokens ───────────────────────────────────────────────────────────────────────────── */}
        <IssueBox developers={resp.developers} configs={resp.configs} headers={headers} onIssued={load} />
      </div>
    </section>
  );
}

// ── A read row for an existing per-developer override (shows the live capacity picture + an edit toggle) ──
function ConfigRow({
  c, developers, headers, onSaved,
}: { c: Config; developers: DevRow[]; headers: Record<string, string> | undefined; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <ConfigEditor
        title={`Edit ${c.developerName || c.developer}`}
        sub=""
        existing={c}
        developers={developers}
        scopeLocked={c.developer}
        headers={headers}
        onSaved={() => { setEditing(false); onSaved(); }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  const capText = c.cap !== null ? `${c.liveCount ?? 0} live of ${c.cap}` : "no cap set";
  const overCap = c.cap !== null && (c.liveCount ?? 0) >= c.cap;
  return (
    <div style={{ ...card, marginTop: 0, padding: "12px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15 }}>{c.developerName || c.developer}</strong>
        <button type="button" onClick={() => setEditing(true)} style={{ ...refreshBtn, fontSize: 11.5 }}>Edit</button>
      </div>
      <div style={{ marginTop: 6, fontSize: 13.5, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span>
          <span style={{ opacity: 0.6 }}>Fee: </span>
          <strong>{fmtMinor(c.feeMinor, c.currency)}</strong>
          <span style={{ opacity: 0.55 }}> {c.model === "per_token" ? "per token" : "per period (allotment)"}</span>
        </span>
        <span style={{ color: overCap ? T.hold : T.dim }}>
          <span style={{ opacity: 0.6 }}>Capacity: </span>{capText}
        </span>
      </div>
    </div>
  );
}

// ── The config editor (shared by house-default, new-rate, and edit). VRX-root authors the fee. ──────────
function ConfigEditor({
  title, sub, existing, developers, scopeLocked, headers, onSaved, onCancel,
}: {
  title: string;
  sub: string;
  existing: Config | null;
  developers: DevRow[];
  scopeLocked?: string; // "*" for house; an account for an edit; undefined = free pick (new rate)
  headers: Record<string, string> | undefined;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [developer, setDeveloper] = useState(existing?.developer ?? scopeLocked ?? "");
  const [model, setModel] = useState<FeeModel>(existing?.model ?? "per_token");
  // Edit in MAJOR units in the input (human-friendly); convert to minor on save.
  const [feeMajor, setFeeMajor] = useState(existing ? String(existing.feeMinor / 100) : "");
  const [currency, setCurrency] = useState(existing?.currency ?? "USDC");
  const [cap, setCap] = useState(existing?.allotmentCap ? String(existing.allotmentCap) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const scopeIsHouse = scopeLocked === "*";
  const pickable = scopeLocked === undefined; // the free-pick "new rate" editor

  const save = async () => {
    setBusy(true);
    setMsg(null);
    setOk(false);
    try {
      const feeMinor = Math.round(Number(feeMajor) * 100);
      const config: Record<string, unknown> = {
        developer: scopeIsHouse ? "*" : developer.trim(),
        model,
        feeMinor,
        currency: currency.trim(),
      };
      if (cap.trim()) config.allotmentCap = Number(cap);
      const res = await fetch("/api/root/booking-tokens", {
        method: "POST",
        headers: { ...(headers ?? {}), "content-type": "application/json" },
        body: JSON.stringify({ op: "setConfig", config }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not save."); return; }
      setOk(true);
      setMsg("Saved.");
      onSaved();
    } catch {
      setMsg("Could not save.");
    } finally {
      setBusy(false);
    }
  };

  const allotment = model === "allotment";

  return (
    <div style={{ ...card, marginTop: 0, padding: "12px 14px", background: T.bg2 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      {sub && <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2, maxWidth: 560 }}>{sub}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 10 }}>
        {pickable && (
          <label style={{ fontSize: 12.5 }}>
            <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Developer</span>
            <select value={developer} onChange={(e) => setDeveloper(e.target.value)} style={{ ...input, marginBottom: 0, fontSize: 14 }}>
              <option value="">Select…</option>
              {developers.map((d) => <option key={d.account} value={d.account}>{d.name}</option>)}
            </select>
          </label>
        )}
        <label style={{ fontSize: 12.5 }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Charge model</span>
          <select value={model} onChange={(e) => setModel(e.target.value as FeeModel)} style={{ ...input, marginBottom: 0, fontSize: 14 }}>
            <option value="per_token">Per token</option>
            <option value="allotment">Allotment (per period)</option>
          </select>
        </label>
        <label style={{ fontSize: 12.5 }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>{allotment ? "Periodic fee" : "Fee per token"}</span>
          <input value={feeMajor} onChange={(e) => setFeeMajor(e.target.value)} placeholder="0.00" inputMode="decimal" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
        </label>
        <label style={{ fontSize: 12.5 }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Currency</span>
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="USDC" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
        </label>
        <label style={{ fontSize: 12.5 }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>
            Capacity cap{allotment ? "" : " (optional)"}
          </span>
          <input value={cap} onChange={(e) => setCap(e.target.value)} placeholder={allotment ? "e.g. 50" : "no cap"} inputMode="numeric" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
        </label>
      </div>
      {allotment && (
        <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 6 }}>
          Allotment: the developer pays the periodic fee for &ldquo;up to N active tokens&rdquo; — the cap is the product.
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
        <button type="button" onClick={save} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : "Save rate"}
        </button>
        {onCancel && <button type="button" onClick={onCancel} style={refreshBtn}>Cancel</button>}
        {msg && <span style={{ fontSize: 12.5, color: ok ? T.vetted : T.danger }}>{msg}</span>}
      </div>
    </div>
  );
}

// ── Issue an allotment of fresh tokens against a developer's cap ────────────────────────────────────────
function IssueBox({
  developers, configs, headers, onIssued,
}: { developers: DevRow[]; configs: Config[]; headers: Record<string, string> | undefined; onIssued: () => void }) {
  const [developer, setDeveloper] = useState("");
  const [count, setCount] = useState("");
  const [economics, setEconomics] = useState<Economics>("permission");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  // Only developers that HAVE a config (own override or the house default) can receive an issue — surface the
  // effective cap so the operator knows what's available before they issue.
  const hasHouse = configs.some((c) => c.developer === "*");
  const cfgFor = useMemo(() => {
    const own = configs.find((c) => c.developer === developer.toLowerCase());
    const house = configs.find((c) => c.developer === "*");
    return own ?? house ?? null;
  }, [configs, developer]);

  const issue = async () => {
    setBusy(true);
    setMsg(null);
    setOk(false);
    try {
      const res = await fetch("/api/root/booking-tokens", {
        method: "POST",
        headers: { ...(headers ?? {}), "content-type": "application/json" },
        body: JSON.stringify({ op: "issue", developer: developer.trim(), count: Number(count), economics }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j?.error || "Could not issue."); return; }
      setOk(true);
      setMsg(`Issued ${j.issued.length} token${j.issued.length === 1 ? "" : "s"} · ${j.liveCount} live of ${j.cap ?? "—"}.`);
      setCount("");
      onIssued();
    } catch {
      setMsg("Could not issue.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...card, marginTop: 0, padding: "12px 14px", borderColor: T.accentSoft }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Issue tokens</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2, maxWidth: 560 }}>
        Grant a developer fresh reservation capacity. Issuing counts against their cap; each token is stamped with
        the developer&rsquo;s issuance fee (per-token models). A developer must have a rate set first.
      </div>
      {!hasHouse && configs.length === 0 && (
        <div style={{ fontSize: 12.5, color: T.hold, marginTop: 8 }}>Set a house default or a developer rate first.</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 10 }}>
        <label style={{ fontSize: 12.5 }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Developer</span>
          <select value={developer} onChange={(e) => setDeveloper(e.target.value)} style={{ ...input, marginBottom: 0, fontSize: 14 }}>
            <option value="">Select…</option>
            {developers.map((d) => <option key={d.account} value={d.account}>{d.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12.5 }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>How many</span>
          <input value={count} onChange={(e) => setCount(e.target.value)} placeholder="e.g. 10" inputMode="numeric" style={{ ...input, marginBottom: 0, fontSize: 14 }} />
        </label>
        <label style={{ fontSize: 12.5 }}>
          <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>Default economics</span>
          <select value={economics} onChange={(e) => setEconomics(e.target.value as Economics)} style={{ ...input, marginBottom: 0, fontSize: 14 }}>
            <option value="permission">Permission (free)</option>
            <option value="stake">Stake (refundable)</option>
            <option value="prepaid">Prepaid (credited)</option>
          </select>
        </label>
      </div>
      {cfgFor && developer && (
        <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 6 }}>
          Effective cap: {cfgFor.allotmentCap ?? "none"} · fee {fmtMinor(cfgFor.feeMinor, cfgFor.currency)} {cfgFor.model === "per_token" ? "per token" : "per period"}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
        <button type="button" onClick={issue} disabled={busy || !developer || !count} style={{ ...btnPrimary, opacity: busy || !developer || !count ? 0.5 : 1 }}>
          {busy ? "Issuing…" : "Issue"}
        </button>
        {msg && <span style={{ fontSize: 12.5, color: ok ? T.vetted : T.danger }}>{msg}</span>}
      </div>
    </div>
  );
}
