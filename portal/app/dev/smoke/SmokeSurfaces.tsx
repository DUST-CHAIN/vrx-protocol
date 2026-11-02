"use client";

// Client layout for /dev/smoke. Receives the server-discovered fixture "worlds" (one per seeded
// set on one scroll. Every surface is a REAL self-fetching component pointed at a seeded account/requestId;
// this file only arranges them and labels WHICH real booking backs each one.

import { useState } from "react";
import { T } from "@/lib/theme";
import { card } from "@/lib/ui";
import SaleContractButton from "@/components/SaleContractButton";
import SettlementView from "@/components/SettlementView";
import IncomeProjection from "@/components/IncomeProjection";
import PaymentLedgerPanel from "@/components/PaymentLedgerPanel";
import BuyerPaymentPanel from "@/components/BuyerPaymentPanel";
import ReconciliationPanel from "@/components/ReconciliationPanel";
import VrxAgreementPanel from "@/components/VrxAgreementPanel";
import SaleTermsDefaultsPanel from "@/components/SaleTermsDefaultsPanel";
import { KycVaultPanel } from "@/components/KycVault";
import { DealChatPanel } from "@/components/DealChat";
import RelationshipChannel from "@/components/RelationshipChannel";
import DirectEnquiries from "@/components/DirectEnquiries";
import BuyerRequirements from "@/components/BuyerRequirements";
import type { SmokeBooking } from "@/lib/smoke-fixtures";

type DevWorld = {
  developer: string;
  bookings: SmokeBooking[];
  richest: SmokeBooking | null;
  agencyByAgent: Record<string, string | null>;
};

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ margin: "28px 0" }}>
      <h2 style={{ fontSize: 18, color: T.text, margin: "0 0 2px" }}>{title}</h2>
      {hint && <p style={{ fontSize: 12.5, color: T.dim, margin: "0 0 14px" }}>{hint}</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>{children}</div>
    </section>
  );
}

