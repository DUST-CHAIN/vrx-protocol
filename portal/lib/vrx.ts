// VRX contract client — the reusable near-api-js wiring for the portal.
// This is the modern (near-api-js 5.x) analogue of the pilot's `loadBContract` (near-api-js 0.44,
// `vetted-poc-developer`): a single place that knows the contract's method surface and how to reach it.
// The METHOD VOCAB is OUR post-rename vocabulary — NOT the pilot's old
// createBuilding/replyOffer names. The MECHANISM ports; the names are ours.
// PRIVACY: every real-world identifier the portal sends is an OPAQUE HASH/HMAC computed off-chain
// (instance_hash, org_ref, request_hash, integrity_hash, scope, unit_key…). The portal must NEVER put
// PII, prices, terms, or milestones on-chain in the clear — hash them first. (This is the concrete
// improvement over the pilot, whose createUnit wrote type/size/status in plaintext.)
// SIGNING: this module does READS only, and routes them through the server (view → /api/view; the
// browser holds no RPC provider or key — see the sole-reader note below). Writes need an Account signer —
// added when we wire onboarding (owner-signed register_node/register_org). For real users that
// signer becomes @near-wallet-selector; for local owner-driven dev it's a local keypair. The view/call
// method names below don't change between those — only how we obtain the signer does.

// SOLE-READER POSTURE (indexer Slice 4): the browser NEVER opens a direct RPC provider. Every
// read goes through view → POST /api/view (the server holds the keys + does the actual chain read).
// The old `export const provider = new providers.JsonRpcProvider(...)` was a dead escape hatch (zero
// consumers) that could tempt a future caller back into direct browser RPC — removed. If you need a
// chain read from the browser, add a method to the view-surface below; do NOT reintroduce a provider
// here. `lib/vrx.no-direct-rpc.test.ts` guards this (asserts this module constructs no JsonRpcProvider).

/**
 * Read-only view call against the live contract — now proxied through OUR server (`POST /api/view`).
 *
 * WHY: the browser used to call test.rpc.fastnear.com directly, which failed TWO ways: unkeyed →
 * -429 rate-limit flood; keyed `?apiKey=` → CORS PREFLIGHT blocked (FastNEAR doesn't answer the OPTIONS
 * preflight the browser sends). Routing through our same-origin API sidesteps both: no CORS/preflight
 * (same origin) and the SERVER does the actual read with the FastNEAR bearer key (no throttle, and the
 * key never ships to the browser). Reads only; opaque args. The per-call timeout still guards a hung
 * request so a slow read fails fast instead of freezing the page.
 */
export async function view<T = unknown>(
  method: string,
  args: Record<string, unknown> = {},
  tries = 3,
  timeoutMs = 8000
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await withTimeout(
        fetch("/api/view", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method, args }),
        }),
        timeoutMs
      );
      if (!res.ok) throw new Error(`view ${res.status}`);
      const json = (await res.json()) as { result?: T; error?: string };
      if (json.error) throw new Error(json.error);
      return json.result as T;
    } catch (e) {
      lastErr = e;
      if (attempt < tries - 1) await sleep(200 * 2 ** attempt);
    }
  }
  throw lastErr;
}

