"use client";

// we resolve an agent's on-chain access (get_peer → gates, with retries when the RPC is throttled),
// show a live DOS/console log of what's actually happening. Honest + on-brand ("show the process as it
// goes"): the user sees "network busy, retrying (2/5)…" rather than a blank that looks like "no access".
// Pure presentational: the caller drives it with a list of step lines. Reuse anywhere a multi-step
// network resolution wants to be visible (the picker now; could wrap wallet-connect later).

export type LogLine = {
  /** The step text, e.g. "resolving your agency". */
  text: string;
  /** pending = in progress (spinner) · ok = done (✓) · warn = retrying/busy (amber) · done = final ✓. */
  state: "pending" | "ok" | "warn";
  /** Optional trailing detail, e.g. "dysfunctional-smoke" or "retrying (2/5)". */
  detail?: string;
};

export default function ConnectLog({ lines, title = "Connecting…" }: { lines: LogLine[]; title?: string }) {
  return (
    <div
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        lineHeight: 1.7,
        background: "#0a0d14",
        border: "1px solid #1c2130",
        borderRadius: 10,
        padding: "14px 16px",
        color: "#c7cde0",
      }}
    >
      <div style={{ opacity: 0.6, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>
        {title}
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
          <Marker state={l.state} />
          <span style={{ opacity: l.state === "pending" ? 0.75 : 1 }}>{l.text}</span>
          {l.detail && (
            <span style={{ opacity: 0.6, color: l.state === "warn" ? "#ffb454" : l.state === "ok" ? "#38d39f" : "#8a93a8" }}>
              {l.detail}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function Marker({ state }: { state: LogLine["state"] }) {
  if (state === "ok") return <span style={{ color: "#38d39f", width: 14, display: "inline-block" }}>✓</span>;
  if (state === "warn") return <span style={{ color: "#ffb454", width: 14, display: "inline-block" }}>…</span>;
  // pending
  return <span className="vrx-spin" aria-hidden="true" style={{ width: 14 }} />;
}
