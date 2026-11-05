"use client";

// TxAction + useTxRun — the "show the process as it goes" rule, made a shared primitive.
//
// "show the process as it goes as a rule — it's great UX" + "constant good relevant
// feedback and help" + "users love the digital buzz, flashing lights, tx numbers and references."
// So every on-chain WRITE in the portal narrates its lifecycle inline instead of a silent spinner:
//
//     idle → signing (waiting for the wallet) → sent (tx hash appears the instant it exists)
//          → confirmed on-chain ✓ (green flash)   |   or → error (with a human message)
//
// Screens don't hand-roll this. They call `useTxRun` to get a `run(fn)` and a `phase`, and render
// <TxProgress> to show it. `fn` returns the tx hash (our callFunction already does). The buzz
// (.vrx-working shimmer.vrx-flash) lives in globals.css and is reserved for on-chain truth.

import { useCallback, useState } from "react";
import { T } from "@/lib/theme";
import { EXPLORER_URL } from "@/lib/config";

export type TxPhase = "idle" | "gas" | "signing" | "sent" | "confirmed" | "error";

export type TxState = {
  phase: TxPhase;
  tx?: string;
  /** Human message (success summary or error explanation). */
  note?: string;
};

// Detect a NEAR RPC rate-limit (HTTP/JSON-RPC 429) surfaced by the WALLET during broadcast. The wallet
// uses its own RPC, so the error shape varies (a thrown Error, or a JSON-RPC envelope the wallet
// stringifies into the message). We match broadly on the 429 code / "rate limit" text so the catch can
// give an actionable message instead of the misleading "low gas" one. Best-effort + defensive.
function isRateLimited(e: unknown): boolean {
  let hay = "";
  if (e instanceof Error) hay = e.message;
  else if (typeof e === "string") hay = e;
  else if (e && typeof e === "object") {
    try {
      hay = JSON.stringify(e);
    } catch {
      hay = String(e);
    }
  }
  return /\b-?429\b/.test(hay) || /rate\s*limit/i.test(hay);
}

// A brand-new/empty vetted account has no NEAR → the wallet can't broadcast the write and just hangs on
// "waiting to sign" (the developer-accept bug hit at $0.00). So before signing ANY write, if the
// caller gives us their account, we check the balance and auto-request VRX gas from the faucet. Best-
// effort: if the faucet declines or the balance read is busy, we still proceed to sign (the user may
// have gas the read couldn't) — the write's own timeout still catches a true no-gas hang.
const GAS_FLOOR_NEAR = 0.02;

async function ensureGas(account: string, setState: (s: TxState) => void): Promise<void> {
  try {
    const r = await fetch(`/api/faucet/balance?account=${encodeURIComponent(account)}`);
    const j = (await r.json()) as { availableNear?: number; busy?: boolean };
    if (j.busy) return; // can't tell — don't block; proceed to sign
    if ((j.availableNear ?? 0) >= GAS_FLOOR_NEAR) return; // already has gas
    // Low/empty → top up before signing.
    setState({ phase: "gas", note: "Adding VRX gas so this can go through…" });
    await fetch("/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account }),
    });
    // Give the funding tx a moment to land so the balance is spendable when the wallet signs.
    await new Promise((r) => setTimeout(r, 1500));
  } catch {
    /* best-effort — never block the write on the faucet */
  }
}

export function useTxRun() {
  const [state, setState] = useState<TxState>({ phase: "idle" });
  const busy = state.phase === "gas" || state.phase === "signing" || state.phase === "sent";

  const run = useCallback(
    async (
      fn: () => Promise<string>,
      opts?: {
        successNote?: string;
        mapError?: (e: unknown) => string;
        timeoutMs?: number;
        /** If given, auto-check + top up gas for this account before signing (fixes the no-gas hang). */
        ensureGasFor?: string | null;
      }
    ): Promise<boolean> => {
      try {
        if (opts?.ensureGasFor) await ensureGas(opts.ensureGasFor, setState);
      } catch {
        /* never let the pre-flight abort the write */
      }
      setState({ phase: "signing" });
      try {
        // Guard against a wallet that never responds (Meteor can silently fail to open its approve
        // dialog when it can't reach the RPC — the user then sees "Waiting for your wallet…" forever).
        // Race the signing against a timeout so we surface a clear, actionable message instead.
        const timeoutMs = opts?.timeoutMs ?? 90_000;
        const tx = await Promise.race([
          fn(),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("WALLET_TIMEOUT")), timeoutMs)
          ),
        ]);
        // The wallet returned — the tx is on its way / mined. near's signAndSendTransaction resolves
        // after the outcome, so by here it's effectively confirmed; we still show a brief "sent" beat
        // so the user SEES the hash land before the confirmed state (the process, as it goes).
        setState({ phase: "sent", tx });
        await new Promise((r) => setTimeout(r, 350));
        setState({ phase: "confirmed", tx, note: opts?.successNote });
        return true;
      } catch (e) {
        // A hung wallet gets a specific, actionable message regardless of the screen's own mapError.
        const isTimeout = e instanceof Error && e.message === "WALLET_TIMEOUT";
        // RATE-LIMIT (429) from the WALLET's own RPC: Meteor broadcasts through its OWN RPC,
        // not our FastNEAR-keyed server reads, so a signed write can bounce with a -429 "Rate limits
        // exceeded" even when our dashboard is loading fine. (Observed even on FastNEAR's free testnet
        // endpoint — switching the wallet RPC doesn't reliably help.) It otherwise fell through to the
        // misleading "low gas / busy network" message. Detect it + say what actually helps: just retry
        // (transient), or try a different wallet RPC. This is a wallet-network limit, NOT our server.
        const note = isRateLimited(e)
          ? "Your wallet's network is rate-limited right now (NEAR RPC 429). This is on the wallet's side, not VRX — wait a few seconds and press the button again. If it keeps happening, switch your wallet's RPC to a different testnet provider in its settings."
          : isTimeout
          ? "Your wallet didn't respond — this is usually low gas or a busy network. Open the gear menu → Request VRX gas, then try again."
          : opts?.mapError
          ? opts.mapError(e)
          : e instanceof Error
          ? e.message
          : String(e);
        setState({ phase: "error", note });
        return false;
      }
    },
    []
  );

  const reset = useCallback(() => setState({ phase: "idle" }), []);
  return { state, run, reset, busy };
}

