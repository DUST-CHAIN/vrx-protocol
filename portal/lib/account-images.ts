// ACCOUNT → IMAGE index — SERVER-ONLY (file-backed). The thin join from a system account to the imageIds of
// its stored images, so the UI can ask "what is <account>'s avatar icon?" and the ID-card can ask "what is
// <account>'s passport image?" without scanning the whole provenance ledger. (photo subsystem.)
//
// The PROVENANCE ledger (lib/image-provenance) is the tamper-evident source of truth for who/when/on-behalf-of.
// THIS store is the fast lookup index — one row per account holding the CURRENT portrait + passport imageIds
// (a re-upload overwrites the slot; the old image's provenance row stays in the append-only ledger). Keyed by
// subject account. Same .data file-backed pattern; under portal/.data (gitignored).

import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "account-images.json");

/** Which slot an image fills for an account. `portrait` = public avatar icon. `passport` = sensitive ID doc. */
export type ImageSlot = "portrait" | "passport";

export type AccountImages = {
  account: string; // lower-cased subject account
  /** The current PUBLIC portrait imageId (avatar/header mark). */
  portrait?: string;
  /** The current SENSITIVE passport/ID imageId (gated to self/consented). */
  passport?: string;
  updatedAt: number;
};

const norm = (a: string) => a.trim().toLowerCase();

async function readAll(): Promise<AccountImages[]> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p as AccountImages[]) : [];
  } catch {
    return [];
  }
}
async function writeAll(list: AccountImages[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(list, null, 2), "utf8");
}

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: AccountImages[]) => Promise<{ next: AccountImages[]; ret: T }>): Promise<T> {
  const run = chain.then(async () => {
    const list = await readAll();
    const { next, ret } = await fn(list);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

/** Set (overwrite) one slot's imageId for an account. Creates the row if absent. */
export async function setAccountImage(account: string, slot: ImageSlot, imageId: string): Promise<AccountImages> {
  const a = norm(account);
  return mutate(async (list) => {
    const idx = list.findIndex((r) => r.account === a);
    const base: AccountImages = idx >= 0 ? list[idx] : { account: a, updatedAt: 0 };
    const rec: AccountImages = { ...base, [slot]: imageId, updatedAt: Date.now() };
    const next = idx >= 0 ? list.map((r, i) => (i === idx ? rec : r)) : [...list, rec];
    return { next, ret: rec };
  });
}

/** The image slots for one account (undefined fields when absent). null if the account has no images at all. */
export async function imagesFor(account: string): Promise<AccountImages | null> {
  const a = norm(account);
  return (await readAll()).find((r) => r.account === a) ?? null;
}

/** TEST-ONLY: wipe the index. */
export async function __resetForTests(): Promise<void> {
  await writeAll([]);
}
