"use client";

// Root-dashboard applications queue (Lane 2) — the OPERATOR's surface.
//
// Vetted Realty uses this to (1) generate an agency invite (link + QR), (2) watch applications come in,
// (3) approve or reject after phone-vetting. APPROVE is the only step that touches the chain: the owner
// signs register_org(account, hash-of-profile) in their wallet (key custody never leaves the wallet),
// then we record the tx + orgRef in the off-chain store. REJECT is off-chain only (never on-chain).
//
// PRIVACY: the raw profile lives in the off-chain store (portal/.data, gitignored) — the operator
// sees it here to vet; only its HASH is sent on-chain. The neutral-name guideline is a request, not
// enforceable on a self-custodied agency account.
//
// AUTH: operator endpoints are fenced by the x-vrx-operator header (VRX_OPERATOR_SECRET) — a demo-laptop
// gate, not real auth. The security-critical register_org is still owner-wallet-signed. See the API routes.

import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { useWallet } from "@/lib/wallet";
import { getOwner, hashRef, registerOrgArgs } from "@/lib/vrx";
import { recordProvisioned } from "@/lib/provisioned";
import { CONTRACT_ID, EXPLORER_URL } from "@/lib/config";
import { card, lbl, input, submitBtn, banner, mono } from "@/lib/ui";
import { readOperatorSecret, onOperatorSecretChange } from "@/lib/operator-secret";

type AppStatus = "invited" | "applied" | "approved" | "rejected";
type Application = {
  token: string;
  status: AppStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  label?: string;
  account?: string;
  profile?: string;
  orgRef?: string;
  tx?: string;
  rejectReason?: string;
};

// The operator secret now lives in ⚙ Settings (owner-only), shared via lib/operator-secret. This
// page just READS it + re-fetches when it changes there — the old inline SecretGate was retired so the
// secret is one quiet once-per-session setting instead of appearing on every owner page.

export default function Applications() {
  const { accountId, ready, signIn, callFunction } = useWallet();
  const [owner, setOwner] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [apps, setApps] = useState<Application[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    getOwner().then(setOwner).catch(() => setOwner(null));
    setSecret(readOperatorSecret());
    return onOperatorSecretChange(setSecret);
  }, []);

  const isOwner = !!accountId && !!owner && accountId === owner;
  const headers = useMemo(
    () => (secret ? { "x-vrx-operator": secret } : undefined),
    [secret]
  );

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const res = await fetch("/api/applications", { headers });
      if (res.status === 401) {
        setLoadErr("Operator secret required or incorrect — set it in ⚙ Settings.");
        setApps([]);
        return;
      }
      const d = await res.json();
      setApps(d.applications ?? []);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Failed to load.");
    }
  }, [headers]);

  useEffect(() => {
    load();
  }, [load]);

  async function createInvite(label: string) {
    const res = await fetch("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Failed to create invite.");
    await load();
  }

  async function reject(token: string, reason: string) {
    await fetch(`/api/applications/${token}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify({ decision: "reject", reason }),
    });
    await load();
  }

  // APPROVE = owner-sign register_org, then record. Requires the owner wallet connected.
  async function approve(app: Application) {
    if (!app.account) throw new Error("No account on this application.");
    if (!isOwner) throw new Error("Connect the owner wallet to approve (register_org is owner-signed).");
    const ref = await hashRef({ kind: "org", account: app.account, profile: app.profile ?? "" }, "vrx-org");
    const built = registerOrgArgs({ id: app.account, ref });
    const tx = await callFunction({ method: built.method, args: built.args, deposit: "0" });
    // Mirror the onboarding local-store record so /provisioned shows it too.
    recordProvisioned({ id: app.account, kind: "org", ref, tx: tx || undefined });
    await fetch(`/api/applications/${app.token}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify({ decision: "approve", orgRef: ref, tx }),
    });
    await load();
  }

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "40px 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Agency applications</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        Invite agencies, vet them by phone, then approve — approval signs{" "}
        <code>register_org</code> on <code>{CONTRACT_ID}</code> (owner-signed, D43). Raw profiles stay
        off-chain; only an opaque reference is recorded on-chain (D3).
      </p>

      {loadErr && (
        <div style={{ ...banner, border: "1px solid #5a2a2a", background: "#221a1a", color: "#ff8080", fontSize: 13 }}>
          {loadErr}
        </div>
      )}

      <OwnerNote ready={ready} accountId={accountId} owner={owner} isOwner={isOwner} signIn={signIn} />

      <NewInvite onCreate={createInvite} disabled={!!loadErr} />

      <section style={{ marginTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 18 }}>Queue</h2>
          <button type="button" onClick={load} style={{ ...submitBtn, padding: "6px 12px", fontSize: 13 }}>
            Refresh
          </button>
        </div>
        {apps.length === 0 && !loadErr && (
          <p style={{ opacity: 0.6, fontSize: 14 }}>No applications yet. Generate an invite above.</p>
        )}
        {apps.map((a) => (
          <AppCard key={a.token} app={a} isOwner={isOwner} onApprove={approve} onReject={reject} />
        ))}
      </section>
    </main>
  );
}

