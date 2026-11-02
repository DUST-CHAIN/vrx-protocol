"use client";

// DirectEnquiries — the DESK side of the buyer↔desk funnel ( §9 step 3). The developer's incoming
// direct-buyer enquiry list + reply chat, reusing the generalized channel store via /api/conversations-direct.
// The buyer side lives in app/buyer/page.tsx (DeskChat); this is its mirror for whoever runs the desk (the
// building's developer, in-house first —: the desk IS a captive agency, no new operator actor).
// Master-detail: a list of enquiries (one per buyer×building) on the left, the selected thread on the right.
// Transport = poll + the opaque channelTopic SSE push, same as DealChat. Bodies off-chain.

import { useCallback, useEffect, useRef, useState } from "react";
import { card, input, submitBtn } from "@/lib/ui";
import { useMoney } from "@/lib/currency";
import { T } from "@/lib/theme";
import { timeAgo, unitRef } from "@/lib/catalog-client";
import { useEventStream } from "@/lib/useEventStream";
import { useNotifier } from "@/lib/useNotifier";
import { channelTopic } from "@/lib/channel-topic";
import { useWallet } from "@/lib/wallet";
import { useTxRun, TxProgress } from "@/components/TxAction";
import CallOffControl from "@/components/CallOffControl";
import EscalateControl from "@/components/EscalateControl";
import SaleContractButton from "@/components/SaleContractButton";
// slice 4 — the direct desk reuses the agent-path tailoring editors VERBATIM (one shared component).
import { DealTailoringControls, type OfferRecord } from "@/components/OfferTailoring";
import { hashRef, grantExclusiveArgs, daysToWindowNs, depositFor, registerOrgArgs, grantGateArgs, getTile } from "@/lib/vrx";

type Row = {
  conversationId: string;
  building: string;
  buildingName: string;
  counterpart: string;
  role: "developer" | "buyer";
  msgCount: number;
  lastMsg: { from: string; text: string; at: number } | null;
};
type Msg = { id: string; from: string; by: string; text: string; at: number };

/** Cheap signature of the enquiry list — if unchanged between polls, we skip the re-render entirely. */
function rowsSig(rows: Row[]): string {
  return rows.map((r) => `${r.conversationId}:${r.msgCount}:${r.lastMsg?.at ?? 0}`).join("|");
}

