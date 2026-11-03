"use client";

// OnChainLedgerPanel (V7-WISHLIST #5) — the developer-facing ON-CHAIN PROVENANCE lens. The FIRST
// UI consumer of the token/attestation event-replay views built + wired into GET /api/events.
//
// WHAT THIS IS (and is NOT): the sibling `DeveloperTokensPanel` is the MANAGEMENT surface — it reads
// /api/developer/tokens (the off-chain store: cash, economics, hand/sell/collect, to the
// developer). THIS panel is the PUBLIC-TRUTH surface — it reads only the event MIRROR (the opaque on-chain
// facts: custody trail, scarcity count, committed keys, vetting attestations). It answers "what does the
// chain publicly attest about my reservation capacity", not "what did I charge / collect".
//
// PRIVACY: the /api/events token + attestation views carry NO money / economics / seal_hash / terms /
// PII — the contract events structurally never emit them, and the route is test-guarded against it.
// So this panel can only render what's already public on-chain: token ids, account ids, opaque unit/building
// hashes, state + version codes. We never join to catalog names here (that enrichment lives in the
// developer's own party-private surfaces) — this is deliberately the opaque ledger.
//
// Read-only: no write path (the hand/sell/clawback actions live in DeveloperTokensPanel). Plain-fetch +
// card/T idiom (matches DeveloperTokensPanel / EventLog). Newest-first everywhere (lib/events already sorts).

import { useCallback, useEffect, useState } from "react";
import { card, mono } from "@/lib/ui";
import { T } from "@/lib/theme";

// ── Shapes echoed from GET /api/events (lib/events TokenView / AttestationView / RawEvent) ───────────────
type OnChainTokenState = "issued" | "held" | "committed" | "frozen" | "recycled";
type TokenView = {
  id: string;
  developer?: string;
  custody?: string;
  state: OnChainTokenState;
  committedKey?: string;
  exclusiveOrg?: string;
  recycleOf?: string;
  frozenFrom?: OnChainTokenState;
  issuedAt?: number;
  updatedAt: number;
};
type AttestationView = {
  node: string;
  building: string;
  kind: number;
  version: number;
  ratified: boolean;
  setAt: number;
  ratifiedAt?: number;
};
type RawEvent = { tx: string; at: number; logIndex: number; event: string; data: unknown };

// State → tone (reuses the on-chain status palette so it reads like the rest of the terminal).
const STATE_TONE: Record<OnChainTokenState, string> = {
  issued: T.open, // fresh capacity, available to hand down
  held: T.accent, // custody has moved, live
  committed: T.hold, // firmly securing a unit
  frozen: T.closed, // paused by its holder
  recycled: T.dim, // spent, returned to the developer
};
const STATE_LABEL: Record<OnChainTokenState, string> = {
  issued: "Issued",
  held: "In custody",
  committed: "Committed",
  frozen: "Frozen",
  recycled: "Recycled",
};

// A lifecycle event tag → a plain, mechanism-free verb. Unknown tags fall back to the raw tag so a
// future contract event still renders (honest) rather than vanishing.
// Tags are the EXACT ones lib/events.foldTokenView switches on (verified) — a drifted tag would just
// fall through to the raw tag, but matching keeps the trail readable.
const EVENT_VERB: Record<string, string> = {
  tokens_issued: "Issued by VRX",
  token_reissued: "Re-issued from spent capacity",
  token_handed: "Handed to a new holder",
  token_clawed_back: "Clawed back",
  token_committed: "Committed to secure a unit",
  token_released: "Released from its unit",
  exclusive_linked_to_token: "Linked to an exclusive hold",
  token_frozen: "Frozen by its holder",
  token_unfrozen: "Unfrozen",
  token_recycled: "Recycled back to the developer",
};

function shortAcct(a?: string): string {
  if (!a) return "—";
  return a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a;
}
function shortHash(h?: string): string {
  if (!h) return "—";
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
}
function when(at: number): string {
  if (!at) return "";
  const d = new Date(at);
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return d.toLocaleString(undefined, opts);
}

const refreshBtn: React.CSSProperties = {
  border: `1px solid ${T.border}`, background: T.panel2, color: T.text, cursor: "pointer",
  fontSize: 12, padding: "3px 14px", minHeight: 26, height: 26, lineHeight: 1, borderRadius: 999,
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.55, margin: "16px 0 8px" }}>{children}</div>;
}

