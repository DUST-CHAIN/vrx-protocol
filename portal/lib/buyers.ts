// Off-chain BUYER ROSTER — SERVER-ONLY (file-backed). The "agent owns a customer roster" record,
// built as the THIRD consumer of the "Attested Off-Chain Records" spine (the design docs —
// offers were first, agreements second). Same shape, deliberately: plaintext off-chain + a salted hash
// SEAL + re-hash to verify. One pattern, N consumers (the "scan for the reusable PATTERN").
//
// WHAT IT IS: "the agent should have his roster of customers and their deals." A buyer /
// customer is a REUSABLE record the AGENT owns and reuses across deals. A booking then ATTACHES a buyer +
// a SNAPSHOT of whatever buyer detail exists at booking time (which may legitimately be minimal) —
// that snapshot rides in the offer seal's `buyer` slot (lib/seal.ts / lib/offers.ts), so the developer
// inbox shows the buyer block and the on-chain request_hash seals it. This store is the roster SIDE: the
// agent's private, living list of customers the booking flow picks from.
//
// STAGED / DEVELOPER-DEFINED DETAIL — NOT in this slice: the developer defines what buyer detail is
// required and it's staged (enough to book+deposit now, fuller legal detail before signing). For now the
// roster carries a FIXED, sensible field set; the developer's completeness-policy dial is a later arc. The
// inbox already shows a simple "detail not yet provided" / present state (node/page.tsx BuyerBlock), which
// is all this slice needs. REVISIONS + encrypted VAULT/PWA are also deferred.
//
// Same file-backed.data pattern as offers.ts / agreements.ts. The real architecture keeps each
// party's records on their OWN node; this .data store is the demo stand-in — a buyer belongs to its
// owning agent, so the store is keyed by agent and an agent may only ever see its own roster.
//
// PRIVACY: SERVER-SIDE ONLY; holds buyer plaintext (PII) deliberately — it is the AGENT's private
// copy and must never be exposed to another party. The chain carries at most the opaque seal hash, folded
// into a booking's request_hash when a buyer is attached. Nothing here goes on-chain by itself.

import { promises as fs } from "fs";
import path from "path";
import { digest, newSalt } from "./seal";
import { TITLES, composeName, type Title } from "./buyer-snapshot";

/** The seal domain tag for buyer records (public namespace; the SECRET is the per-record salt). */
const BUYER_DOMAIN = "vrx-buyer";

/**
 * The buyer plaintext fields. A FIXED, sensible set for this slice ('s developer-defined policy is a
 * later arc). All optional except `name` — "if some [detail is] missing it's ok, but the developer must
 * see that straight away and can refuse the booking when it's not clear enough who the buyer is".
 * The snapshot that rides in a booking is derived from these (see `buyerSnapshot`).
 */
export type BuyerFields = {
  /** The buyer's name / how the agent refers to them. The one field we require to create a record. When the
   *  structured parts below are set, this is COMPOSED from them (Title + First + Middle + Last) by composeName;
   *  otherwise it's whatever the agent typed. See lib/buyer-snapshot.ts (the shared, client-safe definitions). */
  name: string;
  /** Honorific — one of TITLES (a closed set; the server rejects anything else). name-split. */
  title?: Title;
  /** Given / first name. */
  firstName?: string;
  /** Preferred name / nickname — a separate sealed hint, NOT folded into the legal composed `name`. */
  nickName?: string;
  /** Middle name(s). */
  middleName?: string;
  /** Family / last name. */
  lastName?: string;
  /** Contact phone (free-form; off-chain, never validated as an identity). */
  phone?: string;
  /** Contact email. NB: never the forbidden personal inbox — this is the buyer's own, entered by the agent. */
  email?: string;
  /** Nationality / citizenship — relevant to the freehold-quota buyer type but kept descriptive here. */
  nationality?: string;
  /** An opaque ID reference the agent holds (passport/ID no.) — free text; we do NOT verify it, we snapshot it. */
  idRef?: string;
  /** Agent-PRIVATE note the agent keeps about this customer (their own CRM memory) — default-hidden from the
   *  developer. For free-text the developer SHOULD see, use `remarks` instead (the two are deliberately split). */
  note?: string;
  /** FREE-TEXT context intended for the DEVELOPER (anything they should know about this buyer/deal) — distinct
   *  from the agent-private `note`. Default-hidden in the booking mask until the agent chooses to show it. */
  remarks?: string;
};

/** A buyer record the agent owns. Mirrors Offer/Agreement: plaintext + salted seal + provenance. */
export type Buyer = {
  /** Opaque record id (the store key). Generated server-side on create. */
  id: string;
  /** The owning AGENT account. An agent may only read/write buyers where this matches their own account. */
  agent: string;
  /** The buyer plaintext the agent entered. */
  fields: BuyerFields;
  /** Per-record secret salt (hex) — stored next to the plaintext, used to re-verify. NEVER on-chain. */
  salt: string;
  /** SHA-256(domain | salt | stableStringify(fields)) — the tamper-evident seal of the record as created. */
  sealHash: string;
  /** ms epoch created. */
  at: number;
  /** ms epoch last updated (== at on create). An edit re-seals (new salt+hash) — simple overwrite, no revisions yet. */
  updatedAt: number;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "buyers.json");

