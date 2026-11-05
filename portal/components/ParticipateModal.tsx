"use client";

// ParticipateModal (F9) — the "Help fund & run VRX" surface rendered as an in-app MODAL OVERLAY instead
// of a full-page navigation / new tab (: "this should open in a popup, not a new tab"). It mirrors the
// content of the /participate route (that route still exists as a deep-linkable page); this is the overlay
// every NodeLicensesNudge opens by default. Same overlay convention as ContractModal (fixed backdrop, click-
// outside to close, inner stopPropagation). The heavy NetworkMap (Leaflet) mounts only while the modal is open.

import { T } from "@/lib/theme";
import Portal from "@/components/Portal";
import NodeLicensesPanel from "@/components/NodeLicensesPanel";
import NetworkMap from "@/components/NetworkMap";
import { PARENT_ASSET } from "@/lib/node-licenses";

export default function ParticipateModal({ onClose }: { onClose: () => void }) {
  return (
    <Portal>
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Help fund and run VRX"
      style={{
        position: "fixed", inset: 0, background: "rgba(4,7,12,0.78)", zIndex: 1000,
        display: "flex", alignItems: "flex-start", justifyContent: "center", overflow: "auto", padding: "32px 16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative", width: "min(720px, 100%)", background: T.bg, color: T.text,
          border: `1px solid ${T.border}`, borderRadius: 12, padding: "28px 24px",
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close"
          style={{
            position: "absolute", top: 12, right: 12, width: 34, height: 34, borderRadius: 999,
            border: `1px solid ${T.border}`, background: T.bg2, color: T.faint, fontSize: 18, lineHeight: 1,
            cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center",
          }}
        >
          ×
        </button>

        <h1 style={{ fontSize: 24, margin: "0 6px 6px 0", color: T.text, paddingRight: 36 }}>Help fund &amp; run VRX</h1>
        <p style={{ fontSize: 14, color: T.dim, lineHeight: 1.6, marginTop: 0 }}>
          VRX is low-cost to use and built for the benefit of all. The way to help finance and grow the protocol —
          and share in running it — is to acquire a <strong style={{ color: T.text }}>node-operator license</strong>:
          a <code style={{ color: "#f7931a" }}>{PARENT_ASSET}</code> asset on Bitcoin. Operators run nodes in key
          locations (operator income + protocol growth); the proceeds fund development and operations directly.
        </p>

        <div style={{ margin: "6px 0 2px" }}>
          <h2 style={{ fontSize: 16, color: T.text, margin: "0 0 8px" }}>The VRX node network</h2>
          <NetworkMap />
        </div>
        <NodeLicensesPanel />
      </div>
    </div>
    </Portal>
  );
}