export default function OnChainLedgerPanel({ me }: { me: string }) {
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [committed, setCommitted] = useState<TokenView[]>([]);
  const [attestations, setAttestations] = useState<AttestationView[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // One opened token's full provenance trail (newest-first). Lazy — fetched on click, cached by id.
  const [openId, setOpenId] = useState<string | null>(null);
  const [trails, setTrails] = useState<Record<string, RawEvent[]>>({});
  const [trailBusy, setTrailBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      // Four reads against the shared mirror — all cheap (file-backed, no RPC). We deliberately do NOT pass
      // sync=1: freshness is owned by the cron/poller (/api/events/sync), and a cold sync can hang on RPC —
      // riding it here would block the whole render (the "stuck on Loading" trap). The mirror is already
      // kept current server-side; this panel just reads it.
      const [tRes, lRes, cRes, aRes] = await Promise.all([
        fetch(`/api/events?developer=${encodeURIComponent(me)}`),
        fetch(`/api/events?developer=${encodeURIComponent(me)}&live=1`),
        fetch(`/api/events?committed=1`),
        fetch(`/api/events?node=${encodeURIComponent(me)}&attestations=1`),
      ]);
      if (!tRes.ok) throw new Error(`Failed (${tRes.status}).`);
      const tJson = (await tRes.json()) as { tokens?: TokenView[] };
      const lJson = lRes.ok ? ((await lRes.json()) as { count?: number }) : { count: undefined };
      const cJson = cRes.ok ? ((await cRes.json()) as { tokens?: TokenView[] }) : { tokens: [] };
      const aJson = aRes.ok ? ((await aRes.json()) as { attestations?: AttestationView[] }) : { attestations: [] };
      // committed=1 is GLOBAL (every developer's firm holds) — scope to mine for the "committed now" count.
      const mine = (cJson.tokens ?? []).filter((t) => (t.developer ?? "").toLowerCase() === me.toLowerCase());
      setTokens(tJson.tokens ?? []);
      setLiveCount(typeof lJson.count === "number" ? lJson.count : null);
      setCommitted(mine);
      setAttestations(aJson.attestations ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => { void load(); }, [load]);

  const openTrail = useCallback(async (id: string) => {
    if (openId === id) { setOpenId(null); return; } // toggle closed
    setOpenId(id);
    if (trails[id]) return; // cached
    setTrailBusy(true);
    try {
      const res = await fetch(`/api/events?token=${encodeURIComponent(id)}`);
      if (!res.ok) return; // 404 token_not_found → leave the row open with no trail
      const j = (await res.json()) as { events?: RawEvent[] };
      setTrails((prev) => ({ ...prev, [id]: j.events ?? [] }));
    } catch {
      /* leave uncached; a retry re-fetches */
    } finally {
      setTrailBusy(false);
    }
  }, [openId, trails]);

  if (err) {
    return (
      <section style={card}>
        <p style={{ color: T.danger, fontSize: 13 }}>{err}</p>
        <button type="button" onClick={() => void load()} disabled={loading} style={refreshBtn}>{loading ? "…" : "Retry"}</button>
      </section>
    );
  }
  if (!tokens) return <section style={card}><p style={{ opacity: 0.5, fontSize: 14 }}>{loading ? "Loading…" : "—"}</p></section>;

  const total = tokens.length;

  return (
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 0 }}>On-chain ledger</h2>
        <button type="button" onClick={() => void load()} disabled={loading} style={refreshBtn}>{loading ? "…" : "Refresh"}</button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.65, lineHeight: 1.5, margin: "6px 0 10px", maxWidth: 680 }}>
        The public on-chain record of your reservation capacity — custody trail, live scarcity, and your
        vetting attestations. This is the opaque truth anyone can verify on the chain; it carries no prices,
        terms or personal data (those stay in your private views).
      </p>

      {/* Scarcity header — the live / total numerator the chain exposes. */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "4px 0 8px" }}>
        <Stat label="Live capacity" value={liveCount ?? "—"} tone={T.vetted} hint="tokens occupying a scarcity slot (not recycled)" />
        <Stat label="Total tokens" value={total} tone={T.text} hint="every token VRX has issued to you" />
        <Stat label="Committed now" value={committed.length} tone={T.hold} hint="firmly securing a unit right now" />
      </div>

      {total === 0 && (
        <p style={{ opacity: 0.6, fontSize: 14 }}>No token events on-chain for you yet. Once VRX issues you capacity it appears here.</p>
      )}

      {/* The token list — click a row to expand its full provenance trail. */}
      {total > 0 && (
        <>
          <SectionTitle>Tokens · {total}</SectionTitle>
          <div style={{ display: "grid", gap: 6 }}>
            {tokens.map((t) => (
              <TokenRow
                key={t.id}
                token={t}
                open={openId === t.id}
                trail={trails[t.id]}
                trailBusy={trailBusy && openId === t.id && !trails[t.id]}
                onToggle={() => void openTrail(t.id)}
              />
            ))}
          </div>
        </>
      )}

      {/* Attestations — the node's vetting sign-offs over opaque building scopes. */}
      {attestations.length > 0 && (
        <>
          <SectionTitle>Vetting attestations · {attestations.length}</SectionTitle>
          <div style={{ display: "grid", gap: 6 }}>
            {attestations.map((a) => (
              <div
                key={`${a.building}-${a.kind}`}
                style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", fontSize: 13, padding: "6px 10px", borderRadius: 6, background: T.bg2 }}
              >
                <span style={{ ...mono, fontSize: 12.5, opacity: 0.85 }}>building {shortHash(a.building)}</span>
                <span style={{ display: "inline-flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <span style={{ opacity: 0.6, fontSize: 12 }}>v{a.version}</span>
                  {a.ratified ? (
                    <span style={{ color: T.vetted, fontSize: 12, fontWeight: 600 }}>✓ ratified</span>
                  ) : (
                    <span style={{ color: T.hold, fontSize: 12 }}>awaiting ratification</span>
                  )}
                  <span style={{ opacity: 0.5, fontSize: 11.5 }}>{when(a.ratifiedAt ?? a.setAt)}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// A small labelled stat chip for the scarcity header.
function Stat({ label, value, tone, hint }: { label: string; value: React.ReactNode; tone: string; hint: string }) {
  return (
    <div title={hint} style={{ padding: "8px 14px", borderRadius: 10, background: T.bg2, border: `1px solid ${T.borderSoft}`, minWidth: 120 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone, lineHeight: 1.1, ...mono }}>{value}</div>
      <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 2 }}>{label}</div>
    </div>
  );
}

// One token row + its lazily-loaded provenance trail (expands on click).
function TokenRow({
  token, open, trail, trailBusy, onToggle,
}: {
  token: TokenView;
  open: boolean;
  trail: RawEvent[] | undefined;
  trailBusy: boolean;
  onToggle: () => void;
}) {
  const tone = STATE_TONE[token.state] ?? T.text;
  return (
    <div style={{ borderRadius: 8, background: open ? T.panel2 : T.bg2, border: `1px solid ${open ? T.border : "transparent"}` }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer",
          display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", padding: "7px 10px", color: T.text,
        }}
      >
        <span style={{ ...mono, fontSize: 13.5, opacity: 0.9 }}>#{token.id}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: tone, display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: tone, display: "inline-block" }} />
          {STATE_LABEL[token.state]}
        </span>
        {token.custody && (
          <span style={{ fontSize: 12, opacity: 0.6 }}>held by <span style={mono}>{shortAcct(token.custody)}</span></span>
        )}
        {token.committedKey && (
          <span style={{ fontSize: 11.5, opacity: 0.6 }}>· unit <span style={mono}>{shortHash(token.committedKey)}</span></span>
        )}
        {token.exclusiveOrg && (
          <span style={{ fontSize: 11.5, opacity: 0.6 }}>· exclusive <span style={mono}>{shortAcct(token.exclusiveOrg)}</span></span>
        )}
        {token.recycleOf && <span style={{ fontSize: 11.5, opacity: 0.5 }}>· from #{token.recycleOf}</span>}
        <span style={{ marginLeft: "auto", fontSize: 11.5, opacity: 0.5, whiteSpace: "nowrap" }}>
          {when(token.updatedAt)} {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div style={{ padding: "2px 10px 10px", borderTop: `1px solid ${T.borderSoft}` }}>
          {trailBusy && <div style={{ fontSize: 12.5, opacity: 0.6, padding: "8px 2px" }}>Loading trail…</div>}
          {!trailBusy && trail && trail.length === 0 && (
            <div style={{ fontSize: 12.5, opacity: 0.6, padding: "8px 2px" }}>No lifecycle events recorded.</div>
          )}
          {!trailBusy && trail && trail.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 0, marginTop: 6 }}>
              {/* tokenHistory already returns the trail NEWEST-FIRST (lib/events.ts:381 reverses it), so
                  render as-is — do NOT reverse again. */}
              {trail.map((e, i) => (
                <div
                  key={`${e.tx}-${e.logIndex}`}
                  style={{
                    display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap",
                    padding: "6px 0", borderBottom: i === trail.length - 1 ? "none" : `1px solid ${T.borderSoft}`,
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: T.accent, display: "inline-block", flexShrink: 0, alignSelf: "center", opacity: 0.8 }} />
                  <span style={{ fontSize: 13, color: T.text, flex: 1, minWidth: 160 }}>
                    {EVENT_VERB[e.event] ?? e.event}
                  </span>
                  <span style={{ fontSize: 11.5, opacity: 0.5, whiteSpace: "nowrap" }}>{when(e.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
