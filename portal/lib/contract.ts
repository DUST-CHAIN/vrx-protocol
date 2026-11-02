// ──: the system WRITES the full agency-agreement CONTRACT from the filled form fields ──────────────
// legal agreement." This module is that generator — a PURE function (no React, no deps, no I/O) that turns a
// sealed Agreement into the FULL legal document. The on-screen "View contract" modal and browser print/PDF
// both render the ContractDoc this returns; nothing else needs to change to export a PDF (browser print).
// Clause skeleton generalized from the representative (Crestview) one: Title+date · Parties · Whereas ·
// Engagement · Services(a–d) · Commission · Payment/Duration · Facilitation · Amendments · Execution(seal).
// DOMAIN-GENERAL: the economic core (commission %, deposit trigger, duration, basis) comes verbatim from
// the structured form via `seal.terms` (assembleTerms, node/page.tsx) — this module only wraps it in the legal
// frame. The Whereas/Engagement/Services boilerplate is kept deliberately NEUTRAL — it says "units" and "the
// properties" generically, never real-estate-locked, so the same generator serves cars/livestock/slots too.
// HONESTY (privacy moat + "never fabricate an identity"): the Parties block reads the KYC identity SNAPSHOTS
// frozen into the seal. When a party has no vetted profile the snapshot is absent — we print the bare
// account id and say "(identity not yet vetted)", never invent a legal name. The Execution block states the
// seal hash + whether the sealed terms AND identities still verify (the ✓Vetted check) — that sealed
// duplicate held by both parties IS the digital equivalent of the wet signatures + witnesses. The
// on-chain co-signature is sequenced LATER and shown here only as a forward-looking line.

/** A party's KYC identity snapshot as it rides in the seal (subset the client row carries). The `seal.hash`
 * is the party's vetted-identity reference — it's what fills the signature line as that party's "signature"
 * today (a cryptographic identity proof), until the on-chain co-signature arc adds a real txn id. */
export type ContractParty = {
  legalName: string;
  region: string;
  role: "developer" | "agency" | "agent";
  seal?: { salt?: string; hash: string };
};

/** One per-building commission clause as it rides in the seal. */
export type ContractBuilding = {
  buildingId: string;
  commissionPct: number;
  scope: "whole" | { units: string[] };
  /** — the unlock threshold (% of unit price received before commission is payable), sealed per
   * building alongside commissionPct. Optional/backward-compat: absent → the commission clause states the
   * deposit-received default (lib/agreements AgreementBuilding.unlockPct is the source of truth). */
  unlockPct?: number;
};

/** The minimal agreement shape `renderContract` needs — the client `AgreementRecord` already satisfies it. */
export type ContractInput = {
  seal: {
    agency: string;
    developer: string;
    buildings: ContractBuilding[];
    terms: string;
    by: "agency" | "developer";
    proposedAt: number;
    agencyIdentity?: ContractParty;
    developerIdentity?: ContractParty;
  };
  sealHash: string;
  status: "published" | "proposed" | "agreed" | "declined" | "revoked";
  at: number;
  verified: boolean;
};

/** A rendered section: a heading + one or more body paragraphs/lines. The modal and print view both walk this. */
export type ContractSection = { heading: string; body: string[] };

/** One party's signature slot in the Execution block. When `signed`, the line is "inked" with the party's
 * proof reference (their vetted-identity seal hash today; a real on-chain txn id once lands). */
export type ContractSignatory = {
  name: string;
  /** The proof that stands as this party's signature — their KYC identity-seal hash (full). Absent if the
   * party isn't vetted yet (then the line stays blank — never fake a signature). */
  proofRef?: string;
  signed: boolean;
};

// `ContractDoc` is the GENERIC seam of the whole contract subsystem. It is just "a sealed paper document":
// title + dateline + ordered sections + an execution/seal block. It knows NOTHING about real estate, SaaS,
// cars, or any domain. Everything downstream of it is reusable as-is for EVERY use-case:
// • <ContractModal> renders + prints/PDFs any ContractDoc identically.
// • the ✓Vetted re-hash, the preview→final→signed stage machine, the seal/signature block — all domain-free.
// Only the AUTHORING is domain-shaped. Each use-case gets its own PURE `render<Domain>Contract(input):
// ContractDoc` function that emits this shape:
// • `renderContract` (this file) = the AGENCY AGREEMENT.
// • `renderSaleContract` (lib/sale-contract) = the PROPERTY SALE & PURCHASE.
// RULE for the next contract type (software/SaaS "pay sooner", equipment lease, event-slot, …): write a NEW
// `render<Domain>Contract`, do NOT add domain branches/flags into the property or agency renderer. One mega-
// — is only for VARIANTS WITHIN one domain: property with/without EIA, with/without furniture). Cross-
// DOMAIN = new renderer; cross-VARIANT = conditionals inside one renderer. (Not built: no non-property consumer
// yet, per the build-a-new-concept gate.) Note a SEPARATE axis: the DIRECT-buyer path
// is NOT a new domain — it's a second CALLER of renderSaleContract (no agent, no commission, buyer never -
// masked), which the generator already largely handles via the viewer/unlock inputs.
/** The whole rendered document — a title, a dateline, the ordered sections, and the execution/seal block. */
export type ContractDoc = {
  title: string;
  dateline: string;
  sections: ContractSection[];
  /** The ✓Vetted execution block, rendered distinctly (seal hash + verify state + signature lines). */
  execution: {
    verified: boolean;
    /** TRUE once both parties have executed it (status "agreed"): show inked signatures, no DRAFT watermark. */
    signed: boolean;
    /** The FULL seal reference (not truncated) — the modal shows it in full + links to on-chain proof. */
    sealHashFull: string;
    sealHashShort: string;
    lines: string[];
    developer: ContractSignatory;
    agency: ContractSignatory;
  };
};

