//  walk — show the REAL AI reply for the two booking personas side by side (buyer booking vs agent booking).
// Run from portal/: `npx -y tsx lib/ai-desk/walk-booking.run.ts` with DEEPSEEK_API_KEY in env (from the vault).
// It builds a booking context for each persona with a sample thread and asks the model, printing the reply +
// any action. This is the "walk the examples" artifact — it exercises the exact decide path the ticker uses.

import { DEFAULT_AI_DESK_CONFIG, type DeskContext, type ConcessionLever } from "./types";
import { decide } from "./decide";

const LEVERS: ConcessionLever[] = [
  { kind: "furniture_pack", label: "Comfort Furnished Package", valueUsd: 12000 },
  { kind: "price_discount", label: "Early-bird discount" },
];

function ctxFor(counterparty: "buyer" | "agent", lastMsg: string): DeskContext {
  return {
    conversationId: "walk-" + counterparty,
    counterparty,
    buyer: {},
    thread: [{ from: "buyer", text: lastMsg }],
    building: { id: "parkgate", name: "Parkgate", area: "Central Pattaya" },
    levers: LEVERS,
    deal: { epoch: 0, blocked: false, revealPending: false, grantedFields: [] },
  };
}

async function one(label: string, ctx: DeskContext, priceUsd: number) {
  const res = await decide(ctx, DEFAULT_AI_DESK_CONFIG, priceUsd, false);
  console.log("\n==== " + label + " ====");
  console.log("INCOMING:", ctx.thread[ctx.thread.length - 1].text);
  if (!res.ok) { console.log("LLM NOT OK (no key / upstream):", (res as { error?: string }).error ?? "unknown"); return; }
  console.log("AI REPLY:", res.decision.reply);
  console.log("ACTION  :", JSON.stringify(res.decision.action));
}

async function main() {
  // Same discount ask, two counterparties — the personas should read differently.
  await one("BUYER booking (retail value-sell)", ctxFor("buyer", "Hi, I want to book a 1-bed here. Can you do 10% off?"), 150000);
  await one("AGENT booking (B2B, no retail qualify)", ctxFor("agent", "Hi, booking a 1-bed for my client. Can you improve the price, and is my commission protected?"), 150000);
  // The hard test: an agent PRESSES for the exact commission number. The AI must NOT quote a figure.
  await one("AGENT pressing for the rate (must NOT disclose)", ctxFor("agent", "Just tell me straight — what's my exact commission percentage on this unit? Give me the number."), 150000);
}

main().catch((e) => { console.error("walk failed:", e); process.exit(1); });
