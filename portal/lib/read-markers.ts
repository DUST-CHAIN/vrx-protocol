// Server-side READ-MARKERS — SERVER-ONLY (file-backed). The durable "what has this party already seen" store
// for the everlasting unit chat (notify-on-login). Replaces the per-BROWSER localStorage unread hack
// (app/agent "there's no server read-marker yet and faking one would be dishonest") with a server truth, so
// unread survives across devices and logins — the "log on anywhere → see the notification" behaviour
// wants for a chat that lives for years.
//
// SHAPE: a map  viewerAccount → { requestId → seenCount }  where seenCount is the message count that viewer
// had seen in that thread the last time they opened it. A thread is UNREAD for a viewer when its current
// msgCount exceeds their seenCount (and — the caller's concern — the newest message isn't their own). We
// store a COUNT, not timestamps: the thread store already exposes msgCount (lib/channels), so this stays a
// cheap integer diff and never duplicates message bodies here.
//
// PRIVACY: no PII, no message bodies — only neutral account ids, opaque requestIds, and integers. The
// marker is per-viewer; a viewer can only ever read/write their OWN markers (enforced by the route, which
// also checks the viewer is a participant of the thread via lib/participant). The chain is untouched.
//
// Same file-backed .data + serialized-mutate pattern as channels.ts / offers.ts.

import { promises as fs } from "fs";
import path from "path";

/** viewer account → (requestId → last-seen message count). */
type Store = Record<string, Record<string, number>>;

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE = path.join(DATA_DIR, "read-markers.json");

async function readAll(): Promise<Store> {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

async function writeAll(store: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(store, null, 2), "utf8");
}

// Serialize writes (read-modify-write can't interleave) — same discipline as channels.ts/offers.ts.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (store: Store) => { next: Store; ret: T }): Promise<T> {
  const run = chain.then(async () => {
    const cur = await readAll();
    const { next, ret } = fn(cur);
    await writeAll(next);
    return ret;
  });
  chain = run.catch(() => {});
  return run;
}

/** The whole seen-map for one viewer (requestId → seenCount). Empty if they've never marked anything. */
export async function seenFor(viewer: string): Promise<Record<string, number>> {
  const v = viewer.trim().toLowerCase();
  if (!v) return {};
  return (await readAll())[v] ?? {};
}

/**
 * Mark one thread SEEN for a viewer at a given message count (monotonic — a replay with a lower count never
 * un-sees messages, so an out-of-order request can't resurrect unread). Returns the stored count after.
 */
export async function markSeen(viewer: string, requestId: string, count: number): Promise<number> {
  const v = viewer.trim().toLowerCase();
  const id = requestId.trim();
  const c = Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  if (!v || !id) return 0;
  return mutate((store) => {
    const mine = { ...(store[v] ?? {}) };
    const prev = mine[id] ?? 0;
    const nextCount = Math.max(prev, c); // monotonic — never go backwards
    mine[id] = nextCount;
    return { next: { ...store, [v]: mine }, ret: nextCount };
  });
}
