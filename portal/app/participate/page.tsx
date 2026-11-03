"use client";

// /participate — the dedicated "help FUND & run VRX" surface. The deliberate invitation to
// finance the protocol by buying a real Bitcoin node-operator license. Surface #3 of the node-license funnel
// (the other two: the compact nudge in the wallet area + the ☰ menu / onboarding).
//
// Honest framing (HARD rule): this is REAL Bitcoin value, distinct from $VRX play credit — the page + the
// NodeLicensesPanel say so plainly, and the purchase happens on tokenscan/Counterparty, never here.

import Link from "next/link";
import { T } from "@/lib/theme";
import NodeLicensesPanel from "@/components/NodeLicensesPanel";
import NetworkMap from "@/components/NetworkMap";
import { PARENT_ASSET } from "@/lib/node-licenses";

export default function Participate() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 20px" }}>
      <Link href="/" style={{ color: T.dim, fontSize: 13, textDecoration: "none" }}>← Back</Link>
      <h1 style={{ fontSize: 26, margin: "14px 0 6px", color: T.text }}>Help fund &amp; run VRX</h1>
      <p style={{ fontSize: 14, color: T.dim, lineHeight: 1.6, marginTop: 0 }}>
        VRX is low-cost to use and built for the benefit of all. The way to help finance and grow the protocol —
        and share in running it — is to acquire a <strong style={{ color: T.text }}>node-operator license</strong>:
        a <code style={{ color: "#f7931a" }}>{PARENT_ASSET}</code> asset on Bitcoin. Operators run nodes in key
        locations (operator income + protocol growth); the proceeds fund development and operations directly.
      </p>
      {/* The ecosystem map — the global node network (+ agencies), the promo-grade "where VRX runs" picture. */}
      <div style={{ margin: "6px 0 2px" }}>
        <h2 style={{ fontSize: 16, color: T.text, margin: "0 0 8px" }}>The VRX node network</h2>
        <NetworkMap />
      </div>
      <NodeLicensesPanel />
    </main>
  );
}
