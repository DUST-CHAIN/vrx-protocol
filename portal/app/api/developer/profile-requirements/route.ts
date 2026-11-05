// /api/developer/profile-requirements — a developer reads/sets WHICH buyer-profile fields it requires before
// a direct buyer may make an offer on its units (§9 / Phase 3; the config surface for
// Developer.requiredProfileFields). The readiness resolver (lib/buyers-direct readinessFor / readinessAcross)
// already READS this override; this route is just the write + read surface that lets a developer tune it.
//
//   GET  ?developer=<acct>          → { required: string[], defaults: string[] }  (required = the configured
//                                      override, or the DEFAULT set when none; defaults = the default set, so
//                                      the UI can show "these are always required" as the floor).
//   POST { developer, fields }      → save the override. `fields` is cleaned to real BuyerDirectProfile keys;
//                                      an EMPTY/absent list CLEARS the override (→ falls back to the default
//                                      set). The default fields are ALWAYS required — a developer can only ADD
//                                      to them, never drop below, so we union the cleaned extras with the
//                                      default set before saving (the floor can't be configured away).
//
// AUTH posture (matches the rest of the off-chain developer-authored demo layer, e.g.
// /api/catalog/building-setup): trusted caller — `developer` is the caller's own account; the signed-request
// binding is the deferred F1 signing arc. A developer only ever writes its OWN row. Server-side validated so a
// malformed payload can't corrupt the store.

import { NextResponse } from "next/server";
import { getDeveloper, saveDeveloper, type Developer } from "@/lib/developers";
import { DEFAULT_REQUIRED_PROFILE_FIELDS, requiredFieldsFor } from "@/lib/buyers-direct";
import { cleanRequired } from "@/lib/profile-requirements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULTS = DEFAULT_REQUIRED_PROFILE_FIELDS as string[];

export async function GET(req: Request) {
  const developer = new URL(req.url).searchParams.get("developer")?.trim() || "";
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });
  const dev = await getDeveloper(developer);
  // requiredFieldsFor resolves override-or-default; expose both so the UI can mark the default floor.
  const required = requiredFieldsFor(dev?.requiredProfileFields) as string[];
  return NextResponse.json({ required, defaults: DEFAULTS });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const developer = typeof body.developer === "string" ? body.developer.trim() : "";
  if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });

  const dev = await getDeveloper(developer);
  if (!dev) return NextResponse.json({ error: "developer not found" }, { status: 404 });

  const fields = cleanRequired(body.fields);
  // If the override equals exactly the default set, store nothing (absent = default) to keep the record clean
  // and the "is this customized?" check honest.
  const isJustDefault = fields.length === DEFAULTS.length && DEFAULTS.every((d) => fields.includes(d));
  const updated: Developer = { ...dev, requiredProfileFields: isJustDefault ? undefined : fields };
  await saveDeveloper(updated);

  return NextResponse.json({
    required: requiredFieldsFor(updated.requiredProfileFields) as string[],
    defaults: DEFAULTS,
  });
}
