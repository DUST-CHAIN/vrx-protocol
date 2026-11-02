# VRX Ingest Pack — the developer onboarding handoff format

> **Status: SCHEMA / SPEC. Not an app yet.** This folder defines the **plug-in pack** a developer
> assembles off-site and VRX root imports, vets, and selectively "turns active". It is the ground-truth
> contract between the future **developer-side materials app** and the VRX server importer. Grounded in
> the real server data model (`portal/lib/catalog.ts`); will evolve with it (keep the two in lockstep).


Developer onboarding is **INGEST, not CRUD**. A developer should NOT hand-type units into our UI.
Instead, an **external app runs on the developer's own machine** (eventually Electron + local AI, running
on their **Node**). With our assistants/sellers working in parallel, the developer's team uses that app to:

1. **Collect all unit data** (floors, numbers, types, sizes, prices, views, terms) — import from a
   spreadsheet / price list, AI-assisted extraction from their existing materials.
2. **Assign + crop + brand/tune all images** (renderings, floor plans, level plans, per unit/type/floor).
3. **Preview the rich-media pages** exactly as they'll appear on the VRX server — the app ships the same
   templates we render from, so what they tune is what goes live.
4. **Export a ZIP = the ingest pack** — a complete, self-describing bundle: every building, unit, price,
   image, terms, and the entity tree.

VRX root then **imports the ZIP, vets it, and selectively activates** the developer and each of their
projects (nothing goes live until root turns it active). The pack is a *proposal*; activation is ours.

## Why a pack (not a live API the developer calls)

- **Parallel + offline:** the developer's team + our sellers fill it in over days, no live connection.
- **Vettable:** root reviews a frozen, hashable artifact before anything touches the chain or the public
  catalog. Matches the vetted-network moat (onboarding is owner-gated).
- **Verifiable chain-of-data:** the pack is a TREE (below). Hashing the tree gives a content identifier
  for the whole developer + every project/building/unit — a provenance fingerprint we can anchor
  on-chain later (opaque) so "this is the pack root vetted + activated" is provable.


Reality is a tree, and data is **reused by inheritance** down it. We model it the same way so shared
facts live once and children inherit them:

```
Developer (person / holding company)
└─ Company (the specific legal entity a project is registered under)
   └─ Complex (a multi-building development; shared marketing + facilities)
      └─ Building (inherits complex facilities + branding + trust from the company/developer)
         └─ UnitType (shared floor plan, size range, default terms)
            └─ Unit (inherits building + complex + company; carries only its own specifics)
```

- A unit **inherits** the building's & complex's shared facilities/images; overrides only what's unique.
- Trust/brand **derives** from the developer and their companies (a buyer trusts the unit because of the
  chain above it).
- The same tree models the OTHER side too (VRX → agencies → their agents → contacts) — out of scope for
  the ingest pack, but the structure is deliberately the same so it generalises.

This mirrors the image dedup already shipped: the shared Parkside/Seabreeze marketing sets are stored
ONCE per complex and buildings inherit them (`portal/lib/mm.ts`).

## Pack layout (the ZIP)

```
pack/
  pack.json            # manifest: schema version, developer + company, declared tree, checksums
  complexes/
    <complexId>/
      complex.json     # complex-level: name, area, shared amenities, shared media refs
      media/           # complex-shared renderings (inherited by all its buildings)
  buildings/
    <buildingId>/
      building.json    # one Building (see schema/building.schema.json) — inherits its complex
      units.csv        # the unit inventory (one row per unit) — bulk, spreadsheet-friendly
      media/
        renderings/    # building-specific renderings (ext_/int_/fac_)
        units/         # unit floor plans keyed {TYPE}_{SUBTYPE}
        levels/        # per-floor level plans {floor}
  terms/
    <id>.json          # reusable PaymentTerms blocks referenced by buildings/units
```

- **`units.csv`** keeps the bulk inventory in the format the developer already has (price lists are
  spreadsheets). The app validates it against `schema/unit.columns.md` and converts to `Unit[]` on import.
- **Media** is referenced by the naming convention the server already resolves (type+subtype for unit
  plans, floor number for level plans) so the import is deterministic — no hand-mapping.

## How VRX imports it (target flow — not built)

1. Root uploads the ZIP in the VRX admin dashboard.
2. Importer validates `pack.json` against `schema/pack.schema.json`, checks checksums, resolves the tree.
3. Preview: root sees the exact rich-media pages (same templates the developer previewed).
4. **Vet → activate selectively:** root turns the developer active, then each complex/building, in its own
   time. Unactivated packs sit staged. Mirrors the current `.data/catalog.json` seed path but gated.
5. On activate, units become stampable on-chain via the existing owner-gated flow (contract UNCHANGED).

## Relationship to what's already built

- The **server already consumes this shape** — `portal/lib/catalog.ts` `Building`/`Unit`/`PaymentTerms`
  ARE the target types. An internal DB→seed importer is today's version; the ingest pack is the
  generalised, developer-facing, offline version of the same import.
- Demo seed data will be **discarded at mainnet**; real developers come in via packs,
  built to perfection in their own app.

See `schema/` for the formal definitions and `examples/` for a minimal valid pack.
