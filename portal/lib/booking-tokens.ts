// BOOKING TOKENS — scarce, VRX-issued, recyclable reservation slots that carry a cash obligation.
// SERVER-ONLY (file-backed.data, serialized `mutate`). Off-chain-first per the rule: this is the
// attested-off-chain-record spine shape built so the later on-chain swap (V7+) is a seam change, not a
// rewrite. Design: `the design docs`. Mirrors lib/seller-entities.ts / lib/agents.ts exactly.
//
// ── What a token IS (b) ──────────────────────────────────────────────────────────────────────
// VRX is the SOLE ISSUER (a developer cannot mint). A token = a reservation SLOT that carries the cash
// obligation; it is handed/sold down the trust chain (developer → agency → agent), used once to secure a
// booking, reconciled up the chain, then recycled back to the developer. SERIAL (each token a distinct
// object with its own custody/provenance history) — the design's resolved lean (recycle THIS token).
//
// ── Slice boundaries (this file grows per slice; commit per slice) ──────────────────────────────────────
//   Slice 1 (THIS): the record + store + VRX issuance + per-developer scarcity cap + the VRX-root-owned,
//                   per-developer-negotiable issuance-FEE config stamped onto each issued token. VRX-root writes only.
//   Slice 2: custody transfers (CHAIN-CONSTRAINED, counterparty-validated) + crypto-verified sale + economics.
//   Slice 3: freeze / recall (anti-theft) as STATES on this machine.
//   Slice 4: commit → secure-booking — a token authorizes the firm-hold; METERS exactly one slot per token.
//   Slice 5: cash + reconcile — the customer's cash leg + the three-hop reconcile UP the custody chain
//            (agent records → agency confirms receipt → developer confirms collection), with a dispute path.
//   Slice 6: recycle + re-issue — deal fell-through/completed → token returns to the developer as reusable
//            capacity (provenance preserved); re-issue mints a fresh token stamped `recycleOf` (NO re-charge).
//   Slice 7: UI.
//
// ── Privacy ────────────────────────────────────────────────────────────────────────────────────────
// Amounts / evidence / destinations are OFF-CHAIN only; only accounts + hashes/refs ever seal. The token's
// existence + custody may later go on-chain (scarcity proof) but never the money detail.

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { sealRecord, type Seal } from "./seal";
import { agencyOf } from "./agents";
import { agenciesForDeveloper, developersForAgency } from "./gates";

// ── Types ───────────────────────────────────────────────────────────────────────────────────────────────

/** The developer's trust-dial for a token's money-FOR-the-token (the selector, design §3a/3b/3c). */
export type TokenEconomics = "stake" | "prepaid" | "permission";

/** The token lifecycle. `frozen` (slice 3) is a STATE, not a separate feature (c — "handle as
 *  states, not ad-hoc verbs"). `revoked`/burn is deliberately NOT added: recycle already recovers a token, so
 *  a legitimate pull-back returns capacity to the developer rather than destroying it (design §Open-Qs v1 lean). */
export type TokenState =
  | "issued" // VRX → developer, unassigned
  | "with_agency" // developer handed/sold to an agency
  | "with_agent" // agency handed to a field agent
  | "committed" // agent used it to secure a booking (firm-hold placed)
  | "cash_taken" // agent recorded cash + photo proof (payment-vault evidence)
  | "reconciling" // agency confirmed receipt from agent / developer collecting
  | "settled" // developer confirmed the money — the token's deal is closed
  | "frozen" // temporarily blocked from committing (freeze only what you hold); thaws to its prior state
  | "recycled"; // deal fell through OR completed OR recalled → back to the developer to re-issue

/** VRX issuance charge model (design §6). per_token = a unit fee per slot; allotment = a periodic fee for a cap. */
export type IssuanceFeeModel = "per_token" | "allotment";

/** The VRX issuance CHARGE a token was issued under (VRX-root-owned, per-developer negotiable). Absent on a
 *  recycled→re-issued token (already paid for). For an allotment tier the per-token fee may be 0. */
export type TokenIssuanceFee = {
  amountMinor: number;
  currency: string;
  model: IssuanceFeeModel;
  at: number;
};

/** A single sealed custody transfer (slice 2 appends; slice 1 seeds the issuance entry). */
export type CustodyEntry = { from: string; to: string; at: number; sealHash: string };

export type BookingToken = {
  id: string; // stable serial
  issuedBy: "vrx"; // VRX is the issuer (scarcity control)
  developer: string; // the developer the capacity belongs to
  economics: TokenEconomics; // the developer's selector for THIS token (defaults at issue; set on hand in slice 2)
  state: TokenState;
  custody: string; // current holder account (developer / agency / agent)
  custodyLog: CustodyEntry[]; // every transfer, sealed
  issuanceFee?: TokenIssuanceFee; // the VRX charge this token was issued under (absent on a recycle)
  recycleOf?: string; // provenance if re-issued from a recycled token (slice 6)
  issuedAt: number;
  // The money paid FOR the token itself when sold (economics stake/prepaid), slice 2. CRYPTO-ONLY + verified:
  // the confirmed transfer IS the receipt, so custody provably moved (closes the theft-by-freeze gap).
  tokenPayment?: TokenPayment;
  // Bindings + money legs (populated by later slices; typed now so the record shape is stable):
  buildingId?: string;
  unitId?: string;
  requestId?: string;
  cash?: TokenCash; // slice 5: the customer's cash leg + the three-hop reconcile chain up the custody chain
  frozenFrom?: TokenState; // slice 3: the state to thaw back to when a freeze is lifted
  seal: Seal; // the record's own seal (tamper-evidence over the immutable issuance facts)
};

/** The CUSTOMER'S CASH leg a committed token carries (slice 5, design §gate-1 #3). The field agent takes cash
 *  on the spot + photographs the proof; the trust then travels UP the custody chain — agent records it, the
 *  AGENCY confirms it received the cash from the agent, the DEVELOPER confirms it collected from the agency.
 * Amounts + the photo are OFF-CHAIN — the token stores only an `evidenceId` REFERENCE into the existing
 *  payment-vault (`lib/payment-vault`), never bytes. `disputed`/`disputeNote` flag a broken hop (never silently
 * dropped — goes to a record, same discipline as the payment ledger). The in-app variant settles the SAME
 * obligation over a rail (recorded via the vault's in_app rail); the fields here are rail-agnostic. */
