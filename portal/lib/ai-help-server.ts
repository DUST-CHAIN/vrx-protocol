// AI help — server-only brain for the help widget. Two public things live here:
//   1. decideAllow(...) — the PURE rate/spend-limit decision (per-IP session cap + HARD global daily token
//      ceiling), extracted so it's unit-testable without network/disk/clock. This is the money-protection
//      core: a DeepSeek call costs real tokens, and a public pre-launch chat is an abuse surface, so the
//      ceiling must FAIL CLOSED — when it's hit, the route returns "capped" and the client falls back to the
//      free pre-written help (lib/ai-help-content). A per-session cap alone is bypassable (new session = fresh
//      quota), so the real backstop is the GLOBAL daily token tally.
//   2. askDeepSeek(...) — the actual DeepSeek call (server-only key) + the VRX system prompt. The prompt is
//      sourced from public/for-ai-agent.md: CAPABILITY-level only, honest about [built] vs [planned], NEVER
//      mechanism (the privacy moat — no hash/HMAC mechanics), structural legal posture, refuses off-topic so
//      it can't be used as a free general-LLM proxy. Contact is vrx@vettedrealty.com, NEVER the forbidden Gmail.
//
// Same `.data` store idiom as lib/booking-codes.ts (readStore/writeStore + serialized mutate). Secret read
// from process.env.DEEPSEEK_API_KEY — server-only, never NEXT_PUBLIC_, never committed (same discipline as
// AXIOM_TOKEN). DeepSeek's API is OpenAI-compatible; base URL + model are env-overridable so a deploy can
// retune without a code change.

import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "ai-help-usage.json");

// ── Tunables (env-overridable at deploy, no code change) ───────────────────────────────────────────────
/** Max AI messages one IP may send per rolling session day. Fairness, not the real backstop. */
export const PER_IP_DAILY = Number(process.env.AI_HELP_PER_IP_DAILY || 12);
/** HARD global ceiling: total DeepSeek tokens (prompt+completion) we will spend across ALL users per day.
 *  When exceeded, the route fails CLOSED → free pre-written help only. This is the wallet protection. */
export const GLOBAL_DAILY_TOKENS = Number(process.env.AI_HELP_GLOBAL_DAILY_TOKENS || 200_000);
/** Cap tokens per single answer so one prompt can't gulp the whole day's budget. */
export const MAX_COMPLETION_TOKENS = Number(process.env.AI_HELP_MAX_TOKENS || 500);

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
// Use the CHEAP model: `deepseek-chat` (the V3 chat model) — NOT `deepseek-reasoner` (R1), which costs several
// times more per token. DeepSeek has no separate "flash" tier; deepseek-chat IS the low-cost one, and it also
// picks up DeepSeek's automatic off-peak discount + prompt-cache pricing. Env-overridable if that ever changes.
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

// ── The usage store shape ──────────────────────────────────────────────────────────────────────────────
// Keyed per UTC day so the ledger self-resets at midnight; we only ever keep today's bucket (old days are
// dropped on read), so the file can't grow unbounded.
type DayBucket = {
  day: string; // "YYYY-MM-DD" (UTC)
  tokensUsed: number; // running global token tally for the day
  perIp: Record<string, number>; // ip -> messages sent today
};
type Store = { bucket: DayBucket };

/** UTC day string for a timestamp. Exported for the test. */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function emptyBucket(now: number): DayBucket {
  return { day: dayKey(now), tokensUsed: 0, perIp: {} };
}

// ── The PURE limit decision (no IO, no clock) — the heart of the money protection, unit-pinned. ─────────
export type Decision =
  | { allow: true }
  | { allow: false; reason: "ip_capped" | "global_capped" };

/**
 * Decide whether to serve an AI answer, given the CURRENT day bucket and this IP. Order matters:
 *   - global ceiling checked FIRST (the wallet backstop wins over per-user fairness),
 *   - then the per-IP daily cap.
 * Both fail CLOSED (deny) — the caller turns a denial into the free-help fallback, never an error.
 */
