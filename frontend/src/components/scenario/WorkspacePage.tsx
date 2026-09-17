/**
 * Workspace page (#/workspace/<id>): header with the scenario name (click to rename), size and save indicator; asset palette (left),
 * 3D / 2D viewport (centre), inspector (right). Opens the scenario on mount, flushes a pending save on unmount and on page unload, and owns the
 * keyboard shortcuts so they work in both views.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ASSET_TYPE_IDS } from "../../scenario/assetDefs";
import { rotateBy } from "../../scenario/model";
import { useScenarioStore, type WorkspaceTab } from "../../scenario/store";
import { navigate } from "../../router";
import { Icon, Panel } from "../ui/primitives";
import { useStore } from "../../state/store";
import { AssetPalette } from "./AssetPalette";
import { InstanceInspector } from "./InstanceInspector";
import { EditorScene } from "./EditorScene";
import { EditorMap2D } from "./EditorMap2D";

const TABS: Array<[WorkspaceTab, string]> = [["3D", "3D VIEW"], ["2D", "2D VIEW"]];
const isEditable = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);

function Header({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="brand"><span className="ai">Twin</span><span>House</span><span className="brand-sub">Workspace</span></div>
      {children}
      <div className="topbar-right">
        {right}
        <button className="tb-btn" onClick={() => navigate({ page: "scenarios" })} title="Back to the twin list">‹ Twins</button>
        <button className="tb-btn" onClick={() => navigate({ page: "console" })} title="Operations console (live simulation)">Console</button>
      </div>
    </header>
  );
}

export function WorkspacePage({ id }: { id: string }) {
  const active = useScenarioStore((s) => s.active);
  const activeState = useScenarioStore((s) => s.activeState);
  const activeError = useScenarioStore((s) => s.activeError);
  const saveState = useScenarioStore((s) => s.saveState);
  const saveError = useScenarioStore((s) => s.saveError);
  const open = useScenarioStore((s) => s.open);
  const close = useScenarioStore((s) => s.close);
  const flushSave = useScenarioStore((s) => s.flushSave);
  const retrySave = useScenarioStore((s) => s.retrySave);
  const renameScenario = useScenarioStore((s) => s.renameScenario);
  const viewTab = useScenarioStore((s) => s.viewTab);
  const setViewTab = useScenarioStore((s) => s.setViewTab);
  const selectedId = useScenarioStore((s) => s.selectedId);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    void open(id);
    // The editor reuses the console's Lift model, whose click handler selects the lift in the console store: clear that on the way out
    return () => { void close(); useStore.getState().selectLift(null); };
  }, [id, open, close]);
  useEffect(() => { if (activeState === "missing") navigate({ page: "scenarios" }); }, [activeState]);
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      void flushSave({ keepalive: true });
      if (useScenarioStore.getState().saveState === "error") { e.preventDefault(); e.returnValue = ""; }   // the browser asks before discarding a failed save
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [flushSave]);
  // Shortcuts (ignored while typing in a field): Escape deselects, Delete / Backspace removes, Q / E rotate ∓15° (Shift: 90°)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useScenarioStore.getState();
      if (e.key === "Escape") { st.select(null); return; }
      const inst = st.active?.instances.find((i) => i.id === st.selectedId);
      if (!inst) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); st.removeInstance(inst.id); return; }
      const k = e.key.toLowerCase();
      if (k === "q" || k === "e") {
        e.preventDefault();
        const step = (e.shiftKey ? 90 : 15) * (Math.PI / 180);
        st.updateInstance(inst.id, { rotation: rotateBy(inst.rotation, k === "q" ? -step : step) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (activeState === "error") {
    return (
      <div className="page"><Header />
        <div className="page-body narrow"><div className="error-box">Cannot load this twin: {activeError}<button className="btn" onClick={() => void open(id)}>Retry</button></div></div>
      </div>
    );
  }
  if (!active) return <div className="page"><Header /><div className="page-body narrow"><p className="hint">Loading twin…</p></div></div>;

  const { length: L, width: W, height: H } = active.size;
  const saveText = saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Save failed — retry";
  const saveTitle = saveState === "error" ? `${saveError ?? "save failed"} — click to retry` : "Every change is saved to the backend automatically";
  return (
    <div className="page">
      <Header right={<span className={"save-state " + saveState} title={saveTitle} role={saveState === "error" ? "button" : undefined} onClick={saveState === "error" ? retrySave : undefined}>{saveText}</span>}>
        <input className="ws-name" key={active.name} defaultValue={active.name} maxLength={80} aria-label="Twin name" title="Twin name — click to rename"
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== active.name) renameScenario(v); else e.target.value = active.name; }}
          onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.value = active.name; if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }} />
        <span className="ws-size" title="Length × Width × Height">{L} × {W} × {H} m</span>
      </Header>
      <div className="page-body workspace">
        <aside className="ws-col"><Panel title="Asset types" sub={`${ASSET_TYPE_IDS.length} in the catalog`} grow><AssetPalette /></Panel></aside>
        <main className="viewport ws-viewport">
          <div className="view-tabs">{TABS.map(([k, l]) => <button key={k} className={viewTab === k ? "on" : ""} onClick={() => setViewTab(k)}>{l}</button>)}</div>
          {viewTab === "3D" && <div className="vp-toolbar"><button className="icon-btn" title="Reset camera" onClick={() => setResetKey((k) => k + 1)}>{Icon.expand}</button></div>}
          {viewTab === "3D" ? <EditorScene resetKey={resetKey} /> : <EditorMap2D />}
          <div className="ws-help">Drag a type from the list into the 3D view · drag an instance to move it (stays inside the walls, snaps flush to a wall within 0.5 m) · ring (snaps near 0 / 90 / 180 / 270°) or Q / E to rotate (Shift: 90°) · Delete removes · Esc deselects</div>
        </main>
        <aside className="ws-col"><Panel title="Inspector" sub={selectedId ?? "nothing selected"} grow><InstanceInspector /></Panel></aside>
      </div>
    </div>
  );
}
