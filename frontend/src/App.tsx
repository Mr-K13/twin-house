import { useEffect, useState } from "react";
import { useStore } from "./state/store";
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

/** The simulation runner is inside the gate: while the phone notice page shows, the WebSocket and the local engine do not start and do not waste CPU */
function Console() {
  useFitScale();
  useSimulationRunner();
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
    </div>
  );
}

export default function App() {
  return <NarrowScreenGate><Console /></NarrowScreenGate>;
}
