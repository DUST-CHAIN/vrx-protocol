"use client";

// NodeLicensesPanel — the BTC NODE-LICENSE FUNNEL. The one reusable rich card that invites a
// user to help FUND & RUN the VRX protocol by buying a Vetted Realty node-operator license on Bitcoin.
//
// HONEST BY DESIGN (project HARD rule): these are REAL Bitcoin-denominated assets, utterly DISTINCT from $VRX
// (off-chain play credit). The card says so plainly, uses a Bitcoin-orange accent (not the $VRX blue) so the
// two never visually blur, and makes clear the purchase happens on Counterparty / tokenscan.io — VRX custodies
// nothing and processes no payment here. Every row + the footer deep-link OUT to tokenscan for the live market.
//
// Each row shows the REAL node (name + city, from the on-chain asset metadata) + its minted-on-BTC CARD image
// (pulled live from vettedrealty.com) — tap the card to POP IT OUT, zoomable (the shared Lightbox).
//
// Data = lib/node-licenses (a vendored snapshot + an "as of" date; the UI always points to tokenscan for live
// price/availability so a stale snapshot is never passed off as current).

import { useState } from "react";
import { card } from "@/lib/ui";
import { T } from "@/lib/theme";
import Lightbox from "@/components/Lightbox";
import {
  nodeLicenses,
  formatBtc,
  SNAPSHOT_AS_OF,
  PARENT_ASSET,
  TOKENSCAN_BASE,
} from "@/lib/node-licenses";

const BTC = "#f7931a"; // Bitcoin orange — the deliberate "this is REAL, on Bitcoin" signal (not the $VRX blue)

export default function NodeLicensesPanel() {
  const licenses = nodeLicenses();
  const images = licenses.map((l) => l.image);
  const captions = licenses.map((l) => `${l.name} · ${l.code} · ${formatBtc(l.priceBtc)} ₿`);
  const [popped, setPopped] = useState<number | null>(null);

  return (
    <section style={{ ...card }} aria-label="Node operator licenses">
      <h3 style={{ margin: "2px 0 2px", fontSize: 16, color: T.text, display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ color: BTC }}>₿</span> Fund &amp; run VRX — node licenses
      </h3>
      <p style={{ margin: "0 0 10px", fontSize: 13, color: T.dim, lineHeight: 1.5 }}>
        Real value lives on Bitcoin. A <strong style={{ color: T.text }}>node-operator license</strong> is a{" "}
        <code style={{ color: BTC, fontFamily: T.mono, fontSize: 12 }}>{PARENT_ASSET}</code> subasset on
        Counterparty — buying one helps <strong style={{ color: T.text }}>finance and run the VRX protocol</strong>{" "}
        and lets you operate a node in a key city (operator income + protocol growth, for the benefit of all).
        This is <strong style={{ color: T.text }}>not $VRX</strong> (that&apos;s in-system play credit) — it&apos;s a
        real Bitcoin asset, bought on tokenscan, not here.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {licenses.map((l, i) => (
          <a
            key={l.asset}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              borderRadius: 8,
              background: T.bg2,
              border: `1px solid ${T.border}`,
              textDecoration: "none",
              color: T.text,
            }}
            title={`Open ${l.asset} on tokenscan.io`}
          >
            {/* Node CARD thumbnail — tap to pop out (zoomable). stopPropagation so it doesn't follow the row link. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={l.image}
              alt={`${l.name} node card`}
              width={56}
              height={36}
              loading="lazy"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setPopped(i);
              }}
              style={{ width: 56, height: 36, objectFit: "cover", borderRadius: 5, border: `1px solid ${T.border}`, flexShrink: 0, cursor: "zoom-in", background: T.bg }}
            />
            <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 13, color: T.text, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {l.name}
              </span>
              <span style={{ fontSize: 11, color: T.faint, fontFamily: T.mono }}>{l.code} · node license</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <span
                style={{ fontSize: 10.5, color: l.open ? T.open : T.faint, border: `1px solid ${l.open ? T.open : T.border}`, borderRadius: 999, padding: "1px 7px" }}
              >
                {l.open ? "OPEN" : "CLOSED"}
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: BTC, whiteSpace: "nowrap" }}>
                {formatBtc(l.priceBtc)} ₿
              </span>
              <span aria-hidden style={{ color: T.faint, fontSize: 13 }}>↗</span>
            </span>
          </a>
        ))}
      </div>

      <p style={{ margin: "10px 0 0", fontSize: 11, color: T.faint, lineHeight: 1.5 }}>
        Prices &amp; availability as of {SNAPSHOT_AS_OF} — see{" "}
        <a href={TOKENSCAN_BASE + PARENT_ASSET} target="_blank" rel="noopener noreferrer" style={{ color: BTC }}>
          tokenscan.io/asset/{PARENT_ASSET}
        </a>{" "}
        for the live market. Purchases settle on Bitcoin via Counterparty dispensers — VRX does not hold or
        process your BTC. Equity in the parent company: vrx@vettedrealty.com.
      </p>

      {popped !== null && (
        <Lightbox images={images} start={popped} caption={captions[popped]} onClose={() => setPopped(null)} />
      )}
    </section>
  );
}