// ── The VRX method surface (from contract/src/lib.rs) ──────────────────────────────
// Grouped so the portal (and its future onboarding/booking screens) has one honest map of what
// the contract exposes. Signer column notes who may call each WRITE method.
// VIEWS (no signer):
// get_owner -> AccountId
// get_node(id) get_org(id) get_peer(id) -> Option<record>
// get_gate(node_id, org_id) can_access(org_id, node_id, scope_hash) -> bool
// get_agreement(node_id, org_id) -> Option<Agreement> ( commission anchor)
// get_tile(unit_key) get_hold_expiry(unit_key) get_hold_window -> u64 ns
// get_claim(request_id) get_pending_claims(node_id) -> Vec<String>
// get_pass(id) get_pass_link(id)
// get_toll -> U128 get_treasury -> AccountId is_exempt(account) -> Option<u8>
// required_deposit(caller, est_bytes) -> U128 (storage + toll for a non-exempt writer; 0 if exempt)
// WRITES (all #[payable]; non-exempt callers attach required_deposit, owner is implicitly exempt):
// register_node(node_id, instance_hash) OWNER only
// register_org(org_id, org_ref) OWNER only
// register_peer(peer_id, agent_ref) org
// deactivate_peer(peer_id) org
// grant_gate(org_id, scope[]) node revoke_gate(org_id) node
// set_agreement(org_id, commission_hash) node revoke_agreement(org_id) node
// stamp_tile(unit_key, status, integrity_hash) node stamp_tiles(stamps[]) node (batch)
// set_hold_window(ns) owner
// open_claim(request_id, unit_key, node_id, request_hash) peer
// reply_claim(request_id, status, response_hash, tile_hash) node
// confirm_claim(request_id, integrity_hash) NODE (not peer — else E23)
// burn_pass_hold(pass_id, request_id, unit_key, node_id, request_hash, tile_hash)
// deactivate_node(id) deactivate_org(id) owner
// add_exempt(account, tier) remove_exempt(account) set_toll(U128) set_treasury(AccountId) owner
// Tile status codes: 0 open · 1 hold · 2 closed · 3 done. View output uses serde-pinned SHORT keys
// (k/h/s/n/b/o/p/r…), NOT the Rust field names — expect terse JSON.

export const VRX_VIEW_METHODS = [
  "get_owner",
  "get_node",
  "get_org",
  "get_peer",
  "get_gate",
  "can_access",
  "get_agreement",
  "get_tile",
  "get_hold_expiry",
  "get_hold_window",
  "get_claim",
  "get_pending_claims",
  "get_pass",
  "get_pass_link",
  "get_toll",
  "get_treasury",
  "is_exempt",
  "required_deposit",
] as const;

// Convenience typed reads used by the skeleton landing page.
export const getOwner = () => view<string>("get_owner");
export const getToll = () => view<string>("get_toll");
export const getTreasury = () => view<string>("get_treasury");
export const getHoldWindow = () => view<string>("get_hold_window");
// get_node/get_org/get_peer all take a single `id` arg (contract/src/lib.rs:689/708/737) —
// NOT node_id/org_id/peer_id. (The write methods register_node/register_org DO use node_id/org_id;
// don't confuse the two.)
export const getNode = (id: string) => view<unknown | null>("get_node", { id });
export const getOrg = (id: string) => view<unknown | null>("get_org", { id });
export const getPeer = (id: string) => view<unknown | null>("get_peer", { id });
// get_gate takes BOTH node_id and org_id (contract/src/lib.rs:781) — not a single `id`.
export const getGate = (nodeId: string, orgId: string) =>
  view<unknown | null>("get_gate", { node_id: nodeId, org_id: orgId });

// ── Off-chain hashing (PRIVACY MOAT) ────────────────────────────────────────────────
// The contract stores only OPAQUE references — it must never see PII, prices, or terms in the
// clear. The portal hashes real-world data HERE, in the browser, before any write. We use the
// Web Crypto SHA-256 of a UTF-8 payload; the pre-image (the real details) stays entirely
// off-chain. Same input → same hash, so a node/org can be looked up again from its details.
// NOTE: this is a plain digest, not an HMAC. The contract's "commission_hash" etc. are HMACs
// with an off-chain key held by the operator; those keyed anchors are computed by the operator's
// off-chain service, not the browser. For onboarding refs (instance_hash / org_ref) a salted
// digest is sufficient and keeps the pre-image private. We prepend a domain tag + optional salt.
export async function hashRef(
  payload: Record<string, unknown> | string,
  domain = "vrx",
  salt = ""
): Promise<string> {
  const text = typeof payload === "string" ? payload : stableStringify(payload);
  const input = `${domain}|${salt}|${text}`;
  const bytes = new TextEncoder().encode(input);
  // Web Crypto (crypto.subtle) only exists in a SECURE CONTEXT — HTTPS or localhost. Over plain
  // http://<LAN-IP> (e.g. a phone hitting the dev box) it is undefined and.digest throws an
  // opaque "reading 'digest' of undefined". Fail with an explained, actionable error instead.
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "This page must be opened over HTTPS or on localhost. Secure browser crypto is unavailable " +
        "over a plain http:// address (e.g. a phone using the computer's IP), so unit references " +
        "can't be computed. Use the https:// address for the portal."
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Deterministic JSON — sorted keys so the same details always hash identically.
function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(obj, keys);
}

