use near_sdk::collections::{UnorderedMap, UnorderedSet};
use near_sdk::{env, near, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};

// ── Panic codes ───────────────────────────────────────────────────────────────
// Named aliases for the on-chain panic codes. The *string values are frozen* as the
// original `E##` codes: they are the public error contract (asserted by the test suite,
// surfaced to off-chain consumers). Renaming here is source-only readability — the
// emitted message is unchanged. Add new codes at the end; never repurpose an existing one.
mod err {
    // init / state
    pub const ALREADY_INIT: &str = "E0";        // new(): state already exists
    // registration
    pub const NODE_EXISTS: &str = "E1";         // rno: node already registered
    pub const ORG_EXISTS: &str = "E2";          // rog: org already registered
    pub const NOT_ORG: &str = "E3";             // rpe: caller is not a registered org
    pub const PEER_EXISTS: &str = "E4";         // rpe: peer already registered
    pub const PEER_NOT_FOUND: &str = "E5";      // dpe: peer does not exist
    pub const NOT_PEERS_ORG: &str = "E6";       // dpe: caller is not the peer's org
    pub const NOT_NODE: &str = "E7";            // caller is not a registered node
    pub const ORG_NOT_FOUND: &str = "E8";       // cax: target org does not exist
    pub const GATE_NOT_FOUND: &str = "E9";      // rax/uax: gate does not exist
    pub const NOT_GATES_NODE: &str = "E10";     // rax/uax: caller is not the gate's node
    // tiles
    pub const BAD_TILE_STATUS: &str = "E11";    // pin/pins: status out of range (>3)
    pub const TOO_MANY_STAMPS: &str = "E12";    // pins: over the 50-stamp cap
    // claims
    pub const NOT_PEER: &str = "E13";           // req/qrp: caller is not a registered peer
    pub const PEER_INACTIVE: &str = "E14";      // req/qrp: caller peer is deactivated
    pub const NO_GATE: &str = "E15";            // req/qrp: no gate for this org→node
    pub const GATE_INACTIVE: &str = "E16";      // req/qrp: gate is revoked
    pub const TILE_NOT_FOUND: &str = "E17";     // tile key does not exist
    pub const TILE_NOT_OPEN: &str = "E18";      // req/qrp: tile is not status=open
    pub const TILE_NODE_MISMATCH: &str = "E19"; // req/qrp: tile belongs to a different node
    pub const REQUEST_EXISTS: &str = "E20";     // req/qrp: duplicate request id
    pub const BAD_REPLY_STATUS: &str = "E21";   // rep: status not in 1..=3
    pub const CLAIM_NOT_FOUND: &str = "E22";    // rep/ack: claim does not exist
    pub const CLAIM_NODE_MISMATCH: &str = "E23";// rep/ack: caller is not the claim's node
    pub const CLAIM_NOT_OPEN: &str = "E24";     // rep: claim is not status=open
    pub const CLAIM_NOT_ACCEPTED: &str = "E25"; // ack: claim is not status=accepted
    pub const TILE_NODE_MISMATCH_FIN: &str = "E26"; // fin: tile belongs to a different node
    // owner admin
    pub const NOT_OWNER: &str = "E27";          // xno/xog: caller is not the contract owner
    pub const NODE_NOT_FOUND: &str = "E28";     // xno: node does not exist
    pub const ORG_NOT_FOUND_ADMIN: &str = "E29";// xog: org does not exist
    // booking passes
    pub const NOT_OWNER_MINT: &str = "E40";     // mnt: caller is not the contract owner
    pub const BAD_MINT_COUNT: &str = "E41";     // mnt: count not in 1..=100
    pub const RECIPIENT_NOT_PEER: &str = "E42"; // mnt: recipient is not a registered peer
    pub const RECIPIENT_INACTIVE: &str = "E43"; // mnt: recipient peer is deactivated
    pub const PASS_NOT_FOUND: &str = "E44";     // qrp: pass does not exist
    pub const PASS_NOT_OWNED: &str = "E45";     // qrp: pass not owned by caller
    pub const PASS_BURNED: &str = "E46";        // qrp: pass already burned
    // migrations
    pub const NO_V0_STATE: &str = "E50";        // migrate: state is not V0 layout
    pub const NO_V1_STATE: &str = "E51";        // migrate2: state is not V1 layout
    pub const NO_V2_STATE: &str = "E52";        // migrate3: state is not V2 layout
    pub const NO_V3_STATE: &str = "E53";        // migrate4: state is not V3 layout
    // commission agreements
    pub const AGREEMENT_NOT_FOUND: &str = "E54"; // revoke_agreement: no agreement for this node→org
    pub const NOT_AGREEMENTS_NODE: &str = "E55";// revoke_agreement: caller is not the agreement's node
    // protocol usage fee (V5)
    pub const NO_V4_STATE: &str = "E56";        // migrate5: state is not V4 layout
    pub const INSUFFICIENT_DEPOSIT: &str = "E57"; // #[payable] writer: attached_deposit < storage_cost (+ toll)
    // rebirth
    pub const NOT_OWNER_REBIRTH: &str = "E60";  // rebirth: caller is not the contract owner
    pub const PASS_NOT_FOUND_REBIRTH: &str = "E61"; // rebirth: pass does not exist
    pub const PASS_NOT_BURNED: &str = "E62";    // rebirth: pass is not burned
    pub const PASS_ALREADY_REBORN: &str = "E63";// rebirth: pass already has a rebirth
    // exclusive hold
    pub const EXCLUSIVE_HELD: &str = "E58";      // open_claim: unit is under a live exclusive held by another org
    pub const EXCLUSIVE_TILE_BUSY: &str = "E59"; // grant_exclusive: unit isn't open (a live claim-hold / closed / done)
    pub const NO_V5_STATE: &str = "E64";         // migrate6: state is not V5 layout
    // vetting / sign-off attestation
    pub const NO_V6_STATE: &str = "E65";         // migrate7: state is not V6 layout
    pub const ATTESTATION_NOT_FOUND: &str = "E66"; // ratify_attestation: no attestation for this node→building
    pub const CLAIM_NOT_TERMINAL: &str = "E67";  // cleanup_claim: claim is still live (status 0/1), not cleanable
}

// ── Events (NEP-297) ────────────────────────────────────────────────────────────
// Structured logs so indexers/off-chain services can follow state changes without
// polling every view. Emitted as a single `EVENT_JSON:{...}` log line per NEP-297.
// PRIVACY: events carry ONLY data that is already on-chain — opaque ids, opaque
// keys/hashes, account ids, and status codes. NEVER PII, amounts, or deal terms. A hold
// event is fine (a hold is not a leak); we never emit payment/sale/milestone data.
// The event vocabulary is deliberately generic (node/org/peer/scope/tile/claim/pass) so
// it stays domain-agnostic. Add variants at the end; don't repurpose existing ones.
const EVENT_STANDARD: &str = "vrx";
const EVENT_VERSION: &str = "1.0.0";

/// Default unpaid-hold window: 2 hours, in nanoseconds (block_timestamp unit).
/// Owner-configurable at runtime via `set_hold_window` → stored in `Contract.hold_window_ns`.
/// This is the ONLY time knob on-chain; office-hours/timezone policy stays off-chain.
const DEFAULT_HOLD_WINDOW_NS: u64 = 2 * 60 * 60 * 1_000_000_000;

/// Default per-call usage toll (V5): 0.001 NEAR = 1e21 yoctoNEAR (~half a US cent at NEAR ≈ $3–5).
/// Owner-configurable at runtime via `set_toll`; seeded here by `new` and `migrate5`. NOT a
/// price oracle — the owner nudges it as the NEAR price drifts (kept near half a cent).
/// Charged ONLY to non-exempt callers, on top of the storage they create.
const DEFAULT_TOLL_YOCTO: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR
// Exempt-tier labels (V5), metadata only — the toll is waived identically regardless of tier.
// `add_exempt` accepts any u8; these are documented rather than enforced.

#[near(serializers = [json])]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub enum Event {
    /// A node (seller) registered. `node` = account id.
    NodeRegistered { node: AccountId },
    /// An org (agency) registered.
    OrgRegistered { org: AccountId },
    /// A peer (agent) was registered under an org.
    PeerRegistered { org: AccountId, peer: AccountId },
    /// A peer was deactivated by its org.
    PeerDeactivated { peer: AccountId },
    /// A node granted an org access to a set of opaque scope hashes.
    GateGranted { node: AccountId, org: AccountId },
    /// A node revoked an org's gate.
    GateRevoked { node: AccountId, org: AccountId },
    /// A tile was stamped. `key` = opaque unit key, `status` = 0..=3.
    TileStamped { node: AccountId, key: String, status: u8 },
    /// A claim was opened (approval path). `id` = opaque request id.
    ClaimOpened { id: String, node: AccountId },
    /// A claim received a reply. `status` = 1=ok 2=no 3=alt.
    ClaimReplied { id: String, status: u8 },
    /// Booking passes minted to an agent. `ids` = new token ids.
    PassesMinted { to: AccountId, ids: Vec<u64> },
    /// A pass was burned to open an instant hold (token path). `id` = pass token id.
    PassBurned { id: u64, key: String, request: String },
    /// A burned pass was reborn as a fresh pass.
    PassReborn { old_id: u64, new_id: u64 },
    /// An expired hold was released → tile back to open. `key` = opaque unit key.
    HoldReleased { node: AccountId, key: String },
    /// The owner changed the unpaid-hold window. `ns` = new window in nanoseconds.
    HoldWindowSet { ns: u64 },
    /// A state migration ran. `from`/`to` = state schema versions.
    Migrate { from: u8, to: u8 },
    /// A commission agreement was set/amended. `version` bumps on each amend.
    /// PRIVACY: carries ids + version ONLY — never the rate/tiers/amounts (those
    /// live in the off-chain rulebook the on-chain `commission_hash` merely anchors).
    AgreementSet { node: AccountId, org: AccountId, version: u32 },
    /// A commission agreement was revoked. Ids only, no amounts.
    AgreementRevoked { node: AccountId, org: AccountId },
    /// The protocol usage fee (V5). These ARE money-adjacent and deliberately auditable:
    /// a partner can verify their exempt status on-chain, and toll/treasury changes are public.
    /// `tier` is the exempt label (0=us, 1=partner). `yocto` is the flat toll — NOT deal value, so
    /// the moat is untouched (a flat fee reveals nothing about any specific deal). `treasury` is
    /// a public account id by nature (funds must land somewhere addressable).
    ExemptAdded { account: AccountId, tier: u8 },
    ExemptRemoved { account: AccountId },
    TollSet { yocto: near_sdk::json_types::U128 },
    TreasurySet { treasury: AccountId },
    /// A temporary exclusive hold was granted over a unit. `key` = opaque unit key,
    /// `org` = the agency that now holds the sole right to book it. PRIVACY: ids + key only —
    /// the window (`until`) is deliberately NOT emitted (a timestamp is avoidable metadata leak);
    /// observers learn only THAT a unit is exclusively held and by whom, never for how long.
    ExclusiveGranted { node: AccountId, key: String, org: AccountId },
    /// A temporary exclusive hold ended — early release by the node, or auto-release at expiry.
    ExclusiveReleased { node: AccountId, key: String },
    /// A vetting/sign-off attestation was set/amended. `version` bumps on each re-attest.
    /// PRIVACY: carries node + opaque building scope hash + kind + version ONLY — NEVER the
    /// `seal_hash` (the salted baseline seal it anchors), nor any slate/term/PII. We prove only THAT
    /// an approver attested a sealed record of this kind, and who/when/which-version — the sealed
    /// content stays off-chain, exactly like the Agreement commission anchor.
    AttestationSet { node: AccountId, building: String, kind: u8, version: u32 },
    /// The owner (VRX) ratified a developer's attestation on-chain ( #3). Ids + building only —
    /// this is the independently-provable "VRX agreed" stamp (can't be forged: owner-key-gated).
    AttestationRatified { node: AccountId, building: String },
    /// A terminal claim was cleaned up and its storage deposit refunded to the node.
    /// `id` = opaque request id. No amounts/terms — pure lifecycle hygiene.
    ClaimCleaned { id: String, node: AccountId },
}

