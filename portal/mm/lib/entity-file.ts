// Browser glue for the reuse ops: download an entity envelope as a .json file, and read one back from a picked
// file. The PURE core (lib/project-reuse.ts) builds/parses envelopes; this is the one impure DOM corner that
// turns them into real downloads/uploads (kept out of the pure module so that stays React- and DOM-free + tested).
// the design docs §3a (export/import at every level).

import { type EntityEnvelope, parseEnvelope } from "./project-reuse";
import { slugify } from "./pack";

/** A readable default filename for an exported entity, e.g. "mm-building-tower-a.json". */
export function entityFilename(env: EntityEnvelope): string {
  const name =
    (env.data as { name?: string; id?: string }).name ||
    (env.data as { id?: string }).id ||
    env.level;
  return `mm-${env.level}-${slugify(String(name)) || env.level}.json`;
}

/** Trigger a browser download of the envelope as pretty-printed JSON. No-op outside the browser. */
export function downloadEntity(env: EntityEnvelope, filename = entityFilename(env)): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([JSON.stringify(env, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke on the next tick so the click has fired
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Read a picked File and parse it as an entity envelope. Resolves null for anything that isn't a valid envelope
 *  (never rejects on bad JSON — the caller just shows "not a valid MM entity file"). */
export function readEntityFile(file: File): Promise<EntityEnvelope | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(parseEnvelope(JSON.parse(String(reader.result))));
      } catch {
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}