async function readAll(): Promise<Buyer[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Buyer[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: Buyer[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

/** Normalize + trim the plaintext fields; drop empty optionals so the seal is stable (no "" vs undefined drift). */
function cleanFields(raw: unknown): BuyerFields | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  //  name-split — structured parts (field-type safe: the title is COERCED to the closed TITLES set, never
  // trusted free text; everything else is trimmed strings). When any part is set, the display/legal `name` is
  // COMPOSED from Title+First+Middle+Last so name ↔ parts can never disagree; otherwise the free-typed `name`
  // stands (full backward compatibility with pre-split records).
  const rawTitle = str(r.title);
  const title = (TITLES as readonly string[]).includes(rawTitle) ? (rawTitle as Title) : "";
  const firstName = str(r.firstName);
  const nickName = str(r.nickName);
  const middleName = str(r.middleName);
  const lastName = str(r.lastName);
  const hasParts = Boolean(title || firstName || middleName || lastName);
  const composed = composeName({ title, firstName, middleName, lastName });
  const name = hasParts && composed ? composed : str(r.name);
  if (!name) return null; // name is the one required field (enough to identify a real customer)

  const f: BuyerFields = { name };
  if (title) f.title = title;
  if (firstName) f.firstName = firstName;
  if (nickName) f.nickName = nickName;
  if (middleName) f.middleName = middleName;
  if (lastName) f.lastName = lastName;
  const phone = str(r.phone);
  const email = str(r.email);
  const nationality = str(r.nationality);
  const idRef = str(r.idRef);
  const note = str(r.note);
  const remarks = str(r.remarks);
  if (phone) f.phone = phone;
  if (email) f.email = email;
  if (nationality) f.nationality = nationality;
  if (idRef) f.idRef = idRef;
  if (note) f.note = note;
  if (remarks) f.remarks = remarks;
  return f;
}

/** The whole roster for one agent (case-insensitive account match), newest first. */
export async function listForAgent(agent: string): Promise<Buyer[]> {
  const a = agent.trim().toLowerCase();
  if (!a) return [];
  return (await readAll())
    .filter((b) => b.agent.toLowerCase() === a)
    .sort((x, y) => y.updatedAt - x.updatedAt);
}

/** One buyer by id, SCOPED to its owning agent (returns null if the id isn't that agent's — never leak another's). */
export async function getBuyerForAgent(id: string, agent: string): Promise<Buyer | null> {
  const a = agent.trim().toLowerCase();
  const rec = (await readAll()).find((b) => b.id === id.trim());
  return rec && rec.agent.toLowerCase() === a ? rec : null;
}

/**
 * Create or update a buyer the given agent owns. On create a fresh id + salt are generated and the record
 * sealed. On update (existing id owned by this agent) the fields are re-sealed with a NEW salt (an edit is a
 * new attestation — no revision history yet, just a clean overwrite). Returns the saved record, or null
 * if the fields are invalid (no name) or the id exists but belongs to a DIFFERENT agent (never cross-write).
 */
export async function saveBuyerForAgent(
  agent: string,
  fields: unknown,
  id?: string
): Promise<Buyer | null> {
  const a = agent.trim();
  if (!a) return null;
  const clean = cleanFields(fields);
  if (!clean) return null;

  const list = await readAll();
  const now = Date.now();
  const salt = newSalt();
  const sealHash = digest(clean as unknown as Record<string, unknown>, BUYER_DOMAIN, salt);

  if (id) {
    const idx = list.findIndex((b) => b.id === id.trim());
    if (idx >= 0) {
      if (list[idx].agent.toLowerCase() !== a.toLowerCase()) return null; // not yours — refuse
      list[idx] = { ...list[idx], fields: clean, salt, sealHash, updatedAt: now };
      await writeAll(list);
      return list[idx];
    }
    // id given but not found → fall through and create with that id (idempotent seed replays)
  }

  const rec: Buyer = {
    id: id?.trim() || `buyer-${now}-${Math.random().toString(36).slice(2, 8)}`,
    agent: a,
    fields: clean,
    salt,
    sealHash,
    at: now,
    updatedAt: now,
  };
  list.push(rec);
  await writeAll(list);
  return rec;
}

/** The ✓-verifiable check: re-hash the held fields with the record's salt and compare to its seal. */
export function verifyBuyer(b: Buyer): boolean {
  try {
    if (!b?.salt || !b?.sealHash) return false;
    return digest(b.fields as unknown as Record<string, unknown>, BUYER_DOMAIN, b.salt) === b.sealHash;
  } catch {
    return false;
  }
}

// The attested SNAPSHOT that rides in a booking's offer seal lives in lib/buyer-snapshot.ts — a PURE
// module with no crypto import, so the agent screen can import it client-side without pulling Node's crypto
// into the browser bundle. Server callers that hold a full Buyer use this thin adapter.
import { buyerSnapshot } from "./buyer-snapshot";
export { buyerSnapshot } from "./buyer-snapshot";

/** Server convenience: the booking snapshot for a full roster record. */
export function snapshotOf(b: Buyer): Record<string, string> {
  return buyerSnapshot(b.fields);
}