export default function DirectEnquiries({ me }: { me: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  // server read-markers so an UNREAD dot shows per row AND a new buyer message alerts even when that
  const [seenMap, setSeenMap] = useState<Record<string, number>>({});
  const notify = useNotifier();
  // when a row's buyer-side message count GROWS past what we last observed.
  const observedRef = useRef<Record<string, number>>({});
  const primedRef = useRef(false);

  const loadSeen = useCallback(async () => {
    try {
      const j = await fetch(`/api/conversations/seen?viewer=${encodeURIComponent(me)}`).then((r) => r.json());
      if (j.seen && typeof j.seen === "object") setSeenMap(j.seen as Record<string, number>);
    } catch {
      /* transient */
    }
  }, [me]);

  const loadList = useCallback(async () => {
    try {
      const j = await fetch(`/api/conversations-direct/list?viewer=${encodeURIComponent(me)}`).then((r) => r.json());
      const next: Row[] = j.rows ?? [];
      // Alert on a genuinely NEW incoming (buyer) message in ANY thread — even one that isn't selected. A row's
      // newest message being from the buyer AND its count exceeding what we last saw = a fresh buyer message.
      if (!primedRef.current) {
        primedRef.current = true;
        for (const r of next) observedRef.current[r.conversationId] = r.msgCount;
      } else {
        for (const r of next) {
          const prevCount = observedRef.current[r.conversationId] ?? 0;
          const fromBuyer = r.lastMsg?.from === "buyer";
          if (r.msgCount > prevCount && fromBuyer) {
            notify(
              `New enquiry — ${r.buildingName}`,
              r.lastMsg?.text?.slice(0, 120) ?? "A buyer messaged your desk",
              { tag: `vrx-direct-${r.conversationId}`, repeat: 3, href: `/node?section=enquiries` }
            );
          }
          observedRef.current[r.conversationId] = r.msgCount;
        }
      }
      // Only replace state when the list actually changed (by a cheap signature) — a fresh array every poll
      // would re-render the whole master-detail (and churn the selected row) for nothing.
      setRows((prev) => (prev && rowsSig(prev) === rowsSig(next) ? prev : next));
    } catch {
      setRows((prev) => prev ?? []);
    }
  }, [me, notify]);

  useEffect(() => {
    void loadList();
    void loadSeen();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadList();
        void loadSeen();
      }
    }, 20_000);
    return () => clearInterval(t);
  }, [loadList, loadSeen]);

  // Any direct thread moving nudges the list (a new enquiry appears / re-sorts). The per-thread push is
  // handled inside the open chat; this keeps the LIST fresh.
  useEventStream((ev) => {
    if (typeof ev.topic === "string" && ev.topic.startsWith("channel:")) {
      void loadList();
      void loadSeen();
    }
  });

  // A row is UNREAD for the desk when it has more messages than we've marked seen AND the newest is the buyer's.
  const isRowUnread = useCallback(
    (r: Row) => r.msgCount > (seenMap[r.conversationId] ?? 0) && r.lastMsg?.from === "buyer",
    [seenMap]
  );

  // Selecting a row marks it seen at its current count (monotonic server write) → clears the dot + the badge.
  const selectRow = useCallback(
    (r: Row) => {
      setSel(r.conversationId);
      setSeenMap((m) => ({ ...m, [r.conversationId]: Math.max(m[r.conversationId] ?? 0, r.msgCount) }));
      void fetch("/api/conversations/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewer: me, conversationId: r.conversationId, count: r.msgCount, kind: "direct" }),
      }).catch(() => {});
    },
    [me]
  );

  const selectedRow = rows?.find((r) => r.conversationId === sel) ?? null;

  return (
    <section style={{ ...card }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Direct enquiries</h2>
      <p style={{ fontSize: 13, opacity: 0.7, marginTop: 0, lineHeight: 1.5 }}>
        Walk-in buyers who messaged your desk after browsing your direct-sale buildings. Reply here; you&apos;ll
        open specific units to a buyer from the conversation once you&apos;ve vetted them.
      </p>

      <HouseOrgSetup me={me} />

      {rows === null ? (
        <p style={{ opacity: 0.6 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ opacity: 0.6 }}>No direct enquiries yet. They&apos;ll appear here when a buyer messages your desk.</p>
      ) : (
        <div className="vrx-master-detail" style={{ display: "grid", gridTemplateColumns: "minmax(210px, 280px) 1fr", gap: 14 }}>
          <div className="vrx-md-list" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rows.map((r) => {
              const active = r.conversationId === sel;
              const unread = isRowUnread(r);
              return (
                <button
                  key={r.conversationId}
                  onClick={() => selectRow(r)}
                  style={{
                    textAlign: "left",
                    padding: "8px 10px",
                    borderRadius: 9,
                    border: `1px solid ${active ? "#2b62ff" : unread ? "#2b62ff" : T.border}`,
                    background: active ? T.panel2 : T.bg2,
                    color: T.text,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: unread ? 700 : 600, display: "flex", alignItems: "center", gap: 6 }}>
                    {unread && (
                      <span
                        aria-label="unread"
                        style={{ width: 8, height: 8, borderRadius: 999, background: "#2b62ff", flexShrink: 0 }}
                      />
                    )}
                    {r.buildingName}
                  </div>
                  <div style={{ fontSize: 11.5, opacity: 0.6, fontFamily: T.mono }}>{r.counterpart}</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.lastMsg ? r.lastMsg.text : "No messages yet"}
                  </div>
                </button>
              );
            })}
          </div>
          <div>
            {selectedRow ? (
              <DeskReply
                me={me}
                row={selectedRow}
                onPosted={loadList}
                onSeen={(count) =>
                  setSeenMap((m) => ({ ...m, [selectedRow.conversationId]: Math.max(m[selectedRow.conversationId] ?? 0, count) }))
                }
              />
            ) : (
              <p style={{ opacity: 0.55, fontSize: 13 }}>Select an enquiry to read and reply.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function DeskReply({ me, row, onPosted, onSeen }: { me: string; row: Row; onPosted: () => void; onSeen: (count: number) => void }) {
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [loadError, setLoadError] = useState(false); // a FIRST-load failure must not strand the panel on "Loading…" forever.
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const convId = row.conversationId;
  // NOTE: the per-thread CHIME lives at the LIST level now (DirectEnquiries), so it alerts even when a
  // thread isn't the selected one — and so we don't double-chime the open thread. Here we just keep the OPEN
  // thread marked SEEN as messages arrive (clears the row dot + the nav badge while the dev is reading it).
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;

  const markSeen = useCallback(
    (count: number) => {
      onSeenRef.current(count);
      void fetch("/api/conversations/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewer: me, conversationId: convId, count, kind: "direct" }),
      }).catch(() => {});
    },
    [me, convId]
  );

  const reload = useCallback(async () => {
    try {
      const j = await fetch(
        `/api/conversations-direct?account=${encodeURIComponent(me)}&conversationId=${encodeURIComponent(convId)}`
      ).then((r) => r.json());
      if (j.error) {
        // Only surface an error when we have nothing to show yet; a poll failure over an already-loaded thread stays quiet.
        setMessages((prev) => (prev === null ? (setLoadError(true), prev) : prev));
        return;
      }
      const msgs: Msg[] = j.messages ?? [];
      setLoadError(false);
      // Only update state when the message set actually changed (avoids a needless re-render on every poll).
      setMessages((prev) => (prev && prev.length === msgs.length && prev[prev.length - 1]?.id === msgs[msgs.length - 1]?.id ? prev : msgs));
      // The open thread is, by definition, being read → keep it marked seen at the latest count.
      markSeen(msgs.length);
    } catch {
      // Transient on a loaded thread (the 8s poll retries); but a FIRST-load throw would otherwise strand "Loading…".
      setMessages((prev) => (prev === null ? (setLoadError(true), prev) : prev));
    }
  }, [me, convId, markSeen]); // STABLE except on a genuine thread switch

  // Reset + reload ONLY when the thread (convId) actually changes — not on every list poll.
  useEffect(() => {
    setMessages(null);
    setLoadError(false);
    void reload();
  }, [reload]);

  useEventStream((t) => {
    if (t.topic === channelTopic(convId)) void reload();
  });

  // Safety poll (SSE can drop): re-read this thread every 8s while it's open.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 8000);
    return () => clearInterval(t);
  }, [reload]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/conversations-direct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: me, conversationId: convId, text }),
      });
      if (res.ok) {
        setDraft("");
        await reload();
        onPosted();
      }
    } finally {
      setSending(false);
    }
  }

  const msgs = messages ?? [];
  return (
    <div>
      <div style={{ fontSize: 12.5, opacity: 0.6, marginBottom: 8 }}>
        {row.buildingName} · buyer <span style={{ fontFamily: T.mono }}>{row.counterpart}</span>
      </div>

      {/* Vetting: advance the funnel + open specific units once the buyer checks out (§9 3b–5). */}
      <DeskVetting me={me} buyer={row.counterpart} building={row.building} buildingName={row.buildingName} conversationId={convId} />

      {messages === null && loadError ? (
        <p style={{ fontSize: 12.5, opacity: 0.75 }}>
          Couldn’t load this conversation.{" "}
          <button
            type="button"
            onClick={() => {
              setLoadError(false);
              void reload();
            }}
            style={{ background: "none", border: "none", padding: 0, color: T.accent, cursor: "pointer", fontSize: 12.5, textDecoration: "underline" }}
          >
            Retry
          </button>
        </p>
      ) : messages === null ? (
        <p style={{ fontSize: 12.5, opacity: 0.55 }}>Loading…</p>
      ) : msgs.length === 0 ? (
        <p style={{ fontSize: 12.5, opacity: 0.55 }}>No messages yet.</p>
      ) : (
        <div ref={scrollRef} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10, maxHeight: 320, overflowY: "auto" }}>
          {msgs.map((m) => {
            // `vrx` SYSTEM notices (reveal grants, call-off markers, block notices) render centred + muted.
            if (m.from === "vrx") {
              return (
                <div key={m.id} style={{ alignSelf: "center", maxWidth: "92%", textAlign: "center", fontSize: 11, opacity: 0.7, color: T.dim, padding: "4px 10px", whiteSpace: "pre-wrap" }}>
                  {m.text}
                </div>
              );
            }
            const mine = m.from === "developer";
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: mine ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  padding: "6px 10px",
                  borderRadius: 10,
                  fontSize: 13,
                  lineHeight: 1.45,
                  background: mine ? T.accentSoft : T.panel2,
                  border: `1px solid ${T.borderSoft}`,
                }}
              >
                <div style={{ fontSize: 10.5, opacity: 0.55, marginBottom: 2 }}>
                  {mine ? "You (desk)" : "Buyer"} · {timeAgo(m.at)}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Reply to the buyer…"
          style={{ ...input, margin: 0, flex: 1 }}
          disabled={sending}
        />
        <button type="button" onClick={() => void send()} disabled={sending || !draft.trim()} style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, margin: 0 }}>
          {sending ? "…" : "Send"}
        </button>
      </div>
      {/* D-slice: the bilateral call-off — either party can propose a no-prejudice close. */}
      <CallOffControl account={me} conversationId={convId} role="developer" onChanged={reload} />
      {/* F-slice: refer to VRX — keeps the deal live, brings VRX in to mediate. */}
      <EscalateControl account={me} conversationId={convId} onChanged={reload} />
      <p style={{ fontSize: 10.5, opacity: 0.6, marginTop: 6, marginBottom: 0 }}>
        Private to you and the buyer, kept off-chain.
      </p>
    </div>
  );
}

// ── Vetting panel ( §9 3b–5) — the desk's controls once it's talking to a buyer: see the funnel + the
// offer-eligibility bar, advance the funnel, and OPEN specific units. Opening a unit auto-advances the
// buyer to "units_opened" (server-side, monotonic). All desk-only + fail-closed on the server. ──
type Funnel = "new" | "in_conversation" | "units_opened" | "offer_eligible";
const FUNNEL_LABEL: Record<Funnel, string> = {
  new: "New",
  in_conversation: "In conversation",
  units_opened: "Units opened",
  offer_eligible: "Offer-eligible",
};
const FUNNEL_FLOW: Funnel[] = ["new", "in_conversation", "units_opened", "offer_eligible"];