impl Event {
    /// Emit as a NEP-297 `EVENT_JSON` log line.
    pub fn emit(&self) {
        // {"standard":"vrx","version":"1.0.0","event":"...","data":{...}}
        let payload = near_sdk::serde_json::json!({
            "standard": EVENT_STANDARD,
            "version": EVENT_VERSION,
        });
        // Merge the event tag+data (self serializes to {"event":..,"data":..}) with the
        // standard/version envelope.
        let mut obj = payload;
        let ev = near_sdk::serde_json::to_value(self).unwrap();
        if let (Some(map), Some(evmap)) = (obj.as_object_mut(), ev.as_object()) {
            for (k, v) in evmap { map.insert(k.clone(), v.clone()); }
        }
        env::log_str(&format!("EVENT_JSON:{}", obj));
    }
}

#[derive(BorshStorageKey, BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub enum SK {
    N, O, P, G, T, C, Q, QS { h: Vec<u8> },
    // BookingPass — added at end so existing storage keys are unchanged
    Pa,                          // passes by id
    PO,                          // pass_owner_idx (owner -> set of token_ids)
    POS { h: Vec<u8> },          // inner set per owner
    PL,                          // pass_links (rebirth lineage sidecar)
    // ── V3: hold-expiry sidecar. Added at end — existing keys unchanged. ──
    HE,                          // hold_expiry (unit_key -> expiry ts ns)
    // ── V4: commission agreements. Added at end — existing keys unchanged. ──
    Ag,                          // agreements ("{node}:{org}" -> Agreement)
    // ── V5 (protocol fee): exempt caller list. Added at end — existing keys unchanged. ──
    Ex,                          // exempt (AccountId -> tier: 0=us, 1=partner)
    // ── V6: exclusive-hold sidecar. Added at end — existing keys unchanged. ──
    Xc,                          // exclusives (unit_key -> Exclusive)
    // ── V7: vetting/sign-off attestations. Added at end — existing keys unchanged. ──
    At,                          // attestations ("{node}:{building_hash}" -> Attestation)
}

/// Seller / operator node.
/// NOTE on field names: the readable names below are source-only. Each field pins its
/// JSON key to the original 1-char name via `#[serde(rename)]`, so the view API (gno etc.)
/// and every off-chain consumer see the SAME wire shape as before. Borsh is order-based and
/// ignores names entirely — so storage layout is byte-identical too. Never reorder fields.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Node {
    pub id: AccountId,
    #[serde(rename = "h")] pub instance_hash: String,
    #[serde(rename = "t")] pub registered_at: u64,
    #[serde(rename = "a")] pub active: bool,
}

/// Agency / org
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Org {
    pub id: AccountId,
    #[serde(rename = "r")] pub org_ref: String, // opaque HMAC of internal agency id
    #[serde(rename = "t")] pub registered_at: u64,
    #[serde(rename = "a")] pub active: bool,
}

/// Agent / peer
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Peer {
    pub id: AccountId,
    #[serde(rename = "g")] pub org: AccountId, // org (agency) account this agent belongs to
    #[serde(rename = "r")] pub agent_ref: String, // opaque agent ref
    #[serde(rename = "t")] pub registered_at: u64,
    #[serde(rename = "a")] pub active: bool,
}

/// Access grant / gate. Grants an org access to a set of opaque scope hashes under a node.
/// `allowed_scope` was "building hashes" in the real-estate origin; the contract is
/// domain-agnostic (the hashes are opaque), so the name is generic. JSON key stays "b".
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Gate {
    #[serde(rename = "n")] pub node: AccountId, // node (seller)
    #[serde(rename = "o")] pub org: AccountId, // org (agency)
    #[serde(rename = "b")] pub allowed_scope: Vec<String>, // allowed opaque scope hashes
    #[serde(rename = "t")] pub granted_at: u64,
    #[serde(rename = "a")] pub active: bool,
}

/// Unit stamp / tile — status: 0=open 1=hold 2=closed 3=done
///
/// On-chain hold expiry is NOT a field here: appending a field to a struct stored as a
/// VALUE inside an UnorderedMap breaks borsh (old entries lack the trailing bytes → EOF on
/// read; migrate can't fix values it doesn't eagerly rewrite). So expiry lives in a sidecar map
/// `hold_expiry` keyed by unit_key — the same borsh-safe pattern the contract already uses for
/// `pass_links`. Absent entry = no active timed hold. Reveals only "held for now".
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Tile {
    #[serde(rename = "k")] pub unit_key: String, // opaque key (hashed unit ref)
    #[serde(rename = "n")] pub node: AccountId, // node (seller)
    #[serde(rename = "s")] pub status: u8, // 0=open 1=hold 2=closed 3=done
    #[serde(rename = "t")] pub stamped_at: u64,
    #[serde(rename = "b")] pub stamped_by: AccountId,
    #[serde(rename = "h")] pub integrity_hash: String,
}

/// BookingPass NFT — prepaid booking slot, non-transferable, no expiry.
/// Status implied by tb: None=active, Some(_)=burned.
/// Lineage (rebirth links) lives in a sidecar map to avoid breaking borsh layout.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Pass {
    pub id: u64,                                              // sequential token_id
    #[serde(rename = "o")] pub owner: AccountId, // current owner (= original recipient; v1 non-transferable)
    #[serde(rename = "mb")] pub minted_by: AccountId, // contract owner who minted it
    #[serde(rename = "tm")] pub minted_at: u64,
    #[serde(rename = "tb")] pub burned_at: Option<u64>, // None = active
    #[serde(rename = "bk")] pub burned_for_unit_key: Option<String>, // tile key it was spent on
    #[serde(rename = "br")] pub burned_for_request_id: Option<String>, // claim id it was spent on
}

/// Sidecar lineage record. Absent = no lineage (neither reborn nor a rebirth).
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct PassLink {
    #[serde(rename = "pi")] pub previous_id: Option<u64>, // set when this pass is a rebirth
    #[serde(rename = "ri")] pub rebirth_id: Option<u64>, // set on burned pass after rebirth issues replacement
}

/// Booking claim — status: 0=open 1=ok 2=no 3=alt
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Claim {
    #[serde(rename = "r")] pub request_id: String, // opaque request id
    #[serde(rename = "k")] pub unit_key: String, // opaque unit key (tile key)
    #[serde(rename = "n")] pub node: AccountId, // node (seller)
    #[serde(rename = "o")] pub org: AccountId, // org (agency)
    #[serde(rename = "p")] pub peer: AccountId, // peer (agent)
    #[serde(rename = "s")] pub status: u8, // 0=open 1=ok 2=no 3=alt 4=confirmed (V7)
    #[serde(rename = "tc")] pub created_at: u64,
    #[serde(rename = "tu")] pub updated_at: u64,
    #[serde(rename = "hq")] pub request_hash: String, // encrypted blob or HMAC (opaque terms)
    #[serde(rename = "hr")] pub response_hash: String,
}

/// Commission / agency-agreement record. Keyed "{node}:{org}" — the SAME
/// key format `Gate` uses, so an org↔node relationship has two parallel on-chain records under one
/// key: `Gate` (access scope) + `Agreement` (commission). Scope is commission ONLY: booth/
/// marketing/equipment side-deals are out — they have no reservation dimension, so parties sign
/// them off-chain like any other contract. Hence no `kind` discriminator; one Agreement per pair.
///
/// PRIVACY: holds ONLY an opaque HMAC anchor of the off-chain commission rulebook. The
/// actual %/tiers/splits/amounts NEVER appear on-chain — we prove only THAT a rulebook exists and
/// hasn't been tampered with, plus who/when/which-version. Money compute + owed→paid tracking stay
/// off-chain ( Option A, anchor-only). KYC/vetting is an off-chain precondition (done at
/// register_org-time), never re-checked here and never on-chain (PII → forbids it).
///
/// Field names are source-only readability; each pins its short JSON key via `#[serde(rename)]`
/// so the view API wire shape is frozen. Borsh is order-based — never reorder these fields.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Agreement {
    #[serde(rename = "n")] pub node: AccountId, // node (seller / developer) — the payer
    #[serde(rename = "o")] pub org: AccountId, // org (agency) — the payee
    #[serde(rename = "hc")] pub commission_hash: String, // HMAC of the off-chain commission rulebook (the anchor)
    #[serde(rename = "v")] pub version: u32, // rulebook version (1-based; bumps on each amend)
    #[serde(rename = "t")] pub agreed_at: u64, // when this version was set (ns)
    #[serde(rename = "a")] pub active: bool, // revocable like a gate
}

/// Temporary exclusive hold. A node grants ONE org the sole right to book a specific
/// unit for a bounded window; every OTHER org is blocked (open_claim → EXCLUSIVE_HELD) until the
/// window lapses, at which point the unit auto-reverts to the shared pool (lazy release in
/// open_claim + a permissionless crank, mirroring the hold_expiry pattern).
///
/// KEY DESIGN (don't lose this): the exclusive does NOT set tile.status=1 — open_claim asserts
/// tile.status==0, so a held tile would block the HOLDER too. The tile stays OPEN; THIS sidecar is
/// the SOLE gate. Other orgs' "held" view comes from get_exclusive, never from tile.status.
///
/// PRIVACY: the holder id lives ONLY here (get_exclusive), never on the public Tile. Field
/// names are source-only; each pins its short JSON key so the view wire shape is frozen.
/// Borsh is order-based — never reorder these fields.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Exclusive {
    #[serde(rename = "o")] pub org: AccountId, // the agency that holds the exclusive
    #[serde(rename = "u")] pub until: u64, // expiry timestamp (ns); auto-releases at/after this
    #[serde(rename = "b")] pub by: AccountId, // the node (developer) who granted it
}

