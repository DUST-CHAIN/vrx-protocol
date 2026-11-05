// /api/stamp-jobs — the developer's CLEAN-SLATE onboarding batch-stamp, run as a durable BACKGROUND JOB
// (§6c of the design docs). The developer assembles a plan (each unit → its
// real on-chain state), submits it, and the server worker drips ≤50-tile stamp_tiles chunks over time
// (rate-spread, resumable). Completing a job only STAMPS tiles — "going on contract" (zero-time) is the
// SEPARATE action at /api/stamp-jobs/go-on-contract.
//
//   POST { caller, building, plan:[{unit,unitKey,status,integrityHash}], spreadMs? }
//        — DEVELOPER queues a stamp job for their building. caller must own the building; every plan unit
//          must exist in it. Returns the created job.
//   GET  ?caller=&building=   — the latest job for one building (the onboarding-state readout).
//   GET  ?caller=&id=         — one job by id (progress polling).
//   GET  ?caller=             — all of this developer's jobs, newest first.
//   PATCH { caller, id, action:"pause"|"resume" } — control a job the caller owns.
//
// AUTH: capability-based (caller names its account); the authorization that matters (caller == the building's
// owning developer, resolved via deskDeveloperFor) is enforced here. This session the worker's sign step is
// STUBBED (no live txs) — the route is safe to exercise end-to-end with zero on-chain writes (scope).

import { NextResponse } from "next/server";
import {
  createJob,
  getJob,
  jobsForDeveloper,
  latestJobFor,
  pauseJob,
  resumeJob,
  progressOf,
  type StampItem,
} from "@/lib/stamp-jobs";
import { deskDeveloperFor } from "@/lib/conversations-direct";
import { getBuilding } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** caller must be the building's owning developer (deskDeveloperFor). Returns the normalized owner or an error. */
async function authorizeDeveloper(caller: string, building: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const owner = await deskDeveloperFor(building);
  if (!owner || owner.toLowerCase() !== caller.toLowerCase()) {
    return { ok: false, status: 403, error: "not the developer for this building" };
  }
  return { ok: true };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const caller = url.searchParams.get("caller")?.trim() || "";
  const building = url.searchParams.get("building")?.trim() || "";
  const id = url.searchParams.get("id")?.trim() || "";
  if (!caller) return NextResponse.json({ error: "caller required" }, { status: 400 });

  // One job by id — caller must own it.
  if (id) {
    const job = await getJob(id);
    if (!job || job.developer !== caller.toLowerCase()) {
      return NextResponse.json({ error: "no such job" }, { status: 404 });
    }
    return NextResponse.json({ job, progress: progressOf(job) });
  }

  // Latest job for one building — caller must own the building.
  if (building) {
    const authz = await authorizeDeveloper(caller, building);
    if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status });
    const job = await latestJobFor(caller, building);
    return NextResponse.json({ job, progress: job ? progressOf(job) : null });
  }

  // All of this developer's jobs.
  const jobs = await jobsForDeveloper(caller);
  return NextResponse.json({ jobs: jobs.map((j) => ({ job: j, progress: progressOf(j) })) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const caller = typeof body.caller === "string" ? body.caller.trim() : "";
  const building = typeof body.building === "string" ? body.building.trim() : "";
  const planRaw = Array.isArray(body.plan) ? body.plan : [];
  const spreadMs = typeof body.spreadMs === "number" ? body.spreadMs : undefined;
  if (!caller || !building) {
    return NextResponse.json({ error: "caller + building required" }, { status: 400 });
  }

  const authz = await authorizeDeveloper(caller, building);
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status });

  // Every plan unit must actually be in the building (don't stamp a phantom set). Fail closed on unknown.
  const bld = await getBuilding(building);
  if (!bld) return NextResponse.json({ error: "no such building" }, { status: 404 });
  const known = new Set(bld.inventory.map((u) => u.id));
  const plan: StampItem[] = [];
  const unknown: string[] = [];
  for (const raw of planRaw) {
    const unit = typeof raw?.unit === "string" ? raw.unit.trim() : "";
    if (!unit || !known.has(unit)) {
      if (unit) unknown.push(unit);
      continue;
    }
    plan.push({
      unit,
      unitKey: typeof raw?.unitKey === "string" ? raw.unitKey.trim() : "",
      status: raw?.status,
      integrityHash: typeof raw?.integrityHash === "string" ? raw.integrityHash.trim() : "",
    });
  }
  if (unknown.length > 0) {
    return NextResponse.json({ error: "unknown unit(s) in the plan", units: unknown }, { status: 400 });
  }

  const job = await createJob({ developer: caller, building, plan, spreadMs });
  if (!job) return NextResponse.json({ error: "empty or invalid plan" }, { status: 400 });
  return NextResponse.json({ job, progress: progressOf(job) });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const caller = typeof body.caller === "string" ? body.caller.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim() : "";
  if (!caller || !id) return NextResponse.json({ error: "caller + id required" }, { status: 400 });

  const job = await getJob(id);
  if (!job || job.developer !== caller.toLowerCase()) {
    return NextResponse.json({ error: "no such job" }, { status: 404 });
  }

  let updated;
  if (action === "pause") updated = await pauseJob(id);
  else if (action === "resume") updated = await resumeJob(id);
  else return NextResponse.json({ error: "action must be pause|resume" }, { status: 400 });

  if (!updated) return NextResponse.json({ error: "could not update job" }, { status: 400 });
  return NextResponse.json({ job: updated, progress: progressOf(updated) });
}