type Eligibility = {
  eligible: boolean;
  reasons: { profileSaved: boolean; kyc: boolean; balance: boolean };
  thresholdUsd: number;
  balanceUsd: number | null;
};
type BuyerState = { funnel: Funnel } | null;

// C-slice: the per-conversation reveal state the desk reads. Mirrors lib/conversations-direct DirectReveal.
type DirectReveal = {
  request?: { by: string; at: number; fields: string[]; declarationSeal: string };
  grantedFields?: string[];
  grantedAt?: number;
};

// The profile fields the desk can REQUEST to see/obtain. Mirrors the maskable BuyerDirectProfile keys; labels
// match the buyer-side editor so both sides name fields the same way.
const REVEAL_FIELDS: Array<{ key: string; label: string }> = [
  { key: "name", label: "Full name" },
  { key: "legalName", label: "Legal name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "passportNo", label: "Passport no." },
  { key: "idCardNo", label: "National ID no." },
  { key: "address", label: "Address" },
];
const REVEAL_LABEL: Record<string, string> = Object.fromEntries(REVEAL_FIELDS.map((f) => [f.key, f.label]));
// status: on-chain tile status baked by the server (0 open · 1 hold · 2 closed · 3 done · -1 not published).
type PickUnit = { id: string; type: string; floor: number; sqm: number; status?: number };

/** A unit's availability for the desk, derived from its on-chain tile status. */
function unitAvail(status: number | undefined): { ok: boolean; label: string; color: string } {
  switch (status) {
    case 0: return { ok: true, label: "available", color: T.vetted };
    case 1: return { ok: false, label: "on hold", color: "#e0a0a0" };
    case 2: return { ok: false, label: "closed", color: "#e0a0a0" };
    case 3: return { ok: false, label: "sold", color: "#e0a0a0" };
    case -1:
    case undefined: return { ok: false, label: "not published", color: "#e0c67c" };
    default: return { ok: false, label: "unavailable", color: "#e0a0a0" };
  }
}

function DeskVetting({ me, buyer, building, buildingName, conversationId }: { me: string; buyer: string; building: string; buildingName: string; conversationId: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<BuyerState>(null);
  const [elig, setElig] = useState<Eligibility | null>(null);
  const [opened, setOpened] = useState<string[]>([]);
  const [units, setUnits] = useState<PickUnit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // C-slice: the masked profile the desk currently sees + the reveal negotiation state.
  const [maskedProfile, setMaskedProfile] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<DirectReveal | null>(null);
  // E-slice: the hard-block state (blocked now / ever-blocked = identity force-shown).
  const [block, setBlock] = useState<{ blocked: boolean; priorBlock: boolean } | null>(null);

  const q = `caller=${encodeURIComponent(me)}&account=${encodeURIComponent(buyer)}&building=${encodeURIComponent(building)}`;

  const refresh = useCallback(async () => {
    try {
      const [s, g, rv, bl] = await Promise.all([
        fetch(`/api/buyers-direct/advance?${q}`).then((r) => r.json()),
        fetch(`/api/unit-grants?${q}`).then((r) => r.json()),
        fetch(`/api/conversations-direct/reveal?account=${encodeURIComponent(me)}&conversationId=${encodeURIComponent(conversationId)}`).then((r) => r.json()).catch(() => null),
        fetch(`/api/conversations-direct/block?account=${encodeURIComponent(me)}&conversationId=${encodeURIComponent(conversationId)}`).then((r) => r.json()).catch(() => null),
      ]);
      if (s.buyer) setState({ funnel: s.buyer.funnel });
      setElig(s.eligibility ?? null);
      setMaskedProfile(s.buyer?.profile ?? {});
      setOpened((g.units ?? []).map((u: { unit: string }) => u.unit));
      if (rv?.reveal) setReveal(rv.reveal);
      if (bl?.block) setBlock(bl.block);
    } catch {
      /* transient */
    }
  }, [q, me, conversationId]);

  useEffect(() => {
    setState(null);
    setElig(null);
    setOpened([]);
    void refresh();
  }, [refresh]);

  // Lazy-load the building's units the first time the picker opens. We read the SNAPSHOT (lazy path), NOT
  // `status=full` — the latter bakes a fresh chain read (the developer's explicit "Live" toggle) and would
  // hit FastNEAR on every open, against a contract that's empty off-chain: browse from our snapshot,
  // never poll the RPC on a view). The persisted snapshot is the authoritative availability base; its
  // per-unit map (0 open · 1 hold · 2 closed · 3 done · -1 not published) is what the buyer grid uses too.
  // A unit absent from the snapshot is treated as "not published" (undefined → fail-closed in unitAvail).
  async function ensureUnits() {
    if (units) return;
    try {
      const j = await fetch(`/api/catalog?building=${encodeURIComponent(building)}&account=${encodeURIComponent(me)}`).then((r) => r.json());
      const statusMap: Record<string, number> = j.snapshot?.units ?? {};
      const inv: PickUnit[] = (j.building?.inventory ?? []).map((u: PickUnit) => ({ id: u.id, type: u.type, floor: u.floor, sqm: u.sqm, status: statusMap[u.id] }));
      setUnits(inv);
    } catch {
      setUnits([]);
    }
  }

  async function advance(to: Funnel) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/buyers-direct/advance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caller: me, account: buyer, building, to }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not advance");
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not advance");
    } finally {
      setBusy(false);
    }
  }

  async function toggleUnit(unit: string, isOpen: boolean) {
    setBusy(true);
    setNote(null);
    try {
      if (isOpen) {
        await fetch(`/api/unit-grants?${q}&unit=${encodeURIComponent(unit)}`, { method: "DELETE" });
      } else {
        const res = await fetch("/api/unit-grants", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caller: me, account: buyer, building, unit }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Could not open unit");
      }
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not update");
    } finally {
      setBusy(false);
    }
  }

  const funnel = state?.funnel ?? "new";
  const bar = (ok: boolean) => (ok ? T.vetted : "#e0a0a0");

  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px", background: T.bg2, marginBottom: 12 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ background: "none", border: "none", color: T.text, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}
      >
        <span style={{ opacity: 0.6 }}>{open ? "▾" : "▸"}</span> Vetting · <span style={{ color: T.faint, fontWeight: 500 }}>{FUNNEL_LABEL[funnel]}</span>
        {elig?.eligible && <span style={{ color: T.vetted, fontSize: 11.5 }}>✓ ready</span>}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          {/* Eligibility bar readout — the three conditions. */}
          {elig && (
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, marginBottom: 10 }}>
              <span style={{ color: bar(elig.reasons.profileSaved) }}>{elig.reasons.profileSaved ? "✓" : "✗"} Profile</span>
              <span style={{ color: bar(elig.reasons.kyc) }}>{elig.reasons.kyc ? "✓" : "✗"} KYC</span>
              <span style={{ color: bar(elig.reasons.balance) }}>
                {elig.reasons.balance ? "✓" : "✗"} Balance
                <span style={{ opacity: 0.6 }}>
                  {" "}
                  ({elig.balanceUsd === null ? "—" : `$${Math.round(elig.balanceUsd).toLocaleString()}`} / ${elig.thresholdUsd.toLocaleString()})
                </span>
              </span>
            </div>
          )}

          {/* Funnel advance buttons. */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {FUNNEL_FLOW.map((s) => {
              const active = s === funnel;
              return (
                <button
                  key={s}
                  disabled={busy || active}
                  onClick={() => void advance(s)}
                  title={active ? "Current state" : `Set to ${FUNNEL_LABEL[s]}`}
                  style={{
                    fontSize: 11.5,
                    padding: "4px 9px",
                    borderRadius: 7,
                    border: `1px solid ${active ? "#2b62ff" : T.border}`,
                    background: active ? T.panel2 : "none",
                    color: active ? T.text : T.faint,
                    cursor: active ? "default" : "pointer",
                    opacity: busy && !active ? 0.6 : 1,
                  }}
                >
                  {FUNNEL_LABEL[s]}
                </button>
              );
            })}
          </div>

          {/* C-slice: request to see / obtain more of the buyer's details — a consented reveal. */}
          <DeskRevealControl
            me={me}
            conversationId={conversationId}
            maskedProfile={maskedProfile}
            reveal={reveal}
            onChanged={refresh}
          />

          {/* E-slice: the desk-only hard block (anti-scammer). */}
          <DeskBlockControl me={me} conversationId={conversationId} block={block} onChanged={refresh} />

          {/* Open units. */}
          <div>
            <button
              onClick={() => void ensureUnits()}
              style={{
                background: T.panel2,
                border: `1px solid ${T.border}`,
                color: T.accent,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
                padding: "6px 12px",
                borderRadius: 8,
                marginBottom: 8,
              }}
            >
              {units ? "▾ " : "▸ "}Open units to this buyer in {buildingName} {units ? `(${opened.length} open)` : "…"}
            </button>
            {units && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 180, overflowY: "auto" }}>
                {units.length === 0 ? (
                  <p style={{ fontSize: 12, opacity: 0.55, margin: 0 }}>No units in this building.</p>
                ) : (
                  units.map((u) => {
                    const isOpen = opened.includes(u.id);
                    const avail = unitAvail(u.status);
                    // A unit can only be OPENED if it's available (status 0). An already-opened unit stays
                    // toggleable so the desk can always CLOSE it, even if it later went on-hold/closed. The
                    // server enforces the same gate (this disable is UX; the POST is the authority).
                    const lockable = !avail.ok && !isOpen;
                    return (
                      <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, cursor: lockable ? "not-allowed" : "pointer", opacity: lockable ? 0.5 : 1 }}>
                        <input type="checkbox" checked={isOpen} disabled={busy || lockable} onChange={() => void toggleUnit(u.id, isOpen)} />
                        <span style={{ fontFamily: T.mono, color: avail.ok ? T.text : avail.color }}>{u.id}</span>
                        <span style={{ opacity: 0.6 }}>
                          {u.type} · floor {u.floor} · {u.sqm}m²
                        </span>
                        <span style={{ marginLeft: "auto", fontSize: 10.5, color: avail.color, whiteSpace: "nowrap" }}>
                          {avail.ok ? "✓ available" : `• ${avail.label}`}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Firm-hold (§9 step 9): once the buyer is offer-eligible, the desk takes a deposit and
              firm-holds an opened unit on-chain — the developer signs grant_exclusive to the house org. */}
          {elig?.eligible && opened.length > 0 && (
            <DeskFirmHold
              me={me}
              buyer={buyer}
              building={building}
              openedUnits={opened}
              onHeld={refresh}
            />
          )}

          {/* Paperwork (slice 4): once a unit is firm-held for this buyer, the desk can OPEN THE PAPERWORK
              — materialize a tailorable Offer (with a payment-structure template) and surface the SAME
              per-deal tailoring the agent booking path has, plus the S&P the buyer will sign. */}
          <DeskPaperwork me={me} buyer={buyer} building={building} />

          {note && <p style={{ fontSize: 12, color: "#e0a0a0", margin: "8px 0 0" }}>{note}</p>}
          <p style={{ fontSize: 10.5, opacity: 0.6, margin: "8px 0 0", lineHeight: 1.5 }}>
            Opening a unit reveals its specs to the buyer; exact price, floor plan and the calculator unlock
            only once the buyer clears the offer bar above.
          </p>
        </div>
      )}
    </div>
  );
}

