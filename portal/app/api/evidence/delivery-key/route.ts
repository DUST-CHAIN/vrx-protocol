// /api/evidence/delivery-key — the AUTHENTICATED party's X25519 DELIVERY key (so they can HOLD their own encrypted
// evidence packs, lib/evidence-delivery-key). The PRIVATE key is the party's own and NEVER reaches the server (the
// server only ever SEALS to the public key; it cannot open packs) — mirrors the KYC operator-key posture.
//
//   GET  → { registered: boolean, current?: <pubkey b64>, archivedCount?, updatedAt? } — does the caller have a key?
//   POST { publicKeyB64 } → register / rotate the caller's delivery PUBLIC key. Rotation archives the prior key so
//                           packs sealed to it stay openable. Validated server-side (a bad key → 400).
//
// AUTH — CALLER-SCOPED, FAIL CLOSED (VRX-0001 class). A party may only register / read THEIR OWN delivery key — the
// account is the PROVEN caller (requireCaller), never a client-supplied ?account=. Registering a key for someone else
// would let an attacker redirect that party's future packs to a key THEY control (a seal-to-attacker hijack), so the
// scope is load-bearing, not cosmetic.
//
// PRIVACY: the stored value is a PUBLIC key (safe at rest — seal-only) + the handle + a timestamp. No PII, no
// private key. GET returns only whether a key exists + the public key + a rotation count — never anything secret.

import { NextResponse } from "next/server";
import { requireCaller } from "@/lib/caller";
import { registerDeliveryKey, deliveryKeyRecord } from "@/lib/evidence-delivery-key";
import { generateDeliveryKeypair } from "@/lib/evidence-pack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const claimed = new URL(req.url).searchParams.get("account")?.trim() || "";
  const who = requireCaller(req, { param: claimed });
  if (!who.ok) return NextResponse.json({ error: who.reason }, { status: who.status });

  const rec = await deliveryKeyRecord(who.account);
  if (!rec) return NextResponse.json({ registered: false });
  return NextResponse.json({
    registered: true,
    current: rec.current,
    archivedCount: rec.archived.length,
    updatedAt: rec.updatedAt,
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const claimed = typeof body.account === "string" ? body.account.trim() : "";
  const who = requireCaller(req, { param: claimed });
  if (!who.ok) return NextResponse.json({ error: who.reason }, { status: who.status });

  // MINT path (convenience): when the party has no key material of their own, the server generates a fresh
  // X25519 keypair, registers the PUBLIC half, and returns the PRIVATE half ONCE for the party to save. The server
  // does NOT store the private key (it drops out of scope here) — the party MUST save it or they can't open future
  // packs. This is the honest interim UX before the NEAR-wallet-derive follow-on (then there's nothing to save: the
  // delivery key derives from the wallet key the party already controls). A sophisticated party POSTs their OWN
  // publicKeyB64 instead (no private key ever touches the server) — the preferred path; mint is the easy on-ramp.
  if (body.action === "mint") {
    const kp = generateDeliveryKeypair();
    try {
      const rec = await registerDeliveryKey(who.account, kp.publicKeyB64);
      return NextResponse.json({
        ok: true,
        minted: true,
        current: rec.current,
        // ⚠ Returned ONCE, never stored server-side. The party saves this; losing it means losing access to packs
        // sealed to the matching public key (they can always rotate to a new key for FUTURE packs).
        privateKeyB64: kp.privateKeyB64,
        archivedCount: rec.archived.length,
        updatedAt: rec.updatedAt,
      });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "mint failed" }, { status: 400 });
    }
  }

  const publicKeyB64 = typeof body.publicKeyB64 === "string" ? body.publicKeyB64.trim() : "";
  if (!publicKeyB64) return NextResponse.json({ error: "publicKeyB64 required" }, { status: 400 });

  try {
    // Register to the PROVEN caller (never a body account) — a party only ever sets their OWN delivery key.
    const rec = await registerDeliveryKey(who.account, publicKeyB64);
    return NextResponse.json({ ok: true, current: rec.current, archivedCount: rec.archived.length, updatedAt: rec.updatedAt });
  } catch (e) {
    // registerDeliveryKey throws on a key that doesn't parse as X25519 SPKI/DER → surface a 400 (not a 500).
    return NextResponse.json({ error: e instanceof Error ? e.message : "invalid delivery key" }, { status: 400 });
  }
}
