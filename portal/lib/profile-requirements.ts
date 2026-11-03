// Pure logic for the developer buyer-profile-requirements config surface (§9 / Phase 3).
// Lives in lib/ (not the route) so it stays unit-testable WITHOUT being a route export — a Next.js
// `route.ts` may only export HTTP handlers + segment config, so exporting a helper there fails the
// generated-type check (TS2344). The route imports cleanRequired from here. (tsc-bug fix.)

import { PROFILE_FIELD_KEYS, DEFAULT_REQUIRED_PROFILE_FIELDS } from "@/lib/buyers-direct";

const DEFAULTS = DEFAULT_REQUIRED_PROFILE_FIELDS as string[];

/** Clean a requested field list → the real BuyerDirectProfile keys, UNIONED with the always-required default
 *  set (so the floor can never be configured away), de-duped, in PROFILE_FIELD_KEYS order for stability.
 *  The route's one piece of real logic; exported here for the unit test. */
export function cleanRequired(raw: unknown): string[] {
  const valid = new Set<string>(PROFILE_FIELD_KEYS as string[]);
  const requested = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string" && valid.has(k)) : [];
  const union = new Set<string>([...DEFAULTS, ...requested]);
  // Stable order: follow PROFILE_FIELD_KEYS.
  return (PROFILE_FIELD_KEYS as string[]).filter((k) => union.has(k));
}
