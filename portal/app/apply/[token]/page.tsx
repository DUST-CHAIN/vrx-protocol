"use client";

// Applicant self-apply page (Lane 2, step 3) — the AGENCY's surface.
// An agency opens this from the invite link (token in the URL), enters its self-custodied NEAR account
// and an off-chain profile, and submits. The application then sits PENDING for Vetted Realty to
// phone-vet and approve on the Root dashboard. This page is public (the unguessable token is the
// capability) — it never lists other applications.
// PRIVACY: the profile the agency types is stored OFF-CHAIN only; on approval, just its HASH is
// sent to register_org. The account id is the future Org id (self-custody). We do NOT ask the
// agency to sign here (open-Q #5 challenge-sign is a later hardening); submitting records the intent.

import { use, useEffect, useState } from "react";

type PublicApp = {
  token: string;
  status: "invited" | "applied" | "approved" | "rejected";
  label?: string;
  expiresAt: number;
  expired: boolean;
  account?: string;
};

export default function Apply({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [app, setApp] = useState<PublicApp | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [account, setAccount] = useState("");
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/applications/${token}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? "Invalid invite link." : "Could not load invite."))))
      .then((d) => setApp(d.application))
      .catch((e) => setLoadErr(e.message));
  }, [token]);

  async function submit() {
    setErr(null);
    if (!account.trim()) {
      setErr("Enter your NEAR account.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/applications/${token}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: account.trim(), profile: profile.trim() }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Submission failed.");
      setApp(d.application);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Submission failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "40px 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Agency application</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        You&apos;ve been invited to join the Vetted Realty network. Submit your details below; we&apos;ll
        verify by phone, then approve your account. Your details stay private — only an opaque reference is
        ever recorded on-chain.
      </p>

      {loadErr && <div style={{ ...banner, border: "1px solid #5a3a3a", background: "#22161a" }}>{loadErr}</div>}

      {app && <StatusPanel app={app} />}

      {app && app.status === "invited" && !app.expired && (
        <section style={card}>
          <fieldset disabled={busy} style={{ border: "none", padding: 0, margin: 0 }}>
            <label style={lbl}>
              Your NEAR account{" "}
              <span style={{ opacity: 0.6 }}>— self-custodied; you keep the keys. Reused across all developers.</span>
            </label>
            <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="e.g. your-agency.near" style={input} />

            <label style={lbl}>
              Agency profile <span style={{ opacity: 0.6 }}>— name, contact, region. Stays off-chain; only hashed on approval.</span>
            </label>
            <textarea
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              rows={5}
              placeholder="Agency name, contact person, phone, region…"
              style={{ ...input, fontFamily: "inherit", resize: "vertical" }}
            />

            <button type="button" onClick={submit} disabled={busy} style={submitBtn}>
              {busy ? "Submitting…" : "Submit application"}
            </button>
          </fieldset>
          {err && <p style={{ color: "#ff8080", marginTop: 12 }}>Error: {err}</p>}
        </section>
      )}
    </main>
  );
}

function StatusPanel({ app }: { app: PublicApp }) {
  if (app.status === "invited" && app.expired) {
    return <div style={{ ...banner, border: "1px solid #5a3a3a", background: "#22161a" }}>This invite has expired. Ask your Vetted Realty contact for a new one.</div>;
  }
  if (app.status === "applied") {
    return (
      <div style={{ ...banner, border: "1px solid #4a4a2a", background: "#22201a" }}>
        Application received for <code>{app.account}</code>. It&apos;s pending phone verification — we&apos;ll
        be in touch. Nothing is on-chain yet.
      </div>
    );
  }
  if (app.status === "approved") {
    return <div style={{ ...banner, border: "1px solid #2f5a3a", background: "#15221a" }}>✓ Approved — your agency <code>{app.account}</code> is registered. Developers can now grant you access.</div>;
  }
  if (app.status === "rejected") {
    return <div style={{ ...banner, border: "1px solid #5a3a3a", background: "#22161a" }}>This application was not approved. Please contact your Vetted Realty representative.</div>;
  }
  return null;
}

// ── styles (mirror the portal) ──
const card: React.CSSProperties = { marginTop: 20, padding: 22, borderRadius: 12, background: "#141824", border: "1px solid #232838" };
const lbl: React.CSSProperties = { display: "block", fontSize: 13, opacity: 0.8, marginBottom: 6 };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px 12px", marginBottom: 16, borderRadius: 8, background: "#0e1119", border: "1px solid #2a2f40", color: "#e6e9ef", fontSize: 14 };
const submitBtn: React.CSSProperties = { background: "#2b62ff", border: "none", color: "#fff", padding: "10px 18px", borderRadius: 8, cursor: "pointer", fontSize: 15 };
const banner: React.CSSProperties = { marginTop: 18, padding: "12px 14px", borderRadius: 10, border: "1px solid", background: "#141824", fontSize: 14 };
