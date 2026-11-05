// /api/root/booking-tokens — the VRX-ROOT booking-token ISSUANCE console (slice 7a). OPERATOR-GATED,
// the same fail-closed posture as /api/root/overview + /api/root/payments.
//
// WHY ROOT OWNS THIS: VRX is the SOLE ISSUER of booking tokens (design decision #6 — a developer cannot mint).
// Issuance is BOTH the scarcity-control lever (VRX governs how much reservation capacity a developer may
// delegate) AND a revenue line (the VRX booking-token issuance fee, a sibling of the V5 protocol fee). So this
// console is where VRX-root: (a) sets a developer's negotiable issuance-fee config (per_token | allotment, with
// the scarcity cap), and (b) issues an allotment of fresh tokens against that cap. Both are VRX-root-only.
//
//   GET  → { configs, developers }
//          configs    = every issuance config on file (house default "*" + per-developer overrides), each with
//                       the developer's LIVE token count + their effective cap (the scarcity picture at a glance).
//          developers = the registry (account + name) so the console can offer a picker + show who has no config.
//   POST { op: "setConfig", config: {...} }       → { config }   — set/replace a developer's (or "*") fee config.
//   POST { op: "issue", developer, count, economics? } → { issued, liveCount, cap }  — issue `count` tokens.
//
// PRIVACY: the issuance fee + cap + token ids are B2B operational facts (no customer PII, no plaintext
// deal terms). Amounts here are the VRX issuance FEE (minor units) — honest + transparent, like the V5 fee.
// AUTH caveat: VRX-root is operator-gated (the secret header), the same demo-layer posture as the other root
// consoles; the real wallet/session binding lands with the signing arc and changes in lib/wallet, not here.

import { NextResponse } from "next/server";
import { listDevelopers } from "@/lib/developers";
import { listProfiles } from "@/lib/profiles";
import {
  listIssuanceConfigs,
  setIssuanceConfig,
  issueTokens,
  liveTokenCount,
  capFor,
  type TokenEconomics,
} from "@/lib/booking-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator gate — FAIL CLOSED, identical to /api/root/overview + /api/root/payments (fix #3). Issuance is
// a VRX-root-only power; an unset secret must DENY. VRX_DEMO_OPEN=1 is the deliberate local escape.
function authed(req: Request): boolean {
  const secret = process.env.VRX_OPERATOR_SECRET;
  if (!secret) return process.env.VRX_DEMO_OPEN === "1";
  return req.headers.get("x-vrx-operator") === secret;
}

const ECONOMICS: readonly TokenEconomics[] = ["stake", "prepaid", "permission"];

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [configs, developers, profiles] = await Promise.all([listIssuanceConfigs(), listDevelopers(), listProfiles()]);
  const nameByAccount = new Map(profiles.map((p) => [p.account.toLowerCase(), p.legalName]));
  const nameOf = (account: string): string => nameByAccount.get(account.trim().toLowerCase()) || account;

  // Decorate each config with the live scarcity picture for its scope (skip the "*" house default — it has no
  // single developer to count). The console shows "N live of cap M" so the operator sees capacity at a glance.
  const decorated = await Promise.all(
    configs.map(async (c) => {
      const isHouse = c.developer === "*";
      const liveCount = isHouse ? null : await liveTokenCount(c.developer);
      return {
        ...c,
        developerName: isHouse ? null : nameOf(c.developer),
        liveCount,
        cap: c.allotmentCap ?? null,
      };
    })
  );

  return NextResponse.json({
    configs: decorated,
    developers: developers.map((d) => ({ account: d.account, name: nameOf(d.account) })),
  });
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const op = typeof body.op === "string" ? body.op : "";

  try {
    if (op === "setConfig") {
      // cleanIssuanceConfig (inside setIssuanceConfig) validates + normalizes; a malformed payload throws → 400.
      const config = await setIssuanceConfig(body.config);
      return NextResponse.json({ config });
    }

    if (op === "issue") {
      const developer = typeof body.developer === "string" ? body.developer.trim() : "";
      const count = Number(body.count);
      if (!developer) return NextResponse.json({ error: "developer required" }, { status: 400 });
      const economics = ECONOMICS.includes(body.economics) ? (body.economics as TokenEconomics) : undefined;
      const issued = await issueTokens(developer, count, economics ? { economics } : undefined);
      const [liveCount, cap] = await Promise.all([liveTokenCount(developer), capFor(developer)]);
      return NextResponse.json({ issued, liveCount, cap });
    }

    return NextResponse.json({ error: "unknown op (setConfig | issue)" }, { status: 400 });
  } catch (e) {
    // The lib throws on a structurally-invalid config, an un-configured developer, or a scarcity-cap breach —
    // all CLIENT errors on the current state, not server faults. 400 with the lib's own message.
    const msg = e instanceof Error ? e.message : "request failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