// ── Onboarding write args ───────────────────────────────────────────
// register_node(node_id, instance_hash) / register_org(org_id, org_ref) are OWNER-ONLY.
// The account id is a NEUTRAL on-chain name chosen by the operator; the hash is the
// opaque ref to the off-chain node/org profile. These builders just shape the args — the
// actual signed send goes through useWallet.callFunction.
export type OnboardArgs = { id: string; ref: string };

export const registerNodeArgs = ({ id, ref }: OnboardArgs) => ({
  method: "register_node",
  args: { node_id: id, instance_hash: ref },
});

export const registerOrgArgs = ({ id, ref }: OnboardArgs) => ({
  method: "register_org",
  args: { org_id: id, org_ref: ref },
});

// ── Access + agents ────────────────────────────────────────────────────────────────
// The two setup steps the reservation flow needs but left un-UI'd:
// grant_gate(org_id, scope[]) [Developer-signed] — a Developer (Node) grants an Agency (Org)
// access to a set of opaque unit-scope hashes.
// register_peer(peer_id, agent_ref) [Agency-signed] — an Agency (Org) registers an Agent (Peer).
// VOCAB (see vrx-vocab-translation memory): Node=Developer, Org=Agency, Peer=Agent, gate=access,
// PRIVACY: scope entries are opaque unit-scope hashes (same hashRef the unit_key uses, so an
// agency's access can be expressed without a plaintext unit registry on-chain). agent_ref is the
// opaque digest of the agent's off-chain profile. open_claim only checks the gate is ACTIVE (not the
// scope contents) — scope is the finer-grained access surface for can_access, kept for correctness.

export const grantGateArgs = (agencyId: string, scope: string[]) => ({
  method: "grant_gate",
  args: { org_id: agencyId, scope },
});
export const revokeGateArgs = (agencyId: string) => ({
  method: "revoke_gate",
  args: { org_id: agencyId },
});
export const registerPeerArgs = (agentId: string, agentRef: string) => ({
  method: "register_peer",
  args: { peer_id: agentId, agent_ref: agentRef },
});
export const deactivatePeerArgs = (agentId: string) => ({
  method: "deactivate_peer",
  args: { peer_id: agentId },
});

// ── Reservation flow: tiles + claims ──────────────────────────────────────────────
// The core primitive: a Node stamps a tile OPEN → an agent (Peer, through an active Gate) opens a
// claim → the Node replies (ok/no/alt) → the Node confirms (deposit paid). This is view→book→
// reserve, on-chain. Confirm is NODE-signed, not peer-signed (else E23 CLAIM_NODE_MISMATCH).
// PRIVACY: unit_key / request_id are opaque; request_hash / response_hash / integrity_hash are
// off-chain HMAC/encrypted blobs. The portal hashes real details before sending — see hashRef.
// Tile status: 0 open · 1 hold · 2 closed · 3 done. Claim status: 0 open · 1 ok · 2 no · 3 alt.

// Terse serde-pinned wire shapes — these are what the views return, NOT the Rust names.
export type TileWire = {
  k: string; // unit_key (opaque)
  n: string; // node (seller)
  s: number; // status 0..3
  t: number; // stamped_at (ns)
  b: string; // stamped_by
  h: string; // integrity_hash
};

export type ClaimWire = {
  r: string; // request_id (opaque)
  k: string; // unit_key
  n: string; // node
  o: string; // org
  p: string; // peer (agent)
  s: number; // status 0..3
  tc: number; // created_at (ns)
  tu: number; // updated_at (ns)
  hq: string; // request_hash
  hr: string; // response_hash
};

