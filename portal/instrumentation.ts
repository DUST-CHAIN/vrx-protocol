// Next.js server bootstrap (runs ONCE when the server process starts — the official seam for background
// work). We use it to optionally start the availability indexer poller (Slice 3, INDEXER_DESIGN.md).
//
// OPT-IN BY DESIGN: the poller runs a steady background chain poll, so it must be turned on
// DELIBERATELY, never by default — on the free FastNEAR keys an always-on loop is exactly the kind of load
// we want to enable on purpose (the Coolify box, or a dev explicitly testing it), not every `npm run dev`.
// Set VRX_INDEXER=1 to enable. Off → the module + its tested logic still ship; only the live loop is idle.
//
// Node runtime only (the poller uses fs/crypto/timers). CRITICAL: the Node-only graph lives in a
// SEPARATE module (instrumentation.node.ts) imported ONLY on the nodejs branch — Next compiles this file for
// edge too, and even a dynamic import in this file gets traced for the edge bundle (which can't resolve
// `fs`). Delegating to instrumentation.node.ts keeps that graph out of the edge trace. See that file's note.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNode } = await import("./instrumentation.node");
  await registerNode();
}
