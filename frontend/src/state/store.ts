import { create } from "zustand";
import layoutJson from "../layout/warehouse_layout.json";
import type { WarehouseLayout, LayoutLocation } from "../layout/types";
import type { TwinState, RobotId, HeatmapLayer } from "../schema/twin_state";

export type ViewTab = "3D" | "MAP" | "TRAFFIC" | "HEATMAP";
export type Quality = "low" | "medium" | "high";
export type SceneTool = "select" | "pan" | "paths" | "labels" | "measure";

export const layout = layoutJson as unknown as WarehouseLayout;

interface Store {
  twin: TwinState;
  /** layout.locations indexed by id */
  locations: Record<string, LayoutLocation>;
  selectedRobot: RobotId | null;
  viewTab: ViewTab;
  quality: Quality;
  showPaths: boolean;
  showLabels: boolean;
  tool: SceneTool;
  focusTarget: [number, number, number] | null;
  activeCamera: string;
  select: (id: RobotId | null) => void;
  setViewTab: (t: ViewTab) => void;
  setQuality: (q: Quality) => void;
  setTool: (t: SceneTool) => void;
  togglePaths: () => void;
  toggleLabels: () => void;
  focus: (p: [number, number, number] | null) => void;
  setActiveCamera: (id: string) => void;
  /** Simulation controls (Phase 2 local; Phase 3 sends SIM_CONTROL instead) */
  speed: 0 | 1 | 2 | 5 | 10;
  paused: boolean;
  seed: number;
  setSpeed: (v: 0 | 1 | 2 | 5 | 10) => void;
  setPaused: (p: boolean) => void;
  /** The runner (local) or the WebSocket (online) calls this each tick */
  setTwin: (t: TwinState) => void;
  /** Data source: online = backend WebSocket; local = frontend engine fallback */
  source: "connecting" | "online" | "local";
  setSource: (s: "connecting" | "online" | "local") => void;
  /** Heatmap layers from the backend (when online); read them from the local engine when local */
  /** Remote heatmap layers, key = `${kind}:${floor}` (independent per floor) */
  heat: Record<string, HeatmapLayer> | null;
  setHeat: (l: HeatmapLayer | null) => void;
  /** Phase 4 UI: Modal / drawers */
  modal: null | "audit" | "tasks" | "robot" | "fleet";
  setModal: (m: null | "audit" | "tasks" | "robot" | "fleet") => void;
  /** Short notice (for example, the backend returns RATE_LIMITED); null = hidden */
  notice: { text: string; kind: "warn" | "info"; until: number } | null;
  setNotice: (text: string | null, kind?: "warn" | "info") => void;
  /** The floor shown in 3D / Map: "all" = stack and show all floors */
  /** "exploded" = raise floor 2 visually by 5 m (render transform only; simulation coordinates do not change) */
  activeFloor: "all" | "exploded" | number;
  setActiveFloor: (f: "all" | "exploded" | number) => void;
  /** The selected lift (the right column shows the Lift panel; mutually exclusive with selectedRobot) */
  selectedLift: string | null;
  selectLift: (id: string | null) => void;
  drawer: null | "scenarios" | "ops" | "whatif";
  setDrawer: (d: null | "scenarios" | "ops" | "whatif") => void;
  /** The most recent What-if result (returned by the backend; includes window comparison data outside the schema) */
  whatif: unknown | null;
  setWhatIf: (r: unknown | null) => void;
}

