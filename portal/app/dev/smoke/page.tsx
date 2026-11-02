// THE PROBLEM it solves: the money/legal surfaces (the S&P contract + review mode, the settlement console,
// projected income, payment ledgers, the VRX/sale-terms config panels, the KYC vault) are spread across 4
// role apps behind wallet connects and navigation. Verifying them all meant "walk the 4 apps and click into
// each deal" — slow, and easy to miss a surface. This page mounts EVERY high-risk surface on ONE scroll,
// NO FIXTURE DRIFT (the decision): every surface here is a self-fetching client component that pulls
// its data from the same server routes the live apps use — we only hand it the seeded account/requestId.
// A green here therefore exercises the identical code path the real app does; it cannot show a surface that
// "works in the harness but not in the app". The booking ids are DISCOVERED from the live store at render
// time (lib/offers), never hardcoded, so this keeps working across reseeds.
// DEV-ONLY: returns 404 in a production build (never ships this harness to a real deployment). It is a
// verification aid, not a product surface — contract FROZEN, nothing on-chain, read-only money views.

import { notFound } from "next/navigation";
import { offersForDeveloper, contractStage } from "@/lib/offers";
import { agencyOf } from "@/lib/agents";
import {
  SMOKE_DEVELOPERS,
  pickBookingsByStage,
  pickRichestBooking,
  type SmokeBooking,
} from "@/lib/smoke-fixtures";
import { SmokeSurfaces } from "./SmokeSurfaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DevWorld = {
  developer: string;
  bookings: SmokeBooking[];
  richest: SmokeBooking | null;
  /** agent → supervising agency, for the agency-viewer S&P demo (resolved server-side). */
  agencyByAgent: Record<string, string | null>;
};

export default async function SmokePage() {
  if (process.env.NODE_ENV === "production") notFound();

  const worlds: DevWorld[] = [];
  for (const developer of SMOKE_DEVELOPERS) {
    const offers = await offersForDeveloper(developer);
    const bookings = pickBookingsByStage(offers, contractStage);
    const richest = pickRichestBooking(bookings);
    // Resolve each booking's agent → supervising agency once, server-side (the client cannot read agents.json).
    const agencyByAgent: Record<string, string | null> = {};
    for (const b of bookings) {
      if (b.agent && !(b.agent in agencyByAgent)) agencyByAgent[b.agent] = await agencyOf(b.agent);
    }
    worlds.push({ developer, bookings, richest, agencyByAgent });
  }

  return <SmokeSurfaces worlds={worlds} />;
}
