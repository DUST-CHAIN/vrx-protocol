"use client";

// The center editor — "one logical frame" that re-focuses on whatever the tree selected. Each entity is a
// form bound to usePack setters (immutable). Inheritance shown read-only (a building echoes its complex/dev).
// Units get their own grid+import surface (UnitsEditor). Law #1: never blocks; law #2: partial is fine.

import type { PackApi } from "./usePack";
import { Field, ListInput, NumberInput, SelectInput, TextArea, TextInput } from "./fields";
import { UnitsEditor } from "./UnitsEditor";
import { MediaCard } from "./MediaCard";
import { slugify } from "@/lib/pack";

export function Editor({ api }: { api: PackApi }) {
  const { pack, selection } = api;

  switch (selection.kind) {
    case "developer":
      return <DeveloperForm api={api} />;
    case "company": {
      const c = pack.companies.find((x) => x.id === selection.id);
      if (!c) return <Missing what="company" />;
      return <CompanyForm api={api} id={c.id} />;
    }
    case "complex": {
      const cx = pack.complexes.find((x) => x.id === selection.id);
      if (!cx) return <Missing what="complex" />;
      return <ComplexForm api={api} id={cx.id} />;
    }
    case "building": {
      const b = pack.buildings.find((x) => x.id === selection.id);
      if (!b) return <Missing what="building" />;
      return <BuildingForm api={api} id={b.id} />;
    }
    case "units":
      return <UnitsEditor api={api} buildingId={selection.buildingId} />;
    case "terms": {
      const t = pack.terms.find((x) => x.id === selection.id);
      if (!t) return <Missing what="terms" />;
      return <TermsForm api={api} id={t.id} />;
    }
    case "texts":
      return <TextsForm api={api} />;
  }
}

function Missing({ what }: { what: string }) {
  return <div className="mm-empty">That {what} no longer exists — pick another from the tree.</div>;
}

function Head({ crumbs, title }: { crumbs: string; title: string }) {
  return (
    <>
      <div className="mm-main__crumbs">{crumbs}</div>
      <h1 className="mm-main__title">{title}</h1>
    </>
  );
}

// ---------------------------------------------------------------------------

function DeveloperForm({ api }: { api: PackApi }) {
  const d = api.pack.developer;
  return (
    <>
      <Head crumbs="Developer" title={d.name || "Developer"} />
      <div className="mm-card">
        <h3>Project settings</h3>
        <div className="mm-grid">
          <Field label="Domain" hint="re-skins labels, templates & image archetypes for this project">
            <SelectInput
              value={api.pack.domain || "realestate"}
              onChange={(v) => api.setDomain(v as "realestate" | "art" | "tickets")}
              options={[
                { value: "realestate", label: "Real estate" },
                { value: "art", label: "Art / NFT" },
                { value: "tickets", label: "Tickets / event slots" },
              ]}
            />
          </Field>
        </div>
      </div>
      <div className="mm-card">
        <h3>Identity</h3>
        <div className="mm-grid">
          <Field label="Name" hint="required">
            <TextInput value={d.name} onChange={(v) => api.patchDeveloper({ name: v, id: slugify(v) })} />
          </Field>
          <Field label="ID" hint="url-safe, derived from name">
            <TextInput value={d.id} onChange={(v) => api.patchDeveloper({ id: slugify(v) })} mono />
          </Field>
          <Field label="Holding company">
            <TextInput value={d.holdingCompany} onChange={(v) => api.patchDeveloper({ holdingCompany: v })} />
          </Field>
          <Field label="NEAR account" hint="on-chain operator">
            <TextInput value={d.nearAccount} onChange={(v) => api.patchDeveloper({ nearAccount: v })} mono />
          </Field>
          <Field label="Logo path" hint="relative to pack">
            <TextInput value={d.logo} onChange={(v) => api.patchDeveloper({ logo: v })} mono />
          </Field>
        </div>
      </div>
    </>
  );
}

