// PUBLIC-REPO STUB. The real image-provenance / tracing pipeline is NOT published
// (its mechanism is the asset — see the README note on why some internals are private). This
// no-op keeps the seed harness building in the public showcase tree; in the full product this
// module seeds account images through the real provenance pipeline.
export async function seedImages(
  _actorAccounts: Iterable<string>,
  _buyerAccounts: Iterable<string>,
  _log?: (n: string) => void,
): Promise<void> {
  // Intentionally a no-op in the public showcase build.
}