// ── DeskPaperwork ( slice 4) — "open the paperwork" on a firm-held direct deal. Materializes a tailorable
// booking path has (DealTailoringControls, shared component) + the S&P the buyer signs (SaleContractButton).
// The materialize action is EXPLICIT (the desk decides when "talking" becomes "papered") and gated on a HELD
// deposit (the earliest-allowed moment — the unit is actually off the market for this buyer, design §2). The
// materialized offer's requestId is a one-way hash, so the UI keeps the value the materialize call returns. ──
const PLAN_TEMPLATES: Array<{ key: string; label: string; hint: string; standard?: boolean }> = [
  { key: "off_plan_standard", label: "Off-plan standard", hint: "Deposit → instalments → balance on transfer (the usual off-plan structure)", standard: true },
  { key: "deposit_then_transfer", label: "Deposit + balance on transfer", hint: "Deposit now, the rest due on handover — no instalments" },
  { key: "full_on_transfer", label: "Pay on transfer", hint: "Minimal deposit now, the full balance on transfer" },
  { key: "refundable_deposit", label: "Refundable deposit", hint: "A refundable holding deposit now, balance on transfer" },
];

function DeskPaperwork({ me, buyer, building }: { me: string; buyer: string; building: string }) {
  const money = useMoney();
  const [open, setOpen] = useState(false);
  const [heldUnit, setHeldUnit] = useState<string | null>(null);
  const [priceUsd, setPriceUsd] = useState<number | null>(null);
  const [template, setTemplate] = useState("off_plan_standard");
  const [instalments, setInstalments] = useState(12);
  const [depositUsd, setDepositUsd] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [offer, setOffer] = useState<OfferRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const q = `caller=${encodeURIComponent(me)}&account=${encodeURIComponent(buyer)}&building=${encodeURIComponent(building)}`;

  // Find a HELD deposit (the materialization precondition) + the held unit's live USD price (to seed the plan).
  const loadHeld = useCallback(async () => {
    try {
      const j = await fetch(`/api/direct-deposits?${q}`).then((r) => r.json());
      const held = (j.deposits ?? []).find((d: { status: string }) => d.status === "held") as { unit: string } | undefined;
      setHeldUnit(held?.unit ?? null);
      if (held) {
        const cj = await fetch(`/api/catalog?building=${encodeURIComponent(building)}&account=${encodeURIComponent(me)}`).then((r) => r.json());
        const unit = (cj.building?.inventory ?? []).find((u: { id: string }) => u.id === held.unit) as { priceUsd?: number } | undefined;
        setPriceUsd(typeof unit?.priceUsd === "number" ? unit.priceUsd : null);
      }
    } catch {
      /* transient */
    }
  }, [q, building, me]);

  // Fetch the materialized offer (developerView) so the tailoring editors can render + re-render on change.
  const loadOffer = useCallback(async (id: string) => {
    try {
      const j = await fetch(`/api/offers?requestId=${encodeURIComponent(id)}`).then((r) => r.json());
      if (j.offer) setOffer(j.offer as OfferRecord);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void loadHeld();
  }, [loadHeld]);

  useEffect(() => {
    if (requestId) void loadOffer(requestId);
  }, [requestId, loadOffer]);

  async function openPaperwork() {
    if (!heldUnit) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/direct-deposits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "materialize",
          caller: me,
          account: buyer,
          building,
          unit: heldUnit,
          template,
          instalments,
          depositUsd: depositUsd ? Number(depositUsd) : 0,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not open the paperwork");
      setRequestId(j.offer?.requestId ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not open the paperwork");
    } finally {
      setBusy(false);
    }
  }

  // No held unit → nothing to paper yet. (Firm-hold first; the panel above does that.)
  if (!heldUnit) return null;

  const isStandard = template === "off_plan_standard";

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ background: "none", border: "none", color: T.text, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}
      >
        <span style={{ opacity: 0.6 }}>{open ? "▾" : "▸"}</span> Paperwork
        {requestId ? <span style={{ color: T.vetted, fontSize: 11.5 }}>✓ opened</span> : <span style={{ color: T.faint, fontSize: 11.5 }}>unit {heldUnit} is held — open the S&amp;P</span>}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          {!requestId ? (
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px", background: T.bg2 }}>
              <p style={{ fontSize: 11.5, opacity: 0.65, margin: "0 0 10px", lineHeight: 1.5 }}>
                Unit <span style={{ fontFamily: T.mono }}>{heldUnit}</span> is firm-held for this buyer
                {priceUsd != null ? <> at <strong>{money(priceUsd)}</strong></> : null}. Pick a payment structure
                and open the Sale &amp; Purchase paperwork. You can fine-tune every figure afterwards.
              </p>

              {/* Payment-structure template picker. */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                {PLAN_TEMPLATES.map((t) => (
                  <label key={t.key} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, cursor: "pointer" }}>
                    <input type="radio" name="plan-template" checked={template === t.key} onChange={() => setTemplate(t.key)} style={{ marginTop: 2 }} />
                    <span>
                      <span style={{ fontWeight: 600 }}>{t.label}</span>
                      {t.standard ? <span style={{ color: T.vetted, fontSize: 10.5 }}> · recommended</span> : null}
                      <span style={{ display: "block", opacity: 0.6, fontSize: 11 }}>{t.hint}</span>
                    </span>
                  </label>
                ))}
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 }}>
                <div style={{ minWidth: 130 }}>
                  <label style={{ fontSize: 11, opacity: 0.6, display: "block", marginBottom: 2 }}>Deposit line (USD)</label>
                  <input
                    value={depositUsd}
                    onChange={(e) => setDepositUsd(e.target.value.replace(/[^\d.]/g, ""))}
                    placeholder="e.g. 20000"
                    inputMode="decimal"
                    style={{ ...input, margin: 0, padding: "6px 8px", fontSize: 13, width: 130 }}
                  />
                </div>
                {isStandard && (
                  <div style={{ minWidth: 90 }}>
                    <label style={{ fontSize: 11, opacity: 0.6, display: "block", marginBottom: 2 }}>Instalments</label>
                    <input
                      value={instalments}
                      onChange={(e) => setInstalments(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                      type="number"
                      min={0}
                      style={{ ...input, margin: 0, padding: "6px 8px", fontSize: 13, width: 80 }}
                    />
                  </div>
                )}
              </div>

              <button type="button" onClick={() => void openPaperwork()} disabled={busy} style={{ ...submitBtn, padding: "7px 16px", fontSize: 13, margin: 0 }}>
                {busy ? "…" : "Open the paperwork"}
              </button>
              <p style={{ fontSize: 10.5, opacity: 0.6, margin: "8px 0 0", lineHeight: 1.5 }}>
                The deposit line is in USD (the price currency). It&apos;s a starting point for the schedule —
                adjust it, the instalments and everything else in the tailoring below once the paperwork is open.
              </p>
              {err && <p style={{ fontSize: 12, color: "#e0a0a0", margin: "8px 0 0" }}>{err}</p>}
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 8 }}>
                <SaleContractButton requestId={requestId} viewer={me} label="View S&amp;P contract" />
              </div>
              {offer ? (
                <DealTailoringControls offer={offer} me={me} onChanged={() => void loadOffer(requestId)} />
              ) : (
                <p style={{ fontSize: 12.5, opacity: 0.55 }}>Loading the deal…</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── DeskRevealControl (C-slice) — the desk asks to SEE or OBTAIN more of the buyer's details. By
// default the desk sees only a masked hint; here it can request specific fields. Requesting REQUIRES
// declines. The buyer consents on their side (the buyer sales-desk view); a grant is PERMANENT for this
function DeskRevealControl({
  me,
  conversationId,
  maskedProfile,
  reveal,
  onChanged,
}: {
  me: string;
  conversationId: string;
  maskedProfile: Record<string, string>;
  reveal: DirectReveal | null;
  onChanged: () => Promise<void>;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [undertaking, setUndertaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const granted = new Set(reveal?.grantedFields ?? []);
  const pending = reveal?.request ?? null;
  const pendingSet = new Set(pending?.fields ?? []);

  function toggle(k: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }

  async function request() {
    if (picked.size === 0 || !undertaking) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/conversations-direct/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: me, conversationId, action: "request", fields: [...picked], declaration: true }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not send the request");
      setPicked(new Set());
      setUndertaking(false);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send the request");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: "9px 11px", marginBottom: 12, background: T.bg2 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Buyer details you can see</div>

      {/* What's shared / pending today. */}
      <div style={{ fontSize: 11.5, opacity: 0.75, marginBottom: 8, lineHeight: 1.5 }}>
        {granted.size > 0 ? (
          <>Shared with you: <strong style={{ color: T.vetted }}>{[...granted].map((f) => REVEAL_LABEL[f] ?? f).join(", ")}</strong>. </>
        ) : (
          <>The buyer&apos;s details are masked by default (anti-poaching). </>
        )}
        {pending && (
          <span style={{ color: T.hold }}>Awaiting the buyer on: {pending.fields.map((f) => REVEAL_LABEL[f] ?? f).join(", ")}.</span>
        )}
      </div>

      {/* Pick fields to request. A field already granted is shown as ✓ and not re-requestable. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginBottom: 8 }}>
        {REVEAL_FIELDS.map((f) => {
          const isGranted = granted.has(f.key);
          const isPending = pendingSet.has(f.key);
          const onFile = (maskedProfile[f.key] ?? "").length > 0; // the desk sees the masked value if any
          return (
            <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, opacity: isGranted ? 0.6 : 1, cursor: isGranted || isPending ? "default" : "pointer" }}>
              {isGranted ? (
                <span style={{ color: T.vetted }}>✓</span>
              ) : (
                <input type="checkbox" checked={picked.has(f.key)} disabled={busy || isPending} onChange={() => toggle(f.key)} />
              )}
              <span>{f.label}</span>
              {/* Hint the desk whether this is an UNMASK (buyer has it) or an ASK-TO-PROVIDE (buyer hasn't filled it). */}
              {!isGranted && !onFile && <span style={{ fontSize: 10, color: T.faint }}>(ask to add)</span>}
            </label>
          );
        })}
      </div>

      {/* The non-circumvention undertaking (Q1) — required before a request can be sent. */}
      {picked.size > 0 && (
        <label style={{ display: "flex", alignItems: "flex-start", gap: 7, fontSize: 11.5, opacity: 0.85, marginBottom: 8, lineHeight: 1.45, maxWidth: 520 }}>
          <input type="checkbox" checked={undertaking} disabled={busy} onChange={(e) => setUndertaking(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            I will not use the buyer&apos;s revealed details to contact, solicit, or deal with them outside VRX,
            nor to circumvent this platform or any agent relationship. <span style={{ color: T.faint }}>(recorded)</span>
          </span>
        </label>
      )}

      <button
        onClick={() => void request()}
        disabled={busy || picked.size === 0 || !undertaking}
        title={picked.size === 0 ? "Pick the details to request" : !undertaking ? "Accept the undertaking first" : "Send the request to the buyer"}
        style={{
          fontSize: 12,
          fontWeight: 600,
          padding: "5px 12px",
          borderRadius: 7,
          border: `1px solid ${picked.size > 0 && undertaking ? T.accent : T.border}`,
          background: "none",
          color: picked.size > 0 && undertaking ? T.accent : T.faint,
          cursor: picked.size > 0 && undertaking ? "pointer" : "not-allowed",
        }}
      >
        {busy ? "Sending…" : "Request from buyer"}
      </button>
      {err && <p style={{ fontSize: 11.5, color: "#e0a0a0", margin: "7px 0 0" }}>{err}</p>}
    </div>
  );
}

// ── DeskBlockControl (E-slice) — the DESK-ONLY hard block (anti-scammer). Blocking: the buyer's messages
// still arrive (nothing lost), but the buyer gets an honest autoreply that the desk won't continue. It also
// PERMANENTLY force-shows that buyer's identity to THIS desk (anti-cheat — they can't re-approach anonymously),
// which SURVIVES an unblock. The buyer has no block (their recourse is the polite call-off or escalating to
// VRX). A two-step confirm guards the action; a priorBlock badge shows when identity is force-shown. ──────────
function DeskBlockControl({
  me,
  conversationId,
  block,
  onChanged,
}: {
  me: string;
  conversationId: string;
  block: { blocked: boolean; priorBlock: boolean } | null;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  async function act(action: "block" | "unblock") {
    setBusy(true);
    try {
      await fetch("/api/conversations-direct/block", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: me, conversationId, action }),
      });
      setConfirm(false);
      await onChanged();
    } catch {
      /* leave state; retry */
    } finally {
      setBusy(false);
    }
  }

  const blocked = !!block?.blocked;
  const prior = !!block?.priorBlock;

  return (
    <div style={{ marginBottom: 12, fontSize: 11.5 }}>
      {prior && (
        <div style={{ color: "#e8b84b", marginBottom: 6 }}>
          ⚠ You blocked this buyer before — their identity is shown to you in full so they can&apos;t re-approach anonymously.
        </div>
      )}
      {blocked ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ color: "#e0a0a0" }}>■ Blocked — their messages still arrive; they&apos;re told you won&apos;t continue.</span>
          <button onClick={() => void act("unblock")} disabled={busy} style={{ background: "none", border: `1px solid ${T.border}`, color: T.dim, fontSize: 11.5, cursor: "pointer", padding: "3px 9px", borderRadius: 7 }}>
            {busy ? "…" : "Unblock"}
          </button>
        </div>
      ) : confirm ? (
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <span style={{ opacity: 0.8 }}>Block this buyer? They can still message, but you won&apos;t be bothered — and their identity stays shown to you.</span>
          <button onClick={() => void act("block")} disabled={busy} style={{ background: "none", border: `1px solid #5a2a2a`, color: "#e0a0a0", fontSize: 11.5, cursor: "pointer", padding: "3px 9px", borderRadius: 7 }}>
            {busy ? "…" : "Yes, block"}
          </button>
          <button onClick={() => setConfirm(false)} style={{ background: "none", border: "none", color: T.dim, fontSize: 11.5, cursor: "pointer", padding: 0, textDecoration: "underline" }}>Cancel</button>
        </span>
      ) : (
        <button onClick={() => setConfirm(true)} style={{ background: "none", border: "none", color: T.faint, fontSize: 11.5, cursor: "pointer", padding: 0, textDecoration: "underline" }}>
          Block this buyer
        </button>
      )}
    </div>
  );
}

