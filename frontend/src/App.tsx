import { useEffect, useState } from "react";
import { BUNDLED_LAYOUT, setLayout, useStore } from "./state/store";
import { TopBar } from "./components/shell/TopBar";
import { useSimulationRunner } from "./simulation/runner";
import { Viewport } from "./components/views/Viewport";
import { AlertsPanel, FleetOverviewPanel, SystemStatusPanel, TaskOverviewPanel } from "./components/panels/LeftPanels";
import { EventLogPanel, LiveCameraPanel, SelectedRobotPanel } from "./components/panels/RightPanels";
import { RobotStatusPanel, TaskQueuePanel, ThroughputPanel } from "./components/panels/BottomPanels";
import { ScenariosDrawer } from "./components/ops/ScenariosDrawer";
import { OpsDrawer } from "./components/ops/OpsDrawer";
import { Modals } from "./components/ops/Modals";
import { WhatIfDrawer } from "./components/ops/WhatIfDrawer";
import { navigate, useHashRoute } from "./router";
import { ScenariosPage } from "./components/scenario/ScenariosPage";
import { WorkspacePage } from "./components/scenario/WorkspacePage";
import { BUILTIN_TWIN_ID } from "./twin/builtin";
import { ApiError, getScenario } from "./scenario/api";
import { useScenarioStore } from "./scenario/store";
import { projectLayout, simReadiness } from "./scenario/projectLayout";

/**
 * The layout design base is 1536×860 CSS px. On a smaller window, scale the full layout down so that all panels stay visible
 * (1080p at Windows 125% scale ≈ 1536×750). Use transform, not CSS zoom: zoom makes R3F measure the canvas size scaled twice.
 */
const DESIGN_W = 1536, DESIGN_H = 860;
function useFitScale() {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const z = Math.min(1, window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
      root.style.setProperty("--ui-scale", z < 0.995 ? z.toFixed(4) : "1");
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);
}

/** Short notice for backend messages such as RATE_LIMITED / TOO_LARGE */
function Notice() {
  const notice = useStore((s) => s.notice);
  const setNotice = useStore((s) => s.setNotice);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), Math.max(0, notice.until - Date.now())); return () => clearTimeout(t); }, [notice, setNotice]);
  if (!notice) return null;
  return <div className={"notice " + notice.kind} onClick={() => setNotice(null)}>{notice.text}</div>;
}

/** This is a desktop operations console. On a narrow screen (phone), the layout shrinks to 0.3× and is not readable. Show a notice first; the user can continue.
 *  Threshold 1024: tablet landscape (1024–1279) can still use the scaled-down version; phones always get the notice. */
const GATE_W = 1024;
function NarrowScreenGate({ children }: { children: React.ReactNode }) {
  const [dismissed, setDismissed] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth < GATE_W);
  useEffect(() => { const f = () => setNarrow(window.innerWidth < GATE_W); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  if (narrow && !dismissed) {
    return (
      <div className="narrow-gate">
        <div className="brand"><span className="ai">Twin</span><span>House</span></div>
        <h2>Designed for desktop</h2>
        <p>TwinHouse is a 3D operations console that works best on screens ≥ 1280 px wide (it still runs, scaled down, from 1024 px). On a phone the interface would shrink to about a quarter of its size and become unreadable.</p>
        <p>Open <b>twin-house.vercel.app</b> on a laptop or desktop browser for the full experience.</p>
        <button className="btn" onClick={() => setDismissed(true)}>Continue anyway</button>
      </div>
    );
  }
  return <>{children}</>;
}

/** Shown in a user twin's console when no task can be generated (no robot, or no task type with both ends) */
function IdleHint({ missing }: { missing: string[] }) {
  const [open, setOpen] = useState(true);
  if (!open || missing.length === 0) return null;
  return (
    <div className="sim-hint" role="status">
      Robots stay idle: this twin needs {missing.join(", ")}. Add them in the Workspace.
      <button className="icon-btn" title="Dismiss" onClick={() => setOpen(false)}>×</button>
    </div>
  );
}

/** The simulation runner is inside the gate: while the phone notice page shows, the WebSocket and the local engine do not start and do not waste CPU */
function Console({ online, missing }: { online: boolean; missing: string[] }) {
  useFitScale();
  useSimulationRunner({ online });
  return (
    <div className="shell">
      <TopBar />
      <div className="shell-body">
        <aside className="col-left">
          <FleetOverviewPanel />
          <TaskOverviewPanel />
          <SystemStatusPanel />
          <AlertsPanel />
        </aside>
        <main className="center"><Viewport /></main>
        <aside className="col-right">
          <SelectedRobotPanel />
          <LiveCameraPanel />
          <EventLogPanel />
        </aside>
        <footer className="bottom">
          <TaskQueuePanel />
          <ThroughputPanel />
          <RobotStatusPanel />
        </footer>
      </div>
      <ScenariosDrawer />
      <OpsDrawer />
      <WhatIfDrawer />
      <Modals />
      <Notice />
      <IdleHint missing={missing} />
    </div>
  );
}

type ConsoleLoad = { state: "loading" } | { state: "ready"; online: boolean; missing: string[] } | { state: "error"; message: string };

/**
 * Console of one twin (#/console/<id>). The built-in twin shows the bundled layout, simulated by the backend (WebSocket, local fallback).
 * A user twin is fetched, projected into a layout (scenario/projectLayout.ts) and simulated by the local engine only.
 */
function ConsolePage({ id }: { id: string }) {
  const [load, setLoad] = useState<ConsoleLoad>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (id === BUILTIN_TWIN_ID) { setLayout(BUNDLED_LAYOUT); setLoad({ state: "ready", online: true, missing: [] }); return; }
    let alive = true;
    setLoad({ state: "loading" });
    (async () => {
      await useScenarioStore.getState().flushSave();   // coming from the Workspace: its last edit is saved before the GET
      try {
        const twin = await getScenario(id);
        if (!alive) return;
        const l = projectLayout(twin);
        setLayout(l);
        setLoad({ state: "ready", online: false, missing: simReadiness(l) });
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) navigate({ page: "scenarios" });
        else setLoad({ state: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { alive = false; };
  }, [id, attempt]);

  if (load.state === "ready") return <Console online={load.online} missing={load.missing} />;
  return (
    <div className="page">
      <header className="topbar">
        <div className="brand"><span className="ai">Twin</span><span>House</span><span className="brand-sub">Console</span></div>
        <div className="topbar-right"><button className="tb-btn" onClick={() => navigate({ page: "scenarios" })} title="Back to the twin list">‹ Twins</button></div>
      </header>
      <div className="page-body narrow">
        {load.state === "loading" ? <p className="hint">Loading twin…</p>
          : <div className="error-box">Cannot load this twin: {load.message}<button className="btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button></div>}
      </div>
    </div>
  );
}

/** Hash routes: `#/` twin setup list, `#/workspace/<id>`, `#/console/<id>`. The setup pages render outside Console, so no WebSocket or engine loop runs while editing a twin.
 *  The console is keyed by twin id: switching twins remounts it, so the scene, memos and the simulation runner start from the new layout. */
function Routed() {
  const route = useHashRoute();
  if (route.page === "workspace") return <WorkspacePage id={route.id} />;
  if (route.page === "console") return <ConsolePage key={route.id} id={route.id} />;
  return <ScenariosPage />;
}

export default function App() {
  return <NarrowScreenGate><Routed /></NarrowScreenGate>;
}