const STEP_LABEL: Record<Exclude<TxPhase, "idle">, string> = {
  gas: "Adding VRX gas so this can go through…",
  signing: "Waiting for your wallet to sign…",
  sent: "Broadcast to NEAR — confirming…",
  confirmed: "Confirmed on-chain",
  error: "Could not complete",
};

/** Inline lifecycle strip. Renders nothing when idle. */
export function TxProgress({ state }: { state: TxState }) {
  if (state.phase === "idle") return null;
  const { phase, tx, note } = state;
  const working = phase === "gas" || phase === "signing" || phase === "sent";
  const ok = phase === "confirmed";
  const err = phase === "error";
  // c (honesty): a DEMO stub tx must NOT read as a real on-chain confirmation to a judge — no
  // explorer link to a non-existent tx, and a "sandbox, not real" label instead of "Confirmed on-chain".
  const isDemoStub = typeof tx === "string" && tx.startsWith("demo-stub");

  return (
    <div
      className={working ? "vrx-working" : ok ? "vrx-flash" : undefined}
      style={{
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${err ? T.danger : ok ? "rgba(56,211,159,0.4)" : T.border}`,
        background: err ? "rgba(255,107,107,0.08)" : ok ? "rgba(56,211,159,0.06)" : T.bg2,
        fontSize: 13.5,
      }}
    >
      {/* The three-beat process, always shown so the user watches it advance. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Beat done={["sent", "confirmed"].includes(phase)} active={phase === "signing"} err={err} label="Sign" />
        <Arrow />
        <Beat done={phase === "confirmed"} active={phase === "sent"} err={false} label="Broadcast" />
        <Arrow />
        <Beat done={phase === "confirmed"} active={false} err={false} label="Confirmed" />
      </div>

      <div style={{ marginTop: 8, color: err ? T.danger : ok ? T.vetted : T.dim }}>
        {ok ? "✓ " : err ? "" : ""}
        {note ?? (ok && isDemoStub ? "Recorded in the sandbox demo" : STEP_LABEL[phase])}
      </div>

      {/* Real tx → explorer link. Demo stub → an honest "not a real transaction" note, never a dead link. */}
      {tx && isDemoStub && (
        <div style={{ marginTop: 6, fontSize: 12, color: T.faint }}>
          Demo sandbox — this action was recorded off-chain, not broadcast to NEAR.
        </div>
      )}
      {tx && !isDemoStub && (
        <div style={{ marginTop: 6, fontFamily: T.mono, fontSize: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: T.faint }}>tx</span>
          <a href={`${EXPLORER_URL}/transactions/${tx}`} target="_blank" rel="noreferrer" style={{ color: T.accent, wordBreak: "break-all" }}>
            {tx}
          </a>
          <CopyBtn text={tx} />
        </div>
      )}
    </div>
  );
}

function Beat({ done, active, err, label }: { done: boolean; active: boolean; err: boolean; label: string }) {
  const color = err ? T.danger : done ? T.vetted : active ? T.accent : T.faint;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color, fontSize: 12.5 }}>
      <span
        className={active ? "vrx-pulse" : undefined}
        style={{
          width: 9,
          height: 9,
          borderRadius: 999,
          background: done || active ? color : "transparent",
          border: `1.5px solid ${color}`,
          display: "inline-block",
        }}
      />
      {label}
    </span>
  );
}

function Arrow() {
  return <span style={{ color: T.faint, fontSize: 12 }}>→</span>;
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      style={{
        minHeight: 0,
        padding: "1px 7px",
        borderRadius: 5,
        border: `1px solid ${T.borderSoft}`,
        background: T.panel,
        color: copied ? T.vetted : T.dim,
        cursor: "pointer",
        fontSize: 11,
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
