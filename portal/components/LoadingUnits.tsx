// Shared "units are loading" placeholder — a spinner + a skeleton grid that holds the layout so the
// panel doesn't jump when the real units arrive (design guideline: skeletons over bare spinners for
// layout stability). Used by the agent, agency, and developer unit views for a consistent load state.

import { T } from "@/lib/theme";

export default function LoadingUnits({ label = "Loading units…", cells = 48 }: { label?: string; cells?: number }) {
  return (
    <div style={{ marginTop: 8 }} aria-busy="true" aria-live="polite">
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: T.dim, marginBottom: 12 }}>
        <span className="vrx-spin" />
        {label}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(46px, 1fr))", gap: 6 }}>
        {Array.from({ length: cells }).map((_, k) => (
          <div key={k} className="vrx-skeleton" style={{ height: 34 }} />
        ))}
      </div>
    </div>
  );
}