/** Normalize the stored terms text for an inline PREVIEW: turn whatever leading bullet the terms were written
 * with (`*`, `•`, `·`, `-`) into a single clean "• " so a row preview never shows a raw asterisk. Keeps the
 * line breaks. Pure. (The full contract render strips the bullet entirely; this one keeps a tidy bullet.) */
export function prettyTerms(terms: string): string {
  return terms
    .split("\n")
    .map((l) => l.replace(/^\s*[•*·-]\s*/, "• ").trimEnd())
    .join("\n");
}

// Format a ms-epoch as a plain legal dateline, locale-stable (en-GB long form). Pure — no Date.now.
function fmtDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

// Describe one party for the Parties block. Honest: real legal name + region when vetted; bare account +
// "(identity not yet vetted)" otherwise — never a fabricated name.
function partyLine(account: string, id: ContractParty | undefined, label: string): string {
  if (id) return `${label}: ${id.legalName}, of ${id.region} (account "${account}").`;
  return `${label}: account "${account}" (identity not yet vetted).`;
}

// Describe the scope of one building clause in plain words (domain-neutral — "units", not "condos").
function scopeText(b: ContractBuilding): string {
  if (b.scope === "whole") return "all available units";
  const n = b.scope.units.length;
  return `${n} specified unit${n === 1 ? "" : "s"} (non-exclusive)`;
}

/**
 * Render the full agency-agreement contract document from a sealed Agreement. Pure: same input → same output,
 * no clock/network/storage. The caller supplies the record exactly as the portal already holds it.
 */