export function decideAllow(bucket: DayBucket, ip: string, now: number): Decision {
  // A stale bucket (yesterday) is treated as empty — same reset the store read applies, so the pure fn and
  // the persisted fn agree on the rollover boundary.
  const fresh = bucket.day === dayKey(now) ? bucket : emptyBucket(now);
  if (fresh.tokensUsed >= GLOBAL_DAILY_TOKENS) return { allow: false, reason: "global_capped" };
  const ipCount = fresh.perIp[ip] ?? 0;
  if (ipCount >= PER_IP_DAILY) return { allow: false, reason: "ip_capped" };
  return { allow: true };
}

// ── Persisted store (serialized read-modify-write, same as the other .data stores) ──────────────────────
async function readStore(): Promise<Store> {
  const now = Date.now();
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, "utf8")) as Partial<Store>;
    const b = parsed?.bucket;
    // Drop a stale (previous-day) bucket on read so the ledger self-resets at UTC midnight.
    if (b && b.day === dayKey(now) && typeof b.tokensUsed === "number" && b.perIp) {
      return { bucket: { day: b.day, tokensUsed: b.tokensUsed, perIp: { ...b.perIp } } };
    }
  } catch {
    /* no file yet / unreadable → fresh bucket */
  }
  return { bucket: emptyBucket(now) };
}

