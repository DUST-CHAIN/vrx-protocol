// Liveness probe. Deliberately trivial + dependency-free: no RPC, no disk, no contract call — it
// answers "is the Node process up and serving?" and nothing more. It is the ONE path middleware.ts leaves
// open while VRX_MAINTENANCE_MODE is on, so an uptime monitor / load balancer still gets a 200 during an
// emergency freeze. Not a readiness check (it doesn't assert dependencies are healthy) — just liveness.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic"; // never cache a liveness answer

export function GET() {
  return NextResponse.json({ ok: true, service: "vrx-portal", ts: new Date().toISOString() });
}
