# Security Policy

VRX invites independent security review and publishes its audits — in a form that strengthens, not
endangers, the system.

## Reporting a vulnerability

Security researchers who want to review VRX, or who have found an issue, should contact us at
**vrx@vettedrealty.com**. We treat independent scrutiny as a feature of a privacy-first system, not a
threat, and we commit to publishing every professional audit we receive (in a non-harming form) and to
sharing a portion of any prize we win with the auditors who help strengthen the project.

Please report privately via email first — do not open a public issue for a suspected vulnerability.

## Audit history

**First audit — November 2026.** An independent security researcher (Vicente Aceituno) performed a black-box
assessment of the VRX platform and reported a set of findings spanning the web application and the on-chain
contract. We treated it as a serious backlog, not noise.

**Outcome: every reported finding was remediated, and the web-application fixes are deployed live.** The
remaining on-chain fixes are implemented and tested in the contract source and ship with our next contract
migration. We verified the remediations against the live target. A small number of lower-risk hardening
items remain queued as defence-in-depth. We've invited a follow-up assessment.

## Our standing posture

- **Privacy is the design.** Personal data, prices and deal terms are never placed on-chain; the chain
  records only that a reservation happened and who holds it. The confidential half stays off-chain.
- **We publish our audits** (in a form that strengthens, not endangers, the system) and keep the detailed
  findings and fixes private so they can't serve as a map for an attacker.
- **Some internals are deliberately private** (notably the image-provenance / forensic mechanism), under
  legal advice — the public source is a curated showcase, not the full product.

_As of: November 2026._
