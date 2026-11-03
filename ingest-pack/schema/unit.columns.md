# `units.csv` — the unit inventory columns

One row per unit. Price lists are already spreadsheets, so the inventory stays CSV (the materials app
validates + converts to the server's `Unit[]` on export; the VRX importer re-validates). UTF-8, header
row required, comma-separated. Columns map 1:1 to `portal/lib/catalog.ts` `Unit` (keep in lockstep).

| column         | required | type        | maps to `Unit.`   | notes |
|----------------|----------|-------------|-------------------|-------|
| `id`           | yes      | string      | `id`              | Stable unit id / human ref, e.g. `unit-1204`. Unique within the building. |
| `type`         | yes      | string      | `type`            | UnitType.key — `studio`/`1br`/`2br`/`shop`/`duplex`/`penthouse`. Drives floor-plan prefix. |
| `subtype`      | rec.     | string      | `subtype`         | Letter A/B/C… — WITH `type`, selects the unit floor plan (`{PREFIX}_{SUBTYPE}`). Get this right → correct plan per unit, no mixup. |
| `floor`        | yes      | integer     | `floor`           | Selects the level plan (`levels/{floor}`). |
| `unitNumber`   | rec.     | integer     | `unitNumber`      | Real unit number, e.g. 1204. |
| `sqm`          | yes      | number      | `sqm`             | Current authoritative size (m²). |
| `sqmBefore`    | no       | number      | `sqmStages.beforeBuilding` | Staged area (presale). |
| `sqmAfter`     | no       | number      | `sqmStages.afterBuilding`  | Staged area (built). |
| `sqmFinal`     | no       | number      | `sqmStages.final` | Staged area (Land-Office final). |
| `priceUsd`     | yes      | number      | `priceUsd`        | Headline list price, USD base (server converts currencies). |
| `priceFreehold`| no       | number      | `pricing.freeholdUsd` | Dual pricing (quota buildings). |
| `priceCompany` | no       | number      | `pricing.companyUsd`  | Dual pricing (quota buildings). |
| `view`         | no       | string      | `view`            | Normalised, e.g. `Sea view`, `Pool view`. |
| `corner`       | no       | boolean     | `corner`          | `true`/`false`. |
| `baths`        | no       | integer     | `baths`           | |
| `note`         | no       | string      | `note`            | Free per-unit note. |
| `termsRef`     | no       | string      | `terms` (override)| Id of a `terms/<id>.json` block overriding the building default. Absent = inherit building. |

**NOT a column:** ownership (freehold/company/private). Ownership is a property of the BUYER/sale, not the
unit — chosen at reservation. The foreign quota is a building-level number (see building.schema.json
`quota`), never a per-unit tag.

**Off-market state** (`blocked`/`killed`) is also NOT in the import — it's a developer action
taken LATER in the live system, with its own audit trail; a freshly-imported unit is always on-market.

## Media naming (deterministic — no hand-mapping at import)

Images resolve from the unit's own fields, so the developer just names files by the convention and the
import wires them automatically:

- **Unit floor plan:** `buildings/<id>/media/units/{PREFIX}_{SUBTYPE}.(jpg|png)` — one plan shared by all
  units of that type+subtype. PREFIX: STD/1BR/2BR/SHP/DPX/PTH.
- **Level plan:** `buildings/<id>/media/levels/{floor}.(jpg|png)`.
- **Building renderings:** `buildings/<id>/media/renderings/{ext_|int_|fac_}*` (exterior/interior/facilities).
- **Complex-shared marketing:** `complexes/<complexId>/media/...` — inherited by every building in the
  complex (stored once; the inheritance model). Same `ext_/int_/fac_` prefixes.
