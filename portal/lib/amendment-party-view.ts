// amendment-party-view — the PARTY-FACING projection of a sealed contract amendment (Slice 7 party half,
// the design docs §Slice 7). Pure + server-and-test-importable (no route/session deps) so the
// LEAK BOUNDARY is unit-testable: a party viewing their OWN contract sees the change class, the evidence link,
// the dispute-right flag, the timestamp and the ✓-verify result — and NOTHING that must stay server-side.
//
// STRIPS the per-record salt (never leaves the server) and DROPS the buyerRef (the opaque off-seal ref is
// not needed party-side; we never surface it to a party viewing their own deal — the masking boundary).

import { verifyAmendment, type ContractAmendment } from "./contract-amendment";

/** The exact shape the party-facing amendments route returns per record. No salt, no buyerRef, no developer. */
export type PartyAmendmentView = {
  id: string;
  changeClass: ContractAmendment["changeClass"];
  evidenceId: string;
  disputeRight: boolean;
  at: number;
  verified: boolean;
};

export function partyAmendmentView(a: ContractAmendment): PartyAmendmentView {
  return {
    id: a.id,
    changeClass: a.changeClass,
    evidenceId: a.evidenceId,
    disputeRight: a.disputeRight,
    at: a.at,
    verified: verifyAmendment(a),
  };
}