export const TILE_STATUS = ["open", "hold", "closed", "done"] as const;
export const CLAIM_STATUS = ["open", "accepted", "declined", "alternative"] as const;

// Off-chain open-request TTL (gap logged) — a PORTAL-SIDE COURTESY, not chain enforcement.
// An open booking request (claim status 0) has no on-chain expiry: the contract keeps it open forever
// (the hold_expiry auto-release applies only to an ACCEPTED hold, tile status 1, not to an open
// request). So a request nobody answered sits open indefinitely. Until the contract gains a real request
// TTL + permissionless crank (owed in the contract session, alongside claim-cleanup — mirror the
// pattern), we expire stale OPEN requests HERE: the queue shows them as "lapsed" and won't let a developer
// act on one. IMPORTANT: this is display-only — the underlying on-chain Claim still exists (the ledger
// hole is closed only by the on-chain crank). We label it plainly so nobody mistakes it for chain truth.
export const OPEN_REQUEST_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/** ns → ms. Claim timestamps (tc/tu) are nanoseconds. */
export const nsToMs = (ns: number): number => Math.floor(ns / 1_000_000);

/** True if an OPEN request (status 0) has passed the off-chain TTL and should read as lapsed in the UI.
 * Only open claims lapse — an accepted/declined/alternative claim is a settled outcome, never "stale". */
export function isRequestLapsed(claim: ClaimWire | null | undefined, now: number = Date.now()): boolean {
  if (!claim || claim.s !== 0) return false;
  return now - nsToMs(claim.tc) > OPEN_REQUEST_TTL_MS;
}

/**
 * The live CLOCK for an OPEN booking request — age + time left before it lapses, for the UX countdown
 * (: "before it's lapsed do we have a countdown/age?"). Returns null for a non-open claim (settled
 * outcomes have no clock). `urgent` trips in the last 30 minutes so the UI can turn amber before the cliff.
 * Pure + `now`-injectable so a 1s ticker can re-render it. (The business-hours-aware version is a future
 * sub-arc — this one is plain wall-clock against OPEN_REQUEST_TTL_MS.)
 */
export function requestClock(
  claim: ClaimWire | null | undefined,
  now: number = Date.now()
): { ageMs: number; leftMs: number; lapsed: boolean; urgent: boolean } | null {
  if (!claim || claim.s !== 0) return null;
  const ageMs = Math.max(0, now - nsToMs(claim.tc));
  const leftMs = OPEN_REQUEST_TTL_MS - ageMs;
  return { ageMs, leftMs, lapsed: leftMs <= 0, urgent: leftMs > 0 && leftMs <= 30 * 60 * 1000 };
}

/** Humanise a positive ms duration as a compact "1h 26m" / "8m" / "45s". Floors to whole units. */
export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export const getTile = (unitKey: string) =>
  view<TileWire | null>("get_tile", { unit_key: unitKey });
export const getClaim = (requestId: string) =>
  view<ClaimWire | null>("get_claim", { request_id: requestId });
export const getPendingClaims = (nodeId: string) =>
  view<string[]>("get_pending_claims", { node_id: nodeId });

// required_deposit(caller, est_bytes) -> U128 string. Non-exempt writers must attach storage + toll;
// exempt callers (owner + labelled exempt map) get 0. We over-estimate est_bytes generously so
// the deposit always covers the write; the contract refunds any excess.
export const requiredDeposit = (caller: string, estBytes: number) =>
  view<string>("required_deposit", { caller, est_bytes: estBytes });

/**
 * Deposit to attach for a non-exempt writer. Asks the contract what it needs (storage + toll) via
 * required_deposit, over-estimating est_bytes so the write always covers itself; excess is refunded
 * on-chain. Owner/exempt callers get "0" back. Falls back to a safe flat 0.02 NEAR if the view is
 * unavailable (older deploy), which the contract will still refund down to the real cost.
 *
 * ⚠️ est_bytes MUST comfortably exceed the ACTUAL bytes the write adds. `required_deposit` is only an
 * ESTIMATE (est_bytes × storage_cost + toll), but the contract's `charge` asserts against the REAL
 * storage delta measured at runtime (lib.rs:650-656). If est_bytes is too low, the browser attaches
 * less than charge demands → the tx reverts with E57 INSUFFICIENT_DEPOSIT. `open_claim` stores a
 * whole Claim (two 64-char hex hashes + 3 account ids + a queue insert) — well over 512B. So the
 * default is generous (2048); excess is refunded on-chain, so over-estimating is free. (512 was
 * too small and reverted the first live open_claim.)
 */
