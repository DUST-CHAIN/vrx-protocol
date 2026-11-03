"use client";

// The NEAR sign-off panel — sits under the plain export in the validation rail.
//
// PRODUCT RULE: anyone USES MM freely and the plain "Export ingest-pack ZIP" is always on.
// A STAMPED, identity-bearing export additionally requires a real NEAR developer account to SIGN OFF — the
// seal is a NEP-413 signature over the pack's deterministic content digest (lib/seal). No account → connect
// first; connected → "Seal & export" signs the digest, attaches seal.json, and shows the "Sealed by" chip.
//
// Any edit to the pack moves its digest, so a prior stamp no longer matches — we DROP the seal on pack
// change (honest: re-seal after edits). The seal signs the SAME canonical bytes the export emits (one write
// path): packDigest is derived from pack.json's own checksums, and toZip(pack,_,seal) adds the sidecar.

import { useEffect, useState } from "react";
import type { PackApi } from "./usePack";
import { useWallet } from "./useWallet";
import { toZip } from "@/lib/export";
import {
  packDigest,
  sealMessage,
  assembleSeal,
  newNonceB64,
  shortDigest,
  SEAL_RECIPIENT,
  type Seal,
} from "@/lib/seal";

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function SealPanel({ api }: { api: PackApi }) {
  const { pack } = api;
  const { accountId, ready, connect, disconnect, signMessage } = useWallet();
  const [seal, setSeal] = useState<Seal | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // An edit re-derives a different digest → a prior stamp is stale. Drop it so the chip never lies.
  useEffect(() => { setSeal(null); setErr(null); }, [pack]);

  async function sealAndExport() {
    setErr(null);
    if (!accountId) { await connect(); return; } // connect first; the user clicks again once connected
    setBusy(true);
    try {
      const digest = await packDigest(pack);
      const nonceB64 = newNonceB64();
      const signed = await signMessage({ message: sealMessage(digest), recipient: SEAL_RECIPIENT, nonceB64 });
      if (!signed) { setErr("Signing was declined (or this wallet can't sign messages)."); return; }
      const s = assembleSeal({ packDigest: digest, nonceB64, signed });
      setSeal(s);
      download(await toZip(pack, undefined, s), `${pack.developer.id || "pack"}-sealed-pack.zip`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sealing failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mm-seal" style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--mm-border, rgba(128,128,128,0.25))" }}>
      <div className="mm-seal__head" style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>NEAR sign-off</strong>
        <span style={{ fontSize: 11, opacity: 0.7 }}>stamp this building with your NEAR identity</span>
      </div>

      {/* Connection line */}
      <div className="mm-seal__wallet" style={{ fontSize: 12, marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {!ready ? (
          <span style={{ opacity: 0.6 }}>connecting wallet…</span>
        ) : accountId ? (
          <>
            <span title="connected NEAR account">◆ {accountId}</span>
            <button className="mm-btn" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => { void disconnect(); }}>
              disconnect
            </button>
          </>
        ) : (
          <button className="mm-btn" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => { void connect(); }}>
            Connect NEAR
          </button>
        )}
      </div>

      <button
        className="mm-btn mm-btn--primary"
        onClick={() => { void sealAndExport(); }}
        disabled={busy || !ready}
        title={accountId
          ? "Sign off on this exact building with your NEAR key, then export a stamped pack (seal.json)"
          : "Connect a NEAR account to sign off on this building"}
      >
        {busy ? "Signing…" : accountId ? "◆ Seal & export (sign off)" : "◆ Connect NEAR to seal"}
      </button>

      {err && <div style={{ color: "var(--mm-err, #c0392b)", fontSize: 12, marginTop: 6 }}>{err}</div>}

      {seal ? (
        <div
          className="mm-seal__chip"
          title={`Sealed by ${seal.nearAccountId}\ndigest ${seal.packDigest}\nsigned ${seal.signedAt}`}
          style={{
            marginTop: 8, fontSize: 12, lineHeight: 1.4, padding: "7px 10px", borderRadius: 6,
            background: "rgba(0,200,120,0.12)", border: "1px solid rgba(0,200,120,0.4)",
          }}
        >
          <div><b>✓ Sealed by {seal.nearAccountId}</b></div>
          <div style={{ opacity: 0.8, fontFamily: "ui-monospace, monospace" }}>· {shortDigest(seal.packDigest)}</div>
        </div>
      ) : (
        <div className="mm-rail__note" style={{ marginTop: 6 }}>
          Unsealed. The plain export above is unstamped — anyone can author &amp; export; a NEAR sign-off binds this exact building to your identity.
        </div>
      )}
    </div>
  );
}