function OwnerNote({
  ready, accountId, owner, isOwner, signIn,
}: { ready: boolean; accountId: string | null; owner: string | null; isOwner: boolean; signIn: () => void }) {
  if (!ready) return null;
  if (isOwner) return null;
  return (
    <div style={{ ...banner, border: "1px solid #5a4a2a", background: "#22201a" }}>
      {accountId
        ? <>Connected as <code>{accountId}</code>, not the owner (<code>{owner ?? "…"}</code>). You can invite and reject, but <strong>approving</strong> needs the owner wallet (register_org is owner-signed).</>
        : <>You can invite and reject now. <strong>Approving</strong> needs the owner wallet — <button onClick={signIn} style={{ ...submitBtn, padding: "4px 10px", fontSize: 12 }}>Connect</button></>}
    </div>
  );
}

function NewInvite({ onCreate, disabled }: { onCreate: (label: string) => Promise<void>; disabled: boolean }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setErr(null);
    setBusy(true);
    try {
      await onCreate(label.trim());
      setLabel("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section style={card}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>New invite</h2>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <label style={lbl}>Label <span style={{ opacity: 0.6 }}>— who this invite is for (your note; off-chain)</span></label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sunrise Realty (call 5pm)" style={{ ...input, marginBottom: 0 }} />
        </div>
        <button type="button" onClick={go} disabled={busy || disabled} style={submitBtn}>
          {busy ? "…" : "Generate invite"}
        </button>
      </div>
      {err && <p style={{ color: "#ff8080", fontSize: 13 }}>{err}</p>}
    </section>
  );
}

function AppCard({
  app, isOwner, onApprove, onReject,
}: {
  app: Application;
  isOwner: boolean;
  onApprove: (a: Application) => Promise<void>;
  onReject: (token: string, reason: string) => Promise<void>;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const link = typeof window !== "undefined" ? `${window.location.origin}/apply/${app.token}` : "";

  useEffect(() => {
    if (app.status === "invited" && link) {
      QRCode.toDataURL(link, { margin: 1, width: 160 }).then(setQr).catch(() => setQr(null));
    }
  }, [app.status, link]);

  async function act(fn: () => Promise<void>) {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article style={{ ...card, marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div>
          <StatusBadge status={app.status} />
          {app.label && <span style={{ marginLeft: 10, fontSize: 14 }}>{app.label}</span>}
        </div>
        <span style={{ fontSize: 12, opacity: 0.6 }}>{new Date(app.updatedAt).toLocaleString()}</span>
      </div>

      {app.status === "invited" && (
        <div style={{ display: "flex", gap: 16, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
          {qr && <img src={qr} alt="invite QR" width={130} height={130} style={{ borderRadius: 8, background: "#fff", padding: 4 }} />}
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>Share this link (or scan the QR into a mobile wallet):</div>
            <code style={{ ...mono, fontSize: 12, wordBreak: "break-all" }}>{link}</code>
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => { navigator.clipboard?.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                style={{ ...submitBtn, padding: "5px 12px", fontSize: 13 }}
              >
                {copied ? "Copied ✓" : "Copy link"}
              </button>
              <span style={{ fontSize: 12, opacity: 0.6, alignSelf: "center" }}>
                expires {new Date(app.expiresAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
      )}

      {app.account && (
        <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.7 }}>
          <div>Account: <code>{app.account}</code></div>
          {app.profile && (
            <div style={{ opacity: 0.75 }}>
              Profile (off-chain, for vetting): <span style={{ whiteSpace: "pre-wrap" }}>{app.profile}</span>
            </div>
          )}
          {app.orgRef && <div style={{ opacity: 0.6 }}>On-chain ref: <code style={mono}>{app.orgRef.slice(0, 14)}…</code></div>}
          {app.tx && (
            <div>Tx: <a href={`${EXPLORER_URL}/transactions/${app.tx}`} target="_blank" rel="noreferrer" style={{ color: "#7aa2ff" }}>{app.tx.slice(0, 12)}…</a></div>
          )}
          {app.rejectReason && <div style={{ color: "#ffcf70" }}>Reason: {app.rejectReason}</div>}
        </div>
      )}

      {app.status === "applied" && (
        <fieldset disabled={busy} style={{ border: "none", padding: 0, margin: "12px 0 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => act(() => onApprove(app))}
            disabled={!isOwner}
            title={isOwner ? "Owner-sign register_org and approve" : "Connect the owner wallet to approve"}
            style={{ ...submitBtn, background: isOwner ? "#2f7a4a" : "#2a3a30", cursor: isOwner ? "pointer" : "not-allowed" }}
          >
            {busy ? "…" : "Approve (owner-sign register_org)"}
          </button>
          <button
            type="button"
            onClick={() => { const r = prompt("Rejection reason (optional):") ?? ""; act(() => onReject(app.token, r)); }}
            style={{ ...submitBtn, background: "#0e1119", border: "1px solid #5a3a3a", color: "#ff9a9a" }}
          >
            Reject
          </button>
        </fieldset>
      )}

      {err && <p style={{ color: "#ff8080", fontSize: 13, marginTop: 8 }}>Error: {err}</p>}
    </article>
  );
}

function StatusBadge({ status }: { status: AppStatus }) {
  const map: Record<AppStatus, { bg: string; fg: string; label: string }> = {
    invited: { bg: "#232838", fg: "#9aa4bf", label: "invited" },
    applied: { bg: "#2a2413", fg: "#ffcf70", label: "pending vetting" },
    approved: { bg: "#15271b", fg: "#7ce0a0", label: "approved" },
    rejected: { bg: "#26161a", fg: "#ff9a9a", label: "rejected" },
  };
  const s = map[status];
  return <span style={{ fontSize: 12, padding: "3px 10px", borderRadius: 999, background: s.bg, color: s.fg }}>{s.label}</span>;
}
