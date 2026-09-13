/**
 * Asset Catalog modal: the list of equipment types on the left; for the selected type, the parameter schema,
 * a 3D preview of one instance (CatalogPreview), the behavioural characteristics (imported from the engine constants), and a sortable table of every instance in the layout.
 * All data is static and bundled (see catalog/assetTypes.ts), so this works offline / LOCAL as well as online.
 */
import { useMemo, useState } from "react";
import { ASSET_TYPES, type Cell } from "../../catalog/assetTypes";
import { Head } from "../ui/primitives";
import { CatalogPreview } from "./CatalogPreview";

const cmp = (a: Cell, b: Cell) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true }));

export function CatalogModal() {
  const [sel, setSel] = useState(ASSET_TYPES[0].id);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "id", dir: 1 });
  const [q, setQ] = useState("");
  /** Instance shown in the 3D preview (row click); null = the first instance of the type */
  const [previewId, setPreviewId] = useState<string | null>(null);
  const entry = ASSET_TYPES.find((t) => t.id === sel) ?? ASSET_TYPES[0];
  const total = ASSET_TYPES.reduce((n, t) => n + t.instances.length, 0);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? entry.rows.filter((r) => Object.values(r.cells).some((c) => String(c).toLowerCase().includes(needle))) : [...entry.rows];
    return list.sort((a, b) => sort.dir * cmp(a.cells[sort.key], b.cells[sort.key]) || cmp(a.id, b.id));
  }, [entry, sort, q]);
  const pick = (id: string) => { setSel(id); setSort({ key: "id", dir: 1 }); setQ(""); setPreviewId(null); };
  const previewIdx = Math.max(0, entry.rows.findIndex((r) => r.id === previewId));
  const previewRow = entry.rows[previewIdx];
  /** Click a header to sort by that column; click again to flip the direction */
  const sortBy = (k: string) => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : 1 }));
  const variants = entry.variants.filter((v) => v.counts.length > 1);
  return (
    <>
      <Head title="Asset Catalog"><span className="hint" style={{ margin: 0 }}>{ASSET_TYPES.length} types · {total} instances in the current layout</span></Head>
      <div className="catalog-body">
        <nav className="catalog-nav wi-list" aria-label="Asset types">
          {ASSET_TYPES.map((t) => (
            <button key={t.id} className={"wi-item" + (t.id === sel ? " on" : "")} onClick={() => pick(t.id)} aria-pressed={t.id === sel}>
              <span>{t.label}</span><span className="count">{t.instances.length}</span>
            </button>
          ))}
        </nav>
        <div className="catalog-detail">
          <div className="catalog-top">
            <div>
              <h4 className="drawer-sub">{entry.label}</h4>
              <p className="hint">{entry.description}</p>
              <p className="hint">The 3D view shows <b>{previewRow?.id}</b> as the main scene draws it. Click any row in the instance table to preview that instance.</p>
            </div>
            {previewRow && <CatalogPreview typeId={entry.id} instance={entry.instances[previewIdx]} label={previewRow.id} />}
          </div>

          <h4 className="drawer-sub">Parameters · {entry.fields.length}</h4>
          <table className="dt full">
            <thead><tr><th>Field</th><th>Type</th><th>Unit</th><th>Description</th></tr></thead>
            <tbody>
              {entry.fields.map((f) => (
                <tr key={f.name} style={{ cursor: "default" }}>
                  <td style={{ fontWeight: 600 }}>{f.name}{f.optional && <span className="src"> (optional)</span>}</td>
                  <td>{f.type}</td><td>{f.unit ?? ""}</td>
                  <td style={{ fontFamily: "var(--font)" }}>{f.description}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 className="drawer-sub">Characteristics · {entry.characteristics.length}</h4>
          <table className="dt full">
            <thead><tr><th>Characteristic</th><th>Value</th><th>Unit</th><th>Source</th></tr></thead>
            <tbody>
              {entry.characteristics.map((c) => (
                <tr key={c.label} style={{ cursor: "default" }}>
                  <td style={{ fontFamily: "var(--font)" }}>{c.label}</td>
                  <td style={{ fontWeight: 600 }}>{c.value}</td><td>{c.unit ?? ""}</td>
                  <td className="src">{c.source}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 className="drawer-sub">Instances · {entry.instances.length}</h4>
          {variants.length > 0 && (
            <div className="catalog-variants">
              {variants.map((v) => (
                <span key={v.label} className="chip" title={`${v.label}: distinct values in the layout`}>
                  {v.label}: {v.counts.map((c, i) => <span key={c.value}>{i ? " · " : ""}<b>{c.value}</b> ×{c.n}</span>)}
                </span>
              ))}
            </div>
          )}
          <div className="filters">
            <input placeholder={`filter ${entry.label.toLowerCase()} rows…`} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
            <span className="count">{rows.length} / {entry.rows.length}</span>
          </div>
          <div className="catalog-table">
            <table className="dt full">
              <thead><tr>{entry.columns.map((c) => <th key={c.key} onClick={() => sortBy(c.key)} style={{ cursor: "pointer", color: sort.key === c.key ? "var(--accent)" : undefined }}>{c.label}{sort.key === c.key ? (sort.dir === 1 ? " ↓" : " ↑") : ""}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.id === previewRow?.id ? "sel" : ""} onClick={() => setPreviewId(r.id)} title="Show in the 3D preview">
                    {entry.columns.map((c, i) => <td key={c.key} style={i === 0 ? { fontWeight: 700 } : undefined}>{r.cells[c.key]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