export type TokenCash = {
  amountMinor: number; // the cash amount, minor units (PRIVATE, off-chain)
  currency: string; // ISO code (display only; never on-chain)
  takenBy: string; // the field agent who took the cash
  takenAt: number;
  evidenceId?: string; // a REFERENCE into lib/payment-vault (the encrypted photo/slip) — never bytes here
  requestId?: string; // the materialized offer this cash is against, when known
  agencyConfirmedAt?: number; // the agency confirmed it received the cash from the agent (hop 1)
  agencyConfirmedBy?: string;
  developerConfirmedAt?: number; // the developer confirmed it collected from the agency (hop 2)
  developerConfirmedBy?: string;
  disputed?: boolean; // a hop is contested (agency says "agent never paid us", etc.) — goes to a record
  disputeNote?: string;
  disputedBy?: string;
  disputedAt?: number;
};

/** The crypto payment a token was SOLD for (design §Fairness). Crypto-only — a cash/off-platform sale is
 *  refused, because only a verified transfer yields a receipt the system can check. `txHash` is that receipt.
 *  `refundedTxHash` is the verifiable refund if a paid token is ever recalled (slice 3). */
export type TokenPayment = {
  rail: "crypto"; // token SALE is crypto-only (a crypto rail); never cash/off-platform
  amountMinor: number;
  currency: string; // e.g. NEAR / USDC
  txHash: string; // the VERIFIED transfer = the receipt (custody moves because of this)
  paidAt: number;
  refundedAt?: number;
  refundedTxHash?: string;
  creditedToRequestId?: string; // prepaid economics: credited against the real deposit when a booking lands
};

/** VRX-root-owned issuance-fee config, per developer (negotiable). `developer:"*"` = the house default.
 *  Sibling of the V5 protocol fee on the VRX terms surface. */
export type TokenIssuanceConfig = {
  developer: string; // scope ("*" = house default)
  model: IssuanceFeeModel;
  feeMinor: number; // per_token: the unit fee · allotment: the periodic fee
  currency: string;
  allotmentCap?: number; // allotment model: "up to N active tokens" (also the developer's scarcity cap)
  setBy: "vrx";
  at: number;
};

// ── Store (same spine as seller-entities.ts / agents.ts) ────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), ".data");
const TOKENS = path.join(DATA_DIR, "booking-tokens.json");
const CONFIG = path.join(DATA_DIR, "booking-token-config.json");

const SEAL_DOMAIN = "vrx-booking-token";

// Serialized write chain — the lost-write discipline shared by every mutating store.
let tokenChain: Promise<unknown> = Promise.resolve();
function mutateTokens<T>(fn: (list: BookingToken[]) => Promise<{ next: BookingToken[]; ret: T }>): Promise<T> {
  const run = tokenChain.then(async () => {
    const list = await readTokens();
    const { next, ret } = await fn(list);
    await writeTokens(next);
    return ret;
  });
  tokenChain = run.catch(() => {});
  return run as Promise<T>;
}

async function readTokens(): Promise<BookingToken[]> {
  try {
    const raw = await fs.readFile(TOKENS, "utf8");
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p as BookingToken[]) : [];
  } catch {
    return [];
  }
}

async function writeTokens(list: BookingToken[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(TOKENS, JSON.stringify(list, null, 2), "utf8");
}

let configChain: Promise<unknown> = Promise.resolve();
function mutateConfig<T>(fn: (list: TokenIssuanceConfig[]) => Promise<{ next: TokenIssuanceConfig[]; ret: T }>): Promise<T> {
  const run = configChain.then(async () => {
    const list = await readConfigs();
    const { next, ret } = await fn(list);
    await writeConfigs(next);
    return ret;
  });
  configChain = run.catch(() => {});
  return run as Promise<T>;
}

async function readConfigs(): Promise<TokenIssuanceConfig[]> {
  try {
    const raw = await fs.readFile(CONFIG, "utf8");
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p as TokenIssuanceConfig[]) : [];
  } catch {
    return [];
  }
}

async function writeConfigs(list: TokenIssuanceConfig[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG, JSON.stringify(list, null, 2), "utf8");
}

// ── Validation helpers (pure, unit-tested) ──────────────────────────────────────────────────────────────

const ECONOMICS: readonly TokenEconomics[] = ["stake", "prepaid", "permission"];
const FEE_MODELS: readonly IssuanceFeeModel[] = ["per_token", "allotment"];
const HOUSE = "*"; // the house-default config scope

/** A token is "live" (counts toward a developer's scarcity cap) in any non-recycled state. A recycled token
 *  is spent capacity returned for re-issue — it does NOT occupy a slot. This is the scarcity denominator. */
export function isLiveState(state: TokenState): boolean {
  return state !== "recycled";
}

/** Normalise an incoming issuance-fee config (VRX-root authored). Throws on a structurally-invalid payload
 *  (route → 400). `developer` is lower-cased; "*" (or blank) is the house default. */
export function cleanIssuanceConfig(raw: unknown): TokenIssuanceConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const developer = (typeof r.developer === "string" ? r.developer.trim().toLowerCase() : "") || HOUSE;
  const model = (FEE_MODELS as readonly string[]).includes(String(r.model)) ? (String(r.model) as IssuanceFeeModel) : null;
  if (!model) throw new Error("model must be per_token or allotment");
  const feeMinor = Number(r.feeMinor);
  if (!Number.isInteger(feeMinor) || feeMinor < 0) throw new Error("feeMinor must be a non-negative integer (minor units)");
  const currency = (typeof r.currency === "string" ? r.currency.trim().toUpperCase() : "").slice(0, 10);
  if (!currency) throw new Error("currency required");
  const out: TokenIssuanceConfig = { developer, model, feeMinor, currency, setBy: "vrx", at: Date.now() };
  if (model === "allotment") {
    const cap = Number(r.allotmentCap);
    if (!Number.isInteger(cap) || cap <= 0) throw new Error("allotment model requires a positive allotmentCap");
    out.allotmentCap = cap;
  } else if (Number.isInteger(Number(r.allotmentCap)) && Number(r.allotmentCap) > 0) {
    // per_token may ALSO carry a cap (the scarcity lever is independent of the charge model).
    out.allotmentCap = Number(r.allotmentCap);
  }
  return out;
}

// ── Config API (VRX-root only — enforced at the route; this module trusts its caller is root) ───────────

/** Set (create/replace) the issuance config for a developer scope ("*" = house default). VRX-root only. */
export async function setIssuanceConfig(raw: unknown): Promise<TokenIssuanceConfig> {
  const cfg = cleanIssuanceConfig(raw);
  return mutateConfig(async (list) => {
    const next = list.filter((c) => c.developer !== cfg.developer);
    next.push(cfg);
    return { next, ret: cfg };
  });
}

/** The effective config for a developer: their own override if present, else the house default, else null. */
export async function issuanceConfigFor(developer: string): Promise<TokenIssuanceConfig | null> {
  const dev = developer.trim().toLowerCase();
  const list = await readConfigs();
  return list.find((c) => c.developer === dev) ?? list.find((c) => c.developer === HOUSE) ?? null;
}

