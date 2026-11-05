// POST /api/offers/instalment-due-date — pin an explicit DUE DATE on a plan INSTALMENT.
//
//   POST { requestId, viewer, instalment, dueAt }   — dueAt (ms epoch) null/0 clears the override.
//
// Every payment carries a date. By default an instalment's due date is auto-derived from the
// offer/booking date + the plan's payment frequency (lib/sale-contract `instalmentDueDate`). When the buyer
// wants a specific date — or a derived date lands on a weekend/holiday — the desk pins it here. The pinned
// date is NOT a hidden side-arrangement: it renders in the S&P §2 and feeds the payment ledger exactly like
// every other figure. Editable while `preview`, FROZEN at `final` (409) — the same stage guard as the other
// deal-tailoring surfaces. DEVELOPER/DESK-ONLY (roleOnOffer resolves the direct desk as "developer" too).

import { NextResponse } from "next/server";
import { getOffer, setInstalmentDueDate } from "@/lib/offers";
import { roleOnOffer } from "@/lib/participant";
import { getBuilding } from "@/lib/catalog";
import { instalmentDueDate, validateInstalmentDueDate, type SalePlan } from "@/lib/sale-contract";

const DAY_MS = 86_400_000;
const MONTH_MS = 30 * DAY_MS;
const LONGSTOP_MS = 30 * 365 * DAY_MS; // absolute far-out cap when no completion window is known (~30y)

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const viewer = typeof body.viewer === "string" ? body.viewer.trim() : "";
  const instalment = Number(body.instalment);
  // dueAt: a finite positive ms epoch sets the override; null / 0 / absent clears it (revert to auto-interval).
  const dueAtRaw = body.dueAt;
  const dueAt = typeof dueAtRaw === "number" && Number.isFinite(dueAtRaw) && dueAtRaw > 0 ? Math.round(dueAtRaw) : null;
  if (!requestId || !viewer || !(instalment >= 1)) {
    return NextResponse.json({ error: "requestId + viewer + instalment(>=1) required" }, { status: 400 });
  }

  const offer = await getOffer(requestId);
  if (!offer) return NextResponse.json({ error: "offer not on file" }, { status: 404 });

  const role = await roleOnOffer(offer, viewer);
  if (role !== "developer") {
    return NextResponse.json({ error: "only the developer may set instalment due dates" }, { status: 403 });
  }

  // The ordinal must be within the sealed plan's instalment count — a date on a non-existent instalment would
  // never render (the renderer only dates ordinals 1..instalmentCount), so reject it rather than store a ghost.
  const plan = (offer.seal?.plan ?? null) as SalePlan | null;
  const count = typeof plan?.instalmentCount === "number" ? Math.max(0, Math.floor(plan.instalmentCount)) : 0;
  if (dueAt !== null && !(instalment <= count)) {
    return NextResponse.json({ error: "that instalment is not in the plan" }, { status: 409 });
  }

  //  (· catch) — SANITY-check a pinned date before storing it. VRX doesn't judge
  // fairness (the desk sets their own terms, shown transparently to the buyer), but it stops structurally-broken
  // or "never-due" dates that could become a silent trap or park the commission-unlock indefinitely. Only runs
  // when SETTING a date (clearing is always allowed). A soft warning is surfaced but does NOT block the store.
  let warn: string | undefined;
  if (dueAt !== null) {
    const anchor = offer.at;
    // Far-out cap = the building's completion window + a 12-month margin, else the absolute ~30y long-stop.
    const building = offer.display?.buildingId ? await getBuilding(offer.display.buildingId) : null;
    const months = building?.project?.completeWithinMonths;
    const maxAt = typeof months === "number" && months > 0 ? anchor + (months + 12) * MONTH_MS : anchor + LONGSTOP_MS;
    // Effective (override-or-auto) dates of the OTHER instalments, so order is checked against what §2 shows.
    const existing = offer.instalmentDueDates ?? {};
    const neighbours: Record<number, number> = {};
    for (let n = 1; n <= count; n++) {
      if (n === instalment) continue;
      const d = instalmentDueDate(n, { anchorAt: anchor, freqDays: plan?.frequencyDays, override: existing[String(n)] });
      if (typeof d === "number") neighbours[n] = d;
    }
    const v = validateInstalmentDueDate({ dueAt, ordinal: instalment, bookingAt: anchor, maxAt, neighbours });
    if (!v.ok) return NextResponse.json({ error: v.reject ?? "That date isn't valid for this instalment." }, { status: 409 });
    warn = v.warn;
  }

  const { offer: updated, locked } = await setInstalmentDueDate(requestId, instalment, dueAt);
  if (locked) return NextResponse.json({ error: "the contract is final — the schedule is locked" }, { status: 409 });
  return NextResponse.json({ ok: true, instalmentDueDates: updated?.instalmentDueDates ?? {}, ...(warn ? { warn } : {}) });
}