/// Vetting / sign-off attestation. Anchors an off-chain baseline on-chain so an approval is
/// independently provable rather than trust-the-server. Granularity is building-level — one
/// attestation per "{node}:{building_hash}"; per-unit tile status is unchanged.
///
/// `kind` keeps this a single generic "sealed attestation" shape. The developer records an
/// attestation (`approved_by`/`approver_role`); the owner then ratifies it
/// (`ratified_by`/`ratified_at`), an owner-key-gated stamp that cannot be forged.
///
/// PRIVACY: `seal_hash` is the ONLY content bytes and it's an opaque salted seal — never a slate,
/// term, or PII. Field names are source-only readability; each pins its short JSON key so the view
/// wire shape is frozen. Borsh is order-based — never reorder these fields.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Attestation {
    #[serde(rename = "b")] pub building_hash: String, // opaque building scope hash — same hash space as Gate scopes
    #[serde(rename = "k")] pub kind: u8, // 0 = release/sign-off (V7); 1 = version-seal (future #2)
    #[serde(rename = "s")] pub seal_hash: String, // the salted baseline seal being anchored — opaque
    #[serde(rename = "ab")] pub approved_by: AccountId, // who approved it (developer-self default; CEO/VRX via the dial)
    #[serde(rename = "ar")] pub approver_role: u8, // 0 = developer-self, 1 = VRX/CEO approver ( approver abstraction)
    #[serde(rename = "v")] pub version: u32, // 1-based; bumps on each re-attest (re-approval round)
    #[serde(rename = "t")] pub at: u64, // when this version was set (ns)
    #[serde(rename = "rb")] pub ratified_by: Option<AccountId>, // owner (VRX) ratification — None until ratified (forge-proof)
    #[serde(rename = "rt")] pub ratified_at: Option<u64>, // when ratified (ns); None until ratified
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner: AccountId,
    pub nodes: UnorderedMap<AccountId, Node>,
    pub orgs:  UnorderedMap<AccountId, Org>,
    pub peers: UnorderedMap<AccountId, Peer>,
    pub gates: UnorderedMap<String, Gate>,
    pub tiles: UnorderedMap<String, Tile>,
    pub claims: UnorderedMap<String, Claim>,
    pub queue:  UnorderedMap<AccountId, UnorderedSet<String>>,
    // ── BookingPass (added in upgrade) ────────────────────────────────────────
    pub passes: UnorderedMap<u64, Pass>,
    pub pass_owner_idx: UnorderedMap<AccountId, UnorderedSet<u64>>,
    pub next_pass_id: u64,
    // ── Rebirth lineage (added in v2) ─────────────────────────────────────────
    pub pass_links: UnorderedMap<u64, PassLink>,
    // ── V3 append: on-chain hold expiry. MUST stay last for borsh order-safety. ──
    pub hold_expiry: UnorderedMap<String, u64>, // unit_key -> hold expiry ts (ns); absent = no timed hold
    pub hold_window_ns: u64,                     // owner-configurable unpaid-hold window (ns)
    // ── V4 append: commission agreements. MUST stay last for borsh order-safety. ──
    pub agreements: UnorderedMap<String, Agreement>, // "{node}:{org}" -> Agreement; absent = none
    // ── V5 append (protocol fee): usage toll + exempt list. MUST stay last for borsh order-safety. ──
    pub toll_yocto: u128,                     // flat per-call toll (yoctoNEAR); owner-set. 0 = toll off.
    pub treasury: AccountId,                  // where swept tolls go (defaults to owner)
    pub exempt: UnorderedMap<AccountId, u8>,  // caller -> tier (0=us, 1=partner); absent = not exempt
    // ── V6 append: temporary exclusive holds. MUST stay last for borsh order-safety. ──
    pub exclusives: UnorderedMap<String, Exclusive>, // unit_key -> Exclusive; absent = no exclusive
    // ── V7 append: vetting/sign-off attestations. MUST stay last for borsh order-safety. ──
    pub attestations: UnorderedMap<String, Attestation>, // "{node}:{building_hash}" -> Attestation; absent = none
}

/// V2 contract state — pre-hold-window (before). Read by migrate3 to add the
/// configurable `hold_window_ns`. Mirrors the exact field order of the pre-V3 Contract.
#[near(serializers = [borsh])]
pub struct ContractV2 {
    pub owner: AccountId,
    pub nodes: UnorderedMap<AccountId, Node>,
    pub orgs:  UnorderedMap<AccountId, Org>,
    pub peers: UnorderedMap<AccountId, Peer>,
    pub gates: UnorderedMap<String, Gate>,
    pub tiles: UnorderedMap<String, Tile>,
    pub claims: UnorderedMap<String, Claim>,
    pub queue:  UnorderedMap<AccountId, UnorderedSet<String>>,
    pub passes: UnorderedMap<u64, Pass>,
    pub pass_owner_idx: UnorderedMap<AccountId, UnorderedSet<u64>>,
    pub next_pass_id: u64,
    pub pass_links: UnorderedMap<u64, PassLink>,
}

/// V3 contract state — pre-commissions (before). Read by migrate4 to add the `agreements`
/// map. Mirrors the exact field order of the pre-V4 Contract (through hold_window_ns).
#[near(serializers = [borsh])]
pub struct ContractV3 {
    pub owner: AccountId,
    pub nodes: UnorderedMap<AccountId, Node>,
    pub orgs:  UnorderedMap<AccountId, Org>,
    pub peers: UnorderedMap<AccountId, Peer>,
    pub gates: UnorderedMap<String, Gate>,
    pub tiles: UnorderedMap<String, Tile>,
    pub claims: UnorderedMap<String, Claim>,
    pub queue:  UnorderedMap<AccountId, UnorderedSet<String>>,
    pub passes: UnorderedMap<u64, Pass>,
    pub pass_owner_idx: UnorderedMap<AccountId, UnorderedSet<u64>>,
    pub next_pass_id: u64,
    pub pass_links: UnorderedMap<u64, PassLink>,
    pub hold_expiry: UnorderedMap<String, u64>,
    pub hold_window_ns: u64,
}

/// V4 contract state — pre-fee (before V5). Read by migrate5 to add the fee fields
/// (`toll_yocto`/`treasury`/`exempt`). Mirrors the exact field order of the pre-V5 Contract
/// (through the `agreements` map).
#[near(serializers = [borsh])]
pub struct ContractV4 {
    pub owner: AccountId,
    pub nodes: UnorderedMap<AccountId, Node>,
    pub orgs:  UnorderedMap<AccountId, Org>,
    pub peers: UnorderedMap<AccountId, Peer>,
    pub gates: UnorderedMap<String, Gate>,
    pub tiles: UnorderedMap<String, Tile>,
    pub claims: UnorderedMap<String, Claim>,
    pub queue:  UnorderedMap<AccountId, UnorderedSet<String>>,
    pub passes: UnorderedMap<u64, Pass>,
    pub pass_owner_idx: UnorderedMap<AccountId, UnorderedSet<u64>>,
    pub next_pass_id: u64,
    pub pass_links: UnorderedMap<u64, PassLink>,
    pub hold_expiry: UnorderedMap<String, u64>,
    pub hold_window_ns: u64,
    pub agreements: UnorderedMap<String, Agreement>,
}

/// V5 contract state — pre-exclusive-hold (before). Read by migrate6 to add the
/// `exclusives` map. Mirrors the exact field order of the pre-V6 Contract (through the fee fields
/// `toll_yocto`/`treasury`/`exempt`).
#[near(serializers = [borsh])]
pub struct ContractV5 {
    pub owner: AccountId,
    pub nodes: UnorderedMap<AccountId, Node>,
    pub orgs:  UnorderedMap<AccountId, Org>,
    pub peers: UnorderedMap<AccountId, Peer>,
    pub gates: UnorderedMap<String, Gate>,
    pub tiles: UnorderedMap<String, Tile>,
    pub claims: UnorderedMap<String, Claim>,
    pub queue:  UnorderedMap<AccountId, UnorderedSet<String>>,
    pub passes: UnorderedMap<u64, Pass>,
    pub pass_owner_idx: UnorderedMap<AccountId, UnorderedSet<u64>>,
    pub next_pass_id: u64,
    pub pass_links: UnorderedMap<u64, PassLink>,
    pub hold_expiry: UnorderedMap<String, u64>,
    pub hold_window_ns: u64,
    pub agreements: UnorderedMap<String, Agreement>,
    pub toll_yocto: u128,
    pub treasury: AccountId,
    pub exempt: UnorderedMap<AccountId, u8>,
}

/// V6 contract state — pre-attestation (before V7). Read by migrate7 to add the
/// `attestations` map. Mirrors the exact field order of the pre-V7 Contract (through `exclusives`).
#[near(serializers = [borsh])]
pub struct ContractV6 {
    pub owner: AccountId,
    pub nodes: UnorderedMap<AccountId, Node>,
    pub orgs:  UnorderedMap<AccountId, Org>,
    pub peers: UnorderedMap<AccountId, Peer>,
    pub gates: UnorderedMap<String, Gate>,
    pub tiles: UnorderedMap<String, Tile>,
    pub claims: UnorderedMap<String, Claim>,
    pub queue:  UnorderedMap<AccountId, UnorderedSet<String>>,
    pub passes: UnorderedMap<u64, Pass>,
    pub pass_owner_idx: UnorderedMap<AccountId, UnorderedSet<u64>>,
    pub next_pass_id: u64,
    pub pass_links: UnorderedMap<u64, PassLink>,
    pub hold_expiry: UnorderedMap<String, u64>,
    pub hold_window_ns: u64,
    pub agreements: UnorderedMap<String, Agreement>,
    pub toll_yocto: u128,
    pub treasury: AccountId,
    pub exempt: UnorderedMap<AccountId, u8>,
    pub exclusives: UnorderedMap<String, Exclusive>,
}

/// Old contract state — used only for one-time migration from pre-Pass deploy.
#[near(serializers = [borsh])]
pub struct ContractV0 {
    pub owner: AccountId,
    pub nodes: UnorderedMap<AccountId, Node>,
    pub orgs:  UnorderedMap<AccountId, Org>,
    pub peers: UnorderedMap<AccountId, Peer>,
    pub gates: UnorderedMap<String, Gate>,
    pub tiles: UnorderedMap<String, Tile>,
    pub claims: UnorderedMap<String, Claim>,
    pub queue:  UnorderedMap<AccountId, UnorderedSet<String>>,
}