export async function listIssuanceConfigs(): Promise<TokenIssuanceConfig[]> {
  return readConfigs();
}

// ── Scarcity ────────────────────────────────────────────────────────────────────────────────────────────

/** How many LIVE (non-recycled) tokens a developer currently holds capacity for — the scarcity numerator. */
export async function liveTokenCount(developer: string): Promise<number> {
  const dev = developer.trim().toLowerCase();
  return (await readTokens()).filter((t) => t.developer.toLowerCase() === dev && isLiveState(t.state)).length;
}

/** The developer's scarcity CAP — from their effective issuance config's `allotmentCap`. null = no cap set
 *  (VRX hasn't configured this developer → issuance is refused, fail-closed: capacity must be granted first). */
export async function capFor(developer: string): Promise<number | null> {
  const cfg = await issuanceConfigFor(developer);
  return cfg?.allotmentCap ?? null;
}

// ── Issuance (VRX-root only) ────────────────────────────────────────────────────────────────────────────

/** Issue `count` fresh tokens to a developer (VRX is the issuer). Enforces the scarcity cap: issuing must not
 *  push the developer's LIVE token count past their configured `allotmentCap`. Each token is stamped with the
 *  issuance FEE derived from the developer's effective config (per_token → feeMinor each; allotment → 0 per
 *  token, since the developer pays the tier periodically). Fail-closed: no config / no cap → refuse (capacity
 *  must be granted by VRX first). Returns the newly-issued tokens. VRX-root-only (enforced at the route). */
