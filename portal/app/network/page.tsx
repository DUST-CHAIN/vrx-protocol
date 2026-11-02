"use client";

// Network-wide provisioned view (layer #2) — the GLOBAL counterpart to /provisioned.
// /provisioned shows only what THIS client provisioned (local store). This page discovers EVERY node/org
// provisioned on the contract — regardless of which client did it — via the shared (public NearBlocks)
// indexer (lib/indexer.ts), then confirms each live against the chain (get_node/get_org). This closes the
// local store's blind spot without standing up our own indexer or adding on-chain list_* views (which
// would centralize load — keeps them only as a fallback).
// PRIVACY: only neutral account ids + opaque on-chain refs are shown (nothing else is on-chain).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getNode, getOrg } from "@/lib/vrx";
import { discoverProvisioned, type Discovered } from "@/lib/indexer";
import { CONTRACT_ID, EXPLORER_URL } from "@/lib/config";

type OnChain = { id: string; h?: string; r?: string; t: number; a: boolean } | null;
type Row = Discovered & { onchain: OnChain; state: "loading" | "confirmed" | "missing" | "error" };

export default function Network() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const found = await discoverProvisioned();
      setLoaded(true);
      setRows(found.map((d) => ({ ...d, onchain: null, state: "loading" as const })));
      const confirmed = await Promise.all(
        found.map(async (d): Promise<Row> => {
          try {
            const oc = (d.kind === "node" ? await getNode(d.id) : await getOrg(d.id)) as OnChain;
            return { ...d, onchain: oc, state: oc ? "confirmed" : "missing" };
          } catch {
            return { ...d, onchain: null, state: "error" };
          }
        })
      );
      setRows(confirmed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Indexer unreachable.");
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "40px 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Network</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        Every node and org provisioned on <code>{CONTRACT_ID}</code> — discovered via the shared
        indexer, then confirmed live on-chain. Unlike{" "}
        <Link href="/provisioned" style={{ color: "#7aa2ff" }}>Provisioned</Link> (this client only),
        this is the network-wide view. Only neutral ids + opaque refs are shown.
      </p>
      <p style={{ fontSize: 12, opacity: 0.55, marginTop: -6 }}>
        Note: on testnet the public indexer&apos;s account-transaction listing can be incomplete (it may
        miss or lag some registrations). Anything it does surface is re-confirmed live against the chain,
        so entries shown here are real — but absence here is not proof of absence on-chain. A self-hosted
        indexer consuming the NEP-297 <code>NodeRegistered</code>/<code>OrgRegistered</code> events is the
        eventual authoritative layer.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "16px 0" }}>
        <button type="button" onClick={refresh} disabled={loading} style={btn}>
          {loading ? "Discovering…" : "Refresh from indexer"}
        </button>
      </div>

      {err && (
        <div style={{ ...empty, borderColor: "#5a3a3a" }}>
          Couldn&apos;t reach the shared indexer ({err}). The indexer is a convenience layer — the chain
          is still the source of truth. Try again, or use{" "}
          <Link href="/provisioned" style={{ color: "#7aa2ff" }}>Provisioned</Link> for this client&apos;s
          own records.
        </div>
      )}

      {loaded && !err && rows.length === 0 && (
        <div style={empty}>No nodes or orgs discovered on the contract yet.</div>
      )}

      {rows.map((r) => (
        <article key={`${r.kind}:${r.id}`} style={rowCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <div>
              <span style={kindTag(r.kind)}>{r.kind === "node" ? "Node" : "Org"}</span>
              <code style={{ fontSize: 15, marginLeft: 8 }}>{r.id}</code>
            </div>
            <StateBadge state={r.state} active={r.onchain?.a} />
          </div>
          <div style={{ fontSize: 13, opacity: 0.75, marginTop: 8, lineHeight: 1.6 }}>
            {r.onchain && (r.onchain.h ?? r.onchain.r) && (
              <div>Opaque ref: <code style={{ wordBreak: "break-all" }}>{short(r.onchain.h ?? r.onchain.r ?? "")}</code></div>
            )}
            <div>Registered: {new Date(r.at).toLocaleString()}</div>
            <div>
              Tx:{" "}
              <a href={`${EXPLORER_URL}/transactions/${r.tx}`} target="_blank" rel="noreferrer" style={{ color: "#7aa2ff" }}>
                {short(r.tx)}
              </a>
            </div>
          </div>
        </article>
      ))}
    </main>
  );
}

function StateBadge({ state, active }: { state: Row["state"]; active?: boolean }) {
  if (state === "loading") return <span style={{ ...badge, ...badgeGray }}>checking…</span>;
  if (state === "error") return <span style={{ ...badge, ...badgeRed }}>chain error</span>;
  if (state === "missing") return <span style={{ ...badge, ...badgeRed }}>indexed, not on-chain</span>;
  return active ? <span style={{ ...badge, ...badgeGreen }}>active</span> : <span style={{ ...badge, ...badgeAmber }}>inactive</span>;
}

function short(h: string): string {
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

// ── styles (mirror /provisioned) ──
const btn: React.CSSProperties = { padding: "8px 14px", borderRadius: 8, background: "#0e1119", border: "1px solid #2a2f40", color: "#c7cde0", fontSize: 14, cursor: "pointer" };
const rowCard: React.CSSProperties = { padding: 16, marginBottom: 12, borderRadius: 12, background: "#141824", border: "1px solid #232838" };
const empty: React.CSSProperties = { padding: 22, borderRadius: 12, background: "#141824", border: "1px dashed #2a2f40", fontSize: 14, opacity: 0.85 };
const badge: React.CSSProperties = { fontSize: 12, padding: "3px 10px", borderRadius: 999, whiteSpace: "nowrap" };
const badgeGray: React.CSSProperties = { background: "#232838", color: "#9aa4bf" };
const badgeGreen: React.CSSProperties = { background: "#15271b", color: "#7ce0a0", border: "1px solid #2f5a3a" };
const badgeAmber: React.CSSProperties = { background: "#2a2413", color: "#ffcf70", border: "1px solid #5a4a1a" };
const badgeRed: React.CSSProperties = { background: "#26161a", color: "#ff9a9a", border: "1px solid #5a3a3a" };
const kindTag = (kind: "node" | "org"): React.CSSProperties => ({ fontSize: 11, padding: "2px 8px", borderRadius: 6, background: kind === "node" ? "#152030" : "#20182a", color: kind === "node" ? "#8ab6ff" : "#c79aff", border: `1px solid ${kind === "node" ? "#2a4a70" : "#4a2a6a"}` });
