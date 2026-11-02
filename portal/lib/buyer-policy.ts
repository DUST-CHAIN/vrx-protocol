// PURE buyer-policy helper — NO crypto / NO fs import, so it is safe on BOTH the client (the agent screen's
// submit gate) and the server (the developer inbox's completeness badge). The / "minimum buyer
// detail to book" floor. (.)
// identity must be there so the developer never has to chase a ghost. The v1 GLOBAL FLOOR = full name +
// country (nationality) + a basic-KYC marker (the agent affirms, per buyer, that they hold ID on file —
// the `idRef` field; NOT document upload, that's the onboarding arc). Below the floor the booking
// is blocked at submit with a clear reason.
// DEVELOPER-DEFINED, STAGED ( proper) — the floor here is the GLOBAL DEFAULT. A developer may later
// RAISE it (require more to book, and/or a stricter set before SIGNING vs before BOOKING). That dial lives
// freedom" nuance: a developer/product-class where law permits NO KYC can set the floor to nothing —
// so the floor is a DEFAULT, not a hard-coded law. v1 ships the default; the per-developer override is next.

/** The buyer fields we evaluate against the floor. Subset of BuyerSnapshotFields (lib/buyer-snapshot). */
export type PolicyBuyerFields = {
  name?: string;
  nationality?: string;
  idRef?: string;
  phone?: string;
  email?: string;
};

/** One unmet requirement, with a human reason the agent (submit gate) or developer (badge) can read. */
export type PolicyGap = { field: keyof PolicyBuyerFields; label: string };

/** The result of checking a buyer against a stage's policy. */
export type PolicyResult = {
  /** true = the buyer meets the floor for this stage. */
  ok: boolean;
  /** The missing requirements (empty when ok). */
  gaps: PolicyGap[];
};

/** The stage a buyer is being checked for. v1 only gates BOOK; SIGN is where the stricter arc will land. */
export type PolicyStage = "book" | "sign";

/**
 * The v1 GLOBAL DEFAULT floor per stage. `book` = name + country + KYC marker (idRef on file). `sign` adds
 * a contact channel (a signing buyer must be reachable) — defined now so the staged shape exists, though
 * the sign gate itself rides the later signing arc.
 */
const FLOOR: Record<PolicyStage, PolicyGap[]> = {
  book: [
    { field: "name", label: "Full name" },
    { field: "nationality", label: "Country / nationality" },
    { field: "idRef", label: "ID on file (passport / ID reference)" },
  ],
  sign: [
    { field: "name", label: "Full name" },
    { field: "nationality", label: "Country / nationality" },
    { field: "idRef", label: "ID on file (passport / ID reference)" },
    { field: "phone", label: "A contact (phone or email)" },
  ],
};

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

/**
 * PER-DEVELOPER override (the arc the v1 comment above anticipated finally lands for the agent gate).
 * A developer's `requiredProfileFields` (lib/buyers-direct, §9) is expressed in the DIRECT-buyer
 * vocabulary (legalName / nationality / phone / email / passportNo / idCardNo / address). A booking attaches
 * a ROSTER buyer (lib/buyer-snapshot: name / nationality / idRef / phone / email / note), so we MAP each
 * required direct-key onto the roster field that satisfies it. The agent gate passes the selected developer's
 * list here; `readinessFor` remains the authority for the direct-buyer path. One mapping, surfaced not hidden:
 * legalName → the roster `name` (name-split: `name` is now the COMPOSED Title+First+Middle+Last, i.e.
 * the legal name — so this mapping is exact; the structured parts seal/mask under it but satisfy it as one)
 * nationality/phone/email → same-named roster field
 * passportNo | idCardNo → roster `idRef` (the "ID on file" reference; EITHER requirement is met by idRef)
 * address → NOT captured on a roster buyer yet → an honest, visible gap until the form arc adds it.
 * Unknown keys are ignored (defensive). Returns the policy gaps in the roster vocabulary so the agent UI
 * renders one coherent "needs X, Y" line, pre-emptively, before Reserve.
 */
const REQUIRED_KEY_TO_GAP: Record<string, PolicyGap> = {
  legalName: { field: "name", label: "Full legal name" },
  nationality: { field: "nationality", label: "Country / nationality" },
  phone: { field: "phone", label: "Phone" },
  email: { field: "email", label: "Email" },
  passportNo: { field: "idRef", label: "Passport / ID number on file" },
  idCardNo: { field: "idRef", label: "Passport / ID number on file" },
  // `address` has no roster field today — mapped to a sentinel the checker reports as always-missing.
  address: { field: "name", label: "Residential address (not yet captured — edit the buyer)" },
};

/** Build the gap list a developer's requiredProfileFields implies, de-duped by label (so passportNo+idCardNo
 * collapse to one "ID number" line). `address` is special-cased as unsatisfiable until the form arc adds it. */
function gapsForRequired(required: readonly string[], b: PolicyBuyerFields): PolicyGap[] {
  const out: PolicyGap[] = [];
  const seen = new Set<string>();
  for (const key of required) {
    const gap = REQUIRED_KEY_TO_GAP[key];
    if (!gap || seen.has(gap.label)) continue;
    // address is never satisfiable from roster fields today → always a gap; others check the mapped field.
    const satisfied = key !== "address" && nonEmpty(b[gap.field]);
    if (!satisfied) {
      out.push(gap);
      seen.add(gap.label);
    }
  }
  return out;
}

/**
 * Check a buyer against the floor for a stage. A `sign`-stage "contact" requirement is satisfied by EITHER
 * phone or email (so it's listed once, not per-channel). Returns ok + the list of gaps.
 *
 * When `required` is supplied (the selected developer's requiredProfileFields), the developer's policy is
 * used INSTEAD of the global FLOOR[stage] — the arc the v1 note anticipated. Absent → the global default,
 * so the legacy call sites are unchanged.
 */
export function checkBuyerPolicy(
  buyer: PolicyBuyerFields | undefined,
  stage: PolicyStage = "book",
  required?: readonly string[] | null
): PolicyResult {
  const b = buyer ?? {};
  if (required && required.length > 0) {
    const gaps = gapsForRequired(required, b);
    return { ok: gaps.length === 0, gaps };
  }
  const gaps: PolicyGap[] = [];
  for (const req of FLOOR[stage]) {
    if (req.field === "phone") {
      // the "a contact" requirement — phone OR email satisfies it
      if (!nonEmpty(b.phone) && !nonEmpty(b.email)) gaps.push(req);
    } else if (!nonEmpty(b[req.field])) {
      gaps.push(req);
    }
  }
  return { ok: gaps.length === 0, gaps };
}

/** A one-line human summary for a badge/tooltip: "enough to book" or "incomplete — need X, Y". */
export function policySummary(result: PolicyResult): string {
  if (result.ok) return "enough to book";
  return `incomplete — need ${result.gaps.map((g) => g.label).join(", ")}`;
}