export async function depositFor(caller: string, estBytes = 2048): Promise<string> {
  try {
    return await requiredDeposit(caller, estBytes);
  } catch {
    return "20000000000000000000000"; // 0.02 NEAR safety net; contract refunds the excess
  }
}

// Arg builders — mirror the contract signatures exactly (contract/src/lib.rs read).
export const stampTileArgs = (unitKey: string, status: number, integrityHash: string) => ({
  method: "stamp_tile",
  args: { unit_key: unitKey, status, integrity_hash: integrityHash },
});

// Batch stamp — stamp_tiles(stamps: Vec<(unit_key, status, integrity_hash)>). ONE wallet
// approval + ONE toll for the whole batch, instead of N single stamps. Contract HARD-CAPS the batch
// at 50 (over → E12 TOO_MANY_STAMPS, lib.rs:926), so the UI must chunk large selections into ≤50.
// The Rust tuple serializes as a JSON ARRAY [key, status, hash] — not an object.
export const STAMP_BATCH_MAX = 50;
export type StampTuple = [string, number, string];
export const stampTilesArgs = (stamps: StampTuple[]) => ({
  method: "stamp_tiles",
  args: { stamps },
});

// Read many tiles WITHOUT hammering the RPC — chunk the get_tile calls so 500 units don't fire 500
// parallel requests (the public endpoint rate-limits). `onTile` streams each result as it lands so the
// flow through onTile. chunk=25 keeps it snappy without a request storm.
export async function readTiles(
  unitKeys: { id: string; key: string }[],
  onTile: (id: string, status: number) => void,
  chunk = 12
): Promise<void> {
  // Each read is bounded by a timeout AND its own catch, so a hung/rate-limited RPC call can NEVER stall
  // the whole loop (the "reading chain… 125/216 stuck" bug: the public endpoint rate-limits after a
  // burst and the pending fetches never resolved → await Promise.all parked forever). A timed-out or
  // errored read reports -1 (treated as "not listed") and the loop moves on. Smaller chunks + a small gap
  // between them keep us under the rate limiter. A settled (not rejected) join means one bad chunk can't
  // abort the rest.
  for (let i = 0; i < unitKeys.length; i += chunk) {
    const slice = unitKeys.slice(i, i + chunk);
    await Promise.allSettled(
      slice.map(async ({ id, key }) => {
        const s = await readTileStatus(key);
        onTile(id, s);
      })
    );
    if (i + chunk < unitKeys.length) await sleep(120); // breathe between chunks (rate-limit friendly)
  }
}