// ── Firm-hold panel ( §9 step 9) — the deposit + on-chain hold. Shown only when the buyer is LIVE
// offer-eligible AND at least one unit is opened to them. The desk: (1) picks an opened unit, (2) enters
// the deposit it received (off-chain figure), (3) signs grant_exclusive(unit_key, houseOrg, window) in
// its own wallet — the hold goes to the developer's HOUSE ORG, the buyer's identity never
// reaches the chain. The deposit record is written FIRST (server re-checks eligibility + that the house
// org exists), returning the house org to grant to; then the developer signs; then we attach the tx. ──
type HoldDeposit = { unit: string; status: "pending" | "held" | "released"; holdTxHash: string; holdUntil: number };

function DeskFirmHold({
  me,
  buyer,
  building,
  openedUnits,
  onHeld,
}: {
  me: string;
  buyer: string;
  building: string;
  openedUnits: string[];
  onHeld: () => void;
}) {
  const { callFunction } = useWallet();
  const { state, run, busy } = useTxRun();
  const [unit, setUnit] = useState(openedUnits[0] ?? "");
  const [amount, setAmount] = useState(""); // whole units of currency the desk received
  const [currency, setCurrency] = useState("THB");
  const [days, setDays] = useState(7);
  const [deposits, setDeposits] = useState<HoldDeposit[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // On-chain tile status per opened unit (0 open · 1 hold · 2 closed · 3 done · -1 not published) so the
  // select only offers AVAILABLE units — the authoritative block is still the getTile pre-check in firmHold.
  const [statusByUnit, setStatusByUnit] = useState<Record<string, number>>({});

  const q = `caller=${encodeURIComponent(me)}&account=${encodeURIComponent(buyer)}&building=${encodeURIComponent(building)}`;

  const loadDeposits = useCallback(async () => {
    try {
      const j = await fetch(`/api/direct-deposits?${q}`).then((r) => r.json());
      setDeposits((j.deposits ?? []).map((d: HoldDeposit) => ({ unit: d.unit, status: d.status, holdTxHash: d.holdTxHash, holdUntil: d.holdUntil })));
    } catch {
      /* transient */
    }
  }, [q]);

  // Load this building's availability from the SNAPSHOT (lazy path), NOT `status=full` — that bakes a fresh
  // chain read and would hit FastNEAR on every mount: don't poll the RPC to paint a view). This only
  // filters the select to units the snapshot shows OPEN; the AUTHORITATIVE block is the live getTile
  // pre-check in firmHold — the one chain read that's a genuine must, run only when the desk commits.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const j = await fetch(`/api/catalog?building=${encodeURIComponent(building)}&account=${encodeURIComponent(me)}`).then((r) => r.json());
        if (!live) return;
        setStatusByUnit(j.snapshot?.units ?? {});
      } catch {
        /* transient — the firmHold getTile pre-check still guards the actual hold */
      }
    })();
    return () => { live = false; };
  }, [building]);

  const availableOpened = openedUnits.filter((u) => statusByUnit[u] === 0);
  // Keep the selection on an AVAILABLE unit.
  useEffect(() => {
    if (availableOpened.length && !availableOpened.includes(unit)) setUnit(availableOpened[0]);
  }, [availableOpened, unit]);

  useEffect(() => {
    void loadDeposits();
  }, [loadDeposits]);

  const heldFor = (u: string) => deposits.find((d) => d.unit === u && d.status === "held");

  async function firmHold() {
    setErr(null);
    const u = unit.trim();
    const amt = Number(amount);
    if (!u || !Number.isFinite(amt) || amt <= 0) {
      setErr("Pick a unit and enter the deposit amount.");
      return;
    }
    // The amount is captured in MINOR units (integer) to avoid float drift (THB satang / USD cents).
    const amountMinor = Math.round(amt * 100);
    const windowNs = daysToWindowNs(days);
    const key = await hashRef(unitRef(building, u), "vrx-unit");

    // 1) PRE-CHECK the unit is PUBLISHED + AVAILABLE on-chain, BEFORE taking a deposit or signing. The desk
    // must NOT be able to firm-hold a unit the developer hasn't published, and must not silently publish it
    // (that would override the developer's deliberate unit state — a privilege violation; the firm-hold only
    // RESERVES an already-available unit, it never lists one). A unit is holdable iff a tile exists with
    // status OPEN (0). Anything else (no tile = unpublished; status 1/2/3 = held/closed/sold) is blocked with
    // a clear message. (Tile status: 0 open · 1 hold · 2 closed · 3 done.)
    let tile: { s?: number } | null = null;
    try {
      tile = await getTile(key);
    } catch {
      setErr("Couldn't check this unit's availability right now — try again in a moment.");
      return;
    }
    if (!tile) {
      setErr("This unit isn't published yet. Publish it in “My buildings” before reserving it for a buyer.");
      return;
    }
    if (tile.s !== 0) {
      setErr("This unit isn't available to reserve right now (it's already held, closed or sold).");
      return;
    }

    // 2) Record the deposit — the server re-checks LIVE eligibility + the house org, returns the org to grant.
    let houseOrg = "";
    try {
      const res = await fetch("/api/direct-deposits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "record", caller: me, account: buyer, building, unit: u, unitKey: key, amountMinor, currency }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not record the deposit");
      houseOrg = typeof j.houseOrg === "string" ? j.houseOrg : "";
      if (!houseOrg) throw new Error("No house org configured for this desk");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not record the deposit");
      return;
    }

    // 3) The on-chain firm-hold — grant the exclusive to the house org (unit is confirmed published + OPEN).
    const built = grantExclusiveArgs(key, houseOrg, windowNs);
    const until = Date.now() * 1e6 + windowNs;
    const ok = await run(
      async () => {
        const deposit = await depositFor(me);
        const tx = await callFunction({ method: built.method, args: built.args, deposit });
        // d) Mirror the exclusive-hold (write-through, same as /node) and attach the tx to the deposit.
        void fetch("/api/exclusives", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "grant", unitKey: key, buildingId: building, unitId: u, orgId: houseOrg, developer: me, until }),
        }).catch(() => {});
        await fetch("/api/direct-deposits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "hold", caller: me, account: buyer, building, unit: u, holdTxHash: tx, holdUntil: until }),
        }).catch(() => {});
        return tx;
      },
      {
        successNote: `Unit ${u} firm-held for the buyer (deposit received).`,
        ensureGasFor: me,
        mapError: firmHoldErr,
      }
    );
    if (ok) {
      setAmount("");
      await loadDeposits();
      onHeld();
    }
  }

  const alreadyHeld = heldFor(unit);

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>Firm-hold (deposit received)</div>
      <p style={{ fontSize: 11, opacity: 0.6, margin: "0 0 8px", lineHeight: 1.5 }}>
        The buyer has cleared the offer bar. Record the deposit you&apos;ve received and firm-hold a unit for
        them on-chain — you&apos;ll sign in your wallet. Other agencies are blocked from booking it until the
        hold ends.
      </p>
      {availableOpened.length === 0 ? (
        <p style={{ fontSize: 12, color: "#e0c67c", margin: "4px 0 0", lineHeight: 1.5 }}>
          None of the units you&apos;ve opened to this buyer are available to reserve right now (they&apos;re
          unpublished, held, or sold). Publish an available unit in “My buildings” and open it to the buyer first.
        </p>
      ) : (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ minWidth: 110 }}>
          <label style={{ fontSize: 11, opacity: 0.6, display: "block", marginBottom: 2 }}>Unit</label>
          <select value={unit} onChange={(e) => setUnit(e.target.value)} disabled={busy} style={{ ...input, margin: 0, padding: "6px 8px", fontSize: 13 }}>
            {availableOpened.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 110 }}>
          <label style={{ fontSize: 11, opacity: 0.6, display: "block", marginBottom: 2 }}>Deposit</label>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="e.g. 50000"
            inputMode="decimal"
            disabled={busy}
            style={{ ...input, margin: 0, padding: "6px 8px", fontSize: 13, width: 110 }}
          />
        </div>
        <div style={{ minWidth: 70 }}>
          <label style={{ fontSize: 11, opacity: 0.6, display: "block", marginBottom: 2 }}>Ccy</label>
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 4))} disabled={busy} style={{ ...input, margin: 0, padding: "6px 8px", fontSize: 13, width: 64 }} />
        </div>
        <div>
          <label style={{ fontSize: 11, opacity: 0.6, display: "block", marginBottom: 2 }}>Days</label>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button type="button" onClick={() => setDays((d) => Math.max(1, d - 1))} disabled={busy || days <= 1} style={stepBtn}>−</button>
            <span style={{ minWidth: 24, textAlign: "center", fontSize: 14, fontWeight: 600, fontFamily: T.mono }}>{days}</span>
            <button type="button" onClick={() => setDays((d) => d + 1)} disabled={busy} style={stepBtn}>+</button>
          </div>
        </div>
      </div>
      )}
      {availableOpened.length > 0 && (
        <>
          {alreadyHeld && (
            <p style={{ fontSize: 11, color: T.vetted, margin: "8px 0 0" }}>
              ✓ Unit {unit} is already firm-held for this buyer.
            </p>
          )}
          <button
            type="button"
            onClick={() => void firmHold()}
            disabled={busy || !unit || !amount}
            style={{ ...submitBtn, marginTop: 10, padding: "7px 16px", fontSize: 13 }}
          >
            {busy ? "…" : alreadyHeld ? "Re-hold / extend" : "Record deposit & firm-hold"}
          </button>
        </>
      )}
      <p style={{ fontSize: 10.5, opacity: 0.6, margin: "6px 0 0", lineHeight: 1.5 }}>
        Only units you&apos;ve published and that are currently available can be reserved. Publish or free a unit
        in “My buildings” first if it isn&apos;t selectable.
      </p>
      {err && <p style={{ fontSize: 12, color: "#e0a0a0", margin: "8px 0 0" }}>{err}</p>}
      <TxProgress state={state} />
    </div>
  );
}

