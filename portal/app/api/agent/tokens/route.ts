// /api/agent/tokens — the field AGENT's booking-token surface ( slice 7c). The agent holds a token its
// agency handed down, uses it to SECURE A BOOKING on a unit (meters the slot), records the CUSTOMER'S CASH it
// took on the spot, and can RELEASE a booking that fell through before any cash was taken.
// GET ?agent=<acct>&viewer=<acct>
// → { tokens } — the tokens currently in the agent's custody, plain-words state labels.
// POST { agent, op, tokenId... }
// op:"commit" { buildingId, unitId, requestId? } → secure a booking (with_agent → committed; meters
// the slot: one booking per token). The on-chain
// firm-hold is the EXISTING direct-deposits seam
// the deal flow wires separately — this records
// + binds the token's slot off-chain (deferred
// chain write, same seam as the lib's slice 4).
// op:"recordCash" — record the cash taken on the spot (committed → cash_taken). TWO request shapes:
// • JSON { amountMinor, currency, evidenceId?, requestId? } — amount + an optional REFERENCE.
// • multipart/form-data { op, tokenId, agent, amountMinor, currency, requestId?, photo? } — the field
// agent attaches an encrypted PHOTO of the receipt; the route encrypts it into the token-scoped
// evidence vault (lib/token-evidence, reusing the AES-GCM pipeline) and passes the resulting
// `evidenceId` into recordCash. The bytes NEVER leave the server unencrypted. ( seam #2.)
// op:"release" {} → release a pre-cash committed booking (deal fell
// through) back to the agent's slot to re-commit.
// AUTH (demo-layer): the viewer/caller names its own account and must equal the agent subject. The lib enforces
// holder-scope (only the agent holding the token may act) + the one-slot-per-token + monotonic-cash invariants.
// PRIVACY: the cash AMOUNT + any evidence stay off-chain; only ids + accounts + states seal.

import { NextResponse } from "next/server";
import { listProfiles } from "@/lib/profiles";
import {
  tokensInCustody,
  commitToken,
  recordCash,
  releaseCommit,
  type BookingToken,
} from "@/lib/booking-tokens";
import { putTokenEvidence, VaultLockedError } from "@/lib/token-evidence";
import { publish } from "@/lib/bus";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8 MB, same cap as the KYC upload
const OK_PHOTO_MIME = /^image\/(jpeg|png|webp|heic|heif)$/i;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, string> = {
  with_agent: "Ready — secure a booking",
  committed: "Booking secured — record the cash",
  cash_taken: "Cash recorded — awaiting your agency",
  reconciling: "Reconciling up the chain",
  settled: "Settled",
  frozen: "Paused",
  recycled: "Returned",
};