/** Empty initial TwinState (the engine snapshot replaces it as soon as the runner mounts) */
const EMPTY: TwinState = {
  schema_version: "1.0", layout_id: layout.id,
  sim: { tick: 0, tick_ms: 100, speed: 1, mode: "PAUSED", seed: 42, baseline_snapshot_id: null },
  robots: {}, tasks: {}, lifts: {}, zones: {}, conveyors: {}, cameras: {}, sensors: {}, people: {}, alerts: {}, recent_events: [], recent_decisions: [],
  kpi: { tick: 0, fleet: { total: 0, active: 0, charging: 0, idle: 0, warning: 0, error: 0, offline: 0 }, operation: { throughput_per_min: 0, completed_today: 0, completed_target: 150, pending: 0, ongoing: 0, avg_task_time_s: 0, on_time_rate: 1, avg_utilization: 0 }, efficiency: { avg_travel_distance_m: 0, avg_wait_time_s: 0, congestion_index: 0, energy_kwh: 0 }, throughput_series: [], lifts: { trips: 0, utilization: 0, avg_wait_s: 0, faults: 0 } },
  subsystems: { WAREHOUSE: "NORMAL", CONVEYORS: "NORMAL", CHARGING: "NORMAL", CCTV: "NORMAL", NETWORK: "NORMAL" },
};

export const useStore = create<Store>((set) => ({
  twin: EMPTY,
  speed: 1, paused: false, seed: 42,
  source: "connecting",
  setSource: (source) => set({ source }),
  modal: null,
  setModal: (modal) => set({ modal }),
  notice: null,
  setNotice: (text, kind = "warn") => set({ notice: text ? { text, kind, until: Date.now() + 4000 } : null }),
  activeFloor: "all",
  setActiveFloor: (activeFloor) => set({ activeFloor }),
  selectedLift: null,
  selectLift: (selectedLift) => set(selectedLift ? { selectedLift, selectedRobot: null } : { selectedLift }),
  whatif: null,
  setWhatIf: (whatif) => set({ whatif }),
  drawer: null,
  setDrawer: (drawer) => set((st) => ({ drawer: st.drawer === drawer ? null : drawer })),
  heat: null,
  setHeat: (l) => set((st) => (l === null ? { heat: null } : { heat: { ...(st.heat ?? {}), [`${l.kind}:${l.floor ?? 1}`]: l } })),
  setSpeed: (speed) => set({ speed, paused: speed === 0 }),
  setPaused: (paused) => set({ paused }),
  locations: Object.fromEntries(layout.locations.map((l) => [l.id, l])),
  selectedRobot: null,
  viewTab: "3D",
  quality: "medium",
  showPaths: true,
  showLabels: true,
  tool: "select",
  focusTarget: null,
  activeCamera: "CAM-B01",
  select: (id) => set(id ? { selectedRobot: id, selectedLift: null } : { selectedRobot: id }),
  setViewTab: (viewTab) => set({ viewTab }),
  setQuality: (quality) => set({ quality }),
  setTool: (tool) => set({ tool }),
  togglePaths: () => set((s) => ({ showPaths: !s.showPaths })),
  toggleLabels: () => set((s) => ({ showLabels: !s.showLabels })),
  focus: (focusTarget) => set({ focusTarget }),
  setActiveCamera: (activeCamera) => set({ activeCamera }),
  setTwin: (twin) => set({ twin }),
}));

/** Status → color, shared across the App */
export const STATUS_COLOR: Record<string, string> = {
  ACTIVE: "#22c55e", CHARGING: "#3b82f6", IDLE: "#eab308", WARNING: "#f97316", ERROR: "#ef4444", OFFLINE: "#6b7280",
};
export const SEVERITY_COLOR: Record<string, string> = {
  INFO: "#3b82f6", LOW: "#3b82f6", MEDIUM: "#3b82f6", HIGH: "#eab308", CRITICAL: "#ef4444",
};
export const ZONE_COLOR = Object.fromEntries(layout.zones.map((z) => [z.id, z.color]));

/** Simulation clock: tick 0 = 08:00:00 */
export const SIM_START_S = 8 * 3600;
export function tickToClock(tick: number, tickMs = 100, withSeconds = false): string {
  const s = Math.max(0, Math.floor(SIM_START_S + (tick * tickMs) / 1000));
  const hh = Math.floor(s / 3600) % 24, mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return withSeconds ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(hh)}:${p(mm)}`;
}