const stepBtn: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 7,
  border: `1px solid ${T.border}`,
  background: T.bg2,
  color: T.text,
  cursor: "pointer",
  fontSize: 15,
  lineHeight: 1,
};

// Translate a contract/wallet error into plain language for the firm-hold ( — never leak E-codes/contract
// words to the user). Mirrors node/page.tsx exclusiveErr, worded for the direct-sales desk.
function firmHoldErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/rejected|cancell?ed|user closed|denied|WALLET_TIMEOUT/i.test(msg)) return "Cancelled, or your wallet didn't respond. Try again.";
  if (/-?429|rate\s*limit/i.test(msg)) return "Your wallet's network is busy right now — wait a few seconds and try again.";
  if (/E17|TILE_NOT_FOUND/i.test(msg)) return "This unit couldn't be prepared on-chain. Try again, or re-open the unit to the buyer first.";
  if (/E59|TILE_NODE_MISMATCH|TILE_BUSY|EXCLUSIVE_TILE_BUSY/i.test(msg)) return "This unit isn't available to reserve right now (already reserved, sold, or held).";
  if (/NO_GATE|GATE_INACTIVE/i.test(msg)) return "Your house org isn't set up yet — open the “Direct-sale house org” panel above and complete the two setup steps first.";
  if (/ORG_NOT_FOUND|NOT_ORG/i.test(msg)) return "Your house org isn't registered yet — complete the house-org setup above first.";
  if (/NOT_NODE/i.test(msg)) return "This account isn't set up as a developer.";
  if (/E57|deposit|balance/i.test(msg)) return "Couldn't complete on-chain — please try again.";
  return "Couldn't firm-hold on-chain. Please try again.";
}