export function renderContract(a: ContractInput): ContractDoc {
  const { seal } = a;
  const dev = seal.developerIdentity;
  const agy = seal.agencyIdentity;

  const sections: ContractSection[] = [];

  // 1. Parties.
  sections.push({
    heading: "Parties",
    body: [
      "This Agency Agreement is made between:",
      partyLine(seal.developer, dev, "The Principal (the “Developer”)"),
      seal.agency
        ? partyLine(seal.agency, agy, "The Agent (the “Agency”)")
        : "The Agent (the “Agency”): to be completed by the vetted agency that joins these published terms.",
    ],
  });

  // 2. Whereas — recital of purpose. Domain-general: "units" / "the properties", never real-estate-locked.
  sections.push({
    heading: "Recitals",
    body: [
      "WHEREAS the Developer owns or controls a portfolio of units and wishes to appoint the Agency to introduce and procure buyers for those units on a non-exclusive basis;",
      "WHEREAS the Agency is a vetted party willing to provide such services on the terms set out below;",
      "NOW THEREFORE the parties agree as follows:",
    ],
  });

  // 3. Engagement — independent contractor. Boilerplate, neutral.
  sections.push({
    heading: "1. Engagement",
    body: [
      "The Developer engages the Agency as an independent contractor to provide the Services set out in Clause 2 in respect of the units listed in this Agreement. Nothing in this Agreement creates a partnership, employment, or joint venture between the parties.",
    ],
  });

  sections.push({
    heading: "2. Services",
    body: [
      "The Agency shall:",
      "(a) introduce and procure prospective buyers for the units;",
      "(b) register each prospective buyer with the Developer before presenting terms;",
      "(c) respond to enquiries, negotiate, and support each buyer through to a definitive agreement; and",
      "(d) promote the units through the Agency’s own channels and any media agreed with the Developer.",
    ],
  });

  // 5. Commission — the per-building rate table, snapshotted at proposal. Each line also states the
  // UNLOCK threshold: the % of the unit price the Developer must have RECEIVED from the customer before
  // the Agency's commission on that unit becomes payable (sealed per building; absent → the deposit %).
  const commissionBody = ["Commission is payable to the Agency on the following basis:"];
  for (const b of seal.buildings) {
    const unlock =
      typeof b.unlockPct === "number"
        ? ` Payable once a sale and purchase agreement is signed and the Developer has received at least ${b.unlockPct}% of the unit price from the customer.`
        : " Payable once a sale and purchase agreement is signed and the customer's deposit has been received.";
    commissionBody.push(`• ${b.commissionPct}% on ${b.buildingId} — ${scopeText(b)}.${unlock}`);
  }
  // enforces, disclosed in the document the Agency signs: how the unlock works, the Agency's STAGE-GATED
  // visibility of payment evidence, and that bogus evidence does not unlock commission and can stop the deal.
  commissionBody.push(
    "Whether commission on a unit is payable is determined by the customer's recorded payments to the Developer against that unit: it becomes payable only when a sale and purchase agreement is signed and the recorded, customer-confirmed payments reach the threshold above.",
    "While a sale is being arranged, the Agency can see the payment evidence recorded for its customer's deal. Once the sale and purchase agreement is signed, that standing visibility ends — the customer may choose to keep the Agency able to see a particular payment, and a disputed payment may be opened to the Agency to help resolve it.",
    "A payment recorded with false or misleading evidence does not count towards the unlock threshold and may be grounds to suspend or terminate the dealings under this Agreement.",
  );
  sections.push({ heading: "3. Commission", body: commissionBody });

  // 6. Terms — the economic clauses the Developer actually set (assembleTerms), verbatim. These are the
  // payment trigger, non-exclusivity, duration/renewal, and basis — the sealed, agency-visible text.
  if (seal.terms.trim()) {
    sections.push({
      heading: "4. Payment, Duration and Basis",
      body: seal.terms.split("\n").map((l) => l.replace(/^[•*·-]\s*/, "").trim()).filter(Boolean),
    });
  }

  // 7. Facilitation and Validity ( §9) — the standing VRX-facilitation clause. This is what legally
  // ANCHORS VRX's protocol commission: the agreement names VRX as facilitator and binds its validity to deals
  // transacted via VRX, so the protocol fee is contracted, not arbitrary. Domain-general wording ("the
  // platform", "deals") — never real-estate-locked, consistent with. Standing clause: present on every
  // agency agreement regardless of the per-building terms.
  sections.push({
    heading: "5. Facilitation and Validity",
    body: [
      "This Agreement is facilitated by VRX and is valid only in respect of deals introduced, recorded, and transacted through the VRX platform. Introductions, bookings, and any resulting sale must be conducted via the platform for the Agency’s engagement and commission under this Agreement to apply.",
      "The parties acknowledge VRX as the facilitator of this Agreement and of the dealings it governs. A facilitation fee is payable to VRX in connection with deals transacted under this Agreement, on the terms of the VRX service agreement between VRX and the Developer.",
    ],
  });

  // 8. Amendments — durable; mutual written change only.
  sections.push({
    heading: "6. Amendments",
    body: [
      "No amendment to this Agreement is effective unless it is recorded in writing and sealed by both parties. A change to the commercial terms constitutes a new or amended agreement; it does not alter commission already earned on deals concluded before the change.",
    ],
  });

  // "Signed by both" = the agreement has been EXECUTED by both parties, i.e. status "agreed" (the developer
  // authored+sealed it and the agency accepted/joined, or vice-versa). Proposed/published/declined/revoked are
  // NOT both-party-executed → the doc renders as a DRAFT (watermark, blank signature lines).
  const signed = a.status === "agreed";

  // Execution block — the ✓Vetted seal as the digital duplicate+signatures; on-chain co-signature
  // sequenced later and shown only as a forward line.
  const lines = signed
    ? [
        a.verified
          ? "This Agreement is SEALED and EXECUTED: the terms above and both parties’ vetted identities match the cryptographic seal — unaltered. Each signature below is the signing party’s vetted-identity proof."
          : "⚠ This executed copy does NOT match the seal — treat as void until re-sealed.",
        "Each party holds an identical sealed copy; the matching seal is the digital equivalent of signed duplicates.",
        "On-chain co-signature by both parties’ vetted accounts is to follow.",
      ]
    : [
        "This is a DRAFT — not yet executed by both parties. It becomes binding when both parties have agreed and it is sealed.",
        "The signature references below are filled once each party has executed the agreement.",
      ];

  return {
    title: "AGENCY AGREEMENT",
    dateline: `Made on ${fmtDate(seal.proposedAt || a.at)}.`,
    sections,
    execution: {
      verified: a.verified,
      signed,
      sealHashFull: a.sealHash,
      sealHashShort: a.sealHash.slice(0, 16),
      lines,
      developer: {
        name: dev?.legalName || seal.developer,
        proofRef: dev?.seal?.hash,
        signed, // the developer is a party to every agreement; executed ⇒ they've signed
      },
      agency: {
        name: agy?.legalName || seal.agency || "(the joining agency)",
        proofRef: agy?.seal?.hash,
        // the agency's signature exists only once there IS an agency bound AND it's executed
        signed: signed && !!seal.agency,
      },
    },
  };
}
