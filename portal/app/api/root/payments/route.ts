// WHY ROOT MAY SEE THIS: the VRX protocol fee unlocks on the SAME customer→developer payment progress the
// agency commission does (PAYMENT_LEDGER_DESIGN §7 — "the fee line in byVrx gets the same payable graduation"),
// so root legitimately co-owns the settlement rollup. And buyer DISPUTES are an operational distress signal
// (an early read on the §3b VRX clock / §3c grace→suspension routine), so root sees that a developer HAS
// disputes, how many, and how old.
// THE PRIVACY LINE (doc §7 — the design decision this route turns on): root is NOT a standing viewer of
// payment SLIPS or dispute NOTES or AMOUNTS — those are B2B developer↔buyer PII. So this route shows root:
// • ALWAYS: per-developer/agency settlement balances (owed/paid) + per-deal audit rows + dispute COUNT + the
// oldest-open dispute age (the distress signal). No customer amount, no note, no slip.
// • ONLY WHEN SHARED to `vrx` (a party opened the disputed record to root via disputeShare): that one
// record's amount + note + a flag that evidence is available. Everything else about a dispute stays hidden.
// The settlement balances are commission/fee figures (B2B money VRX facilitates), NOT the customer's payment
// amounts — those never leave the developer↔buyer boundary here.

import { NextResponse } from "next/server";
import { listProfiles } from "@/lib/profiles";
import { listDevelopers } from "@/lib/developers";
import { getCatalog } from "@/lib/catalog";
import { settlementRollup } from "@/lib/earmark";
import { paymentsForDeveloper, sharedTo, type PaymentRecord } from "@/lib/payment-vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator gate — FAIL CLOSED, identical to /api/root/overview + /api/profiles (fix #3). This read crosses
// every party's money boundary, so an unset secret must DENY. VRX_DEMO_OPEN=1 is the deliberate local escape.
function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

