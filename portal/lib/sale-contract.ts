// ──: the system WRITES the full SALE & PURCHASE (S&P) CONTRACT from the booking's sealed offer ──────
//
// the directive: a confirmed sale is the moment a lot of paperwork becomes possible, and
// VRX is uniquely placed to generate it because we already hold the parties' details. The KEY sequencing
// insight: the buyer wants to SEE the full populated contract BEFORE paying the deposit — so this generator
// runs at the OFFER/booking stage, not only at close.
//
// This is the TWIN of lib/contract.ts (the agency-agreement generator), built on the SAME proven pattern
// (the [[attested-offchain-records-pattern]] spine): a PURE function (no React, no deps, no I/O) that
// turns the booking's sealed inputs into a ContractDoc — the exact shape the shared <ContractModal> already
// renders as a paper sheet with print/PDF + an execution/seal block. Nothing else changes to export a PDF.
//
// WHERE THE INPUTS COME FROM:
//  • Party identities — the DEVELOPER from its KYC profile (lib/profiles); the BUYER from the offer's
//  sealed buyer SNAPSHOT exactly as the developer is allowed to see it (developerView, masking —
//  show/partial/hide as the agent set).: "use whatever is exposed to the developer." We NEVER
//     fabricate an identity and we NEVER unmask here — a hidden field reads as "(withheld)".
//  • Economic terms + payment plan — from the attested OFFER (seal.terms + seal.plan), verbatim. The
//     ✓Vetted re-hash of that offer is the seal that stands behind this document (same as the agency agmt).
//  • TIMED NOTES (construction timeline → milestones) + FURNITURE options — OPTIONAL, empty-safe. renders
//     them when present; the developer-side AUTHORING of a detailed construction timeline (start date real/
//     projected + phase estimates → S&P milestones) and furniture options with per-item costs (total depends
//  on unit size × selection) is DEFERRED to a later session. The shapes are defined here so the
//     render is ready the moment the authoring lands.
//
// PRIVACY / HONESTY (+ "never fabricate an identity"): no PII beyond what the developer may already see;
// the buyer-KYC DOCUMENTS (photo / id / passport / card) are encrypted off-chain and are NOT part
// of this document — the pre-signing "developer has seen the buyer KYC" acknowledgement is a SEPARATE gate
// (deferred). This generator only states names/plan/terms + whether the offer seal still verifies.
//
// DOMAIN-GENERAL: the boilerplate says "the Property / the Unit" generically; the economic core comes
// verbatim from the structured offer, so the same frame serves other Class-A inventory later.

import type { ContractDoc, ContractSection } from "./contract";
import { resolveTerminationTerms, type TerminationTermsOverride } from "./termination-terms";
import type { PaymentOption } from "./catalog-client";

// ── Phase A: the BUILD-STATE axis — the first real clause-set fork ───────────────────────
//
// An off-plan sale and a ready/already-built sale are DIFFERENT contracts at the CORE, not just different
// field values — the clause SET itself changes. The off-plan-only machinery (the construction
// & handover undertaking, the contractual completion window, the instalment-on-milestone ties, and — when a
// clause library lands — the EIA/regulatory-approval refund, Cl.5.5) has NO meaning for a building that
// already exists: there is no "won't complete because the permit didn't come through" risk once it's built.
//
// This is the composer's clause-SELECTION seam in its smallest honest form: a single `buildState` axis that
// drives WHICH clauses are even emitted (not blanked — omitted). The product-type and region/language axes
// (add-on #2, language packs) are deliberately NOT built here — Phase A is build-state only. See
// the design docs (the three-axis plan + the three gates) for why this is the first slice.
//
// CANONICAL SIGNAL (the Gate-2 consolidation): the catalog carries THREE overlapping "how built is it"
// fields (project.status, the quota-lifecycle `stage`, and timeline presence) that can disagree. The
// composer must read ONE authoritative signal, not re-derive from three. resolveBuildState below nominates
// project.status as canonical, with `stage` as a fallback, and defaults to "off_plan" when nothing is set —
// so a building that has never declared its state keeps the current (construction-clauses-present) behaviour.
// That default makes Phase A BACK-COMPATIBLE: an existing off-plan building renders exactly as before.

/** The contract build-state axis — the clause-set fork. "off_plan" emits the construction/completion
 *  machinery; "ready" omits it (an already-built object has no completion risk). */
export type SaleBuildState = "off_plan" | "ready";

/** The catalog signals resolveBuildState reads — a client-safe subset, all optional. Mirrors the shapes on
 *  lib/catalog Building (`project.status`) + the quota-lifecycle `stage`. */
export type BuildStateSignals = {
  /** PROJECT-level construction status — the PREFERRED signal. */
  projectStatus?: "planning" | "building" | "complete";
  /** Quota-lifecycle stage — the fallback when projectStatus is absent. */
  stage?: "presale" | "built" | "final";
};

/**
 * Resolve the ONE canonical build-state from the catalog's (possibly disagreeing) signals — the Gate-2
 * consolidation. Pure. Priority: project.status (the construction-status field, most semantically correct)
 * → the quota-lifecycle stage → default "off_plan". The off_plan default is deliberate and back-compatible:
 * a building that has declared NEITHER keeps the current behaviour (construction/completion clauses present),
 * and "off_plan" is the conservative choice (it emits MORE buyer-protective clauses, never fewer).
 */
export function resolveBuildState(sig: BuildStateSignals | undefined): SaleBuildState {
  if (!sig) return "off_plan";
  if (sig.projectStatus) return sig.projectStatus === "complete" ? "ready" : "off_plan";
  if (sig.stage) return sig.stage === "presale" ? "off_plan" : "ready"; // built | final → ready
  return "off_plan";
}

/** The developer party for the S&P — from its KYC profile (lib/profiles identityForSeal), or a bare account. */
export type SaleDeveloperParty = {
  account: string;
  legalName?: string;
  region?: string;
  /** The developer's vetted-identity seal hash — stands as its signature line (same as the agency agmt). */
  proofRef?: string;
  /**
 * step 5 — the resolved reusable SELLER ENTITY for this building (lib/seller-entities), absent-safe.
   * The building is run/signed under a specific selling company (possibly different per building), so when a
   * building points at a seller entity, the S&P names THAT company as the Vendor (+ its director/tax/payee),
   * not the bare developer account/profile. Absent → fall back to legalName/account exactly as before. This
 * is OFF-CHAIN business/payee data the buyer must see on the contract — expected; only hashes seal.
   */
  seller?: SaleSellerEntity;
};

/** The resolved seller-entity block that identifies the Vendor on the S&P (step 5). Subset of
 *  lib/catalog-client.SellerEntity — only the fields the contract body states. All optional-safe. */
export type SaleSellerEntity = {
  companyName: string;
  companyNameTH?: string;
  address?: string;
  addressTH?: string;
  taxId?: string;
  directorName?: string;
  /** Who cheques/transfers are made payable to — stated so the Buyer pays the right account. LEGACY single
 * payee; superseded by `paymentOptions`. Still rendered as a fallback when no options resolve. */
  bankPayable?: string;
  /** the developer's ACCEPTED payment destinations for this building (the menu). Resolved by the sp
   *  route via resolvePaymentOptions (migrates a legacy bankPayable read-side), so there is always ≥1 entry on
   *  a signable contract (the hard-require gate). §2 states these as the accepted-methods TERM; once the buyer
 * agrees one (SaleContractInput.agreedPaymentOptionId) §2 states THAT as the binding destination. these
   *  are off-chain destinations shown to the buyer — never on a seal. */
  paymentOptions?: PaymentOption[];
};

/** The buyer party for the S&P — the DEVELOPER-EXPOSED snapshot (developerView). Each field may be the
 *  real value, a partial hint, or absent/"(withheld)" exactly as the agent's mask allows. Never fabricated. */