async function writeStore(s: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(s, null, 2), "utf8");
}

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (s: Store) => { next: Store; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readStore();
    const { next, ret } = fn(cur);
    await writeStore(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

/** Check the limit for `ip` against the persisted ledger. Does NOT consume — call recordUsage after a
 *  successful answer. (Reads the live bucket, applies the same day-rollover as decideAllow.) */
export async function checkLimit(ip: string): Promise<Decision> {
  const { bucket } = await readStore();
  return decideAllow(bucket, ip, Date.now());
}

/** Record one served answer: +1 for this IP, + token cost to the global tally. Serialized so concurrent
 *  requests can't lose a write. */
export async function recordUsage(ip: string, tokens: number): Promise<void> {
  await mutate((s) => {
    const now = Date.now();
    const b = s.bucket.day === dayKey(now) ? s.bucket : emptyBucket(now);
    const next: Store = {
      bucket: {
        day: b.day,
        tokensUsed: b.tokensUsed + Math.max(0, tokens),
        perIp: { ...b.perIp, [ip]: (b.perIp[ip] ?? 0) + 1 },
      },
    };
    return { next, ret: undefined };
  });
}

// ── The VRX system prompt (capability-level, honest, refuses off-topic) ─────────────────────────────────
// Sourced from public/for-ai-agent.md. Keep in sync with that doc's owner-rule: if a capability ships or a
// product promise moves, update BOTH. NEVER describe [planned] as usable today; NEVER reveal mechanism.
export const VRX_SYSTEM_PROMPT = `You are the VRX help assistant, embedded in the VRX demo portal. You answer questions from prospects, hackathon judges and evaluators about VRX — honestly and concisely.

WHAT VRX IS
VRX is a private, on-chain reservation primitive — one trusted source of truth for who reserved what. An operator with unique, non-substitutable inventory (unit 312 is not unit 311) feeds live availability to many mutually-distrusting sales teams/agencies, who browse, book, reserve, pay a deposit and hold — privately. It is a callable NEAR smart contract plus an off-chain portal. Real estate (off-plan property) is the beachhead and proof; the primitive is domain-agnostic (cars, livestock, equipment, event slots all fit).

THE PRIVACY MOAT
No personal data, no prices and no deal terms ever go on-chain. The chain proves THAT a reservation happened and WHO holds it; the what/how-much/with-whom stays confidential off-chain. This is the core differentiator. Do NOT explain the cryptographic mechanism — describe the capability and the guarantee, never the hashing/HMAC internals.

CAPABILITY STATUS — be honest; never present a planned feature as usable today:
- Built: browse live availability; role-scoped dashboards for every participant type; book/reserve/hold flow with attested off-chain records and commission + settlement projection; sale-and-purchase contract authoring (payment plans, furniture packages, concessions, termination terms); vetting/listing gate with change-notice and oversight; the on-chain contract is live on NEAR testnet.
- In progress: real-wallet verified sign-in (the demo currently uses a wallet-less sandbox mode).
- Planned (not enforced in the demo): a light eligibility bar for a DIRECT buyer on the real on-chain path — a connected NEAR wallet plus a minimal track record (a funded account or past on-chain activity), as an anti-abuse gate so a seller's desk isn't flooded by throwaway identities. A buyer coming through an agency/agent is vouched for by that agency and needs no wallet of their own. Describe this at the capability level only; do not state the exact thresholds.
- Built: $VRX, an in-system transferable credit (fixed 200M supply, held by a VRX treasury; claim, send and spend inside VRX). It is an off-chain ledger today — usable within the VRX system, NOT fiat and not redeemable for cash. The on-chain NEP-141 token form is planned.
- Planned (NOT yet usable): real on-chain settlement rail; secondary market (ownership transfer); multi-jurisdiction packs.

THE DEMO
vrx.poolo.org is a sandbox: the real app on seeded data that resets clean. Visitors enter wallet-free and can assume any role (Developer, Agency, Agent, Buyer). Write actions in the sandbox are simulated — the real contract runs for real on NEAR testnet. Say this plainly if asked "is this real on-chain yet".

HOW TO EXPLORE (if asked how to get started or navigate)
Assume a role from the top bar ("Switch role"); each role is a full working app for that party. The fastest tour is to walk one deal end to end as an Agent — browse a building, book a unit, reserve, settle — then switch to the Developer role to see the booking arrive. The intro cover (what VRX is + how to explore) is reachable any time from Settings ("About VRX / intro cover") and this help widget.

LEGAL POSTURE (state it structurally)
VRX facilitates and seals reservations and agreements; it does NOT adjudicate disputes or warrant the legal enforceability of any underlying contract. Parties' own terms and local law govern.

RULES
- Stay strictly on VRX. If asked anything unrelated (general coding, other companies, world knowledge, "write me X"), politely decline in one sentence and offer to help with a VRX question instead. You are not a general assistant.
- Never invent capabilities or roadmap. If you don't know, say so and point to the contact.
- Keep answers short and plain — a few sentences. No markdown headings.
- Contact for anything beyond this: vrx@vettedrealty.com.`;

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskResult =
  | { ok: true; answer: string; tokens: number }
  | { ok: false; error: "no_key" | "upstream" };

/**
 * Call DeepSeek with the VRX system prompt + the conversation so far. Server-only (reads the key from env).
 * Returns the answer text + the token cost (for the global tally). On any upstream fault returns ok:false so
 * the route can fall back to free help rather than surfacing an error.
 */
export async function askDeepSeek(messages: ChatMessage[], signal?: AbortSignal): Promise<AskResult> {
  return askWithSystem(VRX_SYSTEM_PROMPT, messages, { signal });
}

/**
 * The generic DeepSeek caller: same server-only transport (key from env, OpenAI-compatible, fail-soft on any
 * upstream fault) but the SYSTEM PROMPT is a parameter, so other features (the AI sales desk) reuse ONE
 * transport instead of forking it. `temperature`/`maxTokens` are overridable (the sales desk wants a touch more
 * warmth than the factual help widget). askDeepSeek above is the help-widget preset over this.
 */
export async function askWithSystem(
  systemPrompt: string,
  messages: ChatMessage[],
  opts?: { signal?: AbortSignal; temperature?: number; maxTokens?: number }
): Promise<AskResult> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return { ok: false, error: "no_key" };

  try {
    const r = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        max_tokens: opts?.maxTokens ?? MAX_COMPLETION_TOKENS,
        temperature: opts?.temperature ?? 0.3, // factual, low-invention — this is a fit-analyst, not a creative writer
        stream: false,
      }),
      signal: opts?.signal,
    });
    if (!r.ok) return { ok: false, error: "upstream" };
    const j = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const answer = j.choices?.[0]?.message?.content?.trim();
    if (!answer) return { ok: false, error: "upstream" };
    return { ok: true, answer, tokens: j.usage?.total_tokens ?? 0 };
  } catch {
    // network error / abort / malformed JSON — treat as upstream fault, fall back to free help
    return { ok: false, error: "upstream" };
  }
}
