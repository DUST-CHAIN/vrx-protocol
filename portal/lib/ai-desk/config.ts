// AI Sales Director — config store. SERVER-ONLY, file-backed; same.data idiom as lib/gates.ts /
// lib/ai-help-server.ts. Holds the single AiDeskConfig (the per-action authority toggles + bounds + spend cap)
// that the autoresponder lane reads and the VRX-root panel writes. Missing/garbage file → DEFAULT_AI_DESK_CONFIG
// (fail-safe: an unreadable config does NOT silently enable the AI — `enabled` defaults OFF).

import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_AI_DESK_CONFIG, type AiDeskConfig } from "./types";

// Resolve at CALL time, not import time, so a test that chdir's into a temp cwd AFTER importing still reads/
// writes that temp dir (the other .data stores bind at import; this one is import-order-agnostic on purpose).
const dataDir = () => path.join(process.cwd(), ".data");
const storePath = () => path.join(dataDir(), "ai-desk-config.json");

/** Coerce an arbitrary parsed object to a full AiDeskConfig, filling any missing/invalid field from the default
 *  (so adding a new config key later never breaks an old on-disk file). PURE — exported for the test. */
export function coerceConfig(raw: unknown): AiDeskConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (k: keyof AiDeskConfig) =>
    typeof o[k] === "boolean" ? (o[k] as boolean) : (DEFAULT_AI_DESK_CONFIG[k] as boolean);
  const num = (k: keyof AiDeskConfig) =>
    typeof o[k] === "number" && isFinite(o[k] as number) ? (o[k] as number) : (DEFAULT_AI_DESK_CONFIG[k] as number);
  // The signing posture is a small string union — accept only known values, else fall back to the default (so a
  // garbage/legacy file never selects an undefined posture; fail-safe to the inert "soft_hold" stub).
  const POSTURES: AiDeskConfig["signingPosture"][] = ["soft_hold", "vault", "demo_key"];
  const signingPosture = POSTURES.includes(o.signingPosture as AiDeskConfig["signingPosture"])
    ? (o.signingPosture as AiDeskConfig["signingPosture"])
    : DEFAULT_AI_DESK_CONFIG.signingPosture;
  return {
    enabled: bool("enabled"),
    autoReply: bool("autoReply"),
    canRequestReveal: bool("canRequestReveal"),
    canConcede: bool("canConcede"),
    canCallOff: bool("canCallOff"),
    canBlock: bool("canBlock"),
    canOpenUnit: bool("canOpenUnit"),
    maxConcessionPct: Math.min(1, Math.max(0, num("maxConcessionPct"))), // clamp to [0,1]
    piiScrubChat: bool("piiScrubChat"),
    spendCapTokensPerDay: Math.max(0, num("spendCapTokensPerDay")),
    signingPosture,
  };
}

/** Read the live config (DEFAULT if no file / unreadable — fail-safe, AI stays OFF). */
export async function getAiDeskConfig(): Promise<AiDeskConfig> {
  try {
    return coerceConfig(JSON.parse(await fs.readFile(storePath(), "utf8")));
  } catch {
    return { ...DEFAULT_AI_DESK_CONFIG };
  }
}

/** Write a partial update over the current config (the root panel sends only the changed fields). Returns the
 *  new full config. Serialized through a simple chain so concurrent toggles can't lose a write. */
let chain: Promise<unknown> = Promise.resolve();
export async function updateAiDeskConfig(patch: Partial<AiDeskConfig>): Promise<AiDeskConfig> {
  const run = chain.then(async () => {
    const cur = await getAiDeskConfig();
    const next = coerceConfig({ ...cur, ...patch });
    await fs.mkdir(dataDir(), { recursive: true });
    await fs.writeFile(storePath(), JSON.stringify(next, null, 2), "utf8");
    return next;
  });
  chain = run.catch(() => {});
  return run as Promise<AiDeskConfig>;
}