export type SaleBuyerParty = {
  /** Display name as exposed. When masked this is the PARTIAL hint the agent allowed (e.g. "J•• P••••") —
   *  never the full name. Absent only when the agent hid the name entirely. */
  name?: string;
  /** Nationality / region as exposed. Optional. */
  region?: string;
  /** Buyer/ownership type label as exposed (e.g. "foreign individual"). Optional. */
  buyerType?: string | null;
  /** True iff the buyer snapshot was still MASKED to the developer when this was rendered. Then the
 * party line shows the partial name + a short reference tag, not the full identity. */
  masked?: boolean;
  /** A short, opaque REFERENCE tag (a few hash digits off the booking seal) shown beside a masked name so the
 * parties can refer to this exact buyer ("J•• P•••• · #a3f9c1") without disclosing them. The
 * full legal name appears ONLY on the FINAL, ready-to-sign contract — not in this preview. */
  ref?: string;
};

/** The payment plan as it rides in the offer seal (subset of AssembledPlan the inbox already renders). */
export type SalePlan = {
  priceUsd?: number;
  depositUsd?: number;
  onContractUsd?: number;
  onKeyUsd?: number;
  instalmentCount?: number;
  instalmentUsd?: number;
  frequencyDays?: number;
  bookingFeeUsd?: number;
  taxPct?: number;
  furnitureUsd?: number;
  // per-line due date (ms epoch), optional. Absent = derive from the anchor + frequency (the
  // auto-interval default) or an off-seal override; never guessed. Carried so the S&P and the payment ledger
  // date the SAME line identically (one dating rule, two readers) — see instalmentDueDate below.
  schedule?: { label: string; amountUsd: number; dueAt?: number }[];
  balanced?: boolean;
};

/** One construction-timeline milestone (DEFERRED authoring). A phase with a date (real or projected) that
 *  can be referenced by the payment plan. Empty today → the Construction section renders a neutral note. */
export type SaleMilestone = {
  label: string;
  /** Human date text as the developer entered it — "Q3 2027", "projected Mar 2028", a real date. Kept as text
   *  so "projected" vs "real" reads honestly without a date-type we can't yet justify. */
  when: string;
  /** True if this date is only a projection (not a committed/contractual date). */
  projected?: boolean;
};

/** One furniture option line (DEFERRED authoring). Cost is computed from unit size × selection elsewhere;
 *  here we just carry the already-computed figures to render. Empty today → no Furniture section. */
export type SaleFurnitureOption = {
  label: string;
  costUsd?: number;
  selected?: boolean;
};

/** One negotiation concession recorded into the S&P. The developer's promised extra / agreed change;
 *  `valueUsd` present where it has a money value, absent where it's a qualitative promise. */
export type SaleConcession = {
  label: string;
  note?: string;
  valueUsd?: number;
};

/** One per-deal TIMED TERM for the S&P — a time-bound commitment the buyer wants in the contract.
 *  `when` is free-text (a date OR a relative trigger); `committed` = a binding date vs an indicative projection. */
export type SaleTimedTerm = {
  label: string;
  when: string;
  note?: string;
  committed?: boolean;
};

/** A developer discount off the price for the S&P — a fixed amount or a % of the price. The generator
 *  computes the money + the net purchase price from the booked price. */
export type SaleDiscount = {
  kind: "amount" | "percent";
  /** USD when kind="amount"; a 0..100 percentage of the price when kind="percent". */
  value: number;
  note?: string;
};

/** The transfer-tax arrangement for the S&P — rate + buyer/seller split. The generator computes the
 *  shares from the booked price. */
export type SaleTax = {
  ratePct: number;
  /** Buyer's share of the tax as a % of the total tax (seller pays the rest). */
  buyerSharePct: number;
};

/** Everything the S&P generator needs. The caller assembles this from the offer + KYC profile + (later) the
 *  building's construction timeline + the unit's furniture selection. All the optional parts are empty-safe. */
export type SaleContractInput = {
  /** Opaque on-chain booking id — the join key, shown as the contract reference (not PII). */
  requestId: string;
  /** The offer seal hash (on-chain request_hash) — the cryptographic proof behind this document. */
  sealHash: string;
  /** True iff the offer plaintext still re-hashes to sealHash (the ✓Vetted check, verifyOffer). */
  verified: boolean;
  developer: SaleDeveloperParty;
  buyer: SaleBuyerParty;
  /** Display extras (not PII): the building + unit the sale is for, and any free-text label the catalog has. */
  property: { buildingId?: string; unitId?: string; unitLabel?: string };
  /** The structured plan, verbatim from the offer seal. Null when the offer carried only free-text terms. */
  plan: SalePlan | null;
  /** Free-text offer terms, verbatim from the offer seal. */
  terms: string;
  /** DEFERRED/optional: construction-timeline milestones. Empty → a neutral "to be completed" note. */
  milestones?: SaleMilestone[];
  /**
 * step 5 — the CONTRACTUAL COMPLETION WINDOW (building.project.completeWithinMonths): the number of
   * months, measured from the construction start, within which the Developer undertakes to complete/hand over.
   * The contractual BACKSTOP around the (indicative) milestone dates. Absent → no completion-undertaking line.
 * Renders a plain undertaking that points at the agreement's existing default/termination remedies (
 * clause library) rather than inventing a bespoke refund mechanic — can promote it to a full
 * EIA-style refund clause (§5.5) from the clause library later if he wants.
   */
  completeWithinMonths?: number;
  /**
 * step 5 — free-text LEGAL CLAUSE the developer authored for this building (building.land.clauseText):
   * EIA permit notes, land-specific terms & conditions, etc. Rendered verbatim as its own section, empty-safe.
   */
  landClause?: string;
  /** DEFERRED/optional: furniture options. Empty → no Furniture section. */
  furniture?: SaleFurnitureOption[];
  /** negotiation concessions the developer promised (free extras / agreed changes). Empty → no section.
   *  Recorded during negotiation and FROZEN at `final`, so the buyer signs against exactly what was promised. */
  concessions?: SaleConcession[];
  /** per-deal TIMED TERMS (time-bound commitments the buyer wanted in the contract). Empty → no section.
   *  Distinct from the building construction schedule (milestones): these are deal-specific. Frozen at `final`. */
  timedTerms?: SaleTimedTerm[];
  /** — the transfer-tax arrangement (optional, shared). Absent → fall back to the plan's flat taxPct line. */
  tax?: SaleTax;
  /** — developer discount off the price (optional). Absent → no discount line; price stands as the net. */
  discount?: SaleDiscount;
  /** instalment→milestone ties for off-plan payment-on-progress. Key = 1-based instalment ordinal;
   *  value = the resolved milestone { label, when }. Empty → no ties rendered. Display join only. */
  instalmentMilestones?: Record<string, { label: string; when: string }>;
  /**
 * — per-instalment DUE-DATE override. Key = 1-based instalment ordinal; value = ms epoch the
   * desk/admin pinned for that instalment (the buyer wanted a specific date, or a holiday roll). Sparse: only
   * the overridden lines appear; every other instalment falls back to the auto-interval default (anchorAt +
   * n×frequencyDays). Off-seal, frozen at `final` — same discipline as instalmentMilestones. The override wins
   * over the auto date; both render identically in §2 and feed the ledger, so there is never a hidden date.
   */
  instalmentDueDates?: Record<string, number>;
  /**
 * — the payment option the Buyer AGREED for this deal (the id of one of the seller's resolved
   * `paymentOptions`). Off-seal, set when the buyer picks (slice 5), FROZEN at `final` — same discipline as
   * the other tailoring fields. When set AND it resolves to a known option, §2 states THAT destination as the
   * binding payment term; when absent/unresolved, §2 lists the accepted-methods menu for the buyer to pick
   * from. Never a side-arrangement: the agreed method in §2 reconciles with §5's observed-method language.
   */
  agreedPaymentOptionId?: string;
  /**
 * — per-deal override of the §Default and Termination clause PARAMETERS (threshold %, cure-period
   * floor, interest % p.a.). Absent → the real-SPA defaults (lib/termination-terms). The clause RENDERS these
   * numbers; they are never literals in the prose, so a developer / industry can vary them without re-wording.
   * The advisory buyer-default flag (api/payments) reads the SAME resolved threshold, so the signed clause and
   * the operator prompt can never disagree on a figure.
   */
  terminationTerms?: TerminationTermsOverride;
  /**
 * Phase A — the BUILD-STATE axis: "off_plan" emits the construction & handover undertaking,
   * the completion-window backstop, and the instalment-on-milestone ties; "ready" OMITS them (an already-
 * built object has no completion risk). The caller resolves this via resolveBuildState from the catalog's
   * canonical signal. Absent = "off_plan" — back-compatible (an existing building renders exactly as before).
   */
  buildState?: SaleBuildState;
  /**
 * — the contract STAGE (the single source of truth for where the document is). Drives the full-name
   * reveal (only at `final`+), the watermark, and the execution copy. Absent = "preview" (back-compat).
   */
  stage?: "preview" | "final" | "payment_arrived" | "signed";
  /** TRUE once the S&P is executed. Derived from stage === "signed" by the caller (not a parallel flag). */
  signed: boolean;
  /** ms epoch the sale was confirmed/closed (offer.confirmed.at), or the offer time for a draft. */
  at: number;
  /**
 * — the STABLE anchor date for deriving instalment due dates (the offer/booking time,
   * offer.at). Distinct from `at`, which shifts to the confirm date at close; the schedule must not re-date
   * when the deal signs, so dating anchors here. Absent → instalments stay honestly undated (no anchor, no
 * guess — the behaviour), so §7's "due date" references only appear once a date can be stated.
   */
  anchorAt?: number;
  /** The on-chain confirm receipt (offer.confirmed.tx) — shown in the execution block once sold. */
  receiptTx?: string;
};