// ── House-org setup (§9 step 9) — a one-time prerequisite for firm-holding. The direct-sale
// firm-hold grants the exclusive to the developer's HOUSE ORG. Three steps: (1) record the house-org
// account id off-chain (api/developers), (2) register it on-chain (register_org — OWNER-signed), and
// (3) gate it to this developer (grant_gate — DEVELOPER-signed). We sign each with whichever wallet is
// connected; register_org needs the OWNER wallet, so the panel flags when the connected wallet can't do a
// step. Collapsed by default once a house org is set. ──
function HouseOrgSetup({ me }: { me: string }) {
  const { accountId, callFunction } = useWallet();
  const { state, run, busy } = useTxRun();
  const [open, setOpen] = useState(false);
  const [houseOrg, setHouseOrg] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await fetch(`/api/developers?account=${encodeURIComponent(me)}`).then((r) => r.json());
      const ho = j.developer?.houseOrgAccount ?? null;
      setHouseOrg(ho);
      if (ho) setDraft(ho);
    } catch {
      /* transient */
    }
  }, [me]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveId() {
    const id = draft.trim().toLowerCase();
    if (!id) return;
    setNote(null);
    try {
      const res = await fetch("/api/developers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caller: me, houseOrgAccount: id }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
      await load();
      setNote("Saved. Now register it on-chain (owner), then grant it access (you).");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not save");
    }
  }

  async function registerOnChain() {
    const id = (houseOrg ?? draft).trim().toLowerCase();
    if (!id) return;
    const ref = await hashRef({ kind: "house-org", account: id }, "vrx-org");
    const built = registerOrgArgs({ id, ref });
    await run(
      async () => callFunction({ method: built.method, args: built.args, deposit: "0" }),
      {
        successNote: `House org ${id} registered on-chain.`,
        ensureGasFor: accountId,
        mapError: (e) => {
          const m = e instanceof Error ? e.message : String(e);
          return /NOT_OWNER|E\d|owner/i.test(m)
            ? "register_org is owner-signed — connect the owner wallet to do this step."
            : m;
        },
      }
    );
  }

  async function gateIt() {
    const id = (houseOrg ?? draft).trim().toLowerCase();
    if (!id) return;
    // Scope = a single opaque namespace hash for this desk's house org (grant is active-gate; open_claim
    // only checks the gate is ACTIVE, not scope contents — same as the agency-access UI).
    const scope = [await hashRef({ kind: "house-scope", dev: me, org: id }, "vrx-unit")];
    const built = grantGateArgs(id, scope);
    await run(
      async () => {
        const deposit = await depositFor(me);
        const tx = await callFunction({ method: built.method, args: built.args, deposit });
        void fetch("/api/gates", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ developer: me, agency: id }),
        }).catch(() => {});
        return tx;
      },
      { successNote: `House org ${id} now has access to your units.`, ensureGasFor: me }
    );
  }

  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px", background: T.bg2, marginBottom: 14 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ background: "none", border: "none", color: T.text, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}
      >
        <span style={{ opacity: 0.6 }}>{open ? "▾" : "▸"}</span> Direct-sale house org
        {houseOrg ? (
          <span style={{ color: T.vetted, fontSize: 11.5, fontFamily: T.mono }}>{houseOrg}</span>
        ) : (
          <span style={{ color: "#e0c67c", fontSize: 11.5 }}>not set up — needed to firm-hold</span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          <p style={{ fontSize: 11.5, opacity: 0.6, margin: "0 0 10px", lineHeight: 1.55 }}>
            To firm-hold a unit for a direct buyer, your desk reserves it on-chain for your own in-house sales
            team (your &quot;house org&quot;). Set this up once: name the account, register it (needs the owner
            wallet), then grant it access to your units (signed by you).
          </p>
          <p style={{ fontSize: 11, opacity: 0.55, margin: "0 0 10px", lineHeight: 1.5, color: "#e0c67c" }}>
            The house-org account is near-passive: it signs ONCE at setup to enrol your desk&apos;s sales peer, then
            stays idle — your developer wallet signs every firm-hold. Step&nbsp;1 is signed by the OWNER wallet;
            step&nbsp;2 and every firm-hold by YOUR developer wallet. (A one-time house-org enrolment step lands with
            the desk-offer arc.)
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={{ fontSize: 11, opacity: 0.6, display: "block", marginBottom: 2 }}>House-org account</label>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="e.g. summit-house.testnet"
                style={{ ...input, margin: 0, padding: "6px 8px", fontSize: 13 }}
                disabled={busy}
              />
            </div>
            <button type="button" onClick={() => void saveId()} disabled={busy || !draft.trim()} style={{ ...submitBtn, padding: "6px 14px", fontSize: 13, margin: 0 }}>
              Save
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={() => void registerOnChain()} disabled={busy || !(houseOrg ?? draft).trim()} style={stepPill}>
              1 · Register on-chain (owner)
            </button>
            <button type="button" onClick={() => void gateIt()} disabled={busy || !(houseOrg ?? draft).trim()} style={stepPill}>
              2 · Grant access (you)
            </button>
          </div>
          <p style={{ fontSize: 10.5, opacity: 0.6, margin: "8px 0 0" }}>
            Connected as <span style={{ fontFamily: T.mono }}>{accountId ?? "—"}</span>. Step 1 needs the owner
            wallet; step 2 is signed by your developer wallet.
          </p>
          {note && <p style={{ fontSize: 12, color: T.faint, margin: "8px 0 0" }}>{note}</p>}
          <TxProgress state={state} />
        </div>
      )}
    </div>
  );
}

const stepPill: React.CSSProperties = {
  fontSize: 12,
  padding: "6px 12px",
  borderRadius: 8,
  border: `1px solid ${T.border}`,
  background: "none",
  color: T.faint,
  cursor: "pointer",
};