const DAY = 24 * 60 * 60 * 1000;

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = Date.now();

  const [profiles, developers, catalog, settlement] = await Promise.all([
    listProfiles(),
    listDevelopers(),
    getCatalog(),
    settlementRollup(),
  ]);

  const nameByAccount = new Map(profiles.map((p) => [p.account.toLowerCase(), p.legalName]));
  const nameOf = (account: string): string => nameByAccount.get(account.trim().toLowerCase()) || account;
  const buildingName = new Map(catalog.map((b) => [b.id, b.name]));
  const bName = (id?: string) => (id ? buildingName.get(id) ?? id : "—");

  // ── DISPUTES per developer (privacy-filtered). A disputed OFFLINE payment is the distress signal. Count +
  // oldest-open age are always root-visible; the amount/note only when the record was shared to `vrx`. ──
  const disputesByDeveloper = new Map<
    string,
    { count: number; oldestOpenAt: number | null; shared: { requestId?: string; buildingId?: string; unitId?: string; amountUsd: number; note?: string; hasEvidence: boolean; disputedAt: number }[] }
  >();
  for (const dev of developers) {
    const records = await paymentsForDeveloper(dev.account);
    const disputed = records.filter((r: PaymentRecord) => r.buyerConfirm === "disputed");
    if (disputed.length === 0) continue;
    const oldestOpenAt = disputed.reduce<number | null>(
      (min, r) => (r.buyerConfirmAt && (min === null || r.buyerConfirmAt < min) ? r.buyerConfirmAt : min),
      null
    );
    // Only records a party explicitly shared to `vrx` expose their amount + note to root. Everything
    // else contributes to the COUNT + AGE but reveals no PII.
    const shared = disputed
      .filter((r) => sharedTo(r, "vrx"))
      .map((r) => ({
        requestId: r.requestId,
        buildingId: r.buildingId,
        unitId: r.unitId,
        amountUsd: r.amountUsd,
        note: r.disputeNote,
        hasEvidence: r.evidence.length > 0,
        disputedAt: r.buyerConfirmAt ?? r.updatedAt,
      }));
    disputesByDeveloper.set(dev.account.toLowerCase(), { count: disputed.length, oldestOpenAt, shared });
  }

  // ── Per-developer rollup: the VRX-fee line + every agency-commission line + its disputes. One row per
  // developer so the console reads "here is DevCo's money picture at a glance". ──
  const vrxByDev = new Map(settlement.byVrx.map((v) => [v.developer.trim().toLowerCase(), v]));
  const agencyByDev = new Map<string, typeof settlement.byAgency>();
  for (const a of settlement.byAgency) {
    const key = a.developer.trim().toLowerCase();
    const list = agencyByDev.get(key) ?? [];
    list.push(a);
    agencyByDev.set(key, list);
  }

  // Union of every developer that appears in the registry OR any settlement line (a developer may owe VRX/an
  // agency without being in the local registry, e.g. a chain-only developer).
  const devKeys = new Set<string>();
  for (const d of developers) devKeys.add(d.account.trim().toLowerCase());
  for (const v of settlement.byVrx) devKeys.add(v.developer.trim().toLowerCase());
  for (const a of settlement.byAgency) devKeys.add(a.developer.trim().toLowerCase());

  const byDeveloper = [...devKeys]
    .map((key) => {
      const vrx = vrxByDev.get(key);
      const agencyLines = agencyByDev.get(key) ?? [];
      const disputes = disputesByDeveloper.get(key) ?? { count: 0, oldestOpenAt: null, shared: [] };
      return {
        developer: key,
        developerName: nameOf(key),
        vrxFee: vrx
          ? {
              accruedUsd: vrx.accruedUsd,
              prospectiveUsd: vrx.prospectiveUsd,
              outstandingUsd: vrx.outstandingUsd,
              saleCount: vrx.saleCount,
              deals: vrx.deals.map((d) => ({
                requestId: d.requestId,
                building: bName(d.buildingId),
                unitId: d.unitId ?? "—",
                amountUsd: d.amountUsd,
                kind: d.kind,
                vrxPayable: d.vrxPayable ?? false,
                vrxPayableReason: d.vrxPayableReason,
                vrxDueAt: d.vrxDueAt ?? null,
              })),
            }
          : null,
        agencies: agencyLines.map((a) => ({
          agency: a.agency,
          agencyName: nameOf(a.agency),
          accruedUsd: a.accruedUsd,
          prospectiveUsd: a.prospectiveUsd,
          payableUsd: a.payableUsd,
          outstandingUsd: a.outstandingUsd,
          saleCount: a.saleCount,
          deals: a.deals.map((d) => ({
            requestId: d.requestId,
            building: bName(d.buildingId),
            unitId: d.unitId ?? "—",
            amountUsd: d.amountUsd,
            kind: d.kind,
            payable: d.payable ?? false,
            payableReason: d.payableReason,
          })),
        })),
        disputes: {
          count: disputes.count,
          oldestOpenAgeDays: disputes.oldestOpenAt ? Math.floor((now - disputes.oldestOpenAt) / DAY) : null,
          shared: disputes.shared, // amount + note ONLY for records shared to vrx
        },
      };
    })
    // Sort: developers with open disputes first (loudest), then by VRX outstanding (most owed), then name.
    .sort((a, b) => {
      if ((b.disputes.count > 0 ? 1 : 0) !== (a.disputes.count > 0 ? 1 : 0)) {
        return (b.disputes.count > 0 ? 1 : 0) - (a.disputes.count > 0 ? 1 : 0);
      }
      const ao = a.vrxFee?.outstandingUsd ?? 0;
      const bo = b.vrxFee?.outstandingUsd ?? 0;
      if (bo !== ao) return bo - ao;
      return a.developerName.localeCompare(b.developerName);
    });

  const totalDisputes = [...disputesByDeveloper.values()].reduce((n, d) => n + d.count, 0);

  return NextResponse.json({
    totals: {
      commission: settlement.totals.commission,
      vrxFee: settlement.totals.vrxFee,
      openDisputes: totalDisputes,
    },
    byDeveloper,
  });
}