// One tile read, bounded: whichever of {the get_tile, a timeout} settles first wins. Never throws.
async function readTileStatus(key: string, timeoutMs = 6000): Promise<number> {
  try {
    const tile = await Promise.race([
      getTile(key),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return tile ? tile.s : -1;
  } catch {
    return -1;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reject `p` if it hasn't settled within `ms` — bounds a single (possibly hung) RPC attempt. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("rpc_timeout")), ms)),
  ]);
}
export const openClaimArgs = (
  requestId: string,
  unitKey: string,
  nodeId: string,
  requestHash: string
) => ({
  method: "open_claim",
  args: { request_id: requestId, unit_key: unitKey, node_id: nodeId, request_hash: requestHash },
});
export const replyClaimArgs = (
  requestId: string,
  status: number,
  responseHash: string,
  tileHash: string
) => ({
  method: "reply_claim",
  args: { request_id: requestId, status, response_hash: responseHash, tile_hash: tileHash },
});
export const confirmClaimArgs = (requestId: string, integrityHash: string) => ({
  method: "confirm_claim",
  args: { request_id: requestId, integrity_hash: integrityHash },
});

// ── Exclusive hold ────────────────────────────────────────────────────────────
// A Developer (Node) can give ONE Agency (Org) the SOLE right to book a unit for a bounded window
// ("solo / exhibition mode"): every other agency is blocked from that unit + sees it as held, and it
// auto-reverts to the shared pool at expiry. Contract methods (contract/src/lib.rs V6):
// grant_exclusive(unit_key, org_id, window_ns) [Developer-signed, #[payable]] — requires the
// tile exists + belongs to caller + is OPEN (status 0), and the agency has an ACTIVE gate here.
// Re-granting on a unit with a live exclusive REPLACES it (re-assign / extend). window_ns = the
// duration from NOW in nanoseconds.
// release_exclusive(unit_key) [Developer-signed, #[payable]] — end early; must
// be the granting node.
// release_exclusive_if_expired(unit_key) -> bool permissionless crank (frees an expired exclusive).
// get_exclusive(unit_key) -> Option<Exclusive> view — the ONLY place the holder id surfaces.
// KEY DESIGN (don't lose it): the exclusive does NOT set tile.status — the tile stays OPEN so the
// HOLDER can still book it; this sidecar is the sole gate. So "held for another agency" in the UI comes
// from get_exclusive, NEVER from the tile status. PRIVACY: the holder org id lives only in
// get_exclusive; the window (`until`) is deliberately NOT emitted in events.

// Terse serde-pinned wire shape — what get_exclusive returns (Exclusive struct, lib.rs).
export type ExclusiveWire = {
  o: string; // org (the agency that holds the exclusive)
  u: number; // until — expiry timestamp in ns; auto-releases at/after this
  b: string; // by — the developer (node) who granted it
};

export const getExclusive = (unitKey: string) =>
  view<ExclusiveWire | null>("get_exclusive", { unit_key: unitKey });

export const grantExclusiveArgs = (unitKey: string, orgId: string, windowNs: number) => ({
  method: "grant_exclusive",
  // window_ns is a RAW u64 on the contract (not near_sdk::json_types::U64), so near-sdk deserializes
  // it from a JSON NUMBER only — a quoted string panics ("invalid type: string, expected u64").
  // A JS number is exact up to 2^53 ns ≈ 104 days, which comfortably covers exhibition windows;
  // daysToWindowNs enforces that ceiling.
  args: { unit_key: unitKey, org_id: orgId, window_ns: windowNs },
});
export const releaseExclusiveArgs = (unitKey: string) => ({
  method: "release_exclusive",
  args: { unit_key: unitKey },
});

// A live exclusive = one that exists AND hasn't expired. get_exclusive can return a stale (past-until)
// record the chain hasn't cranked yet; the contract treats a past `until` as no-exclusive (open_claim
// clears it lazily), so the UI must too. Returns the holder org id if live, else null.
export function liveHolder(ex: ExclusiveWire | null): string | null {
  if (!ex) return null;
  // `until` is ns since epoch; Date.now is ms. Guard against a 0/absent until.
  if (!ex.u || ex.u / 1e6 <= Date.now()) return null;
  return ex.o;
}

const NS_PER_DAY = 86_400_000_000_000; // 24*60*60*1e9
// 2^53 ns ≈ 104.25 days — the largest window that survives as an exact JS number. The contract takes
// a raw u64 (JSON number), so we cap here rather than risk a float-rounded value silently drifting.
const MAX_WINDOW_DAYS = 100;
/** Convert a whole-day duration to the u64 nanosecond window the contract expects (a JS number). */
export function daysToWindowNs(days: number): number {
  const d = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.round(days)));
  return d * NS_PER_DAY;
}
/** The end-date a `days`-long window opened NOW would expire on (for display). */
export function windowEndDate(days: number): Date {
  return new Date(Date.now() + Math.max(1, Math.round(days)) * 86_400_000);
}
/** Format an ns-since-epoch expiry (from get_exclusive `until`) as a local date string. */
export function fmtUntil(untilNs: number): string {
  return new Date(untilNs / 1e6).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