/// V1 contract state — pre-rebirth. Read by migrate2 to add the pass_links sidecar.
#[near(serializers = [borsh])]
pub struct ContractV1 {
    pub owner: AccountId,
    pub nodes: UnorderedMap<AccountId, Node>,
    pub orgs:  UnorderedMap<AccountId, Org>,
    pub peers: UnorderedMap<AccountId, Peer>,
    pub gates: UnorderedMap<String, Gate>,
    pub tiles: UnorderedMap<String, Tile>,
    pub claims: UnorderedMap<String, Claim>,
    pub queue:  UnorderedMap<AccountId, UnorderedSet<String>>,
    pub passes: UnorderedMap<u64, Pass>,
    pub pass_owner_idx: UnorderedMap<AccountId, UnorderedSet<u64>>,
    pub next_pass_id: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        assert!(!env::state_exists(), "{}", err::ALREADY_INIT);
        let owner_for_treasury = owner.clone();
        Self {
            owner,
            nodes:  UnorderedMap::new(SK::N),
            orgs:   UnorderedMap::new(SK::O),
            peers:  UnorderedMap::new(SK::P),
            gates:  UnorderedMap::new(SK::G),
            tiles:  UnorderedMap::new(SK::T),
            claims: UnorderedMap::new(SK::C),
            queue:  UnorderedMap::new(SK::Q),
            passes: UnorderedMap::new(SK::Pa),
            pass_owner_idx: UnorderedMap::new(SK::PO),
            next_pass_id: 1,
            pass_links: UnorderedMap::new(SK::PL),
            hold_expiry: UnorderedMap::new(SK::HE),
            hold_window_ns: DEFAULT_HOLD_WINDOW_NS,
            agreements: UnorderedMap::new(SK::Ag),
            toll_yocto: DEFAULT_TOLL_YOCTO,
            treasury: owner_for_treasury,
            exempt: UnorderedMap::new(SK::Ex),
            exclusives: UnorderedMap::new(SK::Xc),
            attestations: UnorderedMap::new(SK::At),
        }
    }

    /// One-time migration: read pre-upgrade state and add Pass fields.
    /// OWNER-ONLY: the caller must equal the owner recorded in the pre-migration state
    /// (`v0.owner`) — closes the earlier "anyone-callable" hole. Only works if state
    /// matches V0 layout; after running once, V0 is gone (calling again fails).
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let v0: ContractV0 = env::state_read().expect(err::NO_V0_STATE);
        assert_eq!(env::predecessor_account_id(), v0.owner, "{}", err::NOT_OWNER);
        Event::Migrate { from: 0, to: 1 }.emit();
        let treasury = v0.owner.clone();
        Self {
            owner:  v0.owner,
            nodes:  v0.nodes,
            orgs:   v0.orgs,
            peers:  v0.peers,
            gates:  v0.gates,
            tiles:  v0.tiles,
            claims: v0.claims,
            queue:  v0.queue,
            passes: UnorderedMap::new(SK::Pa),
            pass_owner_idx: UnorderedMap::new(SK::PO),
            next_pass_id: 1,
            pass_links: UnorderedMap::new(SK::PL),
            hold_expiry: UnorderedMap::new(SK::HE),
            hold_window_ns: DEFAULT_HOLD_WINDOW_NS,
            agreements: UnorderedMap::new(SK::Ag),
            toll_yocto: DEFAULT_TOLL_YOCTO,
            treasury,
            exempt: UnorderedMap::new(SK::Ex),
            exclusives: UnorderedMap::new(SK::Xc),
            attestations: UnorderedMap::new(SK::At),
        }
    }

    /// V1 → V2 migration: add empty pass_links sidecar map. Pass struct is unchanged.
    /// OWNER-ONLY: caller must equal the owner recorded in the V1 state.
    #[init(ignore_state)]
    pub fn migrate2() -> Self {
        let v1: ContractV1 = env::state_read().expect(err::NO_V1_STATE);
        assert_eq!(env::predecessor_account_id(), v1.owner, "{}", err::NOT_OWNER);
        Event::Migrate { from: 1, to: 2 }.emit();
        let treasury = v1.owner.clone();
        Self {
            owner:  v1.owner,
            nodes:  v1.nodes,
            orgs:   v1.orgs,
            peers:  v1.peers,
            gates:  v1.gates,
            tiles:  v1.tiles,
            claims: v1.claims,
            queue:  v1.queue,
            passes: v1.passes,
            pass_owner_idx: v1.pass_owner_idx,
            next_pass_id: v1.next_pass_id,
            pass_links: UnorderedMap::new(SK::PL),
            hold_expiry: UnorderedMap::new(SK::HE),
            hold_window_ns: DEFAULT_HOLD_WINDOW_NS,
            agreements: UnorderedMap::new(SK::Ag),
            toll_yocto: DEFAULT_TOLL_YOCTO,
            treasury,
            exempt: UnorderedMap::new(SK::Ex),
            exclusives: UnorderedMap::new(SK::Xc),
            attestations: UnorderedMap::new(SK::At),
        }
    }

    /// V2 → V3 migration: add the hold-expiry sidecar + configurable hold window.
    /// OWNER-ONLY: caller must equal the owner recorded in the V2 state. Existing tiles are
    /// untouched (expiry is a sidecar, not a Tile field), so this is a pure additive migration.
    #[init(ignore_state)]
    pub fn migrate3() -> Self {
        let v2: ContractV2 = env::state_read().expect(err::NO_V2_STATE);
        assert_eq!(env::predecessor_account_id(), v2.owner, "{}", err::NOT_OWNER);
        Event::Migrate { from: 2, to: 3 }.emit();
        let treasury = v2.owner.clone();
        Self {
            owner:  v2.owner,
            nodes:  v2.nodes,
            orgs:   v2.orgs,
            peers:  v2.peers,
            gates:  v2.gates,
            tiles:  v2.tiles,
            claims: v2.claims,
            queue:  v2.queue,
            passes: v2.passes,
            pass_owner_idx: v2.pass_owner_idx,
            next_pass_id: v2.next_pass_id,
            pass_links: v2.pass_links,
            hold_expiry: UnorderedMap::new(SK::HE),
            hold_window_ns: DEFAULT_HOLD_WINDOW_NS,
            agreements: UnorderedMap::new(SK::Ag),
            toll_yocto: DEFAULT_TOLL_YOCTO,
            treasury,
            exempt: UnorderedMap::new(SK::Ex),
            exclusives: UnorderedMap::new(SK::Xc),
            attestations: UnorderedMap::new(SK::At),
        }
    }

    /// V3 → V4 migration: add the empty `agreements` map. Everything else carries over
    /// unchanged. OWNER-ONLY: caller must equal the owner recorded in the V3 state. Pure additive
    /// (a new top-level map — no existing record is touched), so it's borsh-safe.
    #[init(ignore_state)]
    pub fn migrate4() -> Self {
        let v3: ContractV3 = env::state_read().expect(err::NO_V3_STATE);
        assert_eq!(env::predecessor_account_id(), v3.owner, "{}", err::NOT_OWNER);
        Event::Migrate { from: 3, to: 4 }.emit();
        let treasury = v3.owner.clone();
        Self {
            owner:  v3.owner,
            nodes:  v3.nodes,
            orgs:   v3.orgs,
            peers:  v3.peers,
            gates:  v3.gates,
            tiles:  v3.tiles,
            claims: v3.claims,
            queue:  v3.queue,
            passes: v3.passes,
            pass_owner_idx: v3.pass_owner_idx,
            next_pass_id: v3.next_pass_id,
            pass_links: v3.pass_links,
            hold_expiry: v3.hold_expiry,
            hold_window_ns: v3.hold_window_ns,
            agreements: UnorderedMap::new(SK::Ag),
            toll_yocto: DEFAULT_TOLL_YOCTO,
            treasury,
            exempt: UnorderedMap::new(SK::Ex),
            exclusives: UnorderedMap::new(SK::Xc),
            attestations: UnorderedMap::new(SK::At),
        }
    }

    /// V4 → V5 migration (protocol fee): add the usage-toll fields (`toll_yocto`/`treasury`/`exempt`).
    /// Everything else carries over unchanged. OWNER-ONLY: caller must equal the owner recorded in
    /// the V4 state. Additive (a scalar, an account id, and a new top-level map — no existing record
    /// is touched), so it's borsh-safe. Seeds the default toll (0.001 NEAR) and defaults the treasury
    /// to the owner; the owner then `set_treasury`/`set_toll`/`add_exempt` to configure the fee.
    #[init(ignore_state)]
    pub fn migrate5() -> Self {
        let v4: ContractV4 = env::state_read().expect(err::NO_V4_STATE);
        assert_eq!(env::predecessor_account_id(), v4.owner, "{}", err::NOT_OWNER);
        Event::Migrate { from: 4, to: 5 }.emit();
        let treasury = v4.owner.clone();
        Self {
            owner:  v4.owner,
            nodes:  v4.nodes,
            orgs:   v4.orgs,
            peers:  v4.peers,
            gates:  v4.gates,
            tiles:  v4.tiles,
            claims: v4.claims,
            queue:  v4.queue,
            passes: v4.passes,
            pass_owner_idx: v4.pass_owner_idx,
            next_pass_id: v4.next_pass_id,
            pass_links: v4.pass_links,
            hold_expiry: v4.hold_expiry,
            hold_window_ns: v4.hold_window_ns,
            agreements: v4.agreements,
            toll_yocto: DEFAULT_TOLL_YOCTO,
            treasury,
            exempt: UnorderedMap::new(SK::Ex),
            exclusives: UnorderedMap::new(SK::Xc),
            attestations: UnorderedMap::new(SK::At),
        }
    }

    /// V5 → V6 migration: add the empty `exclusives` map. Everything else carries over
    /// unchanged. OWNER-ONLY: caller must equal the owner recorded in the V5 state. Pure additive
    /// (a new top-level map — no existing record is touched), so it's borsh-safe. Unlike migrate5,
    /// the fee fields (`toll_yocto`/`treasury`/`exempt`) are CARRIED OVER from V5, not reseeded —
    /// V5 already configured them (treasury set, exempt list populated), and reseeding would wipe
    /// them. Only the brand-new `exclusives` map is created empty.
    #[init(ignore_state)]
    pub fn migrate6() -> Self {
        let v5: ContractV5 = env::state_read().expect(err::NO_V5_STATE);
        assert_eq!(env::predecessor_account_id(), v5.owner, "{}", err::NOT_OWNER);
        Event::Migrate { from: 5, to: 6 }.emit();
        Self {
            owner:  v5.owner,
            nodes:  v5.nodes,
            orgs:   v5.orgs,
            peers:  v5.peers,
            gates:  v5.gates,
            tiles:  v5.tiles,
            claims: v5.claims,
            queue:  v5.queue,
            passes: v5.passes,
            pass_owner_idx: v5.pass_owner_idx,
            next_pass_id: v5.next_pass_id,
            pass_links: v5.pass_links,
            hold_expiry: v5.hold_expiry,
            hold_window_ns: v5.hold_window_ns,
            agreements: v5.agreements,
            toll_yocto: v5.toll_yocto,
            treasury: v5.treasury,
            exempt: v5.exempt,
            exclusives: UnorderedMap::new(SK::Xc),
            attestations: UnorderedMap::new(SK::At),
        }
    }

    /// V6 → V7 migration: add the empty `attestations` map. Everything else carries over
    /// unchanged. OWNER-ONLY: caller must equal the owner recorded in the V6 state. Pure additive
    /// (a new top-level map — no existing record is touched), so it's borsh-safe. Like migrate6, the
    /// prior appends (fee fields + exclusives) are CARRIED OVER from V6, not reseeded; only the
    /// brand-new `attestations` map is created empty. V7 only adds the field.
    #[init(ignore_state)]
    pub fn migrate7() -> Self {
        let v6: ContractV6 = env::state_read().expect(err::NO_V6_STATE);
        assert_eq!(env::predecessor_account_id(), v6.owner, "{}", err::NOT_OWNER);
        Event::Migrate { from: 6, to: 7 }.emit();
        Self {
            owner:  v6.owner,
            nodes:  v6.nodes,
            orgs:   v6.orgs,
            peers:  v6.peers,
            gates:  v6.gates,
            tiles:  v6.tiles,
            claims: v6.claims,
            queue:  v6.queue,
            passes: v6.passes,
            pass_owner_idx: v6.pass_owner_idx,
            next_pass_id: v6.next_pass_id,
            pass_links: v6.pass_links,
            hold_expiry: v6.hold_expiry,
            hold_window_ns: v6.hold_window_ns,
            agreements: v6.agreements,
            toll_yocto: v6.toll_yocto,
            treasury: v6.treasury,
            exempt: v6.exempt,
            exclusives: v6.exclusives,
            attestations: UnorderedMap::new(SK::At),
        }
    }

    // ── Protocol usage fee (V5) ────────────────────────────────────────────────
    // Charged to callers that are NOT exempt (owner + the exempt list = free).
    // The toll rides a (now-required-for-outsiders) attached deposit that also covers the storage
    // the call creates; exempt callers attach nothing and keep being subsidized exactly as before.

    /// Is this caller exempt from the toll? Owner is ALWAYS exempt (it runs the admin surface and is
    /// the treasury by default — charging itself is pointless and would just churn its own balance).
    fn is_caller_exempt(&self, caller: &AccountId) -> bool {
        *caller == self.owner || self.exempt.get(caller).is_some
    }

    /// The core money-movement primitive (V5). Call it as the LAST line of every state-writing method,
    /// passing the `env::storage_usage` snapshot taken as that method's FIRST line (before any write).
    ///
    /// Non-exempt caller: must have attached ≥ storage_cost + toll. We keep `storage_cost + toll`
    /// (storage stays locked on the account; toll is forwarded to the treasury) and refund the excess.
    /// Exempt caller (owner/partners): storage + toll are BOTH waived — we refund the entire attached
    /// deposit (they need attach nothing; if they attached anyway, they get it all back). This keeps
    /// the pre-V5 behavior for us + partners byte-for-byte: the contract still eats their storage.
    ///
    /// Refund/treasury moves are fire-and-forget `Promise`s (`.detach`, matching the NEP storage
    /// standard) — a failed refund can't roll back committed state, and the amounts are tiny.
    fn charge(&self, usage_before: u64) {
        let caller = env::predecessor_account_id();
        let attached = env::attached_deposit();

        if self.is_caller_exempt(&caller) {
            // Free storage + no toll: give back everything attached (usually zero).
            if attached.as_yoctonear() > 0 {
                Promise::new(caller).transfer(attached).detach();
            }
            return;
        }

        let usage_after = env::storage_usage();
        let bytes_added = usage_after.saturating_sub(usage_before);
        let storage_cost = env::storage_byte_cost().saturating_mul(bytes_added as u128);
        let toll = NearToken::from_yoctonear(self.toll_yocto);
        let need = storage_cost.saturating_add(toll);

        assert!(attached >= need, "{}", err::INSUFFICIENT_DEPOSIT);

        // Refund any overpayment first (fire-and-forget).
        let refund = attached.saturating_sub(need);
        if refund.as_yoctonear() > 0 {
            Promise::new(caller).transfer(refund).detach();
        }
        // Sweep the toll to the treasury (storage_cost stays locked on this account as the deposit
        // for the bytes just written). Skip if toll is 0 (fee turned off) or treasury == this account.
        if toll.as_yoctonear() > 0 && self.treasury != env::current_account_id() {
            Promise::new(self.treasury.clone()).transfer(toll).detach();
        }
    }

    // ── Node (seller) ────────────────────────────────────────────────────────

    /// Provision a node (seller). OWNER-ONLY: the owner is the Vetting Identity / VR-User
    /// — the source of identities. Vetting/KYC is an off-chain precondition done BEFORE this
    /// call; nothing identifying lands on-chain. `node_id` = the account being provisioned;
    /// `instance_hash` = HMAC of instance identity. (Was self-service previously — that was the
    /// onboarding regression.)
    #[payable]
    pub fn register_node(&mut self, node_id: AccountId, instance_hash: String) {
        let u0 = env::storage_usage();
        assert_eq!(env::predecessor_account_id(), self.owner, "{}", err::NOT_OWNER);
        assert!(self.nodes.get(&node_id).is_none(), "{}", err::NODE_EXISTS);
        self.nodes.insert(&node_id, &Node { id: node_id.clone(), instance_hash, registered_at: env::block_timestamp(), active: true });
        let qs = SK::QS { h: node_id.as_bytes().to_vec() };
        self.queue.insert(&node_id, &UnorderedSet::new(qs));
        Event::NodeRegistered { node: node_id }.emit();
        self.charge(u0);
    }

    pub fn get_node(&self, id: AccountId) -> Option<Node> { self.nodes.get(&id) }

    // ── Org (agency) ─────────────────────────────────────────────────────────

    /// Provision an org (agency). OWNER-ONLY: owner = Vetting Identity / VR-User.
    /// Vetting/KYC is an off-chain precondition; nothing identifying on-chain. `org_id` = the
    /// account being provisioned; `org_ref` = opaque org ref (HMAC of internal agency id). A
    /// developer's captive in-house sales team is just an Org provisioned here — no special
    /// path. (Was self-service previously — the onboarding regression.)
    #[payable]
    pub fn register_org(&mut self, org_id: AccountId, org_ref: String) {
        let u0 = env::storage_usage();
        assert_eq!(env::predecessor_account_id(), self.owner, "{}", err::NOT_OWNER);
        assert!(self.orgs.get(&org_id).is_none(), "{}", err::ORG_EXISTS);
        self.orgs.insert(&org_id, &Org { id: org_id.clone(), org_ref, registered_at: env::block_timestamp(), active: true });
        Event::OrgRegistered { org: org_id }.emit();
        self.charge(u0);
    }

    pub fn get_org(&self, id: AccountId) -> Option<Org> { self.orgs.get(&id) }

    // ── Peer (agent) ─────────────────────────────────────────────────────────

    /// Register a peer. Called by org. `agent_ref` = opaque agent ref.
    #[payable]
    pub fn register_peer(&mut self, peer_id: AccountId, agent_ref: String) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        assert!(self.orgs.get(&caller).is_some(), "{}", err::NOT_ORG);
        assert!(self.peers.get(&peer_id).is_none(), "{}", err::PEER_EXISTS);
        self.peers.insert(&peer_id, &Peer { id: peer_id.clone(), org: caller.clone(), agent_ref, registered_at: env::block_timestamp(), active: true });
        Event::PeerRegistered { org: caller, peer: peer_id }.emit();
        self.charge(u0);
    }

    /// Deactivate a peer. Called by their org.
    #[payable]
    pub fn deactivate_peer(&mut self, peer_id: AccountId) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        let mut peer = self.peers.get(&peer_id).expect(err::PEER_NOT_FOUND);
        assert_eq!(peer.org, caller, "{}", err::NOT_PEERS_ORG);
        peer.active = false;
        self.peers.insert(&peer_id, &peer);
        Event::PeerDeactivated { peer: peer_id }.emit();
        self.charge(u0);
    }

    pub fn get_peer(&self, id: AccountId) -> Option<Peer> { self.peers.get(&id) }

    // ── Gate (access grant) ──────────────────────────────────────────────────

    /// Grant an org access to a set of opaque scope hashes. Called by a node.
    #[payable]
    pub fn grant_gate(&mut self, org_id: AccountId, scope: Vec<String>) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        assert!(self.nodes.get(&caller).is_some(), "{}", err::NOT_NODE);
        assert!(self.orgs.get(&org_id).is_some(), "{}", err::ORG_NOT_FOUND);
        let key = format!("{}:{}", caller, org_id);
        self.gates.insert(&key, &Gate { node: caller.clone(), org: org_id.clone(), allowed_scope: scope, granted_at: env::block_timestamp(), active: true });
        Event::GateGranted { node: caller, org: org_id }.emit();
        self.charge(u0);
    }

    /// Revoke an org's gate. Called by the granting node.
    #[payable]
    pub fn revoke_gate(&mut self, org_id: AccountId) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        let key = format!("{}:{}", caller, org_id);
        let mut gate = self.gates.get(&key).expect(err::GATE_NOT_FOUND);
        assert_eq!(gate.node, caller, "{}", err::NOT_GATES_NODE);
        gate.active = false;
        self.gates.insert(&key, &gate);
        Event::GateRevoked { node: caller, org: org_id }.emit();
        self.charge(u0);
    }

    /// Replace a gate's allowed scope hashes. Called by the granting node.
    #[payable]
    pub fn update_gate_scope(&mut self, org_id: AccountId, scope: Vec<String>) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        let key = format!("{}:{}", caller, org_id);
        let mut gate = self.gates.get(&key).expect(err::GATE_NOT_FOUND);
        assert_eq!(gate.node, caller, "{}", err::NOT_GATES_NODE);
        gate.allowed_scope = scope;
        self.gates.insert(&key, &gate);
        self.charge(u0);
    }

    pub fn get_gate(&self, node_id: AccountId, org_id: AccountId) -> Option<Gate> {
        let key = format!("{}:{}", node_id, org_id);
        self.gates.get(&key)
    }

    /// Check whether an org can access a specific opaque scope hash under a node.
    pub fn can_access(&self, org_id: AccountId, node_id: AccountId, scope_hash: String) -> bool {
        let key = format!("{}:{}", node_id, org_id);
        match self.gates.get(&key) {
            Some(g) => g.active && g.allowed_scope.contains(&scope_hash),
            None => false,
        }
    }

    // ── Agreement (commission) ───────────────────────────────────────────
    // Parallel to Gate: keyed "{node}:{org}", node-signed, mirror verbs. Anchor-only:
    // stores an HMAC of the off-chain commission rulebook, never amounts. See the Agreement doc.

    /// Set or amend the commission agreement for this node→org. Called by a NODE (the payer).
    /// `commission_hash` = HMAC of the off-chain commission rulebook (the tamper-proof anchor —
    /// %/tiers/splits stay off-chain). Create → version 1; amend → bumps version, replaces
    /// the anchor, restamps `agreed_at`. Requires the caller be a registered node and the org exist
    /// (mirrors `grant_gate`'s checks). KYC is NOT re-checked here (an off-chain precondition).
    #[payable]
    pub fn set_agreement(&mut self, org_id: AccountId, commission_hash: String) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        assert!(self.nodes.get(&caller).is_some(), "{}", err::NOT_NODE);
        assert!(self.orgs.get(&org_id).is_some(), "{}", err::ORG_NOT_FOUND);
        let key = format!("{}:{}", caller, org_id);
        // Amend bumps version + reactivates; create starts at 1.
        let version = self.agreements.get(&key).map_or(1, |a| a.version + 1);
        self.agreements.insert(&key, &Agreement {
            node: caller.clone(), org: org_id.clone(), commission_hash,
            version, agreed_at: env::block_timestamp(), active: true,
        });
        Event::AgreementSet { node: caller, org: org_id, version }.emit();
        self.charge(u0);
    }

    /// Revoke the commission agreement (active=false). Called by the agreement's node. The record
    /// (and its version history anchor) is kept — mirror of `revoke_gate`.
    #[payable]
    pub fn revoke_agreement(&mut self, org_id: AccountId) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        let key = format!("{}:{}", caller, org_id);
        let mut ag = self.agreements.get(&key).expect(err::AGREEMENT_NOT_FOUND);
        assert_eq!(ag.node, caller, "{}", err::NOT_AGREEMENTS_NODE);
        ag.active = false;
        self.agreements.insert(&key, &ag);
        Event::AgreementRevoked { node: caller, org: org_id }.emit();
        self.charge(u0);
    }

    /// Read the commission agreement for a node→org pair. None = never set.
    pub fn get_agreement(&self, node_id: AccountId, org_id: AccountId) -> Option<Agreement> {
        let key = format!("{}:{}", node_id, org_id);
        self.agreements.get(&key)
    }

    // ── Attestation (vetting / sign-off, V7) ─────────────────────────────
    // Building-level anchor of the salted off-chain baseline seal. Node-signed (developer does
    // the heavy lifting), owner-ratified (VRX's forge-proof "agreed" stamp). Anchor-only like the
    // Agreement: the `seal_hash` is opaque; no slate/term/PII ever lands on-chain. See the struct doc.

    /// Set or amend the vetting/sign-off attestation for this node→building. Called by a NODE (the
    /// developer). `building_hash` = opaque building scope hash (same hash space as Gate scopes);
    /// `kind` = 0 release/sign-off (V7), 1 version-seal (future #2); `seal_hash` = the salted baseline
    /// seal being anchored (opaque); `approved_by`/`approver_role` = who approved it (developer-self
    /// default; the CEO/VRX account from the off-chain approver dial when role=1). Create → version
    /// 1; re-attest (a re-approval round) → bumps version, replaces the seal/approver, restamps `at`,
    /// and CLEARS any prior ratification (a new version must be re-ratified — the old ratification
    /// attested the old seal, not this one). Requires caller be a registered node (mirrors set_agreement).
    #[payable]
    pub fn attest(&mut self, building_hash: String, kind: u8, seal_hash: String, approved_by: AccountId, approver_role: u8) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        assert!(self.nodes.get(&caller).is_some(), "{}", err::NOT_NODE);
        let key = format!("{}:{}", caller, building_hash);
        // Amend bumps version + clears ratification; create starts at 1.
        let version = self.attestations.get(&key).map_or(1, |a| a.version + 1);
        self.attestations.insert(&key, &Attestation {
            building_hash: building_hash.clone(), kind, seal_hash,
            approved_by, approver_role, version, at: env::block_timestamp(),
            ratified_by: None, ratified_at: None,
        });
        Event::AttestationSet { node: caller, building: building_hash, kind, version }.emit();
        self.charge(u0);
    }

    /// Ratify a developer's attestation on-chain. OWNER-ONLY: this is the forge-proof stamp — a
    /// developer can RECORD whose name approved it via `attest`, but only the owner key can produce
    /// this ratification, so it's the independently-provable half. Sets `ratified_by`/`ratified_at`
    /// on the current version.
    #[payable]
    pub fn ratify_attestation(&mut self, node_id: AccountId, building_hash: String) {
        let u0 = env::storage_usage();
        assert_eq!(env::predecessor_account_id(), self.owner, "{}", err::NOT_OWNER);
        let key = format!("{}:{}", node_id, building_hash);
        let mut att = self.attestations.get(&key).expect(err::ATTESTATION_NOT_FOUND);
        att.ratified_by = Some(self.owner.clone());
        att.ratified_at = Some(env::block_timestamp());
        self.attestations.insert(&key, &att);
        Event::AttestationRatified { node: node_id, building: building_hash }.emit();
        self.charge(u0);
    }

    /// Read the vetting attestation for a node→building pair. None = never attested (so the building is
    /// NOT released — the off-chain gate reads this as "not released", fail-closed). The on-chain
    /// source of truth for "released/vetted" that `isBookable` prefers over the off-chain baseline (B).
    pub fn get_attestation(&self, node_id: AccountId, building_hash: String) -> Option<Attestation> {
        let key = format!("{}:{}", node_id, building_hash);
        self.attestations.get(&key)
    }

    // ── Tile (unit stamp) ────────────────────────────────────────────────────

    /// Stamp a single tile. `unit_key` = HMAC(salt, unit_ref). `integrity_hash` = HMAC of unit data fields.
    #[payable]
    pub fn stamp_tile(&mut self, unit_key: String, status: u8, integrity_hash: String) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        assert!(self.nodes.get(&caller).is_some(), "{}", err::NOT_NODE);
        assert!(status <= 3, "{}", err::BAD_TILE_STATUS);
        let ts = env::block_timestamp();
        self.tiles.insert(&unit_key, &Tile { unit_key: unit_key.clone(), node: caller.clone(), status, stamped_at: ts, stamped_by: caller.clone(), integrity_hash });
        Event::TileStamped { node: caller, key: unit_key, status }.emit();
        self.charge(u0);
    }

    pub fn get_tile(&self, unit_key: String) -> Option<Tile> { self.tiles.get(&unit_key) }

    /// true if the tile currently has a timed hold that has EXPIRED (now >= hold_until).
    /// A tile with no expiry entry, or one not yet reached, is not expired.
    fn is_hold_expired(&self, k: &str) -> bool {
        match self.hold_expiry.get(&k.to_string()) {
            Some(until) => env::block_timestamp() >= until,
            None => false,
        }
    }

    /// free an expired hold — set the tile back to open (s=0), clear its expiry, emit
    /// HoldReleased. Returns true if a release happened. Internal helper for both the lazy path
    /// (inside req) and the standalone release crank. Does NOT touch the claim: pure
    /// availability crank — reveals only "no longer held").
    fn release_if_expired(&mut self, k: &str) -> bool {
        if !self.is_hold_expired(k) { return false; }
        if let Some(mut tile) = self.tiles.get(&k.to_string()) {
            if tile.status == 1 {
                let node = tile.node.clone();
                tile.status = 0;
                self.tiles.insert(&k.to_string(), &tile);
                self.hold_expiry.remove(&k.to_string());
                Event::HoldReleased { node, key: k.to_string() }.emit();
                return true;
            }
        }
        // Expiry set but tile isn't a hold (shouldn't happen) — clear the stale entry.
        self.hold_expiry.remove(&k.to_string());
        false
    }

    /// permissionless crank — release an expired hold on tile `unit_key`, freeing it to open
    /// and advancing availability for the queue. No privilege needed (only frees an EXPIRED hold);
    /// a keeper-bot or human calls it to clear tiles nobody has touched. Returns true if freed.
    /// Expiry is ALSO honored lazily inside open_claim, so this is not required for correctness.
    #[payable]
    pub fn release(&mut self, unit_key: String) -> bool {
        let u0 = env::storage_usage();
        let freed = self.release_if_expired(&unit_key);
        self.charge(u0);
        freed
    }

    /// view the hold-expiry timestamp (ns) for a tile, if it has a timed hold. None = none.
    pub fn get_hold_expiry(&self, unit_key: String) -> Option<u64> { self.hold_expiry.get(&unit_key) }

    /// set the owner-configurable unpaid-hold window (ns). The ONLY on-chain time knob;
    /// office-hours/timezone policy stays off-chain.
    #[payable]
    pub fn set_hold_window(&mut self, ns: u64) {
        let u0 = env::storage_usage();
        assert_eq!(env::predecessor_account_id(), self.owner, "{}", err::NOT_OWNER);
        self.hold_window_ns = ns;
        Event::HoldWindowSet { ns }.emit();
        self.charge(u0);
    }

    /// read the current hold window (ns).
    pub fn get_hold_window(&self) -> u64 { self.hold_window_ns }

    // ── Exclusive hold ───────────────────────────────────────────────
    // A node grants ONE org the sole right to book a unit for a bounded window ("solo/exhibition
    // mode"). Others are blocked (open_claim → EXCLUSIVE_HELD); the unit auto-reverts at expiry.
    // Reuses the time-boxed auto-release pattern (lazy in open_claim + a permissionless crank).
    // KEY: the exclusive does NOT set tile.status — the tile stays OPEN so the HOLDER can book it;
    // this sidecar is the SOLE gate. Others' "held" view comes from get_exclusive, not tile.status.

    /// Grant `org_id` the SOLE right to book `unit_key` for `window_ns` nanoseconds. NODE-signed
    /// (the tile's owner). Requires: caller is a registered node AND owns the tile; `org_id` is a
    /// registered org with an ACTIVE gate on this node; the tile is currently OPEN (status=0) with
    /// no live unpaid claim-hold (an EXPIRED hold is lazily released first, mirroring open_claim).
    /// Re-granting on a unit that already has a live exclusive REPLACES it (re-assign / extend).
    /// The tile status is left OPEN (see KEY above). #[payable] + charge.
    #[payable]
    pub fn grant_exclusive(&mut self, unit_key: String, org_id: AccountId, window_ns: u64) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        assert!(self.nodes.get(&caller).is_some(), "{}", err::NOT_NODE);
        // The org must exist and have an active gate on this node (mirror open_claim's gate check —
        // an exclusive is only meaningful for an org that can otherwise book here).
        assert!(self.orgs.get(&org_id).is_some(), "{}", err::ORG_NOT_FOUND);
        let gkey = format!("{}:{}", caller, org_id);
        let gate = self.gates.get(&gkey).expect(err::NO_GATE);
        assert!(gate.active, "{}", err::GATE_INACTIVE);

        // Free an EXPIRED unpaid hold on this tile first (same tx), so an exclusive can be granted
        // over a tile whose old hold has lapsed — mirrors open_claim's lazy release.
        self.release_if_expired(&unit_key);

        // The tile must exist, belong to the caller, and be OPEN (no live claim-hold / not closed/done).
        let tile = self.tiles.get(&unit_key).expect(err::TILE_NOT_FOUND);
        assert_eq!(tile.node, caller, "{}", err::TILE_NODE_MISMATCH);
        assert_eq!(tile.status, 0, "{}", err::EXCLUSIVE_TILE_BUSY);

        let until = env::block_timestamp() + window_ns;
        self.exclusives.insert(&unit_key, &Exclusive { org: org_id.clone(), until, by: caller.clone() });
        Event::ExclusiveGranted { node: caller, key: unit_key, org: org_id }.emit();
        self.charge(u0);
    }

    /// End an exclusive early (before expiry). NODE-signed — must be the node that granted it.
    /// Clears the sidecar entry; the tile was never taken off OPEN, so nothing else changes.
    #[payable]
    pub fn release_exclusive(&mut self, unit_key: String) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        let ex = self.exclusives.get(&unit_key).expect(err::TILE_NOT_FOUND);
        assert_eq!(ex.by, caller, "{}", err::TILE_NODE_MISMATCH);
        self.exclusives.remove(&unit_key);
        Event::ExclusiveReleased { node: caller, key: unit_key }.emit();
        self.charge(u0);
    }

    /// twin of `release_if_expired`: if this unit's exclusive has expired (now >= until), clear
    /// it and emit ExclusiveReleased. Returns true if a release happened. Internal helper for both
    /// the lazy path (inside open_claim) and the permissionless `release_exclusive_if_expired` crank.
    fn release_exclusive_if_expired_inner(&mut self, k: &str) -> bool {
        if let Some(ex) = self.exclusives.get(&k.to_string()) {
            if env::block_timestamp() >= ex.until {
                let node = ex.by.clone();
                self.exclusives.remove(&k.to_string());
                Event::ExclusiveReleased { node, key: k.to_string() }.emit();
                return true;
            }
        }
        false
    }

    /// permissionless crank — release an EXPIRED exclusive on `unit_key`, freeing the unit back
    /// to the shared pool. No privilege needed (only frees an expired exclusive); mirrors `release`.
    /// Expiry is ALSO honored lazily inside open_claim, so this is not required for correctness.
    #[payable]
    pub fn release_exclusive_if_expired(&mut self, unit_key: String) -> bool {
        let u0 = env::storage_usage();
        let freed = self.release_exclusive_if_expired_inner(&unit_key);
        self.charge(u0);
        freed
    }

    /// view the current exclusive holder for a unit, if any (and until when). None = no
    /// exclusive (or it has expired but not yet been cranked — callers should treat a past `until`
    /// as no-exclusive; open_claim clears it lazily). This is the ONLY place the holder id surfaces
    ///: never on the public Tile).
    pub fn get_exclusive(&self, unit_key: String) -> Option<Exclusive> { self.exclusives.get(&unit_key) }

    /// Bulk stamp tiles. Max 50 per call. Each entry: (unit_key, status, integrity_hash).
    /// V5: a single toll for the whole batch (the toll is per-CALL); the deposit must also cover the
    /// storage all 50 tiles create, so the required deposit for a full batch is meaningfully larger.
    #[payable]
    pub fn stamp_tiles(&mut self, stamps: Vec<(String, u8, String)>) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        assert!(self.nodes.get(&caller).is_some(), "{}", err::NOT_NODE);
        assert!(stamps.len() <= 50, "{}", err::TOO_MANY_STAMPS);
        let ts = env::block_timestamp();
        for (unit_key, status, integrity_hash) in stamps {
            assert!(status <= 3, "{}", err::BAD_TILE_STATUS);
            self.tiles.insert(&unit_key, &Tile { unit_key: unit_key.clone(), node: caller.clone(), status, stamped_at: ts, stamped_by: caller.clone(), integrity_hash });
            Event::TileStamped { node: caller.clone(), key: unit_key, status }.emit();
        }
        self.charge(u0);
    }

    // ── Claim (booking request) ──────────────────────────────────────────────

    /// Open a booking claim. `request_id` = opaque request id. `unit_key` = tile key.
    /// `request_hash` = encrypted/HMAC payload (opaque terms).
    #[payable]
    pub fn open_claim(&mut self, request_id: String, unit_key: String, node_id: AccountId, request_hash: String) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        let peer = self.peers.get(&caller).expect(err::NOT_PEER);
        assert!(peer.active, "{}", err::PEER_INACTIVE);

        let gkey = format!("{}:{}", node_id, peer.org);
        let gate = self.gates.get(&gkey).expect(err::NO_GATE);
        assert!(gate.active, "{}", err::GATE_INACTIVE);

        // lazy release: if this tile is on an EXPIRED hold, free it now (same tx) so the
        // requester can claim it — no separate crank/human needed. A live (unexpired) hold stays.
        self.release_if_expired(&unit_key);

        // lazy release: an EXPIRED exclusive is cleared now (same tx) so the unit is back in the
        // shared pool. Then honor a LIVE exclusive: only the holder org may book; others are rejected.
        self.release_exclusive_if_expired_inner(&unit_key);
        if let Some(ex) = self.exclusives.get(&unit_key) {
            assert_eq!(peer.org, ex.org, "{}", err::EXCLUSIVE_HELD);
        }

        let tile = self.tiles.get(&unit_key).expect(err::TILE_NOT_FOUND);
        assert_eq!(tile.status, 0, "{}", err::TILE_NOT_OPEN);
        assert_eq!(tile.node, node_id, "{}", err::TILE_NODE_MISMATCH);
        assert!(self.claims.get(&request_id).is_none(), "{}", err::REQUEST_EXISTS);

        let ts = env::block_timestamp();
        let org_id = peer.org.clone();
        self.claims.insert(&request_id, &Claim {
            request_id: request_id.clone(), unit_key, node: node_id.clone(), org: org_id, peer: caller,
            status: 0, created_at: ts, updated_at: ts, request_hash, response_hash: String::new(),
        });

        if let Some(mut q) = self.queue.get(&node_id) {
            q.insert(&request_id);
            self.queue.insert(&node_id, &q);
        }
        Event::ClaimOpened { id: request_id, node: node_id }.emit();
        self.charge(u0);
    }

    /// Reply to a claim. `status` 1=ok 2=no 3=alt. `response_hash` = response hash.
    /// `tile_hash` = integrity hash stamped onto the tile when the reply grants a hold (status=1).
    #[payable]
    pub fn reply_claim(&mut self, request_id: String, status: u8, response_hash: String, tile_hash: String) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        assert!(status >= 1 && status <= 3, "{}", err::BAD_REPLY_STATUS);
        let mut claim = self.claims.get(&request_id).expect(err::CLAIM_NOT_FOUND);
        assert_eq!(claim.node, caller, "{}", err::CLAIM_NODE_MISMATCH);
        assert_eq!(claim.status, 0, "{}", err::CLAIM_NOT_OPEN);

        claim.status = status;
        claim.response_hash = response_hash;
        claim.updated_at = env::block_timestamp();
        let unit_key = claim.unit_key.clone();
        self.claims.insert(&request_id, &claim);

        if status == 1 {
            let ts = env::block_timestamp();
            self.tiles.insert(&unit_key, &Tile { unit_key: unit_key.clone(), node: caller.clone(), status: 1, stamped_at: ts, stamped_by: caller.clone(), integrity_hash: tile_hash });
            // start the unpaid-hold expiry clock.
            self.hold_expiry.insert(&unit_key, &(ts + self.hold_window_ns));
        }

        if let Some(mut q) = self.queue.get(&caller) {
            q.remove(&request_id);
            self.queue.insert(&caller, &q);
        }
        Event::ClaimReplied { id: request_id, status }.emit();
        self.charge(u0);
    }

    /// Confirm an accepted claim → tile status 2 (closed). `integrity_hash` stamps the tile.
    #[payable]
    pub fn confirm_claim(&mut self, request_id: String, integrity_hash: String) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        let mut claim = self.claims.get(&request_id).expect(err::CLAIM_NOT_FOUND);
        assert_eq!(claim.node, caller, "{}", err::CLAIM_NODE_MISMATCH);
        assert_eq!(claim.status, 1, "{}", err::CLAIM_NOT_ACCEPTED);
        let unit_key = claim.unit_key.clone();
        let ts = env::block_timestamp();
        self.tiles.insert(&unit_key, &Tile { unit_key: unit_key.clone(), node: caller.clone(), status: 2, stamped_at: ts, stamped_by: caller.clone(), integrity_hash });
        // tile is closed (deposit confirmed) — the unpaid-hold clock no longer applies.
        self.hold_expiry.remove(&unit_key);
        // confirm_claim asserts out at CLAIM_NOT_ACCEPTED instead of re-running (the live
        // double-click bug). Pairs with cleanup_claim, which treats 4 as cleanable.
        claim.status = 4;
        claim.updated_at = ts;
        self.claims.insert(&request_id, &claim);
        self.charge(u0);
    }

    /// Mark a tile as fully done → status 3. `integrity_hash` stamps the tile.
    #[payable]
    pub fn finalize_tile(&mut self, unit_key: String, integrity_hash: String) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        let tile = self.tiles.get(&unit_key).expect(err::TILE_NOT_FOUND);
        assert_eq!(tile.node, caller, "{}", err::TILE_NODE_MISMATCH_FIN);
        let ts = env::block_timestamp();
        self.tiles.insert(&unit_key, &Tile { unit_key: unit_key.clone(), node: caller.clone(), status: 3, stamped_at: ts, stamped_by: caller, integrity_hash });
        // tile is done — no hold clock.
        self.hold_expiry.remove(&unit_key);
        self.charge(u0);
    }

    /// Clean up a TERMINAL claim and refund the storage deposit it locked.
    /// A claim in a terminal state (2=no, 3=alt, 4=confirmed) no longer needs to exist on-chain:
    /// its tile carries the authoritative state. Removing it frees ~0.006 NEAR of locked storage,
    /// which we transfer back to the node. Live claims (0=open, 1=accepted) are NOT cleanable.
    /// Node-only (the claim's node is the storage payer). Idempotent-safe: a 2nd call hits
    /// CLAIM_NOT_FOUND because the entry is gone.
    #[payable]
    pub fn cleanup_claim(&mut self, request_id: String) {
        let caller = env::predecessor_account_id();
        let claim = self.claims.get(&request_id).expect(err::CLAIM_NOT_FOUND);
        assert_eq!(claim.node, caller, "{}", err::CLAIM_NODE_MISMATCH);
        assert!(claim.status >= 2, "{}", err::CLAIM_NOT_TERMINAL);

        let before = env::storage_usage();
        self.claims.remove(&request_id);
        let freed = before.saturating_sub(env::storage_usage());
        let refund = env::storage_byte_cost().saturating_mul(freed as u128);

        // Return the freed storage deposit to the node (fire-and-forget, matching `charge`'s
        // refund idiom). A failed transfer can't roll back the committed removal; amount is tiny.
        if refund.as_yoctonear() > 0 {
            Promise::new(caller.clone()).transfer(refund).detach();
        }
        Event::ClaimCleaned { id: request_id, node: caller }.emit();
    }

    pub fn get_claim(&self, request_id: String) -> Option<Claim> { self.claims.get(&request_id) }

    /// Get all open claim ids for a node.
    pub fn get_pending_claims(&self, node_id: AccountId) -> Vec<String> {
        match self.queue.get(&node_id) {
            Some(q) => q.to_vec(),
            None => vec![],
        }
    }

    // ── BookingPass NFT (mint / burn / read) ─────────────────────────────────

    /// Mint `count` booking passes to an agent. Only contract owner can call.
    /// Returns the new token_ids.
    #[payable]
    pub fn mint_passes(&mut self, to: AccountId, count: u32) -> Vec<u64> {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        assert_eq!(caller, self.owner, "{}", err::NOT_OWNER_MINT);
        assert!(count > 0 && count <= 100, "{}", err::BAD_MINT_COUNT);
        // Recipient must be a registered active peer (agent).
        let peer = self.peers.get(&to).expect(err::RECIPIENT_NOT_PEER);
        assert!(peer.active, "{}", err::RECIPIENT_INACTIVE);

        let ts = env::block_timestamp();
        let mut ids = Vec::with_capacity(count as usize);
        let mut owned = self.pass_owner_idx.get(&to).unwrap_or_else(|| {
            UnorderedSet::new(SK::POS { h: to.as_bytes().to_vec() })
        });

        for _ in 0..count {
            let id = self.next_pass_id;
            self.next_pass_id += 1;
            let pass = Pass {
                id, owner: to.clone(), minted_by: caller.clone(), minted_at: ts,
                burned_at: None, burned_for_unit_key: None, burned_for_request_id: None,
            };
            self.passes.insert(&id, &pass);
            owned.insert(&id);
            ids.push(id);
        }
        self.pass_owner_idx.insert(&to, &owned);
        Event::PassesMinted { to, ids: ids.clone() }.emit();
        self.charge(u0);
        ids
    }

    /// Number of active (non-burned) passes owned by an account.
    pub fn active_pass_count(&self, id: AccountId) -> u32 {
        match self.pass_owner_idx.get(&id) {
            Some(set) => set.iter()
                .filter(|tid| self.passes.get(tid).map_or(false, |p| p.burned_at.is_none()))
                .count() as u32,
            None => 0,
        }
    }

    /// List passes for an owner (paginated). Returns active passes only.
    pub fn list_passes(&self, id: AccountId, from: u32, count: u32) -> Vec<Pass> {
        let count = count.min(50) as usize;
        match self.pass_owner_idx.get(&id) {
            Some(set) => set.iter()
                .filter_map(|tid| self.passes.get(&tid))
                .filter(|p| p.burned_at.is_none())
                .skip(from as usize)
                .take(count)
                .collect(),
            None => vec![],
        }
    }

    /// Get a single pass by id (active or burned).
    pub fn get_pass(&self, id: u64) -> Option<Pass> { self.passes.get(&id) }

    /// Atomic: burn pass + create claim + set tile to hold. Skips developer approval.
    /// Caller must be the pass owner (a registered agent).
    #[payable]
    pub fn burn_pass_hold(&mut self, pass_id: u64, request_id: String, unit_key: String, node_id: AccountId, request_hash: String, tile_hash: String) {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();

        // Validate pass: exists, owned by caller, not burned
        let mut pass = self.passes.get(&pass_id).expect(err::PASS_NOT_FOUND);
        assert_eq!(pass.owner, caller, "{}", err::PASS_NOT_OWNED);
        assert!(pass.burned_at.is_none(), "{}", err::PASS_BURNED);

        // Validate caller is an active registered peer
        let peer = self.peers.get(&caller).expect(err::NOT_PEER);
        assert!(peer.active, "{}", err::PEER_INACTIVE);

        // Validate access grant for agency → seller
        let gkey = format!("{}:{}", node_id, peer.org);
        let gate = self.gates.get(&gkey).expect(err::NO_GATE);
        assert!(gate.active, "{}", err::GATE_INACTIVE);

        // lazy release: free an expired hold on this tile before checking it's open.
        self.release_if_expired(&unit_key);

        // honor an exclusive on the token path too (else it'd be a bypass). Clear an expired
        // exclusive, then reject a non-holder org from burning a pass on an exclusively-held unit.
        self.release_exclusive_if_expired_inner(&unit_key);
        if let Some(ex) = self.exclusives.get(&unit_key) {
            assert_eq!(peer.org, ex.org, "{}", err::EXCLUSIVE_HELD);
        }

        // Validate tile exists, is open, and belongs to the seller
        let tile = self.tiles.get(&unit_key).expect(err::TILE_NOT_FOUND);
        assert_eq!(tile.status, 0, "{}", err::TILE_NOT_OPEN);
        assert_eq!(tile.node, node_id, "{}", err::TILE_NODE_MISMATCH);
        assert!(self.claims.get(&request_id).is_none(), "{}", err::REQUEST_EXISTS);

        let ts = env::block_timestamp();
        let org_id = peer.org.clone();

        // Create claim already in status=1 (ok/accepted), no developer review needed
        self.claims.insert(&request_id, &Claim {
            request_id: request_id.clone(), unit_key: unit_key.clone(), node: node_id.clone(), org: org_id, peer: caller.clone(),
            status: 1, created_at: ts, updated_at: ts, request_hash, response_hash: String::new(),
        });

        // Set tile to hold (status=1)
        self.tiles.insert(&unit_key, &Tile {
            unit_key: unit_key.clone(), node: node_id.clone(), status: 1, stamped_at: ts, stamped_by: caller.clone(), integrity_hash: tile_hash,
        });
        // start the unpaid-hold expiry clock.
        self.hold_expiry.insert(&unit_key, &(ts + self.hold_window_ns));

        // Burn pass
        pass.burned_at = Some(ts);
        pass.burned_for_unit_key = Some(unit_key.clone());
        pass.burned_for_request_id = Some(request_id.clone());
        self.passes.insert(&pass_id, &pass);

        Event::PassBurned { id: pass_id, key: unit_key, request: request_id }.emit();
        self.charge(u0);

        // Note: claim does NOT enter the seller's pending queue (status starts at 1, not 0).
        // The seller will see it via get_tile/get_claim directly when the off-chain side syncs.
    }

    /// Rebirth: mint a replacement pass linked to a burned pass. Owner-only.
    /// Old pass must be burned and not already reborn. New pass goes to old pass's owner.
    /// Returns new token_id.
    #[payable]
    pub fn rebirth_pass(&mut self, old_pass_id: u64) -> u64 {
        let u0 = env::storage_usage();
        let caller = env::predecessor_account_id();
        assert_eq!(caller, self.owner, "{}", err::NOT_OWNER_REBIRTH);

        let old = self.passes.get(&old_pass_id).expect(err::PASS_NOT_FOUND_REBIRTH);
        assert!(old.burned_at.is_some(), "{}", err::PASS_NOT_BURNED);
        // Already-reborn check via sidecar
        if let Some(link) = self.pass_links.get(&old_pass_id) {
            assert!(link.rebirth_id.is_none(), "{}", err::PASS_ALREADY_REBORN);
        }

        let to = old.owner.clone();
        let ts = env::block_timestamp();
        let new_id = self.next_pass_id;
        self.next_pass_id += 1;

        let new_pass = Pass {
            id: new_id, owner: to.clone(), minted_by: caller.clone(), minted_at: ts,
            burned_at: None, burned_for_unit_key: None, burned_for_request_id: None,
        };
        self.passes.insert(&new_id, &new_pass);

        let mut owned = self.pass_owner_idx.get(&to).unwrap_or_else(|| {
            UnorderedSet::new(SK::POS { h: to.as_bytes().to_vec() })
        });
        owned.insert(&new_id);
        self.pass_owner_idx.insert(&to, &owned);

        // Sidecar lineage links
        let mut old_link = self.pass_links.get(&old_pass_id).unwrap_or(PassLink { previous_id: None, rebirth_id: None });
        old_link.rebirth_id = Some(new_id);
        self.pass_links.insert(&old_pass_id, &old_link);
        self.pass_links.insert(&new_id, &PassLink { previous_id: Some(old_pass_id), rebirth_id: None });

        Event::PassReborn { old_id: old_pass_id, new_id }.emit();
        self.charge(u0);
        new_id
    }

    /// Get lineage record for a pass (sidecar). None = no rebirth lineage.
    pub fn get_pass_link(&self, id: u64) -> Option<PassLink> { self.pass_links.get(&id) }

    // ── Owner admin ──────────────────────────────────────────────────────────

    #[payable]
    pub fn deactivate_node(&mut self, id: AccountId) {
        let u0 = env::storage_usage();
        assert_eq!(env::predecessor_account_id(), self.owner, "{}", err::NOT_OWNER);
        let mut node = self.nodes.get(&id).expect(err::NODE_NOT_FOUND);
        node.active = false;
        self.nodes.insert(&id, &node);
        self.charge(u0);
    }

    #[payable]
    pub fn deactivate_org(&mut self, id: AccountId) {
        let u0 = env::storage_usage();
        assert_eq!(env::predecessor_account_id(), self.owner, "{}", err::NOT_OWNER);
        let mut org = self.orgs.get(&id).expect(err::ORG_NOT_FOUND_ADMIN);
        org.active = false;
        self.orgs.insert(&id, &org);
        self.charge(u0);
    }

    pub fn get_owner(&self) -> AccountId { self.owner.clone() }

    // ── Protocol fee: admin (owner-only) + views (V5) ──────────────────────────
    // The admin surface is money-adjacent: whoever holds the owner key can waive anyone's fee,
    // set the treasury, or set the toll. Every mutator emits an event so partners/observers can
    // audit their status and the fee parameters on-chain.

    /// Add (or re-label) an exempt caller. Owner-only. `tier` is metadata (0=us, 1=partner) — the
    /// toll is waived identically for any exempt account regardless of tier.
    #[payable]
    pub fn add_exempt(&mut self, account: AccountId, tier: u8) {
        let u0 = env::storage_usage();
        assert_eq!(env::predecessor_account_id(), self.owner, "{}", err::NOT_OWNER);
        self.exempt.insert(&account, &tier);
        Event::ExemptAdded { account, tier }.emit();
        self.charge(u0);
    }

    /// Remove an exempt caller (e.g. a partner deal ended — done manually). Owner-only.
    #[payable]
    pub fn remove_exempt(&mut self, account: AccountId) {
        let u0 = env::storage_usage();
        assert_eq!(env::predecessor_account_id(), self.owner, "{}", err::NOT_OWNER);
        self.exempt.remove(&account);
        Event::ExemptRemoved { account }.emit();
        self.charge(u0);
    }

    /// Set the flat per-call toll (yoctoNEAR). Owner-only. 0 turns the toll off (storage-cover still
    /// applies to non-exempt callers). The owner nudges this as the NEAR price drifts (no oracle).
    #[payable]
    pub fn set_toll(&mut self, yocto: near_sdk::json_types::U128) {
        let u0 = env::storage_usage();
        assert_eq!(env::predecessor_account_id(), self.owner, "{}", err::NOT_OWNER);
        self.toll_yocto = yocto.0;
        Event::TollSet { yocto }.emit();
        self.charge(u0);
    }

    /// Set the treasury account tolls are swept to. Owner-only. Defaults to the owner at init/migrate.
    #[payable]
    pub fn set_treasury(&mut self, treasury: AccountId) {
        let u0 = env::storage_usage();
        assert_eq!(env::predecessor_account_id(), self.owner, "{}", err::NOT_OWNER);
        self.treasury = treasury.clone();
        Event::TreasurySet { treasury }.emit();
        self.charge(u0);
    }

    /// Current per-call toll (yoctoNEAR).
    pub fn get_toll(&self) -> near_sdk::json_types::U128 { near_sdk::json_types::U128(self.toll_yocto) }

    /// Current treasury account.
    pub fn get_treasury(&self) -> AccountId { self.treasury.clone() }

    /// Exempt tier for an account, or None if not exempt. (Owner is always effectively exempt but is
    /// NOT listed here — this reflects the explicit exempt map only.)
    pub fn is_exempt(&self, account: AccountId) -> Option<u8> { self.exempt.get(&account) }

    /// The minimum deposit `caller` should attach for a call that writes `est_bytes` new bytes of
    /// storage. Lets an integrator client attach the exact amount (storage-cover + toll) rather than
    /// guess. Exempt callers (owner + exempt list) need attach nothing → returns 0. For non-exempt
    /// callers `est_bytes` must be estimated off-chain (it depends on the specific args); a caller can
    /// simply over-attach and rely on the automatic refund of the excess. Returned in yoctoNEAR.
    pub fn required_deposit(&self, caller: AccountId, est_bytes: u64) -> near_sdk::json_types::U128 {
        if self.is_caller_exempt(&caller) {
            return near_sdk::json_types::U128(0);
        }
        let storage_cost = env::storage_byte_cost().saturating_mul(est_bytes as u128);
        let need = storage_cost.saturating_add(NearToken::from_yoctonear(self.toll_yocto));
        near_sdk::json_types::U128(need.as_yoctonear())
    }
}