function Surface({ label, backing, children }: { label: string; backing?: string; children: React.ReactNode }) {
  return (
    <div style={{ ...card, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <strong style={{ color: T.text, fontSize: 14 }}>{label}</strong>
        {backing && (
          <span style={{ fontSize: 11, color: T.dim, fontFamily: "ui-monospace, Menlo, monospace" }}>{backing}</span>
        )}
      </div>
      {children}
    </div>
  );
}

export function SmokeSurfaces({ worlds }: { worlds: DevWorld[] }) {
  const [active, setActive] = useState(worlds[0]?.developer ?? "");
  const world = worlds.find((w) => w.developer === active) ?? worlds[0];

  if (!world) {
    return (
      <main style={{ maxWidth: 980, margin: "0 auto", padding: 24, color: T.text }}>
        <h1>Smoke route</h1>
        <p style={{ color: T.dim }}>No seeded offers found. Run the funnel seed first (npm run demo / seed).</p>
      </main>
    );
  }

  const b = world.richest;

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "24px 24px 80px", color: T.text }}>
      <header style={{ borderBottom: `1px solid ${T.border}`, paddingBottom: 14, marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Surface smoke test</h1>
        <p style={{ color: T.dim, fontSize: 13, margin: "6px 0 0" }}>
          Dev-only. Every panel below is the real component fed from the real seed through the real APIs — a
          green here is the same code path the live apps use. Booking ids are discovered from the store, so
          this survives a reseed. Switch developer to exercise each seeded world.
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          {worlds.map((w) => (
            <button
              key={w.developer}
              type="button"
              onClick={() => setActive(w.developer)}
              style={{
                padding: "5px 12px",
                borderRadius: 7,
                border: `1px solid ${w.developer === active ? T.accent : T.border}`,
                background: w.developer === active ? "rgba(61,125,255,0.12)" : T.bg2,
                color: w.developer === active ? T.text : T.dim,
                cursor: "pointer",
                fontSize: 12.5,
              }}
            >
              {w.developer}
            </button>
          ))}
        </div>
      </header>

      {/* ── S&P CONTRACT + REVIEW MODE — the richest booking, from all three viewer roles (masking) ── */}
      <Section
        title="Sale & Purchase contract + review mode"
        hint="The same booking seen by each party. Open 'Review fields' in the modal for the QA checklist. The developer view masks the buyer (withheld, not missing) until reveal; agent/agency see full detail."
      >
        {b ? (
          <Surface
            label={`S&P — ${b.buildingId ?? "?"}/${b.unitId || "unit"} · stage: ${b.stage}${b.confirmed ? " · closed on-chain" : ""}`}
            backing={`req ${b.requestId.slice(0, 10)}…`}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <SaleContractButton requestId={b.requestId} viewer={b.developer} label="As developer (masked)" />
              <SaleContractButton requestId={b.requestId} viewer={b.agent} label="As agent (full)" />
              {world.agencyByAgent[b.agent] && (
                <SaleContractButton
                  requestId={b.requestId}
                  viewer={world.agencyByAgent[b.agent] as string}
                  label="As agency (full)"
                />
              )}
            </div>
          </Surface>
        ) : (
          <Surface label="S&P">
            <span style={{ color: T.dim }}>No bookings for this developer.</span>
          </Surface>
        )}

        {/* The other stages too, so review-mode and the build-state fork get exercised at preview/final. */}
        {world.bookings
          .filter((x) => !b || x.requestId !== b.requestId)
          .map((x) => (
            <Surface
              key={x.requestId}
              label={`S&P — stage: ${x.stage}`}
              backing={`${x.buildingId ?? "?"}/${x.unitId || "unit"} · req ${x.requestId.slice(0, 8)}…`}
            >
              <SaleContractButton requestId={x.requestId} viewer={x.agent} label="View (agent)" />
            </Surface>
          ))}
      </Section>

      {/* ── SETTLEMENT CONSOLE — the money-owed dashboard, both roles ── */}
      <Section
        title="Settlement console"
        hint="Accrued vs prospective vs payable. Developer sees what they owe (per agency + VRX fee); agency sees what they're owed."
      >
        <Surface label="As developer — what I owe" backing={world.developer}>
          <SettlementView me={world.developer} role="developer" />
        </Surface>
        {b && world.agencyByAgent[b.agent] && (
          <Surface label="As agency — owed to me" backing={world.agencyByAgent[b.agent] as string}>
            <SettlementView me={world.agencyByAgent[b.agent] as string} role="agency" />
          </Surface>
        )}
      </Section>

      {/* ── PROJECTED INCOME — the developer's expected/received/behind curves ── */}
      <Section
        title="Projected income"
        hint="Expected vs received vs behind-schedule per building. Gross buyer receipts, indicative — never take-home."
      >
        <Surface label="Developer projected income" backing={world.developer}>
          <IncomeProjection developer={world.developer} />
        </Surface>
      </Section>

      {/* ── PAYMENT LEDGERS — per-deal, developer and buyer/agent views ── */}
      <Section
        title="Payment ledgers"
        hint="The per-deal money trail. Developer-scoped ledger + the buyer/agent payment panel."
      >
        {b ? (
          <>
            <Surface label="Developer deal ledger" backing={`req ${b.requestId.slice(0, 8)}…`}>
              <PaymentLedgerPanel
                requestId={b.requestId}
                developer={b.developer}
                buildingId={b.buildingId}
                unitId={b.unitId}
              />
            </Surface>
            <Surface label="Agent payment panel" backing={b.agent}>
              <BuyerPaymentPanel mode="agent" account={b.agent} requestId={b.requestId} heading="Deal payments" />
            </Surface>
            <Surface label="Reconciliation (agent proxy)" backing={`req ${b.requestId.slice(0, 8)}…`}>
              <ReconciliationPanel requestId={b.requestId} viewer={b.agent} canLog heading="Reconcile payments" />
            </Surface>
            <Surface label="Reconciliation (developer, read-only)" backing={b.developer}>
              <ReconciliationPanel requestId={b.requestId} viewer={b.developer} canLog={false} heading="Reconcile payments" />
            </Surface>
          </>
        ) : (
          <Surface label="Payment ledger">
            <span style={{ color: T.dim }}>No bookings for this developer.</span>
          </Surface>
        )}
      </Section>

      {/* ── CONFIG PANELS — the developer's VRX agreement + default sale terms ── */}
      <Section
        title="Developer configuration"
        hint="The dials behind the contract: the signed VRX↔developer agreement and the house default sale/termination terms."
      >
        <Surface label="VRX agreement (sign / re-sign per building)" backing={world.developer}>
          <VrxAgreementPanel me={world.developer} />
        </Surface>
        <Surface label="Default sale & termination terms" backing={world.developer}>
          <SaleTermsDefaultsPanel me={world.developer} />
        </Surface>
      </Section>

      {/* ── KYC VAULT — the agent's encrypted buyer vault for a seeded buyer ── */}
      {b?.buyerId && (
        <Section
          title="KYC vault"
          hint="The agent-held encrypted buyer identity vault. Mounts against a seeded buyer + the authoring agent."
        >
          <Surface label="Buyer KYC vault (agent view)" backing={`buyer ${b.buyerId}`}>
            <KycVaultPanel buyerId={b.buyerId} agent={b.agent} />
          </Surface>
        </Section>
      )}

      {/* ── DEAL CHAT — the negotiation thread (a legal-adjacent record), both viewer roles ── */}
      {b && (
        <Section
          title="Deal chat (negotiation thread)"
          hint="The per-deal message trail. Seen as developer and as agent — the same thread, each party's view."
        >
          <Surface label="As developer" backing={`req ${b.requestId.slice(0, 8)}…`}>
            <DealChatPanel requestId={b.requestId} viewerRole="developer" me={b.developer} />
          </Surface>
          <Surface label="As agent" backing={b.agent}>
            <DealChatPanel requestId={b.requestId} viewerRole="agent" me={b.agent} />
          </Surface>
        </Section>
      )}

      {/* ── RELATIONSHIP CHANNEL (Part D) — the cross-deal developer↔agency thread, both viewer roles ── */}
      {b && world.agencyByAgent[b.agent] && (
        <Section
          title="Relationship channel (developer↔agency)"
          hint="The cross-deal thread spanning the whole developer↔agency relationship (not one booking) — the Part D channel the halt 'ask more' routes into. Seen from both sides."
        >
          <Surface label="As developer" backing={world.developer}>
            <RelationshipChannel developer={world.developer} agency={world.agencyByAgent[b.agent]!} me={world.developer} />
          </Surface>
          <Surface label="As agency (the agent's supervising agency)" backing={world.agencyByAgent[b.agent]!}>
            <RelationshipChannel developer={world.developer} agency={world.agencyByAgent[b.agent]!} me={b.agent} />
          </Surface>
        </Section>
      )}

      {/* ── DIRECT-BUYER DESK — the developer's direct enquiries inbox + vetting flow ── */}
      <Section
        title="Direct-buyer desk"
        hint="The developer's own direct-sale inbox: incoming enquiries, replies, and the buyer-vetting flow (the seed also populates direct buyers B0–B3)."
      >
        <Surface label="Direct enquiries (developer view)" backing={world.developer}>
          <DirectEnquiries me={world.developer} />
        </Surface>
      </Section>

      {/* ── BUYER REQUIREMENTS — the buyer-side profile/requirements panel ── */}
      {b?.buyerId && (
        <Section
          title="Buyer requirements"
          hint="The buyer's requirements/profile panel, mounted against a seeded buyer account."
        >
          <Surface label="Buyer requirements (buyer view)" backing={`buyer ${b.buyerId}`}>
            <BuyerRequirements me={b.buyerId} />
          </Surface>
        </Section>
      )}
    </main>
  );
}