function viewToken(t: BookingToken, nameOf: (a: string) => string) {
  return {
    id: t.id,
    state: t.state,
    stateLabel: STATE_LABEL[t.state] ?? t.state,
    economics: t.economics,
    developer: t.developer,
    developerName: nameOf(t.developer),
    buildingId: t.buildingId ?? null,
    unitId: t.unitId ?? null,
    requestId: t.requestId ?? null,
    cash: t.cash ? { amountMinor: t.cash.amountMinor, currency: t.cash.currency, disputed: !!t.cash.disputed, evidenceId: t.cash.evidenceId ?? null, agencyConfirmedAt: t.cash.agencyConfirmedAt ?? null, developerConfirmedAt: t.cash.developerConfirmedAt ?? null } : null,
    issuedAt: t.issuedAt,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const agent = url.searchParams.get("agent")?.trim() || "";
  const viewer = url.searchParams.get("viewer")?.trim() || "";
  if (!agent) return NextResponse.json({ error: "agent required" }, { status: 400 });
  if (!viewer || viewer.toLowerCase() !== agent.toLowerCase()) {
    return NextResponse.json({ error: "viewer must match agent" }, { status: 403 });
  }

  const [held, profiles] = await Promise.all([tokensInCustody(agent), listProfiles()]);
  const nameByAccount = new Map(profiles.map((p) => [p.account.toLowerCase(), p.legalName]));
  const nameOf = (account: string): string => nameByAccount.get(account.trim().toLowerCase()) || account;

  return NextResponse.json({ tokens: held.map((t) => viewToken(t, nameOf)) });
}

export async function POST(req: Request) {
  const ctype = req.headers.get("content-type") || "";

  // ── multipart: recordCash WITH an encrypted photo of the receipt ( seam #2) ─────────────────────────
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "invalid form" }, { status: 400 });
    const agent = String(form.get("agent") || "").trim();
    const op = String(form.get("op") || "").trim();
    const tokenId = String(form.get("tokenId") || "").trim();
    if (!agent || !tokenId) return NextResponse.json({ error: "agent and tokenId required" }, { status: 400 });
    if (op !== "recordCash") return NextResponse.json({ error: "only recordCash accepts a photo upload" }, { status: 400 });

    const amountMinor = Number(form.get("amountMinor"));
    const currency = String(form.get("currency") || "");
    const requestId = String(form.get("requestId") || "").trim() || undefined;

    // Optional photo — encrypt it FIRST (into the token-scoped vault), then record the cash with its ref. The
    // order matters: a failed/locked vault must not leave a cash record pointing at a photo that never landed.
    let evidenceId: string | undefined;
    const photo = form.get("photo");
    if (photo instanceof File && photo.size > 0) {
      if (!OK_PHOTO_MIME.test(photo.type)) return NextResponse.json({ error: "photo must be an image (jpeg/png/webp/heic)" }, { status: 400 });
      if (photo.size > MAX_PHOTO_BYTES) return NextResponse.json({ error: "photo too large (max 8 MB)" }, { status: 400 });
      try {
        const bytes = Buffer.from(await photo.arrayBuffer());
        const meta = await putTokenEvidence(tokenId, { bytes, filename: photo.name || "receipt", mime: photo.type, uploadedBy: agent });
        evidenceId = meta.id;
      } catch (e) {
        if (e instanceof VaultLockedError) return NextResponse.json({ error: "the evidence vault is locked — try again or record without a photo" }, { status: 503 });
        throw e;
      }
    }

    try {
      const token = await recordCash({ tokenId, by: agent, amountMinor, currency, evidenceId, requestId });
      publish("events");
      return NextResponse.json({ token });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "request failed";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  }

  // ── JSON: every op (recordCash here takes an optional evidenceId REFERENCE, no bytes) ───────────────────
  const body = await req.json().catch(() => ({}));
  const agent = typeof body.agent === "string" ? body.agent.trim() : "";
  const op = typeof body.op === "string" ? body.op : "";
  const tokenId = typeof body.tokenId === "string" ? body.tokenId.trim() : "";
  if (!agent || !tokenId) return NextResponse.json({ error: "agent and tokenId required" }, { status: 400 });

  try {
    if (op === "commit") {
      const buildingId = typeof body.buildingId === "string" ? body.buildingId.trim() : "";
      const unitId = typeof body.unitId === "string" ? body.unitId.trim() : "";
      if (!buildingId || !unitId) return NextResponse.json({ error: "buildingId and unitId required" }, { status: 400 });
      const requestId = typeof body.requestId === "string" ? body.requestId.trim() || undefined : undefined;
      const token = await commitToken({ tokenId, by: agent, buildingId, unitId, requestId });
      publish("events");
      return NextResponse.json({ token });
    }

    if (op === "recordCash") {
      const amountMinor = Number(body.amountMinor);
      const currency = typeof body.currency === "string" ? body.currency : "";
      const evidenceId = typeof body.evidenceId === "string" ? body.evidenceId.trim() || undefined : undefined;
      const requestId = typeof body.requestId === "string" ? body.requestId.trim() || undefined : undefined;
      const token = await recordCash({ tokenId, by: agent, amountMinor, currency, evidenceId, requestId });
      publish("events");
      return NextResponse.json({ token });
    }

    if (op === "release") {
      const token = await releaseCommit(tokenId, agent);
      publish("events");
      return NextResponse.json({ token });
    }

    return NextResponse.json({ error: "unknown op (commit | recordCash | release)" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "request failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
