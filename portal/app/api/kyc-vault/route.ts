// /api/kyc-vault — the AGENT side of the encrypted buyer-KYC vault (pt-2, lib/kyc-vault).
// The agent owns the buyer roster (lib/buyers) and attaches encrypted identity documents + the structured
// contract fields + an optional captured GPS to a buyer record. Everything is SCOPED to the owning agent.
//
//   GET  ?buyerId=&agent=                 → { entry } metadata (NO bytes, NO crypto) for this agent's buyer,
//                                           or { entry: null } if absent / not this agent's.
//   POST (multipart/form-data)            → UPLOAD one encrypted doc. fields: agent, buyerId, kind, file.
//   POST (application/json) { op:"fields" } → save/merge the structured contract fields.
//   POST (application/json) { op:"gps" }    → record the captured GPS (lat/lng[/accuracy]).
//   DELETE ?buyerId=&agent=&docId=        → delete one doc (removes the ciphertext blob + record).
//
// AUTH POSTURE (demo-layer, same as /api/buyers): the caller NAMES itself via `agent`; the store refuses any
// cross-agent read/write (lib/kyc-vault scopes every op). This is PII — one agent's private buyer KYC,
// never exposed to another party. The plaintext DOCUMENT bytes are served ONLY by /api/kyc-vault/doc, which
// re-authorizes the reader (agent-owns-buyer, or the developer at the pre-sign gate). Encrypted at rest.

import { NextResponse } from "next/server";
import {
  getEntryForAgent,
  saveFieldsForAgent,
  saveGpsForAgent,
  addDocForAgent,
  deleteDocForAgent,
  entryMeta,
  VaultLockedError,
  type KycDocKind,
} from "@/lib/kyc-vault";
import { requireCaller, type Caller } from "@/lib/caller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS: KycDocKind[] = ["headshot", "id_card", "passport", "card_front"];
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per image — a phone photo of an ID/passport fits comfortably
const OK_MIME = /^image\/(jpeg|png|webp|heic|heif)$/i; // images only (the choice); the human visual match

// KYC is the crown-jewel PII vault (audit VRX-0002). The `agent` scope MUST be the PROVEN caller, never a
// client-supplied string — otherwise anyone who knows a public agent id reads another agent's buyers' passports.
// Resolve the owning agent from the session seam: on a REAL deploy requireCaller yields a verified session or
// 401 (demoRoleUxArmed is false → the forgeable param path is UNREACHABLE, so the IDOR is dead); on the
// wallet-less demo/localnet it yields the assumed-role account (seeded aliases, no real PII). Either way the
// scope key is the caller's OWN proven account — a stranger can never name a victim agent to read their vault.
function resolveAgent(req: Request, claimed: string): { ok: true; agent: string } | { ok: false; res: NextResponse } {
  const caller: Caller = requireCaller(req, { param: claimed });
  if (!caller.ok) return { ok: false, res: NextResponse.json({ error: "sign-in required" }, { status: 401 }) };
  return { ok: true, agent: caller.account };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const buyerId = url.searchParams.get("buyerId")?.trim() || "";
  const claimed = url.searchParams.get("agent")?.trim() || "";
  if (!buyerId) return NextResponse.json({ error: "buyerId required" }, { status: 400 });
  const who = resolveAgent(req, claimed);
  if (!who.ok) return who.res;
  const entry = await getEntryForAgent(buyerId, who.agent);
  return NextResponse.json({ entry: entry ? entryMeta(entry) : null });
}

export async function POST(req: Request) {
  const ctype = req.headers.get("content-type") || "";

  // ── JSON ops: structured fields + GPS ──────────────────────────────────────────────────────────────
  if (ctype.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    const claimed = typeof body.agent === "string" ? body.agent.trim() : "";
    const buyerId = typeof body.buyerId === "string" ? body.buyerId.trim() : "";
    if (!buyerId) return NextResponse.json({ error: "buyerId required" }, { status: 400 });
    const who = resolveAgent(req, claimed);
    if (!who.ok) return who.res;
    const agent = who.agent;
    try {
      if (body.op === "fields") {
        const entry = await saveFieldsForAgent(buyerId, agent, body.fields);
        return NextResponse.json({ ok: true, entry: entryMeta(entry) });
      }
      if (body.op === "gps") {
        const lat = Number(body.lat);
        const lng = Number(body.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return NextResponse.json({ error: "lat + lng required" }, { status: 400 });
        }
        const accuracy = Number.isFinite(Number(body.accuracy)) ? Number(body.accuracy) : undefined;
        const entry = await saveGpsForAgent(buyerId, agent, { lat, lng, accuracy });
        return NextResponse.json({ ok: true, entry: entryMeta(entry) });
      }
      return NextResponse.json({ error: "unknown op (expected fields|gps)" }, { status: 400 });
    } catch {
      return NextResponse.json({ error: "you can only edit buyers you own" }, { status: 403 });
    }
  }

  // ── multipart: encrypted document upload ─────────────────────────────────────────────────────────────
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "invalid form" }, { status: 400 });
    const claimed = String(form.get("agent") || "").trim();
    const buyerId = String(form.get("buyerId") || "").trim();
    const kind = String(form.get("kind") || "").trim() as KycDocKind;
    const file = form.get("file");
    if (!buyerId) return NextResponse.json({ error: "buyerId required" }, { status: 400 });
    const who = resolveAgent(req, claimed);
    if (!who.ok) return who.res;
    const agent = who.agent;
    if (!KINDS.includes(kind)) return NextResponse.json({ error: "kind must be one of " + KINDS.join("|") }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
    if (!OK_MIME.test(file.type)) return NextResponse.json({ error: "images only (jpeg/png/webp/heic)" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "image too large (max 8 MB)" }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      const entry = await addDocForAgent(buyerId, agent, kind, {
        bytes,
        filename: file.name || `${kind}.img`,
        mime: file.type,
      });
      return NextResponse.json({ ok: true, entry: entryMeta(entry) });
    } catch (e) {
      if (e instanceof VaultLockedError) {
        return NextResponse.json({ error: "vault is locked — an operator must unlock it before uploads" }, { status: 503 });
      }
      return NextResponse.json({ error: "you can only upload to buyers you own" }, { status: 403 });
    }
  }

  return NextResponse.json({ error: "unsupported content-type" }, { status: 415 });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const buyerId = url.searchParams.get("buyerId")?.trim() || "";
  const claimed = url.searchParams.get("agent")?.trim() || "";
  const docId = url.searchParams.get("docId")?.trim() || "";
  if (!buyerId || !docId) return NextResponse.json({ error: "buyerId + docId required" }, { status: 400 });
  const who = resolveAgent(req, claimed);
  if (!who.ok) return who.res;
  const entry = await deleteDocForAgent(buyerId, who.agent, docId);
  return NextResponse.json({ ok: true, entry: entry ? entryMeta(entry) : null });
}