export async function issueTokens(
  developer: string,
  count: number,
  opts?: { economics?: TokenEconomics }
): Promise<BookingToken[]> {
  const dev = developer.trim();
  if (!dev) throw new Error("developer required");
  if (!Number.isInteger(count) || count <= 0) throw new Error("count must be a positive integer");
  const economics: TokenEconomics = ECONOMICS.includes(opts?.economics as TokenEconomics)
    ? (opts!.economics as TokenEconomics)
    : "permission"; // the neutral default (no money for the token itself) until the developer sets it on hand

  const cfg = await issuanceConfigFor(dev);
  if (!cfg) throw new Error("no issuance config for this developer — VRX must grant capacity first");
  const cap = cfg.allotmentCap ?? null;
  if (cap === null) throw new Error("no allotment cap configured — VRX must set the developer's capacity first");

  return mutateTokens(async (list) => {
    const live = list.filter((t) => t.developer.toLowerCase() === dev.toLowerCase() && isLiveState(t.state)).length;
    if (live + count > cap) {
      throw new Error(`scarcity cap exceeded: ${live} live + ${count} requested > cap ${cap}`);
    }
    const now = Date.now();
    const fresh: BookingToken[] = [];
    for (let i = 0; i < count; i++) {
      const id = `bt-${now}-${randomBytes(5).toString("hex")}`;
      // per_token charges feeMinor per slot; allotment charges 0 per token (the tier is billed separately).
      const fee: TokenIssuanceFee = {
        amountMinor: cfg.model === "per_token" ? cfg.feeMinor : 0,
        currency: cfg.currency,
        model: cfg.model,
        at: now,
      };
      // Seal the IMMUTABLE issuance facts (who, for whom, under what charge) — tamper-evidence on the record.
      const seal = sealRecord({ id, issuedBy: "vrx", developer: dev, economics, issuanceFee: fee, issuedAt: now }, SEAL_DOMAIN);
      const issuanceEntry: CustodyEntry = { from: "vrx", to: dev, at: now, sealHash: seal.hash };
      fresh.push({
        id,
        issuedBy: "vrx",
        developer: dev,
        economics,
        state: "issued",
        custody: dev,
        custodyLog: [issuanceEntry],
        issuanceFee: fee,
        issuedAt: now,
        seal,
      });
    }
    return { next: [...list, ...fresh], ret: fresh };
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────────────

export async function getToken(id: string): Promise<BookingToken | null> {
  const want = id.trim();
  if (!want) return null;
  return (await readTokens()).find((t) => t.id === want) ?? null;
}

/** All tokens a developer owns (the capacity they hold), newest first. */
export async function tokensForDeveloper(developer: string): Promise<BookingToken[]> {
  const dev = developer.trim().toLowerCase();
  return (await readTokens()).filter((t) => t.developer.toLowerCase() === dev).sort((a, b) => b.issuedAt - a.issuedAt);
}

/** All tokens currently in an account's custody (what they hold right now, newest first). */
export async function tokensInCustody(account: string): Promise<BookingToken[]> {
  const a = account.trim().toLowerCase();
  return (await readTokens()).filter((t) => t.custody.toLowerCase() === a).sort((a2, b) => b.issuedAt - a2.issuedAt);
}

// ── Slice 2: custody transfers (CHAIN-CONSTRAINED) + crypto-verified sale + economics selector ──────────
//
// Custody may only move ALONG the trust graph (c) — never peer-to-peer:
//   developer ⇄ its gated agencies ⇄ each agency's own agents ⇄ VRX (the recycle/return direction).
// The transfer route validates the destination is a LEGITIMATE COUNTERPARTY of the sender and REFUSES
// anything else, fail-closed. This closes the sideways-leak hole — scarce capacity can't escape the chain.

/** Is `to` a legitimate custody counterparty of `from` for THIS token? The trust-graph edges:
 *  - developer → one of ITS gated agencies (hand/sell down)
 *  - agency → the token's developer (return up) OR one of its OWN agents (hand down)
 *  - agent → their supervising agency (return up) OR the token's developer (return up) OR "vrx" (recycle)
 *  - developer → "vrx" (return capacity to the issuer)
 *  Fail-closed: anything not on an edge is refused. Pure over the existing relationship stores. */
export async function isLegitimateCustodyMove(token: BookingToken, from: string, to: string): Promise<boolean> {
  const f = from.trim().toLowerCase();
  const t = to.trim().toLowerCase();
  const dev = token.developer.toLowerCase();
  if (!f || !t || f === t) return false;

  // Returning to VRX (recycle direction) is always legitimate from any current holder.
  if (t === "vrx") return true;

  // developer (the token's owner) → one of its gated agencies, or VRX (handled above).
  if (f === dev) {
    const agencies = (await agenciesForDeveloper(token.developer)).map((a) => a.toLowerCase());
    return agencies.includes(t);
  }

  // From an AGENCY: either return up to the token's developer, or hand down to one of its OWN agents.
  const fromIsAgencyOfDev = (await developersForAgency(from)).map((d) => d.toLowerCase()).includes(dev);
  if (fromIsAgencyOfDev) {
    if (t === dev) return true; // return up to the developer
    const agentsAgency = (await agencyOf(to))?.toLowerCase(); // `to` is an agent whose agency is `from`?
    return agentsAgency === f;
  }

  // From an AGENT: return up to their agency, or up to the token's developer (both legitimate return edges).
  const fromAgentAgency = (await agencyOf(from))?.toLowerCase();
  if (fromAgentAgency) {
    if (t === fromAgentAgency) return true; // return to their own agency
    if (t === dev) return true; // return to the token's developer
  }
  return false;
}

/** Validate an incoming crypto sale receipt (design §Fairness: crypto-only + verified). Structural verification
 *  here (rail=crypto, non-empty txHash, positive amount, currency) — the off-chain spine. The ACTUAL on-chain
 *  confirmation of `txHash` is a deliberate SEAM (`verifyTransferHook`) deferred to the real-wallet/V7 arc, per
 * (don't couple to the unfrozen chain). A cash/off-platform sale has no verifiable receipt → refused. */
export function cleanTokenPayment(raw: unknown): TokenPayment {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (String(r.rail) !== "crypto") throw new Error("token sale is crypto-only (a verified transfer is the receipt)");
  const txHash = (typeof r.txHash === "string" ? r.txHash.trim() : "").slice(0, 120);
  if (!txHash) throw new Error("a crypto sale requires a txHash (the verified transfer receipt)");
  const amountMinor = Number(r.amountMinor);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new Error("sale amountMinor must be a positive integer (minor units)");
  const currency = (typeof r.currency === "string" ? r.currency.trim().toUpperCase() : "").slice(0, 10);
  if (!currency) throw new Error("sale currency required");
  const out: TokenPayment = { rail: "crypto", amountMinor, currency, txHash, paidAt: Date.now() };
  const credited = typeof r.creditedToRequestId === "string" ? r.creditedToRequestId.trim().slice(0, 120) : "";
  if (credited) out.creditedToRequestId = credited;
  return out;
}

const ECONOMICS_SET = new Set<TokenEconomics>(["stake", "prepaid", "permission"]);

/** Hand or SELL a token one step along the trust graph (slice 2). `by` MUST currently hold the token (holder-
 *  scoped). `to` MUST be a legitimate counterparty (chain-constrained; peer-to-peer refused). A SALE (economics
 *  stake/prepaid with `payment`) is crypto-only + verified — custody moves BECAUSE a verified crypto receipt is
 *  recorded; a sale without one is refused. `economics` sets the developer's trust-dial for this token on the
 *  hand. Appends a sealed custody entry. Fail-closed throughout. Returns the updated token. */
export async function transferToken(args: {
  tokenId: string;
  by: string; // the current holder performing the transfer
  to: string; // the recipient (must be a legitimate counterparty of `by`)
  economics?: TokenEconomics; // optional: set/override the trust-dial on this hand
  payment?: unknown; // required iff the hand is a SALE (economics stake/prepaid); crypto-verified
}): Promise<BookingToken> {
  const by = args.by.trim();
  const to = args.to.trim();
  if (!by || !to) throw new Error("by and to are required");

  return mutateTokens(async (list) => {
    const idx = list.findIndex((x) => x.id === args.tokenId);
    if (idx < 0) throw new Error("token not found");
    const tok = list[idx];

    // Holder-scoped: you can only hand a token you currently hold.
    if (tok.custody.toLowerCase() !== by.toLowerCase()) throw new Error("not the current holder — you can only hand a token you hold");
    // Only a live, transferable token moves (not committed/settled/recycled — those are mid/end-of-deal states).
    if (tok.state !== "issued" && tok.state !== "with_agency" && tok.state !== "with_agent") {
      throw new Error(`token in state '${tok.state}' is not transferable`);
    }
    // Chain-constrained: the destination must be a legitimate counterparty of the sender (fail-closed).
    if (!(await isLegitimateCustodyMove(tok, by, to))) {
      throw new Error("illegitimate custody move — a token may only move along the trust graph (no peer-to-peer)");
    }

    const economics: TokenEconomics = args.economics && ECONOMICS_SET.has(args.economics) ? args.economics : tok.economics;

    // A SALE (stake/prepaid) requires a verified crypto receipt; permission is a free hand (no payment).
    let payment: TokenPayment | undefined = tok.tokenPayment;
    if (economics === "stake" || economics === "prepaid") {
      if (args.payment === undefined && !tok.tokenPayment) {
        throw new Error("a stake/prepaid token sale requires a crypto payment receipt (crypto-only, verified)");
      }
      if (args.payment !== undefined) payment = cleanTokenPayment(args.payment);
    } else if (args.payment !== undefined) {
      throw new Error("a 'permission' token is a free hand — no payment is recorded");
    }

    // Determine the recipient's resulting state + custody.
    const toIsAgent = (await agencyOf(to)) !== null;
    const toIsDevOrVrx = to.toLowerCase() === tok.developer.toLowerCase() || to.toLowerCase() === "vrx";
    const nextState: TokenState = toIsDevOrVrx ? "issued" : toIsAgent ? "with_agent" : "with_agency";

    const at = Date.now();
    const sealHash = sealRecord({ tokenId: tok.id, from: by, to, economics, at, txHash: payment?.txHash ?? "" }, SEAL_DOMAIN).hash;
    const updated: BookingToken = {
      ...tok,
      economics,
      state: nextState,
      custody: to,
      custodyLog: [...tok.custodyLog, { from: by, to, at, sealHash }],
      ...(payment ? { tokenPayment: payment } : {}),
    };
    const next = list.slice();
    next[idx] = updated;
    return { next, ret: updated };
  });
}

// ── Slice 3: freeze / recall (anti-theft) — the three rules (design §Fairness) ──────────────────────────
//
// NO THEFT-BY-FREEZE (the key concern, c):
//   1. Freeze/revoke power FOLLOWS CUSTODY — you can only freeze a token you CURRENTLY HOLD. A sold token has
//      LEFT the developer's custody AND their freeze power (like cash: you can't void a voucher you've sold).
//   2. Pulling back a SOLD token is NEVER unilateral — it needs EITHER a bilateral recall (both parties agree,
//  call-off shape) OR VRX arbitration (escalate-to-VRX). The developer alone can never claw back.
//   3. A pulled-back PAID token REFUNDS the stake (crypto-verifiable refundedTxHash). Revoke-without-refund IS
//      the theft; tying recall→refund closes it.

const FREEZABLE: ReadonlySet<TokenState> = new Set<TokenState>(["issued", "with_agency", "with_agent"]);

/** FREEZE a token the caller CURRENTLY HOLDS (rule 1 — freeze follows custody). Holder-scoped, fail-closed:
 *  only the current holder can freeze, and only a transferable (not mid-deal) token. Records the prior state
 *  so `thawToken` restores it. A frozen token still occupies a slot (it's live) but cannot be committed. VRX,
 *  as issuer, may freeze any token it issued (a misbehaving agency) — passed as `by:"vrx"`. */
export async function freezeToken(tokenId: string, by: string): Promise<BookingToken> {
  const who = by.trim();
  if (!who) throw new Error("by required");
  return mutateTokens(async (list) => {
    const idx = list.findIndex((x) => x.id === tokenId);
    if (idx < 0) throw new Error("token not found");
    const tok = list[idx];
    const isVrx = who.toLowerCase() === "vrx";
    // Rule 1: freeze follows custody. Only the current holder (or VRX the issuer) may freeze.
    if (!isVrx && tok.custody.toLowerCase() !== who.toLowerCase()) {
      throw new Error("can only freeze a token you currently hold (freeze follows custody — no theft-by-freeze)");
    }
    if (tok.state === "frozen") return { next: list, ret: tok }; // idempotent
    if (!FREEZABLE.has(tok.state)) throw new Error(`a token in state '${tok.state}' cannot be frozen`);
    const updated: BookingToken = { ...tok, frozenFrom: tok.state, state: "frozen" };
    const next = list.slice();
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** THAW a frozen token back to its prior state. Same holder-scope as freeze (the holder, or VRX). */
export async function thawToken(tokenId: string, by: string): Promise<BookingToken> {
  const who = by.trim();
  return mutateTokens(async (list) => {
    const idx = list.findIndex((x) => x.id === tokenId);
    if (idx < 0) throw new Error("token not found");
    const tok = list[idx];
    const isVrx = who.toLowerCase() === "vrx";
    if (!isVrx && tok.custody.toLowerCase() !== who.toLowerCase()) throw new Error("can only thaw a token you hold");
    if (tok.state !== "frozen") return { next: list, ret: tok };
    const back = tok.frozenFrom ?? "issued";
    const { frozenFrom, ...rest } = tok;
    void frozenFrom;
    const updated: BookingToken = { ...rest, state: back };
    const next = list.slice();
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** RECALL a SOLD token (rules 2 + 3). A sold token (currently held by an agency/agent, i.e. NOT by the
 *  developer) can be pulled back ONLY:
 *    • bilaterally — `authority:"bilateral"` requires BOTH the current holder's and the developer's consent
 * (the caller asserts both agreed; the call-off is the real consent surface the route wires), OR
 * • by VRX arbitration — `authority:"vrx"` (the neutral issuer, escalate).
 *  A unilateral developer recall is REFUSED (that is exactly theft-by-freeze). If the token was PAID for
 *  (tokenPayment present), a `refundTxHash` is REQUIRED and recorded (rule 3 — recall refunds the stake,
 *  crypto-verifiable). The recalled token returns to the developer as `recycled` capacity (no burn — recycle
 *  already recovers it). Returns the recalled token. */
export async function recallToken(args: {
  tokenId: string;
  by: string; // who is invoking the recall
  authority: "bilateral" | "vrx";
  holderConsents?: boolean; // for bilateral: the current holder agreed
  developerConsents?: boolean; // for bilateral: the developer agreed
  refundTxHash?: string; // required iff the token was paid for (rule 3)
}): Promise<BookingToken> {
  const by = args.by.trim();
  if (!by) throw new Error("by required");
  return mutateTokens(async (list) => {
    const idx = list.findIndex((x) => x.id === args.tokenId);
    if (idx < 0) throw new Error("token not found");
    const tok = list[idx];
    const dev = tok.developer.toLowerCase();
    const heldByDeveloper = tok.custody.toLowerCase() === dev;

    // Recall only applies to a SOLD/handed token (one that has left the developer's custody). A token still in
    // the developer's inventory is theirs — they freeze/recycle it directly, no recall needed.
    if (heldByDeveloper) throw new Error("token is still in the developer's custody — no recall needed (use freeze/recycle)");

    if (args.authority === "vrx") {
      if (by.toLowerCase() !== "vrx") throw new Error("only VRX may invoke a VRX-arbitration recall");
    } else if (args.authority === "bilateral") {
      // Rule 2: a sold token is NEVER pulled back unilaterally — BOTH sides must consent.
      if (!args.holderConsents || !args.developerConsents) {
        throw new Error("a bilateral recall requires BOTH the current holder and the developer to consent (no unilateral claw-back — anti theft-by-freeze)");
      }
    } else {
      throw new Error("recall authority must be 'bilateral' or 'vrx'");
    }

    // Rule 3: a PAID token refunds the stake — a verifiable crypto refund is required.
    let payment = tok.tokenPayment;
    if (tok.tokenPayment && !tok.tokenPayment.refundedAt) {
      const refundTxHash = (args.refundTxHash ?? "").trim().slice(0, 120);
      if (!refundTxHash) throw new Error("a paid token's recall must refund the stake (a verifiable refundTxHash is required)");
      payment = { ...tok.tokenPayment, refundedAt: Date.now(), refundedTxHash: refundTxHash };
    }

    const at = Date.now();
    const sealHash = sealRecord({ tokenId: tok.id, recall: args.authority, by, at, refundTxHash: payment?.refundedTxHash ?? "" }, SEAL_DOMAIN).hash;
    const updated: BookingToken = {
      ...tok,
      state: "recycled", // returns to the developer as reusable capacity (provenance preserved on the log)
      custody: tok.developer,
      custodyLog: [...tok.custodyLog, { from: tok.custody, to: tok.developer, at, sealHash }],
      ...(payment ? { tokenPayment: payment } : {}),
    };
    const next = list.slice();
    next[idx] = updated;
    return { next, ret: updated };
  });
}

// ── Slice 4: commit → secure booking (meter one slot per token) ─────────────────────────────────────────
//
// the decision #1 (design): a token = a reservation SLOT that carries the cash obligation. An agent in the
// field uses ONE token to secure a booking — this METERS the token (with_agent → committed) and BINDS it to the
// exact (building, unit) and, when known, the materialized offer's requestId. The actual on-chain firm-hold
// (grant_exclusive via lib/direct-deposits + lib/exclusives-store) is the EXISTING seam the route wires AFTER a
// successful commit — this layer does NOT call the chain (off-chain-first; the chain write is the same deferred
// seam as slice 2's txHash verification,). The invariant this slice owns: ONE SLOT PER TOKEN —
// a committed token cannot be re-committed (an agent can't secure two bookings with one token), and a token can
// only be committed by the agent CURRENTLY HOLDING it (holder-scoped). A deal that falls through pre-reconcile
// calls `releaseCommit`, returning the slot to the agent (not yet recycled — recycle back to the developer is
// slice 6, triggered by deal-end or completion).

const COMMITTABLE: ReadonlySet<TokenState> = new Set<TokenState>(["with_agent"]);

/** COMMIT a token to secure a booking (slice 4). `by` MUST currently hold the token (holder-scoped — an agent
 *  in the field). The token MUST be `with_agent` (a token still with the agency/developer hasn't reached a field
 *  agent; a frozen/committed/mid-deal token is refused). Binds the (building, unit) and optional requestId, moves
 *  the token to `committed`, and METERS the slot: a committed token cannot be committed again (one slot per
 *  token). Appends a sealed custody entry (custody unchanged — the agent still holds it; this records the
 * binding,: ids + hash only, no money/PII). The caller (route) then places the on-chain firm-hold
 *  the existing direct-deposits/exclusives seam. Fail-closed throughout. Returns the committed token. */
export async function commitToken(args: {
  tokenId: string;
  by: string; // the field agent currently holding the token
  buildingId: string;
  unitId: string;
  requestId?: string; // the materialized offer this booking is for, when known
}): Promise<BookingToken> {
  const by = args.by.trim();
  const buildingId = args.buildingId.trim();
  const unitId = args.unitId.trim();
  if (!by) throw new Error("by required");
  if (!buildingId || !unitId) throw new Error("buildingId and unitId are required to secure a booking");

  return mutateTokens(async (list) => {
    const idx = list.findIndex((x) => x.id === args.tokenId);
    if (idx < 0) throw new Error("token not found");
    const tok = list[idx];

    // Holder-scoped: only the agent who currently holds the token may commit it.
    if (tok.custody.toLowerCase() !== by.toLowerCase()) {
      throw new Error("not the current holder — only the agent holding the token may secure a booking with it");
    }
    // One slot per token: a token must be an un-committed field token. A committed token is already metered.
    if (!COMMITTABLE.has(tok.state)) {
      throw new Error(`a token in state '${tok.state}' cannot secure a booking (one slot per token — it must be with_agent)`);
    }

    const at = Date.now();
    const sealHash = sealRecord(
      { tokenId: tok.id, commit: true, by, buildingId, unitId, requestId: args.requestId ?? "", at },
      SEAL_DOMAIN
    ).hash;
    const updated: BookingToken = {
      ...tok,
      state: "committed",
      buildingId,
      unitId,
      ...(args.requestId ? { requestId: args.requestId.trim() } : {}),
      // custody unchanged — the agent still holds the committed token; the entry records the binding.
      custodyLog: [...tok.custodyLog, { from: by, to: by, at, sealHash }],
    };
    const next = list.slice();
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** RELEASE a committed booking (slice 4) — the deal fell through BEFORE any cash was taken, so the firm-hold is
 *  released and the token's slot returns to the agent to re-commit (or to be recycled up the chain later, slice
 *  6). Holder-scoped (the agent holding it) or VRX. Only a `committed` token can be released this way — once cash
 *  has been taken (`cash_taken`+), the obligation is live and the money path (slice 5) governs, not a plain
 *  release. Clears the binding and returns the token to `with_agent`. Appends a sealed entry. Idempotent-ish:
 *  releasing a non-committed token is refused (fail-closed, surfaces the real state). */
export async function releaseCommit(tokenId: string, by: string): Promise<BookingToken> {
  const who = by.trim();
  if (!who) throw new Error("by required");
  return mutateTokens(async (list) => {
    const idx = list.findIndex((x) => x.id === tokenId);
    if (idx < 0) throw new Error("token not found");
    const tok = list[idx];
    const isVrx = who.toLowerCase() === "vrx";
    if (!isVrx && tok.custody.toLowerCase() !== who.toLowerCase()) {
      throw new Error("not the current holder — only the agent holding the token (or VRX) may release the booking");
    }
    if (tok.state !== "committed") {
      throw new Error(`only a committed token can be released (it is '${tok.state}')`);
    }
    const at = Date.now();
    const sealHash = sealRecord({ tokenId: tok.id, release: true, by: who, at }, SEAL_DOMAIN).hash;
    const { buildingId, unitId, requestId, ...rest } = tok;
    void buildingId;
    void unitId;
    void requestId;
    const updated: BookingToken = {
      ...rest,
      state: "with_agent",
      custodyLog: [...tok.custodyLog, { from: tok.custody, to: tok.custody, at, sealHash }],
    };
    const next = list.slice();
    next[idx] = updated;
    return { next, ret: updated };
  });
}

// ── Slice 5: cash + reconcile (the physical-cash accountability spine) ──────────────────────────────────
//
// the decision #1 (design): the agent in the field takes the customer's cash on the spot + photographs the
// proof, then the trust travels UP the custody chain — the agent records it (committed → cash_taken), the
// AGENCY confirms it received the cash from the agent (→ reconciling), the DEVELOPER confirms it collected from
// the agency (→ settled). Each hop is a sealed event (accounts + amount-under-seal + evidence REF +
// hash, never bytes/PII on-chain). The cash obligation CANNOT vanish — once recorded it reaches `settled` only
// through the reconcile chain OR an explicit dispute record (never silently dropped, same discipline as a
// disputed payment-ledger entry). The photo REUSES the payment-vault evidence pipeline (the route stores
// it via lib/payment-vault and passes the resulting `evidenceId` here); this layer stores only the reference.
// The in-app variant settles the same obligation over a rail — rail-agnostic here.

const CASH_MONOTONIC: Record<string, TokenState | undefined> = {
  committed: "cash_taken", // agent records the cash taken under the committed booking
  cash_taken: "reconciling", // agency confirms it received the cash from the agent
  reconciling: "settled", // developer confirms it collected from the agency
};

/** RECORD the cash the field agent took on the spot (slice 5). `by` MUST currently hold the token AND be the
 *  committing agent (holder-scoped). The token MUST be `committed` (a booking must exist before cash is taken).
 *  Stores the amount/currency + an optional `evidenceId` REFERENCE into the payment-vault (never bytes). Moves
 *  committed → cash_taken. The cash obligation now EXISTS and can only resolve via the reconcile chain or a
 *  dispute. Appends a sealed self-entry. Fail-closed. Returns the updated token. */
export async function recordCash(args: {
  tokenId: string;
  by: string; // the field agent (current holder)
  amountMinor: number;
  currency: string;
  evidenceId?: string; // the payment-vault ref the route obtained after encrypting the photo
  requestId?: string;
}): Promise<BookingToken> {
  const by = args.by.trim();
  if (!by) throw new Error("by required");
  const amountMinor = Number(args.amountMinor);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new Error("cash amountMinor must be a positive integer (minor units)");
  const currency = (typeof args.currency === "string" ? args.currency.trim().toUpperCase() : "").slice(0, 10);
  if (!currency) throw new Error("cash currency required");

  return mutateTokens(async (list) => {
    const idx = list.findIndex((x) => x.id === args.tokenId);
    if (idx < 0) throw new Error("token not found");
    const tok = list[idx];
    if (tok.custody.toLowerCase() !== by.toLowerCase()) {
      throw new Error("not the current holder — only the agent holding the committed token may record cash");
    }
    if (tok.state !== "committed") throw new Error(`cash can only be recorded on a committed token (it is '${tok.state}')`);

    const at = Date.now();
    const cash: TokenCash = {
      amountMinor,
      currency,
      takenBy: by,
      takenAt: at,
      ...(args.evidenceId ? { evidenceId: args.evidenceId.trim().slice(0, 120) } : {}),
      ...(args.requestId ? { requestId: args.requestId.trim().slice(0, 120) } : tok.requestId ? { requestId: tok.requestId } : {}),
    };
    const sealHash = sealRecord(
      { tokenId: tok.id, cashTaken: true, by, amountMinor, currency, evidenceId: cash.evidenceId ?? "", at },
      SEAL_DOMAIN
    ).hash;
    const updated: BookingToken = {
      ...tok,
      state: "cash_taken",
      cash,
      custodyLog: [...tok.custodyLog, { from: by, to: by, at, sealHash }],
    };
    const next = list.slice();
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** CONFIRM a reconcile hop UP the custody chain (slice 5). `role` is who is confirming:
 *   • "agency" — the agency confirms it RECEIVED the cash from the agent (cash_taken → reconciling). `by` MUST
 *     be the agency that supervises the token's current holder (the committing agent) — resolved via agencyOf.
 *   • "developer" — the developer confirms it COLLECTED from the agency (reconciling → settled). `by` MUST be
 *     the token's developer.
 *  Monotonic: a hop can only fire from its exact prior state (can't settle before the agency confirmed; can't
 *  double-confirm). A DISPUTED cash leg cannot be confirmed (resolve the dispute first). Appends a sealed entry
 *  + stamps the confirming party/time on the cash record. Fail-closed. Returns the updated token. */
export async function confirmCash(args: {
  tokenId: string;
  by: string;
  role: "agency" | "developer";
}): Promise<BookingToken> {
  const by = args.by.trim();
  if (!by) throw new Error("by required");

  return mutateTokens(async (list) => {
    const idx = list.findIndex((x) => x.id === args.tokenId);
    if (idx < 0) throw new Error("token not found");
    const tok = list[idx];
    if (!tok.cash) throw new Error("no cash recorded on this token yet");
    if (tok.cash.disputed) throw new Error("the cash leg is disputed — resolve the dispute before confirming");

    const nextState = CASH_MONOTONIC[tok.state];
    if (!nextState) throw new Error(`no reconcile step available from state '${tok.state}'`);

    if (args.role === "agency") {
      if (tok.state !== "cash_taken") throw new Error(`the agency confirms receipt only from cash_taken (it is '${tok.state}')`);
      // The confirming agency must supervise the agent who took the cash (authorization anchor, not just any agency).
      const agentAgency = (await agencyOf(tok.cash.takenBy))?.toLowerCase();
      if (!agentAgency || agentAgency !== by.toLowerCase()) {
        throw new Error("only the agent's own agency may confirm it received the cash");
      }
    } else if (args.role === "developer") {
      if (tok.state !== "reconciling") throw new Error(`the developer confirms collection only from reconciling (it is '${tok.state}')`);
      if (by.toLowerCase() !== tok.developer.toLowerCase()) {
        throw new Error("only the token's developer may confirm it collected the cash");
      }
    } else {
      throw new Error("role must be 'agency' or 'developer'");
    }

    const at = Date.now();
    const cash: TokenCash = { ...tok.cash };
    if (args.role === "agency") {
      cash.agencyConfirmedAt = at;
      cash.agencyConfirmedBy = by;
    } else {
      cash.developerConfirmedAt = at;
      cash.developerConfirmedBy = by;
    }
    const sealHash = sealRecord({ tokenId: tok.id, reconcile: args.role, by, at }, SEAL_DOMAIN).hash;
    const updated: BookingToken = {
      ...tok,
      state: nextState,
      cash,
      custodyLog: [...tok.custodyLog, { from: by, to: by, at, sealHash }],
    };
    const next = list.slice();
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** DISPUTE the cash leg (slice 5) — a hop is contested ("the agent never gave us the cash" / "we never
 *  collected"). Any party in the token's chain may raise it (the current holder, the supervising agency, the
 *  developer, or VRX the arbiter). Flags the cash record `disputed` with a note; it then cannot be confirmed
 *  until resolved (the obligation does NOT vanish — it becomes a standing record, escalation is the F-slice
 * path). Only a cash-bearing, not-yet-settled token can be disputed. Appends a sealed entry. */
export async function disputeCash(args: { tokenId: string; by: string; note?: string }): Promise<BookingToken> {
  const by = args.by.trim();
  if (!by) throw new Error("by required");
  return mutateTokens(async (list) => {
    const idx = list.findIndex((x) => x.id === args.tokenId);
    if (idx < 0) throw new Error("token not found");
    const tok = list[idx];
    if (!tok.cash) throw new Error("no cash recorded on this token yet");
    if (tok.state === "settled") throw new Error("a settled cash leg cannot be disputed");

    // Party check: the holder, the developer, the agent's supervising agency, or VRX may raise a dispute.
    const b = by.toLowerCase();
    const isHolder = tok.custody.toLowerCase() === b;
    const isDeveloper = tok.developer.toLowerCase() === b;
    const isVrx = b === "vrx";
    const agentAgency = (await agencyOf(tok.cash.takenBy))?.toLowerCase();
    const isAgency = !!agentAgency && agentAgency === b;
    if (!isHolder && !isDeveloper && !isVrx && !isAgency) {
      throw new Error("only a party to the token's chain (holder / agency / developer / vrx) may dispute the cash");
    }

    const at = Date.now();
    const cash: TokenCash = {
      ...tok.cash,
      disputed: true,
      disputeNote: (args.note ?? "").trim().slice(0, 500) || undefined,
      disputedBy: by,
      disputedAt: at,
    };
    const sealHash = sealRecord({ tokenId: tok.id, dispute: true, by, at }, SEAL_DOMAIN).hash;
    const updated: BookingToken = { ...tok, cash, custodyLog: [...tok.custodyLog, { from: by, to: by, at, sealHash }] };
    const next = list.slice();
    next[idx] = updated;
    return { next, ret: updated };
  });
}

// ── Slice 6: recycle + re-issue (capacity returns to the developer, provenance preserved) ───────────────
//
// Design lifecycle: `[any non-settled] --dealFellThrough--> [recycled]` and `[settled + deal completes OR
// deposit refunded] --> [recycled]`. A recycled token returns to the DEVELOPER as reusable capacity (it drops
// out of the live scarcity count — isLiveState) so the developer can RE-ISSUE it to another agency/agent
// WITHOUT a new VRX issuance charge (the developer re-uses capacity already paid for — the design's "recycle
// never re-charges" invariant). Re-issue mints a FRESH token (new id, new lifecycle) stamped `recycleOf` so the
// provenance chain is auditable end-to-end; the spent token stays `recycled` as the historical tombstone.
//
// THE CASH-OBLIGATION GUARD (correctness, design §invariants "the cash obligation cannot vanish"): a token with
// an OPEN cash obligation — cash_taken / reconciling, or ANY disputed leg — CANNOT be recycled. The money must
// first reach `settled` (reconciled) or the dispute be explicitly resolved; otherwise recycling would silently
// drop a live cash accountability. Recall (slice 3) is the SEPARATE anti-theft pull-back with its own refund
// rule; this recycle is the ordinary deal-end/completion return.

/** The states a token may recycle FROM directly (no open cash obligation). `settled` = the deal completed +
 *  reconciled. `issued`/`with_agency`/`with_agent` = never reached a booking. `committed` = a booking was
 *  placed but NO cash was taken (a pure pre-cash fall-through). `cash_taken`/`reconciling` are EXCLUDED — those
 *  carry a live, unreconciled obligation and must settle or resolve first. `frozen`/already-`recycled` excluded. */
const RECYCLABLE: ReadonlySet<TokenState> = new Set<TokenState>([
  "issued",
  "with_agency",
  "with_agent",
  "committed",
  "settled",
]);

/** RECYCLE a token back to the developer as reusable capacity (slice 6) — the ordinary deal-end return (the
 *  deal fell through pre-cash, or completed + reconciled). `by` must be a party able to close the deal: the
 *  token's DEVELOPER, the current HOLDER, or VRX. REFUSES a token with an open cash obligation (cash_taken /
 *  reconciling / any disputed leg) — the money must settle or the dispute resolve first (the obligation cannot
 *  vanish). Moves the token to `recycled` + custody back to the developer; the spent token is the historical
 *  tombstone (re-issue mints a fresh one). Appends a sealed entry. Fail-closed. Returns the recycled token. */
export async function recycleToken(args: { tokenId: string; by: string }): Promise<BookingToken> {
  const by = args.by.trim();
  if (!by) throw new Error("by required");
  return mutateTokens(async (list) => {
    const idx = list.findIndex((x) => x.id === args.tokenId);
    if (idx < 0) throw new Error("token not found");
    const tok = list[idx];
    const b = by.toLowerCase();
    const isDeveloper = tok.developer.toLowerCase() === b;
    const isHolder = tok.custody.toLowerCase() === b;
    const isVrx = b === "vrx";
    if (!isDeveloper && !isHolder && !isVrx) {
      throw new Error("only the developer, the current holder, or VRX may recycle a token");
    }
    if (tok.state === "recycled") return { next: list, ret: tok }; // idempotent
    if (!RECYCLABLE.has(tok.state)) {
      throw new Error(`a token in state '${tok.state}' cannot be recycled (settle or resolve its cash obligation first)`);
    }
    // Belt-and-suspenders: even a RECYCLABLE state must not carry an unresolved disputed cash leg.
    if (tok.cash?.disputed) throw new Error("the cash leg is disputed — resolve the dispute before recycling (the obligation cannot vanish)");

    const at = Date.now();
    const sealHash = sealRecord({ tokenId: tok.id, recycle: true, by, at }, SEAL_DOMAIN).hash;
    const updated: BookingToken = {
      ...tok,
      state: "recycled",
      custody: tok.developer, // capacity returns to the developer
      custodyLog: [...tok.custodyLog, { from: tok.custody, to: tok.developer, at, sealHash }],
    };
    const next = list.slice();
    next[idx] = updated;
    return { next, ret: updated };
  });
}

/** RE-ISSUE a fresh token from a recycled one (slice 6) — the developer re-uses capacity already paid for, so
 *  there is NO new VRX issuance charge (the "recycle never re-charges" invariant). Mints a NEW token (new id,
 *  state `issued`, custody = the developer, a fresh issuance custody entry) stamped `recycleOf` = the source
 *  token's id for provenance; the source token stays `recycled` as the historical tombstone. The fresh token
 *  has NO `issuanceFee` (not re-charged) and starts with a clean economics default (set on the next hand).
 *  VRX-root is NOT required — this is the DEVELOPER re-deploying their own recovered capacity, not a new grant.
 *  The source MUST be recycled and owned by the caller developer. Returns the fresh token. */
export async function reissueToken(args: { recycledId: string; by: string }): Promise<BookingToken> {
  const by = args.by.trim();
  if (!by) throw new Error("by required");
  return mutateTokens(async (list) => {
    const idx = list.findIndex((x) => x.id === args.recycledId);
    if (idx < 0) throw new Error("recycled token not found");
    const src = list[idx];
    if (src.state !== "recycled") throw new Error(`only a recycled token can be re-issued (it is '${src.state}')`);
    if (src.developer.toLowerCase() !== by.toLowerCase()) throw new Error("only the token's developer may re-issue it");

    const now = Date.now();
    const id = `bt-${now}-${randomBytes(5).toString("hex")}`;
    // Re-issue is FREE (no issuanceFee) — the capacity was already paid for. Default economics to "permission"
    // (the neutral free hand) until the developer sets it on the next hand, same as a fresh issue.
    const seal = sealRecord(
      { id, issuedBy: "vrx", developer: src.developer, economics: "permission", recycleOf: src.id, issuedAt: now },
      SEAL_DOMAIN
    );
    const fresh: BookingToken = {
      id,
      issuedBy: "vrx",
      developer: src.developer,
      economics: "permission",
      state: "issued",
      custody: src.developer,
      custodyLog: [{ from: "vrx", to: src.developer, at: now, sealHash: seal.hash }],
      recycleOf: src.id,
      issuedAt: now,
      seal,
      // NB: no issuanceFee — recycling never re-charges (the "recycle never re-charges" invariant).
    };
    return { next: [...list, fresh], ret: fresh };
  });
}

/** TEST-ONLY: wipe both stores so a test starts clean. Guarded to the .data path. */
export async function __resetForTests(): Promise<void> {
  await mutateTokens(async () => ({ next: [], ret: undefined }));
  await mutateConfig(async () => ({ next: [], ret: undefined }));
}
