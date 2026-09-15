/** Scenarios page (#/scenarios): the saved warehouse scenarios from the backend with Open / Delete, and the New Scenario dialog */
import { useEffect, useState } from "react";
import { useScenarioStore } from "../../scenario/store";
import type { ScenarioSize, ScenarioSummary } from "../../scenario/types";
import { navigate } from "../../router";
import { NewScenarioDialog } from "./NewScenarioDialog";

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
    if (!confirm(`Delete scenario "${s.name}" (${s.instance_count} assets)? This cannot be undone.`)) return;
    setBusy(s.id); setError(null);
    try { await remove(s.id); } catch (e) { setError(`Could not delete "${s.name}": ${e instanceof Error ? e.message : String(e)}`); } finally { setBusy(null); }
  };
  const openIt = (id: string) => navigate({ page: "workspace", id });

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand"><span className="ai">Twin</span><span>House</span><span className="brand-sub">Scenario setup</span></div>
        <div className="topbar-right">
          <button className="tb-btn" onClick={() => navigate({ page: "console" })} title="Operations console (live simulation)">‹ Console</button>
          <button className="btn primary" onClick={() => setDialog(true)}>+ New Scenario</button>
        </div>
      </header>
      <div className="page-body narrow">
        <p className="hint">A scenario is a warehouse of your own size that you populate from the asset catalog in the Workspace. Scenarios are stored in the backend, so they are shared across browsers; every change in the Workspace is saved automatically.</p>
        {listState === "loading" && <p className="hint">Loading scenarios…</p>}
        {listState === "error" && <div className="error-box">Cannot reach the backend: {listError}<button className="btn" onClick={() => void loadList()}>Retry</button></div>}
        {listState === "ready" && summaries.length === 0 && <p className="hint">No scenarios yet. Click <b>New Scenario</b> to create the first one.</p>}
        {listState === "ready" && summaries.length > 0 && (
          <div className="wi-list sc-list">
            <div className="sc-row head"><span>Name</span><span>Size L × W × H</span><span>Assets</span><span>Updated</span><span /></div>
            {summaries.map((s) => (
              <div key={s.id} className="wi-item sc-row" onDoubleClick={() => openIt(s.id)}>
                <span className="name" title={s.id}>{s.name}</span>
                <span className="mono">{fmtSize(s.size)}</span>
                <span className="mono">{s.instance_count} {s.instance_count === 1 ? "asset" : "assets"}</span>
                <span className="mono">{fmtTime(s.updated_at)}</span>
                <span className="actions">
                  <button className="btn primary" onClick={() => openIt(s.id)}>Open</button>
                  <button className="btn danger" disabled={busy === s.id} onClick={() => void onDelete(s)}>{busy === s.id ? "Deleting…" : "Delete"}</button>
                </span>
              </div>
            ))}
          </div>
        )}
        {error && <div className="error-box">{error}</div>}
      </div>
      {dialog && <NewScenarioDialog defaultName={`Scenario ${summaries.length + 1}`} onClose={() => setDialog(false)} />}
    </div>
  );
}