// Locale-stable money (USD) for the document body. Plain + legal; no currency-conversion here (the plan is
// snapshotted in USD at booking — "show the numbers" discipline: this is the figure that was agreed).
function money(usd: number | undefined): string {
  if (typeof usd !== "number" || !isFinite(usd)) return "—";
  return usd.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

const DAY_MS = 86_400_000;

// ──: payment method(s) as a §2 contract TERM ───────────────────────────────────────────────────────
// Human label for one accepted payment destination. Kept plain (no field names / mechanism). A crypto
// address is described as "paid to" exactly like a bank account — VRX does not perform the transfer, the buyer
// pays off-platform and records it (Rail A deferred), so the wording must not imply an in-app transfer.
function describePaymentOption(o: PaymentOption): string {
  const dest = o.destination.trim();
  const extra = o.instructions?.trim() ? ` (${o.instructions.trim()})` : "";
  return `${o.label.trim()} — ${dest}${extra}`;
}

/**
 * — the §2 payment-method TERM line(s). ONE resolver so the accepted-methods term, the agreed-destination
 * term and (later) the §5 observed-method default all read from the same source — the §2↔ledger one-rule
 * discipline (mirrors instalmentDueDate). Resolution: prefer the developer's `paymentOptions` menu; if an older
 * entity carried only a legacy `bankPayable`, treat it as one accepted bank destination (so §2 never blanks).
 *   • Buyer has AGREED a resolvable option → state it as the BINDING destination (+ note others by agreement).
 *   • No agreement yet → list the ACCEPTED methods for the buyer to choose from.
 *   • Nothing resolvable → [] (the hard-require gate stops a signable contract reaching here payee-less; a raw
 *     pre-final preview just omits the line rather than lying).
 */
export function paymentMethodTerm(
  options: PaymentOption[] | undefined,
  legacyBankPayable: string | undefined,
  agreedId: string | undefined
): string[] {
  let menu = Array.isArray(options) ? options.filter((o) => o && o.destination?.trim() && o.label?.trim()) : [];
  if (menu.length === 0) {
    const legacy = (legacyBankPayable ?? "").trim();
    if (legacy) menu = [{ id: "legacy", kind: "bank", label: "Bank transfer", destination: legacy }];
  }
  if (menu.length === 0) return [];

  const agreed = agreedId ? menu.find((o) => o.id === agreedId) : undefined;
  if (agreed) {
    const line = `All payments under this Agreement shall be made by ${describePaymentOption(agreed)}, unless the parties agree another method in writing.`;
    if (menu.length > 1) {
      return [line, `Other methods the Developer accepts for this property: ${menu.filter((o) => o.id !== agreed.id).map(describePaymentOption).join("; ")}.`];
    }
    return [line];
  }

  if (menu.length === 1) {
    return [`All payments under this Agreement are to be made by ${describePaymentOption(menu[0])}.`];
  }
  return [
    "Payments under this Agreement may be made by any of the following methods the Developer accepts for this property, as agreed with the Buyer:",
    ...menu.map((o) => `• ${describePaymentOption(o)}`),
  ];
}

/**
 * — the ONE dating rule for an instalment's due date. Priority: an explicit per-line `schedule`
 * date → an off-seal override → the auto-interval default (anchorAt + n×frequencyDays). Returns ms epoch, or
 * undefined when no date can be honestly stated (no anchor AND no frequency AND no override — never guessed).
 * Exported so the S&P renderer AND the payment ledger date the SAME line identically; a second copy of this
 * logic is exactly the kind of seam that drifts.
 *
 *  @param n          1-based instalment ordinal.
 *  @param anchorAt   stable booking/offer epoch (SaleContractInput.anchorAt / Offer.at).
 *  @param freqDays   plan.frequencyDays (0/absent → no interval clock).
 *  @param override   off-seal pinned epoch for THIS ordinal (instalmentDueDates[n]) — wins over the interval.
 *  @param lineDueAt  a date already carried on the schedule[] line (wins over everything — it's the attested one).
 */
export function instalmentDueDate(
  n: number,
  opts: { anchorAt?: number; freqDays?: number; override?: number; lineDueAt?: number }
): number | undefined {
  if (typeof opts.lineDueAt === "number" && opts.lineDueAt > 0) return opts.lineDueAt;
  if (typeof opts.override === "number" && opts.override > 0) return opts.override;
  const freq = typeof opts.freqDays === "number" && opts.freqDays > 0 ? opts.freqDays : 0;
  const anchor = typeof opts.anchorAt === "number" && opts.anchorAt > 0 ? opts.anchorAt : 0;
  if (!anchor || !freq || n < 1) return undefined;
  return anchor + n * freq * DAY_MS;
}

/**
 * (· catch) — SANITY-check a proposed per-instalment due-date override BEFORE it is
 * stored. VRX does NOT adjudicate "fairness" (the desk IS the seller, setting their own terms toward their own
 * buyer, and whatever is set renders transparently in the S&P to all parties). This guard only stops
 * STRUCTURALLY-BROKEN or absurd dates that could become a silent trap, and WARNS on odd-but-legitimate ones.
 *
 * HARD rejects (`reject` set → the route 409s, nothing stored):
 *   - before the booking/offer date (nothing can be due before the deal exists);
 *   - OUT OF CHRONOLOGICAL ORDER vs the adjacent instalments' effective dates (n must sit between n-1 and n+1);
 *   - absurdly far out — beyond `maxAt` (the route passes the building completion window + a margin, else a
 *     hard long-stop cap) → a "never due" instalment that would park the money/commission-unlock indefinitely.
 * SOFT warnings (`warn` set → shown, NOT blocked — a backdated instalment can be legitimate):
 *   - already in the PAST vs `now` (could be an instant-overdue default trap — surface it, let the desk confirm).
 *
 * `neighbours` = the EFFECTIVE (override-or-auto) dates of the other ordinals, so order is checked against what
 * the contract will actually show. Pure + unit-testable; the editor UI calls it for inline feedback too.
 */
export function validateInstalmentDueDate(opts: {
  dueAt: number;
  ordinal: number;
  bookingAt?: number;
  now?: number;
  maxAt?: number;
  /** ordinal (1-based) → effective ms date, for the OTHER instalments (exclude `ordinal`). */
  neighbours?: Record<number, number>;
}): { ok: boolean; reject?: string; warn?: string } {
  const { dueAt, ordinal } = opts;
  if (!(typeof dueAt === "number" && Number.isFinite(dueAt) && dueAt > 0)) {
    return { ok: false, reject: "That is not a valid date." };
  }
  if (typeof opts.bookingAt === "number" && opts.bookingAt > 0 && dueAt < opts.bookingAt) {
    return { ok: false, reject: "A payment can't be due before the booking date." };
  }
  if (typeof opts.maxAt === "number" && opts.maxAt > 0 && dueAt > opts.maxAt) {
    return { ok: false, reject: "That date is too far out to be a real payment deadline." };
  }
  // Chronological order against the nearest earlier / later OTHER instalment.
  const nb = opts.neighbours ?? {};
  let prevMax = -Infinity; // largest effective date among ordinals < this one
  let nextMin = Infinity; //  smallest effective date among ordinals > this one
  for (const [kStr, v] of Object.entries(nb)) {
    const k = Number(kStr);
    if (!(typeof v === "number" && v > 0) || k === ordinal) continue;
    if (k < ordinal) prevMax = Math.max(prevMax, v);
    else nextMin = Math.min(nextMin, v);
  }
  if (dueAt < prevMax) return { ok: false, reject: "This instalment would fall due before an earlier one." };
  if (dueAt > nextMin) return { ok: false, reject: "This instalment would fall due after a later one." };
  // Soft: a date already in the past (relative to now) — allowed, but worth a confirm.
  const now = typeof opts.now === "number" && opts.now > 0 ? opts.now : Date.now();
  if (dueAt < now) return { ok: true, warn: "This due date is already in the past." };
  return { ok: true };
}

// The property descriptor line — domain-neutral ("the Unit / the Property"), honest when ids are absent.
function propertyLine(p: SaleContractInput["property"]): string {
  const label = p.unitLabel || p.unitId;
  if (label && p.buildingId) return `the Unit identified as “${label}” in the development “${p.buildingId}” (the “Property”)`;
  if (label) return `the Unit identified as “${label}” (the “Property”)`;
  if (p.buildingId) return `a Unit in the development “${p.buildingId}” (the “Property”)`;
  return "the Unit the subject of this Agreement (the “Property”)";
}

// The buyer party line — exactly as the developer is allowed to see it, AND only at the right STAGE.
// The FULL legal name prints only when `discloseName` is true = the buyer is unmasked (reveal fired)
// AND the contract has reached `final` (full name only on the ready-to-sign contract). Before that we
// show the PARTIAL name the agent allowed + a short opaque reference tag (: "J*** P***** [hash]"),
// so the parties can refer to this exact buyer without disclosing them. Never fabricated.
// The vendor party line — when the building points at a resolved SELLER ENTITY (step 5), the contract
// names THAT selling company as the Vendor (with its director + tax id, when authored). Absent → fall back to
// the developer's KYC legal name, then a bare account (identity not yet vetted) — unchanged from before. The
// developer account is always shown in parentheses so the chain identity stays traceable alongside the company.
function vendorLine(d: SaleDeveloperParty): string {
  const s = d.seller;
  if (s && s.companyName.trim()) {
    const bits: string[] = [];
    const nameTH = s.companyNameTH?.trim() ? ` (${s.companyNameTH.trim()})` : "";
    if (s.address?.trim()) bits.push(`of ${s.address.trim()}`);
    if (s.taxId?.trim()) bits.push(`tax ID ${s.taxId.trim()}`);
    if (s.directorName?.trim()) bits.push(`represented by its director ${s.directorName.trim()}`);
    const tail = bits.length ? ", " + bits.join(", ") : "";
    return `The Vendor (the “Seller”): ${s.companyName.trim()}${nameTH}${tail} (VRX account “${d.account}”).`;
  }
  if (d.legalName) {
    return `The Vendor (the “Developer”): ${d.legalName}${d.region ? `, of ${d.region}` : ""} (account “${d.account}”).`;
  }
  return `The Vendor (the “Developer”): account “${d.account}” (identity not yet vetted).`;
}

function buyerLine(b: SaleBuyerParty, discloseName: boolean): string {
  if (!discloseName) {
    const partial = b.name?.trim();
    const tag = b.ref ? ` · ref #${b.ref}` : "";
    const named = partial ? `${partial}${tag}` : `registered with VRX${tag}`;
    return `The Purchaser (the “Buyer”): ${named} — identity sealed; the full legal name is disclosed on the final agreement when the Buyer proceeds to sign.`;
  }
  const name = b.name?.trim();
  const bits: string[] = [];
  if (b.region?.trim()) bits.push(`of ${b.region.trim()}`);
  if (b.buyerType) bits.push(`(${b.buyerType})`);
  if (name) return `The Purchaser (the “Buyer”): ${name}${bits.length ? ", " + bits.join(" ") : ""}.`;
  return "The Purchaser (the “Buyer”): as registered with VRX for this booking.";
}

/**
 * Render the full S&P contract document from a booking's sealed offer. Pure: same input → same output, no
 * clock/network/storage. Produces a ContractDoc so the shared <ContractModal> renders + prints it identically
 * to the agency agreement.
 */
export function renderSaleContract(a: SaleContractInput): ContractDoc {
  const sections: ContractSection[] = [];
  const stage = a.stage ?? "preview";
  //  Phase A — the clause-set fork. A READY (already-built) object omits the off-plan temporal
  // machinery entirely: the construction/handover section, the completion-window undertaking, and the
  // instalment-on-milestone ties. Absent → "off_plan" (back-compat; current behaviour unchanged).
  const buildState: SaleBuildState = a.buildState ?? "off_plan";
  const isOffPlan = buildState === "off_plan";
  // Full legal name only once the contract is ready-to-sign (final+) AND the buyer is actually unmasked
  // (reveal fired). In preview — even with a revealed buyer — the name stays the partial+ref tag.
  const atFinalOrLater = stage === "final" || stage === "payment_arrived" || stage === "signed";
  const discloseName = atFinalOrLater && !a.buyer.masked;

  // resolve the AGREED payment destination once (if the buyer has picked one of the seller's options),
  // so §2 (the term) and §5 (observed-method reconcile) read it from the same place and can never disagree.
  const agreedOpt = a.agreedPaymentOptionId
    ? (a.developer.seller?.paymentOptions ?? []).find((o) => o.id === a.agreedPaymentOptionId)
    : undefined;

  // 1. Parties — the Developer (vendor) and the Buyer (purchaser).
  sections.push({
    heading: "Parties",
    body: [
      "This Sale and Purchase Agreement is made between:",
      vendorLine(a.developer),
      buyerLine(a.buyer, discloseName),
    ],
  });

  // 2. The Property.
  sections.push({
    heading: "1. The Property",
    body: [
      `The Developer agrees to sell and the Buyer agrees to purchase ${propertyLine(a.property)}, on the terms set out in this Agreement.`,
      "The Property is sold as a specific, identified unit; it is not substitutable for another unit without a new agreement.",
    ],
  });

  // 3. Price & payment plan — verbatim from the attested offer (the "show the numbers" discipline). We print
  // every figure the plan carries so the Buyer sees EXACTLY what they're committing to before any deposit.
  const payBody: string[] = [];
  const p = a.plan;
  if (p) {
    if (typeof p.priceUsd === "number") payBody.push(`Total purchase price: ${money(p.priceUsd)}.`);
    // developer discount off the price (off-seal, frozen at final). Shown as an explicit deduction +
    // the resulting NET purchase price, so the buyer sees exactly what the discount is worth. The sealed plan's
    // deposit/instalment figures are left untouched (they're the attested schedule); the net is reconciled at
    // transfer. Amount = fixed USD; percent = that % of the stated price.
    if (a.discount && typeof p.priceUsd === "number" && p.priceUsd > 0 && a.discount.value > 0) {
      const amt =
        a.discount.kind === "percent"
          ? Math.round((p.priceUsd * Math.min(100, a.discount.value)) / 100)
          : Math.min(p.priceUsd, Math.round(a.discount.value));
      const net = p.priceUsd - amt;
      const how = a.discount.kind === "percent" ? ` (${a.discount.value}% of the price)` : "";
      const why = a.discount.note?.trim() ? ` — ${a.discount.note.trim()}` : "";
      payBody.push(`Less agreed developer discount: ${money(amt)}${how}${why}.`);
      payBody.push(`Net purchase price after discount: ${money(net)} (reconciled at transfer).`);
    }
    if (typeof p.bookingFeeUsd === "number" && p.bookingFeeUsd > 0) payBody.push(`Booking fee: ${money(p.bookingFeeUsd)}.`);
    if (typeof p.depositUsd === "number" && p.depositUsd > 0) payBody.push(`Deposit payable to reserve the Property: ${money(p.depositUsd)}.`);
    if (typeof p.onContractUsd === "number" && p.onContractUsd > 0) payBody.push(`Payable on signing of this Agreement: ${money(p.onContractUsd)}.`);
    if (typeof p.instalmentCount === "number" && p.instalmentCount > 0) {
      // Instalments are NOT necessarily identical — the amounts can vary (and the final one often
      // carries the remainder). If the plan carries a detailed per-line `schedule`, print that verbatim below
      // rather than claiming "$X each"; otherwise give a representative "~$X" figure, never an exact "each".
      const instLines = (p.schedule ?? []).filter((s) => /instal/i.test(s.label));
      const freq = p.frequencyDays ? `, payable every ${p.frequencyDays} days` : "";
      // resolve a concrete DUE DATE per instalment so §2 states the "due date" that §7
      // (Default & Termination) already relies on. Priority (instalmentDueDate): the attested per-line date →
      // the off-seal override → the auto-interval default (anchorAt + n×frequencyDays). Honest absence: with
      // no anchor AND no frequency AND no override, the line stays dateless (we never invent a date) — then §7
      // correctly reads as conditional. The 1-based ordinal is the line's position in instLines (the schedule
      // is built in order) or the loop index in the synthetic fallback.
      const dueFor = (n: number, lineDueAt?: number): string => {
        const ms = instalmentDueDate(n, {
          anchorAt: a.anchorAt,
          freqDays: p.frequencyDays,
          override: a.instalmentDueDates?.[String(n)],
          lineDueAt,
        });
        return typeof ms === "number" ? ` — due ${fmtDate(ms)}` : "";
      };
      if (instLines.length > 0) {
        payBody.push(`${p.instalmentCount} instalment${p.instalmentCount === 1 ? "" : "s"}${freq}:`);
        instLines.forEach((s, i) => payBody.push(`• ${s.label} — ${money(s.amountUsd)}${dueFor(i + 1, s.dueAt)}.`));
      } else {
        const approx = typeof p.instalmentUsd === "number" ? ` of approximately ${money(p.instalmentUsd)}` : "";
        payBody.push(`${p.instalmentCount} instalment${p.instalmentCount === 1 ? "" : "s"}${approx}${freq}.`);
        // Even without a per-line schedule, state each synthetic instalment's due date when we can date it, so
        // the plan is never a bare count with no "when" (: every payment should carry a date).
        for (let n = 1; n <= p.instalmentCount; n++) {
          const d = dueFor(n);
          if (d) payBody.push(`• Instalment ${n}${d}.`);
        }
      }
      // off-plan payment-on-progress: where the developer tied instalments to construction milestones,
      // state each tie so the Buyer sees what triggers each payment (a change here is the one off-seal link —
      // the plan numbers + the building timeline stay read-only). A tie to a now-removed milestone just drops.
      // Phase A: milestone ties are off-plan-only — a ready object has no construction milestones to pay
      // on, so the ties are dropped entirely (not rendered to a non-existent schedule).
      const ties = isOffPlan ? (a.instalmentMilestones ?? {}) : {};
      const tied = Object.keys(ties)
        .map((k) => ({ n: Number(k), m: ties[k] }))
        .filter((t) => t.n >= 1 && t.n <= (p.instalmentCount ?? 0))
        .sort((x, y) => x.n - y.n);
      if (tied.length > 0) {
        payBody.push("Instalments are due on the following construction milestones:");
        for (const t of tied) payBody.push(`• Instalment ${t.n} — due at ${t.m.label} (${t.m.when}).`);
      }
    }
    if (typeof p.onKeyUsd === "number" && p.onKeyUsd > 0) payBody.push(`Payable on transfer / handover of keys: ${money(p.onKeyUsd)}.`);
    if (typeof p.furnitureUsd === "number" && p.furnitureUsd > 0) payBody.push(`Furniture package: ${money(p.furnitureUsd)}.`);
    // transfer tax: the negotiated shared arrangement if present, else the plan's flat line.
    if (a.tax && a.tax.ratePct > 0) {
      const price = typeof p.priceUsd === "number" ? p.priceUsd : 0;
      const total = Math.round((price * a.tax.ratePct) / 100);
      const buyerShare = Math.round((total * a.tax.buyerSharePct) / 100);
      const sellerShare = total - buyerShare;
      const splitLabel = a.tax.buyerSharePct === 50 ? "shared equally (50/50)" : `${a.tax.buyerSharePct}% Buyer / ${100 - a.tax.buyerSharePct}% Developer`;
      payBody.push(
        `Transfer tax / duty: ${a.tax.ratePct}% of the price (${money(total)}), ${splitLabel} — Buyer ${money(buyerShare)}, Developer ${money(sellerShare)}.`
      );
    } else if (typeof p.taxPct === "number" && p.taxPct > 0) {
      payBody.push(`Applicable tax / duty: ${p.taxPct}% (as prevailing).`);
    }
    // (Removed: a redundant "Payment schedule:" dump of p.schedule[] used to print HERE — but the prose
    // breakdown above already itemises deposit / on-signing / each instalment / on-transfer from the same plan,
    // so a detailed schedule was being listed TWICE in the document. The prose reads better in a legal document;
    // the raw dump was the leftover original renderer. caught the duplication in a live sold-unit S&P.)
    if (p.balanced === false) {
      payBody.push("⚠ Note: the milestone figures above do not fully reconcile to the stated price — to be reconciled before execution.");
    }
  }
  if (payBody.length === 0) payBody.push("The price and payment terms are as set out in the offer terms below.");
  // payment method(s) as a contract TERM. §2 states WHERE/HOW the Buyer pays (must-have).
  // The accepted-methods menu is the seller entity's resolved paymentOptions (the sp route migrates a legacy
  // bankPayable into it read-side, so an older entity still states a destination). When the Buyer has AGREED
  // one option (agreedPaymentOptionId), state THAT as the binding destination; otherwise list the accepted
  // menu for the Buyer to choose from. Off-chain payee data on the seller entity (never on a seal).
  for (const line of paymentMethodTerm(a.developer.seller?.paymentOptions, a.developer.seller?.bankPayable, a.agreedPaymentOptionId)) {
    payBody.push(line);
  }
  sections.push({ heading: "2. Price and Payment", body: payBody });

  // 4. Offer terms — the free-text terms the agent/developer agreed, verbatim (the sealed, buyer-visible text).
  if (a.terms.trim()) {
    sections.push({
      heading: "3. Agreed Terms",
      body: a.terms.split("\n").map((l) => l.replace(/^[•*·-]\s*/, "").trim()).filter(Boolean),
    });
  }

  // 5. Construction timeline / milestones — DEFERRED authoring. Empty-safe: a neutral "to be completed"
  // note today; a dated milestone list once the developer authors the building's construction timeline.
  // Phase A — the clause-set fork: this ENTIRE section is OFF-PLAN-ONLY. A ready/already-built object
  // has no construction & handover to undertake, so the section is OMITTED (not emitted blank) —
  // add-on #1 ("a ready object's document simply never emits the construction recital"). The §Default-and-
  // Termination clause still carries the seller regulatory-approval-failure limb for completeness; it just
  // can't be triggered by a non-existent construction for a ready object.
  if (isOffPlan) {
    const timelineBody: string[] = [];
    const ms = a.milestones ?? [];
    if (ms.length > 0) {
      timelineBody.push("The Developer's current construction and handover schedule for the Property is:");
      for (const m of ms) {
        timelineBody.push(`• ${m.label} — ${m.when}${m.projected ? " (projected, not a contractual date)" : ""}.`);
      }
      timelineBody.push("Projected dates are estimates and may change; committed dates, where stated, are contractual.");
    } else {
      timelineBody.push("Where the Property is under construction, the Developer's construction start and completion/handover schedule is to be completed and attached to this Agreement before execution.");
    }
    //  step 5 — the CONTRACTUAL COMPLETION WINDOW: the backstop around the (indicative) milestone dates.
    // The milestones above are the schedule; this is the Developer's binding undertaking to complete WITHIN a
    // fixed window, with the Buyer's remedy pointed at the agreement's existing default/termination provisions
    // (clause library) — we don't invent a bespoke refund here. (§4 sub-q decided at build: a
    // plain completion undertaking, NOT a new EIA-style refund mechanic; can promote it from the library.)
    if (typeof a.completeWithinMonths === "number" && a.completeWithinMonths > 0) {
      const m = Math.round(a.completeWithinMonths);
      timelineBody.push(
        `The Developer undertakes to complete construction and hand over the Property within ${m} month${m === 1 ? "" : "s"} of the commencement of construction. If the Developer fails to complete within that period, the Buyer's remedies are as set out in the Default and Termination section of this Agreement.`
      );
    }
    sections.push({ heading: "4. Construction and Handover", body: timelineBody });
  }

  // 4b. Land and legal — the developer's building-specific free-text clause (step 5, building.land.
  // clauseText): EIA permit notes, land terms & conditions, etc. Rendered verbatim, empty-safe. Split on
  // newlines so a multi-line clause reads as separate paragraphs, mirroring the Agreed Terms handling.
  const landClause = a.landClause?.trim();
  if (landClause) {
    sections.push({
      heading: "4A. Land and Legal",
      body: landClause.split("\n").map((l) => l.replace(/^[•*·-]\s*/, "").trim()).filter(Boolean),
    });
  }

  // 4B. Time-bound commitments — per-deal TIMED TERMS (part 1): the deal-specific dated commitments
  // the buyer was anxious about and wanted in THEIR contract (e.g. "car-park handed over by March 2027", "title
  // transferred within 60 days of final payment"). Distinct from §4's building-wide construction schedule. Each
  // line states WHAT, WHEN, and whether the date is CONTRACTUAL (committed) or indicative — so the buyer signs
  // knowing which promises bind the Developer. Empty-safe (only rendered when the developer authored some).
  const timed = a.timedTerms ?? [];
  if (timed.length > 0) {
    const timedBody = ["The Developer makes the following time-bound commitments in respect of this sale:"];
    for (const t of timed) {
      const note = t.note ? ` (${t.note})` : "";
      const binding = t.committed
        ? " — a committed contractual date"
        : " — an indicative projection, not a contractual date";
      timedBody.push(`• ${t.label}: ${t.when}${note}${binding}.`);
    }
    timedBody.push("Committed dates bind the Developer; indicative dates are good-faith estimates and may change. The Buyer's remedies for a failure to meet a committed date are as set out in the Default and Termination section of this Agreement.");
    sections.push({ heading: "4B. Time-Bound Commitments", body: timedBody });
  }

  // 6. Furniture — DEFERRED authoring. Only rendered when options exist; cost is computed elsewhere
  // (unit size × selection) and carried in verbatim.
  const furn = a.furniture ?? [];
  if (furn.length > 0) {
    const chosen = furn.find((f) => f.selected);
    const furnBody = [
      chosen
        ? "The Buyer has selected the following furniture package for the Property:"
        : "The following furniture packages are available for the Property:",
    ];
    for (const f of furn) {
      const sel = f.selected ? " [selected]" : "";
      const cost = typeof f.costUsd === "number" ? ` — ${money(f.costUsd)}` : "";
      furnBody.push(`• ${f.label}${cost}${sel}.`);
    }
    if (chosen && typeof chosen.costUsd === "number") {
      furnBody.push(`Selected furniture package: ${chosen.label} — ${money(chosen.costUsd)}, payable as part of the purchase.`);
    } else if (!chosen) {
      furnBody.push("A furniture package, if selected, is priced for this unit and added to the purchase.");
    }
    sections.push({ heading: "5. Furniture", body: furnBody });
  }

  // Dynamic numbering for the tail sections: 5 is Furniture (if present), so the next numbers depend on what
  // optional sections rendered. `nextNum` walks forward from 5.
  let nextNum = furn.length > 0 ? 6 : 5;

  // 6/5. Concessions and agreed variations — negotiation promises recorded into the contract. Only
  // when present; frozen at `final` so the buyer signs against exactly what the developer promised.
  const conc = a.concessions ?? [];
  if (conc.length > 0) {
    const concBody = ["As part of the negotiation of this sale, the Developer has agreed to provide the following at no additional charge to the Buyer, or to make the following variations, which form part of this Agreement:"];
    for (const c of conc) {
      const val = typeof c.valueUsd === "number" && c.valueUsd > 0 ? ` (value ${money(c.valueUsd)})` : "";
      const note = c.note ? ` — ${c.note}` : "";
      concBody.push(`• ${c.label}${val}${note}.`);
    }
    concBody.push("These concessions are binding on the Developer and are provided at no additional cost to the Buyer unless expressly stated otherwise above.");
    sections.push({ heading: `${nextNum}. Concessions and Agreed Variations`, body: concBody });
    nextNum++;
  }

  // Payments and evidence — the S&P-side TRANSPARENCY disclosure owed (docs/
  // PAYMENT_LEDGER_DESIGN.md §7). VRX is transparent about how it handles the customer→developer payment
  // tail, so the rules the buyer's confirm/dispute surface enforces are stated here in the document the buyer
  // signs: payments are recorded with evidence; the buyer (or their agent) confirms or disputes each entry;
  // slips stay private to the developer and buyer; a dispute goes to the deal chat; bad evidence can escalate
  // and stop the deal; the buyer may share a record with their agent. Standing clause (not offer-derived), so
  // it's always present — the buyer never signs without seeing it.
  sections.push({
    heading: `${nextNum}. Payments and Evidence`,
    body: [
      "Payments the Buyer makes to the Developer towards the Price (deposit and instalments) are recorded against this Agreement, each with the date, amount, method and, where available, an evidence slip (a receipt, bank transfer slip or payment screenshot).",
      // reconcile §5's observed method with §2's agreed method: when a destination has been agreed,
      // state that recorded payments are expected to use it (so §2 and §5 never imply different rails).
      ...(agreedOpt ? [`Payments are expected to be made by the method agreed in the Price and Payment section above (${describePaymentOption(agreedOpt)}); a payment made by another method is recorded with that method noted.`] : []),
      "The Buyer — or an agent acting on the Buyer's behalf — can see each payment the Developer has recorded and must CONFIRM it is correct, or DISPUTE it if it does not match what was paid. A disputed entry is raised in the deal conversation for the parties to resolve.",
      "Payment evidence is kept private and encrypted. It is shared only between the Developer and the Buyer (and the Buyer's agent while the sale is being arranged); the Buyer may choose to keep their agent able to see a specific payment after signing. Payment amounts and evidence are never published or placed on-chain.",
      "If a payment is recorded with false or misleading evidence, it does not count towards the Developer's obligations and may be grounds to suspend or terminate this Agreement.",
    ],
  });
  nextNum++;

  // Default and Termination — the §Default-and-Termination clause the arc's state machine enforces the STEPS
  // of (the "no fraud, no holes" north star; the enforced flow). The S&P body references "the default
  // and termination provisions of this Agreement" in §4, §4B and §Payments-and-Evidence above — THIS section
  // is those provisions (before those references pointed at nothing; slice 1 flagged the drift and
  // deferred the prose, slice 4 writes it). It is marked a DRAFT (v1-draft, same honesty posture as
  // VRX_DEVELOPER_TERMS): the STRUCTURE is real and paraphrases the real SPA (Cl.14 ≥threshold/notice/
  // cure/retain/re-sell; Cl.5.4 interest on arrears; Cl.5.5 the reverse, a seller regulatory-approval failure
  // → full refund), but the exact wording is not yet legally reviewed. The FIGURES are rendered from the
  // termination-terms surface (lib/termination-terms) — NEVER baked as literals — so a developer / industry
  // can vary the threshold, cure floor and interest rate without re-wording the clause. The cure PERIOD is
  // stated as the period in the Seller's default notice, "not less than {cureDays} days" — the
  // real window is set per-notice by the serving operator (lib/termination cureWindowMs, guard 3); this is the
  // clause's floor. The mechanics here MUST stay consistent with the machine's guards and slice 5's retain/
  // refund money tie (document-alongside): default → notice → cure window → terminate; no termination before
  // the served cure window elapses; buyer default uncured → monies RETAINED + re-sell; seller regulatory-
  // approval failure → monies REFUNDED. (plain words; no field names, no D-refs, no contract-speak.)
  const tt = resolveTerminationTerms(a.terminationTerms);
  sections.push({
    heading: `${nextNum}. Default and Termination`,
    body: [
      "⚠ Draft wording (not yet legally reviewed). The structure and figures below reflect the parties' agreed default and termination arrangements; the exact legal wording may be refined before it is finalised.",
      `A default by the Buyer occurs if the Buyer fails to pay amounts totalling ${tt.defaultThresholdPct}% or more of the Price when due, fails to pay any instalment by the due date stated for it in the payment plan above, or breaches any other provision of this Agreement.`,
      `On a Buyer default, the Seller may serve a written default notice. The Buyer then has the period stated in that notice — being not less than ${tt.cureDays} days — to rectify the default. If the Buyer rectifies within that period, this Agreement continues in full force.`,
      `If the Buyer does not rectify within the period stated in the default notice, the Seller may terminate this Agreement, retain all monies the Buyer has paid, and re-sell the Property to a third party. The Seller may also charge interest on overdue amounts at ${tt.interestPctPerAnnum}% per annum; charging interest does not waive the Seller's right to terminate.`,
      "A default by the Seller occurs if the Seller is unable to obtain a required regulatory approval for the development that the Seller must obtain, or otherwise fails to perform a fundamental obligation under this Agreement. On a Seller default of that kind, the Seller shall refund to the Buyer all monies the Buyer has paid under this Agreement.",
      "Neither party may terminate this Agreement except through the process set out above: a written default notice, the opportunity to rectify within the stated period, and only then termination with the monies dealt with as stated. Each step is recorded so that both parties, and the Property's reservation record, reflect exactly what occurred.",
    ],
  });
  nextNum++;

  // Changes to the Property's specifications — the DISCLOSED change-right (Slice 6, CHANGE-GOVERNANCE arc;
  // arc design the design docs §4). This is the CONTRACTUAL disclosure that the sealed-amendment
  // mechanism (lib/contract-amendment, Slice 3) rests on: the governing principle is that a developer
  // MAY change specifications during the sale, but the right must be ANCHORED IN THE S&P so a later notified
  // amendment is expected, not a surprise. The clause states, in plain words (no field names / no
  // mechanism / no hash-talk): (1) the Developer may change specifications; (2) a material change is NOTIFIED
  // with a sealed before/after record (Slice 2 evidence); (3) a MAJOR material change entitles the Buyer to
  // DISPUTE (Slice 3's amendment + disputeRight) — matching isMaterialChange's coarse, bias-to-evidence grading,
  // so NO magnitude numbers are stated here (per-field magnitude grading is deliberately unspec'd — arc plan);
  // (4) some facts are IMMUTABLE once on contract and change only through a VRX-reviewed correction (Slice 1's
  // `immutable` disposition + Slice 5's correction path); (5) VRX RECORDS the evidence, it does NOT adjudicate
  // the dispute or warrant any outcome (pt5 — the structural legal posture; VRX anchors, courts/parties
  // decide). Standing clause (always present — the change mechanism can touch any on-contract building, built or
  // off-plan), so the Buyer never signs without seeing the change-governance they are protected by.
  sections.push({
    heading: `${nextNum}. Changes to the Property`,
    body: [
      "The Developer may, during the course of the sale and before completion, make changes to the specifications, layout, materials, common areas or other features of the Property or the development, where permitted by law and any applicable regulatory approval.",
      "Where a change is material — that is, it affects the price, the size, type or layout of the Property, the payment terms, or the land or legal basis of the sale — the Developer will notify the Buyer of the change, and a before-and-after record of the change is sealed and kept so that the Buyer can see exactly what changed and when.",
      "Where a material change is major, it is recorded as an amendment to this Agreement and the Buyer is entitled to dispute it. Raising a dispute does not of itself terminate this Agreement; it is dealt with between the parties, with the sealed record available to both, and the Default and Termination provisions of this Agreement apply where relevant.",
      "Certain particulars — including the title, survey, land identification, the address of the development, and the identity of the parties — are fixed once this Agreement is on foot and cannot be changed by either party acting alone. A correction to any such particular is made only through a reviewed correction process, with the change recorded and the Buyer notified.",
      "VRX records the fact, timing and before-and-after detail of each change, and makes that record available to the parties; it does not decide any dispute between the parties and does not warrant the outcome of any dispute. Any dispute is resolved between the Buyer and the Developer or as otherwise provided by law.",
    ],
  });
  nextNum++;

  // Amendments — mirrors the agency agreement's durable-change clause.
  sections.push({
    heading: `${nextNum}. Amendments`,
    body: [
      "No amendment to this Agreement is effective unless it is recorded in writing and sealed by both parties. The Property remains a specific, non-substitutable unit; any change of unit constitutes a new agreement.",
    ],
  });

  // Execution block — the ✓Vetted seal as the digital duplicate + signatures, plus the on-chain SALE
  // receipt once closed. Mirrors lib/contract exactly so <ContractModal> renders both the same way.
  // The copy is STAGE-aware: preview DRAFT → final/payment_arrived READY-TO-SIGN (with the validity
  // note once payment arrived) → signed EXECUTED.
  const verifyLine = a.verified
    ? "The terms and plan shown match the cryptographic seal held for this booking (✓ verified, unaltered)."
    : "⚠ The terms shown do NOT currently match the seal for this booking — do not rely on this copy; contact your agent.";
  const lines = a.signed
    ? [
        a.verified
          ? "This Agreement is SEALED and EXECUTED: the terms and plan above match the cryptographic seal held for this booking — unaltered since it was signed."
          : "⚠ This executed copy does NOT match the seal held for this booking — treat as void until re-sealed.",
        "Each party holds an identical sealed copy; the matching seal is the digital equivalent of signed duplicates.",
        a.receiptTx
          ? `The sale was confirmed on-chain — receipt (transaction) ${a.receiptTx}.`
          : "The sale confirmation is recorded on-chain against this booking.",
      ]
    : stage === "payment_arrived"
    ? [
        "This Agreement is FINAL and ready to sign: the parties' full identities are set out above and the terms are fixed.",
        verifyLine,
        "The on-contract payment has been confirmed received — this Agreement is valid to execute online. It becomes binding once both parties sign.",
      ]
    : stage === "final"
    ? [
        "This Agreement is FINAL and ready to sign: the parties' full identities are set out above and the terms are fixed.",
        verifyLine,
        "Before it can be executed online, the on-contract payment must be confirmed received by the Developer. It becomes binding once both parties sign.",
      ]
    : [
        "This is a DRAFT provided so the Buyer may review the FULL terms BEFORE paying any deposit. It is not yet executed.",
        verifyLine,
        "It becomes binding when both parties have executed it and it is sealed.",
      ];

  return {
    title: "SALE AND PURCHASE AGREEMENT",
    dateline: `Prepared on ${fmtDate(a.at)}. Booking reference ${a.requestId}.`,
    sections,
    execution: {
      verified: a.verified,
      signed: a.signed,
      sealHashFull: a.sealHash,
      sealHashShort: a.sealHash.slice(0, 16),
      lines,
      developer: {
        // Prefer the resolved seller-entity company (step 5) — it's the party that actually signs the
        // S&P for this building — then the KYC legal name, then the bare account. Never fabricated.
        name: a.developer.seller?.companyName?.trim() || a.developer.legalName || a.developer.account,
        proofRef: a.developer.proofRef,
        signed: a.signed,
      },
      agency: {
        // The second signatory on an S&P is the BUYER (not an agency). We reuse the ContractSignatory slot
        // the modal renders — its role label is passed by the modal, so here we only supply the name/signed.
        // Full name only once disclosed (final+ and unmasked); otherwise the reserved partial+ref handle.
        name: discloseName
          ? a.buyer.name || "(the Buyer)"
          : `${a.buyer.name?.trim() || "Registered Buyer"}${a.buyer.ref ? ` · #${a.buyer.ref}` : ""}`,
        // A buyer has no vetted-identity seal hash today (customers aren't vetted like dev/agency/agent —
        // ), so the buyer signature line carries no proofRef yet. Once buyer-KYC-at-signing lands, a signing
        // reference can fill here. Never fake a signature: unsigned stays blank.
        proofRef: undefined,
        signed: a.signed,
      },
    },
  };
}

// ── REVIEW MODE: the quality-check output ──────────────────────────────────────────────
//
//  spec for the parametric contract: "a REVIEW mode that highlights both the FILLED and the
// MISSING unit/deal-specific fields, so the developer/agency can quality-check at a glance exactly what's
// specific to this unit + deal and what's still blank before signing."
//
// This is a PURE companion to renderSaleContract — it inspects the SAME input (never the rendered prose) and
// returns a flat checklist of the deal-specific items a reviewer should verify. The <ContractModal> renders
// it as a panel (filled = green with the value; missing = yellow) when Review is toggled on. Keeping the
// filled/missing JUDGEMENT here (not in the view) means it's deterministic and unit-testable, and it can
// never drift from what the document actually renders because both read one input.
//
// SCOPE: only DEAL/UNIT-SPECIFIC fields (the things that vary per sale) — not the boilerplate clauses. A
// masked buyer name is NOT "missing" (it's deliberately withheld) — it gets its own "withheld" state so
// a reviewer isn't told to go fill a field the privacy model is intentionally hiding. Build-state-omitted
// clauses (a ready object's construction window) are NOT flagged missing — they don't apply to this contract.

/** One review-checklist item. `state`:
 *  - "filled"   — a deal-specific value is present (shown with `value`).
 *  - "missing"  — a field the reviewer should complete before signing is blank (yellow flag).
 * - "withheld" — deliberately masked by the privacy model, not a gap to fill. */
export type ReviewFlag = {
  /** Stable key for the field (testing / highlighting). */
  key: string;
  /** Human label shown in the checklist. */
  label: string;
  state: "filled" | "missing" | "withheld";
  /** The resolved value when filled (or the withheld hint). */
  value?: string;
};

/**
 * Build the review checklist for an S&P input. Pure. The order is reading-order through the
 * document (parties → property → price/plan → terms → timing → extras). Build-state-aware: off-plan-only
 * items (construction completion window) are only checked for an off_plan contract.
 */
export function reviewAnnotations(a: SaleContractInput): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const buildState: SaleBuildState = a.buildState ?? "off_plan";
  const isOffPlan = buildState === "off_plan";
  const push = (key: string, label: string, present: boolean, value?: string) =>
    flags.push({ key, label, state: present ? "filled" : "missing", ...(present && value ? { value } : {}) });

  // Parties — developer (seller entity preferred) + buyer. The buyer name is WITHHELD, not missing, when masked.
  const devName = a.developer.seller?.companyName?.trim() || a.developer.legalName?.trim();
  push("developer", "Seller / Developer", Boolean(devName), devName || undefined);
  if (a.buyer.masked) {
    flags.push({
      key: "buyer",
      label: "Buyer identity",
      state: "withheld",
      value: `withheld until disclosure${a.buyer.ref ? ` · #${a.buyer.ref}` : ""}`,
    });
  } else {
    push("buyer", "Buyer identity", Boolean(a.buyer.name?.trim()), a.buyer.name?.trim());
  }
  push("buyerType", "Buyer / ownership type", Boolean(a.buyer.buyerType), a.buyer.buyerType || undefined);

  // Property.
  push("property", "Property (unit)", Boolean(a.property.unitId?.trim()), a.property.unitId || undefined);

  // Price & plan — the economic core. Each a separate check so a reviewer sees exactly which figure is blank.
  const p = a.plan;
  push("price", "Purchase price", Boolean(p && typeof p.priceUsd === "number" && p.priceUsd > 0), p && typeof p.priceUsd === "number" ? money(p.priceUsd) : undefined);
  push("deposit", "Deposit", Boolean(p && typeof p.depositUsd === "number" && p.depositUsd > 0), p && typeof p.depositUsd === "number" ? money(p.depositUsd) : undefined);
  const hasPlanShape = Boolean(
    p && ((typeof p.instalmentCount === "number" && p.instalmentCount > 0) || (typeof p.onContractUsd === "number" && p.onContractUsd > 0) || (typeof p.onKeyUsd === "number" && p.onKeyUsd > 0))
  );
  push("plan", "Payment plan", hasPlanShape, hasPlanShape && p ? `${p.instalmentCount ?? 0} instalment(s)` : undefined);

  // Agreed terms (the free-text sealed terms). When present, show a short preview as the value so the row
  // reads as filled with content, not a bare "—" that looks like a gap.
  const termsText = a.terms?.trim() ?? "";
  const termsPreview = termsText.length > 48 ? `${termsText.slice(0, 48).trim()}…` : termsText;
  push("terms", "Agreed terms", Boolean(termsText), termsPreview || undefined);

  // Timing — off-plan only. A ready/built contract has no completion window to check (build-state fork).
  if (isOffPlan) {
    const ms = a.milestones ?? [];
    push("timeline", "Construction timeline", ms.length > 0, ms.length > 0 ? `${ms.length} milestone(s)` : undefined);
    const cw = typeof a.completeWithinMonths === "number" && a.completeWithinMonths > 0;
    push("completion", "Completion window", cw, cw ? `${Math.round(a.completeWithinMonths as number)} month(s)` : undefined);
  }

  // Deal extras that commonly carry meaning the reviewer should confirm are as negotiated. These are OPTIONAL
  // by nature (most deals have none) — so "absent" is NOT flagged missing; only report them when PRESENT
  // (filled), so the checklist stays about "is what SHOULD be here, here" not "you forgot the optional extras".
  if (a.discount) flags.push({ key: "discount", label: "Developer discount", state: "filled", value: a.discount.kind === "percent" ? `${a.discount.value}%` : money(a.discount.value) });
  if ((a.concessions ?? []).length > 0) flags.push({ key: "concessions", label: "Concessions", state: "filled", value: `${a.concessions!.length} item(s)` });
  if ((a.timedTerms ?? []).length > 0) flags.push({ key: "timedTerms", label: "Time-bound commitments", state: "filled", value: `${a.timedTerms!.length} item(s)` });
  const chosenFurn = (a.furniture ?? []).find((f) => f.selected);
  if (chosenFurn) flags.push({ key: "furniture", label: "Furniture package", state: "filled", value: chosenFurn.label });

  return flags;
}