function CompanyForm({ api, id }: { api: PackApi; id: string }) {
  const c = api.pack.companies.find((x) => x.id === id)!;
  return (
    <>
      <Head crumbs={`Developer › ${api.pack.developer.name}`} title={c.name || c.id} />
      <div className="mm-card">
        <h3>Company</h3>
        <div className="mm-grid">
          <Field label="Name" hint="required">
            <TextInput value={c.name} onChange={(v) => api.patchCompany(id, { name: v })} />
          </Field>
          <Field label="ID" hint="url-safe">
            <TextInput value={c.id} onChange={(v) => api.patchCompany(id, { id: slugify(v) })} mono />
          </Field>
          <Field label="Registration" hint="e.g. TH-0105..." full>
            <TextInput value={c.registration} onChange={(v) => api.patchCompany(id, { registration: v })} mono />
          </Field>
        </div>
        <div className="mm-btn-row" style={{ marginTop: 14 }}>
          <button className="mm-btn mm-btn--danger" onClick={() => { api.removeCompany(id); api.select({ kind: "developer" }); }}>
            Delete company
          </button>
        </div>
      </div>
    </>
  );
}

function ComplexForm({ api, id }: { api: PackApi; id: string }) {
  const cx = api.pack.complexes.find((x) => x.id === id)!;
  const companyOpts = [{ value: "", label: "— none —" }, ...api.pack.companies.map((c) => ({ value: c.id, label: c.name || c.id }))];
  return (
    <>
      <Head crumbs={`Developer › ${api.pack.developer.name}`} title={cx.name || cx.id} />
      <div className="mm-card">
        <h3>Complex</h3>
        <div className="mm-grid">
          <Field label="Name" hint="required">
            <TextInput value={cx.name} onChange={(v) => api.patchComplex(id, { name: v })} />
          </Field>
          <Field label="ID" hint="url-safe">
            <TextInput value={cx.id} onChange={(v) => api.patchComplex(id, { id: slugify(v) })} mono />
          </Field>
          <Field label="Owning company">
            <SelectInput value={cx.companyId} onChange={(v) => api.patchComplex(id, { companyId: v || undefined })} options={companyOpts} />
          </Field>
          <Field label="Area / district">
            <TextInput value={cx.area} onChange={(v) => api.patchComplex(id, { area: v })} />
          </Field>
          <Field label="Amenities" hint="comma-separated" full>
            <ListInput value={cx.amenities} onChange={(v) => api.patchComplex(id, { amenities: v })} />
          </Field>
        </div>
        <div className="mm-card" style={{ marginTop: 14, background: "var(--bg)" }}>
          <h3>Buildings in this complex ({cx.buildings.length})</h3>
          <div className="mm-btn-row">
            {api.pack.buildings.filter((b) => b.complexId === id).map((b) => (
              <button key={b.id} className="mm-btn" onClick={() => api.select({ kind: "building", id: b.id })}>
                🏗 {b.name || b.id}
              </button>
            ))}
            <button className="mm-btn mm-btn--primary" onClick={() => api.select({ kind: "building", id: api.addBuilding(id) })}>
              + Add building
            </button>
          </div>
        </div>
        <div className="mm-btn-row" style={{ marginTop: 14 }}>
          <button className="mm-btn mm-btn--danger" onClick={() => { api.removeComplex(id); api.select({ kind: "developer" }); }}>
            Delete complex
          </button>
        </div>
      </div>
    </>
  );
}

