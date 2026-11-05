"use client";

// Owner-gated onboarding screen — the FIRST write flow in the portal.
//
// The owner (Vetting Identity) provisions a vetted NODE (seller/operator) or ORG (agency)
// onto the live contract. register_node/register_org are OWNER-ONLY — a non-owner call
// reverts with E27 (NOT_OWNER). So this screen only works when the connected wallet IS the
// contract owner (calculating-hand.testnet on testnet).
//
// PRIVACY: the real profile details the operator types (name, contact, region…) are NEVER
// sent on-chain. We hash them off-chain (hashRef) and send only the opaque digest as the
// instance_hash / org_ref. The neutral account id is the on-chain handle.

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@/lib/wallet";
import { getOwner, hashRef, registerNodeArgs, registerOrgArgs } from "@/lib/vrx";
import { recordProvisioned } from "@/lib/provisioned";
import { useTxRun, TxProgress } from "@/components/TxAction";

type Kind = "node" | "org";

export default function Onboarding() {
  const { accountId, ready, signIn, callFunction } = useWallet();
  const [owner, setOwner] = useState<string | null>(null);

  const [kind, setKind] = useState<Kind>("node");
  const [id, setId] = useState("");
  const [profile, setProfile] = useState(""); // free-text off-chain details → hashed
  const { state, run, busy } = useTxRun();
  const [refShown, setRefShown] = useState<string | null>(null);

  useEffect(() => {
    getOwner().then(setOwner).catch(() => setOwner(null));
  }, []);

  const isOwner = !!accountId && !!owner && accountId === owner;

  const kindLabel = kind === "node" ? "Developer" : "Agency";

  async function submit() {
    const provisionedId = id.trim();
    if (!provisionedId) return;
    setRefShown(null);
    // Hash the off-chain profile → opaque ref. Empty profile still hashes deterministically.
    const ref = await hashRef({ kind, id: provisionedId, profile: profile.trim() }, `vrx-${kind}`);
    const ok = await run(
      async () => {
        const built =
          kind === "node"
            ? registerNodeArgs({ id: provisionedId, ref })
            : registerOrgArgs({ id: provisionedId, ref });
        // Owner is implicitly exempt (V5) → attach 0 deposit.
        const hash = await callFunction({ method: built.method, args: built.args, deposit: "0" });
        // Record locally so the Root-dashboard read view can list what this client provisioned.
        // Local bookkeeping only — no PII, just the neutral id + opaque ref already on-chain.
        recordProvisioned({ id: provisionedId, kind, ref, tx: hash || undefined });
        return hash;
      },
      { successNote: `${kindLabel} onboarded successfully.`, mapError: errText }
    );
    if (ok) {
      setRefShown(ref);
      setProfile("");
      setId("");
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Onboarding</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        Admit a vetted developer or agency to the platform. Only VRX can onboard participants. The
        profile details you enter are kept private and confidential.
      </p>

      <GateBanner
        ready={ready}
        accountId={accountId}
        owner={owner}
        isOwner={isOwner}
        signIn={signIn}
      />

      <section style={card}>
        <fieldset disabled={!isOwner || busy} style={{ border: "none", padding: 0, margin: 0 }}>
          <label style={lbl}>Who are you onboarding?</label>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            {(["node", "org"] as Kind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                style={{
                  ...pill,
                  ...(kind === k ? pillActive : {}),
                }}
              >
                {k === "node" ? "Developer" : "Agency"}
              </button>
            ))}
          </div>

          <label style={lbl}>
            Account id{" "}
            <span style={{ opacity: 0.6 }}>
              — the participant&apos;s wallet account
            </span>
          </label>
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. aboriginal-seed.testnet"
            style={input}
          />

          <label style={lbl}>
            Profile{" "}
            <span style={{ opacity: 0.6 }}>— name / contact / region, kept private</span>
          </label>
          <textarea
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            placeholder="Details for your own records — kept private and confidential."
            rows={4}
            style={{ ...input, fontFamily: "inherit", resize: "vertical" }}
          />

          <button type="button" onClick={submit} disabled={!isOwner || busy} style={submitBtn}>
            {busy ? "Signing…" : `Onboard ${kindLabel}`}
          </button>
        </fieldset>

        <TxProgress state={state} />

        {refShown && (
          <p style={{ opacity: 0.6, margin: "10px 0 0", fontSize: 13 }}>
            Reference:{" "}
            <code style={{ wordBreak: "break-all" }}>{refShown}</code>
          </p>
        )}
      </section>
    </main>
  );
}

function GateBanner({
  ready,
  accountId,
  owner,
  isOwner,
  signIn,
}: {
  ready: boolean;
  accountId: string | null;
  owner: string | null;
  isOwner: boolean;
  signIn: () => void;
}) {
  if (!ready) return null;
  if (!accountId) {
    return (
      <div style={{ ...banner, border: "1px solid #3a3f52" }}>
        Connect the admin wallet to onboard participants.{" "}
        <button onClick={signIn} style={{ ...pill, ...pillActive, marginLeft: 8 }}>
          Connect
        </button>
      </div>
    );
  }
  if (!isOwner) {
    return (
      <div style={{ ...banner, border: "1px solid #5a3a3a", background: "#22161a" }}>
        Connected as <code>{accountId}</code>, but the administrator account is{" "}
        <code>{owner ?? "…"}</code>. Only the administrator can onboard participants. Switch to the
        admin account in your wallet.
      </div>
    );
  }
  return (
    <div style={{ ...banner, border: "1px solid #2f5a3a", background: "#15221a" }}>
      Connected as administrator <code>{accountId}</code> — you can onboard developers and agencies.
    </div>
  );
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("E27")) return "Only the administrator can onboard participants.";
  if (/exists/i.test(msg)) return "That account is already onboarded.";
  if (/rejected|cancell?ed|user closed|denied/i.test(msg)) return "Request cancelled.";
  return "Something went wrong. Please try again.";
}

// ── styles ──
const card: React.CSSProperties = {
  marginTop: 20,
  padding: 22,
  borderRadius: 12,
  background: "#141824",
  border: "1px solid #232838",
};
const lbl: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  opacity: 0.8,
  marginBottom: 6,
};
const input: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  marginBottom: 16,
  borderRadius: 8,
  background: "#0e1119",
  border: "1px solid #2a2f40",
  color: "#e6e9ef",
  fontSize: 14,
};
const pill: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  background: "#0e1119",
  border: "1px solid #2a2f40",
  color: "#c7cde0",
  fontSize: 14,
  cursor: "pointer",
};
const pillActive: React.CSSProperties = {
  background: "#2b62ff",
  // full shorthand (not borderColor) so toggling pill↔pillActive doesn't mix
  // shorthand + longhand border props (React re-render styling warning).
  border: "1px solid #2b62ff",
  color: "#fff",
};
const submitBtn: React.CSSProperties = {
  ...pillActive,
  padding: "10px 18px",
  border: "none",
  cursor: "pointer",
  fontSize: 15,
};
const banner: React.CSSProperties = {
  marginTop: 18,
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid",
  background: "#141824",
  fontSize: 14,
};
