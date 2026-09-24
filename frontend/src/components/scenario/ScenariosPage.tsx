/**
 * Setup page (#/, the landing page): the built-in Main Warehouse first (Console only), then the twins saved in the backend with Console / Open / Delete,
 * and the New Twin dialog. The UI says "twin"; code, routes and API keep "scenario".
 */
import { useEffect, useState } from "react";
import { useScenarioStore } from "../../scenario/store";
import type { ScenarioSize, ScenarioSummary } from "../../scenario/types";
import { navigate } from "../../router";
import { NewScenarioDialog } from "./NewScenarioDialog";
import { BUILTIN_TWIN_ID, BUILTIN_TWIN_SUMMARY } from "../../twin/builtin";

const fmtSize = (s: ScenarioSize) => `${s.length} × ${s.width} × ${s.height} m`;
const fmtTime = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };

export function ScenariosPage() {
  const summaries = useScenarioStore((s) => s.summaries);
  const listState = useScenarioStore((s) => s.listState);
  const listError = useScenarioStore((s) => s.listError);
  const loadList = useScenarioStore((s) => s.loadList);
  const remove = useScenarioStore((s) => s.remove);
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void loadList(); }, [loadList]);

  const onDelete = async (s: ScenarioSummary) => {
    if (s.id === BUILTIN_TWIN_ID) return;
    if (!confirm(`Delete twin "${s.name}" (${s.instance_count} assets)? This cannot be undone.`)) return;
    setBusy(s.id); setError(null);
    try { await remove(s.id); } catch (e) { setError(`Could not delete "${s.name}": ${e instanceof Error ? e.message : String(e)}`); } finally { setBusy(null); }
  };
  const openIt = (id: string) => navigate({ page: "workspace", id });
  const consoleOf = (id: string) => navigate({ page: "console", id });
  const b = BUILTIN_TWIN_SUMMARY;

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand"><span className="ai">Twin</span><span>House</span><span className="brand-sub">Twin setup</span></div>
        <div className="topbar-right">
          <button className="btn primary" onClick={() => setDialog(true)}>+ New Twin</button>
        </div>
      </header>
      <div className="page-body narrow">
        <p className="hint">A twin is a warehouse of your own size that you populate from the asset catalog in the Workspace, then run live in its <b>Console</b>. Twins are stored in the backend, so they are shared across browsers; every change in the Workspace is saved automatically. The built-in Main Warehouse is read-only.</p>
        <div className="wi-list sc-list">
          <div className="sc-row head"><span>Name</span><span>Size L × W × H</span><span>Assets</span><span>Updated</span><span /></div>
          <div className="wi-item sc-row" onDoubleClick={() => consoleOf(b.id)}>
            <span className="name" title="Bundled with the app; read-only">{b.name} <span className="tag">Built-in</span></span>
            <span className="mono">{fmtSize(b.size)}</span>
            <span className="mono">{b.instance_count} assets</span>
            <span className="mono">—</span>
            <span className="actions"><button className="btn primary" onClick={() => consoleOf(b.id)}>Console</button></span>
          </div>
          {listState === "ready" && summaries.map((s) => (
            <div key={s.id} className="wi-item sc-row" onDoubleClick={() => openIt(s.id)}>
              <span className="name" title={s.id}>{s.name}</span>
              <span className="mono">{fmtSize(s.size)}</span>
              <span className="mono">{s.instance_count} {s.instance_count === 1 ? "asset" : "assets"}</span>
              <span className="mono">{fmtTime(s.updated_at)}</span>
              <span className="actions">
                <button className="btn" onClick={() => consoleOf(s.id)} title="Run this twin live in the operations console">Console</button>
                <button className="btn primary" onClick={() => openIt(s.id)}>Open</button>
                <button className="btn danger" disabled={busy === s.id} onClick={() => void onDelete(s)}>{busy === s.id ? "Deleting…" : "Delete"}</button>
              </span>
            </div>
          ))}
        </div>
        {listState === "loading" && <p className="hint">Loading twins…</p>}
        {listState === "error" && <div className="error-box">Cannot reach the backend: {listError}<button className="btn" onClick={() => void loadList()}>Retry</button></div>}
        {listState === "ready" && summaries.length === 0 && <p className="hint">No twins of your own yet. Click <b>New Twin</b> to create the first one.</p>}
        {error && <div className="error-box">{error}</div>}
      </div>
      {dialog && <NewScenarioDialog defaultName={`Twin ${summaries.length + 1}`} onClose={() => setDialog(false)} />}
    </div>
  );
}