function BuildingForm({ api, id }: { api: PackApi; id: string }) {
  const b = api.pack.buildings.find((x) => x.id === id)!;
  const cx = api.pack.complexes.find((c) => c.id === b.complexId);
  const complexOpts = api.pack.complexes.map((c) => ({ value: c.id, label: c.name || c.id }));
  const termOpts = [{ value: "", label: "— none —" }, ...api.pack.terms.map((t) => ({ value: t.id, label: t.id }))];
  const types = b.unitTypes || [];

  return (
    <>
      <Head crumbs={`Complex › ${cx?.name || b.complexId}`} title={b.name || b.id} />

      <div className="mm-card">
        <h3>Building</h3>
        <div className="mm-grid">
          <Field label="Name" hint="required">
            <TextInput value={b.name} onChange={(v) => api.patchBuilding(id, { name: v })} />
          </Field>
          <Field label="ID" hint="url-safe">
            <TextInput value={b.id} onChange={(v) => api.patchBuilding(id, { id: slugify(v) })} mono />
          </Field>
          <Field label="Complex" hint="required">
            <SelectInput value={b.complexId} onChange={(v) => api.patchBuilding(id, { complexId: v })} options={complexOpts} />
          </Field>
          <Field label="Type">
            <SelectInput
              value={b.type}
              onChange={(v) => api.patchBuilding(id, { type: v })}
              options={[{ value: "High Rise", label: "High Rise" }, { value: "Low Rise", label: "Low Rise" }]}
            />
          </Field>
          <Field label="Stories" hint="required, ≥1">
            <NumberInput value={b.stories} onChange={(v) => api.patchBuilding(id, { stories: v ?? 1 })} />
          </Field>
          <Field label="Declared unit count">
            <NumberInput value={b.units} onChange={(v) => api.patchBuilding(id, { units: v })} />
          </Field>
          <Field label="Tagline" full>
            <TextInput value={b.tagline} onChange={(v) => api.patchBuilding(id, { tagline: v })} />
          </Field>
          <Field label="Area / district">
            <TextInput value={b.area} onChange={(v) => api.patchBuilding(id, { area: v })} />
          </Field>
          <Field label="Address">
            <TextInput value={b.address} onChange={(v) => api.patchBuilding(id, { address: v })} />
          </Field>
          <Field label="Completion blurb">
            <TextInput value={b.completion} onChange={(v) => api.patchBuilding(id, { completion: v })} />
          </Field>
          <Field label="Construction end" hint="YYYY-MM-DD">
            <TextInput value={b.constructionEnd} onChange={(v) => api.patchBuilding(id, { constructionEnd: v })} mono />
          </Field>
          <Field label="Amenities" hint="comma-separated" full>
            <ListInput value={b.amenities} onChange={(v) => api.patchBuilding(id, { amenities: v })} />
          </Field>
        </div>
      </div>

      <div className="mm-card">
        <h3>Fees &amp; charges (USD)</h3>
        <div className="mm-grid">
          <Field label="Reservation fee"><NumberInput value={b.reservationFeeUsd} onChange={(v) => api.patchBuilding(id, { reservationFeeUsd: v })} /></Field>
          <Field label="Booking deposit"><NumberInput value={b.bookingDepositUsd} onChange={(v) => api.patchBuilding(id, { bookingDepositUsd: v })} /></Field>
          <Field label="Maintenance /m²"><NumberInput value={b.maintenancePerSqmUsd} step={0.1} onChange={(v) => api.patchBuilding(id, { maintenancePerSqmUsd: v })} /></Field>
          <Field label="Sinking fund /m²"><NumberInput value={b.sinkingFundPerSqmUsd} step={0.1} onChange={(v) => api.patchBuilding(id, { sinkingFundPerSqmUsd: v })} /></Field>
          <Field label="Transfer fee %" hint="e.g. 6.30%"><TextInput value={b.transferFeePct} onChange={(v) => api.patchBuilding(id, { transferFeePct: v })} mono /></Field>
          <Field label="Payment terms"><SelectInput value={b.termsRef} onChange={(v) => api.patchBuilding(id, { termsRef: v || undefined })} options={termOpts} /></Field>
        </div>
      </div>

      <div className="mm-card">
        <h3>Unit types ({types.length})</h3>
        <div className="mm-units">
          <table>
            <thead>
              <tr><th>Key</th><th>Label</th><th>Sqm min</th><th>Sqm max</th><th /></tr>
            </thead>
            <tbody>
              {types.map((t, i) => (
                <tr key={i}>
                  <td><input value={t.key} style={{ width: 90, fontFamily: "var(--mono)" }} onChange={(e) => editType(i, { key: slugify(e.target.value) })} /></td>
                  <td><input value={t.label} style={{ width: 140 }} onChange={(e) => editType(i, { label: e.target.value })} /></td>
                  <td><input type="number" value={t.sqmMin} style={{ width: 70 }} onChange={(e) => editType(i, { sqmMin: Number(e.target.value) })} /></td>
                  <td><input type="number" value={t.sqmMax} style={{ width: 70 }} onChange={(e) => editType(i, { sqmMax: Number(e.target.value) })} /></td>
                  <td><button className="mm-btn mm-btn--danger" onClick={() => api.setUnitTypes(id, types.filter((_, j) => j !== i))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mm-btn-row" style={{ marginTop: 10 }}>
          <button className="mm-btn" onClick={() => api.setUnitTypes(id, [...types, { key: "studio", label: "Studio", sqmMin: 0, sqmMax: 0 }])}>+ Unit type</button>
          <button className="mm-btn mm-btn--primary" onClick={() => api.select({ kind: "units", buildingId: id })}>Edit units →</button>
        </div>
      </div>

      <MediaCard api={api} buildingId={id} />

      <div className="mm-btn-row">
        <button className="mm-btn mm-btn--danger" onClick={() => { api.removeBuilding(id); api.select({ kind: "developer" }); }}>Delete building</button>
      </div>
    </>
  );

  function editType(i: number, patch: Partial<(typeof types)[number]>) {
    api.setUnitTypes(id, types.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }
}

function TermsForm({ api, id }: { api: PackApi; id: string }) {
  const t = api.pack.terms.find((x) => x.id === id)!;
  const json = JSON.stringify(t.data, null, 2);
  return (
    <>
      <Head crumbs="Payment terms" title={id} />
      <div className="mm-card">
        <h3>Terms block</h3>
        <p style={{ color: "var(--ink-dim)", fontSize: 12, marginTop: -6 }}>
          Opaque to MM — carried verbatim into <code>terms/{id}.json</code>; VRX interprets it. Edit as JSON.
        </p>
        <Field label="Data (JSON)" full>
          <textarea
            defaultValue={json}
            style={{ fontFamily: "var(--mono)", minHeight: 220 }}
            onBlur={(e) => {
              try {
                api.patchTerms(id, JSON.parse(e.target.value || "{}"));
              } catch {
                // keep the text; the rail won't block export (law #2). A toast could warn here later.
              }
            }}
          />
        </Field>
        <div className="mm-btn-row">
          <button className="mm-btn mm-btn--danger" onClick={() => { api.removeTerms(id); api.select({ kind: "developer" }); }}>Delete terms</button>
        </div>
      </div>
    </>
  );
}

function TextsForm({ api }: { api: PackApi }) {
  const texts = api.pack.texts || {};
  const entries = Object.entries(texts);
  return (
    <>
      <Head crumbs="Marketing & contract texts" title="Texts" />
      <div className="mm-card">
        <h3>Free texts</h3>
        <p style={{ color: "var(--ink-dim)", fontSize: 12, marginTop: -6 }}>
          Keyed blurbs (overview, contract clauses, disclaimers). Always valid — carried into the pack as-is.
        </p>
        {entries.length === 0 && <div className="mm-empty">No texts yet. Add one below.</div>}
        {entries.map(([k, v]) => (
          <div key={k} style={{ marginBottom: 16 }}>
            <Field label={k} full>
              <TextArea value={v} onChange={(val) => api.setText(k, val)} />
            </Field>
            <button className="mm-btn mm-btn--danger" style={{ marginTop: 6 }} onClick={() => api.removeText(k)}>Remove</button>
          </div>
        ))}
        <AddText onAdd={(k) => api.setText(k, "")} />
      </div>
    </>
  );
}

function AddText({ onAdd }: { onAdd: (key: string) => void }) {
  return (
    <form
      className="mm-btn-row"
      style={{ marginTop: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        const input = (e.currentTarget.elements.namedItem("k") as HTMLInputElement);
        const key = input.value.trim();
        if (key) { onAdd(key); input.value = ""; }
      }}
    >
      <input name="k" placeholder="new text key (e.g. contract.clause.1)" style={{ flex: 1, fontFamily: "var(--mono)", border: "1px solid var(--line-strong)", borderRadius: 6, padding: "7px 9px" }} />
      <button className="mm-btn mm-btn--primary" type="submit">+ Add text</button>
    </form>
  );
}
