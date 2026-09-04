/**
 * WebSocket client (Phase 3)
 *
 *  Backend → FULL / PATCH / HEATMAP / ERROR   →  store.twin / store.heat
 *  UI      → SIM_CONTROL / INJECT / CREATE_TASK / ACK_ALERT / RESYNC
 *
 * PATCH merge rules (they match make_patch in backend/app/main.py):
 *  - sim / kpi / subsystems / recent_decisions: replace the full section
 *  - robots: for each robot, {...prev, ...patch} (path appears only when it changes)
 *  - tasks / zones / conveyors / cameras / sensors / people / alerts: merge by id; a null value means delete
 *  - events: prepend to recent_events (ring 500)
 * If patch.base_tick does not match the local tick, send RESYNC to request FULL.
 */
import type { ServerMessage, ClientMessage, TwinState, HeatmapLayer, RobotState } from "../schema/twin_state";
import { THRESHOLDS } from "../schema/twin_state";
import { useStore } from "../state/store";

export type ConnState = "connecting" | "online" | "offline";

const WS_URL = (import.meta as unknown as { env: Record<string, string | undefined> }).env?.VITE_WS_URL ?? `ws://${location.hostname}:8000/ws`;
/** REST base (derived from WS_URL): ws://host:8000/ws → http://host:8000 */
export const API_URL = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");
const COLLECTIONS = ["tasks", "lifts", "zones", "conveyors", "cameras", "sensors", "people", "alerts"] as const;

let socket: WebSocket | null = null;
let reconnectTimer = 0;
let stopped = false;
let localTick = -1;
let onStateChange: ((s: ConnState) => void) | null = null;
type CopilotReply = { request_id: string; text: string; citations: Array<{ robot_id?: string; task_id?: string; event_id?: string }>; model?: string };
const copilotListeners = new Set<(r: CopilotReply) => void>();
/** Subscribe to COPILOT_REPLY; return an unsubscribe function */
export function onCopilotReply(fn: (r: CopilotReply) => void): () => void { copilotListeners.add(fn); return () => copilotListeners.delete(fn); }
const whatifListeners = new Set<(r: unknown) => void>();
export function onWhatIfResult(fn: (r: unknown) => void): () => void { whatifListeners.add(fn); return () => whatifListeners.delete(fn); }
const whatifErrorListeners = new Set<(message: string, request_id: string | null) => void>();
/** Notify when the backend answers WHATIF_RUN with ERROR (RATE_LIMITED / BAD_MESSAGE...). The drawer then exits the Simulating state. */
export function onWhatIfError(fn: (message: string, request_id: string | null) => void): () => void { whatifErrorListeners.add(fn); return () => whatifErrorListeners.delete(fn); }
/** The pending What-if request_id (null = none). An ERROR / WHATIF_RESULT counts as its response only when it carries the same id. */
let whatifPending: string | null = null;
export function markWhatIfPending(id: string | null) { whatifPending = id; }

export function wsSend(msg: ClientMessage): boolean {
  if (socket && socket.readyState === WebSocket.OPEN) { socket.send(JSON.stringify(msg)); return true; }
  return false;
}

// Tab returns from background to foreground: the browser can throttle queued PATCH messages, so request one FULL (a named listener is removable on disconnect)
const onVisible = () => { if (document.visibilityState === "visible") { localTick = -1; wsSend({ type: "RESYNC" }); } };

export function wsConnect(onChange: (s: ConnState) => void) {
  wsDisconnect();                       // On a repeat call (StrictMode double mount), close the previous connection first
  stopped = false; onStateChange = onChange;
  open();
  document.addEventListener("visibilitychange", onVisible);
}
export function wsDisconnect() {
  stopped = true; clearTimeout(reconnectTimer);
  document.removeEventListener("visibilitychange", onVisible);
  if (socket) { const s = socket; socket = null; s.onclose = null; s.onmessage = null; s.close(); }
  onStateChange = null; localTick = -1;
}

function open() {
  if (stopped) return;
  onStateChange?.("connecting");
  let ws: WebSocket;
  try {
    // An https page that opens ws:// throws SecurityError synchronously (when VITE_WS_URL is not set). Catch it, or the full App crashes.
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn("[ws] cannot open", WS_URL, e, "— falling back to local engine");
    onStateChange?.("offline");
    return;
  }
  socket = ws;
  const timeout = window.setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 2500);
  ws.onopen = () => { clearTimeout(timeout); onStateChange?.("online"); };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data) as ServerMessage);
  ws.onerror = () => { /* onclose handles it */ };
  ws.onclose = () => {
    clearTimeout(timeout);
    if (socket === ws) socket = null;
    if (whatifPending) { const id = whatifPending; whatifPending = null; whatifErrorListeners.forEach((fn) => fn("connection lost — please run again", id)); }
    onStateChange?.("offline");
    if (!stopped) reconnectTimer = window.setTimeout(open, 3000);
  };
}

function handle(msg: ServerMessage) {
  const st = useStore.getState();
  switch (msg.type) {
    case "FULL": {
      localTick = msg.state.sim.tick;
      st.setTwin(msg.state); syncControls(msg.state);
      break;
    }
    case "PATCH": {
      if (localTick >= 0 && msg.base_tick !== localTick && msg.base_tick !== msg.tick) {
        // Ticks are missing (for example, the tab was asleep). Request a full resend.
        localTick = -1; wsSend({ type: "RESYNC" }); return;
      }
      localTick = msg.tick;
      const next = applyPatch(st.twin, msg);
      st.setTwin(next); if (msg.patch.sim) syncControls(next);
      break;
    }
    case "HEATMAP": st.setHeat(msg.layer); break;
    case "COPILOT_REPLY": copilotListeners.forEach((fn) => fn(msg as unknown as CopilotReply)); break;
    case "WHATIF_RESULT": if (!msg.request_id || msg.request_id === whatifPending) whatifPending = null; whatifListeners.forEach((fn) => fn(msg.result)); break;
    case "ERROR": {
      console.warn("[ws] server error", msg.code, msg.message);
      if (msg.code === "RATE_LIMITED" || msg.code === "TOO_LARGE" || msg.code === "BAD_TASK" || msg.code === "BAD_MESSAGE") {
        st.setNotice(`${msg.code === "RATE_LIMITED" ? "Rate limit" : msg.code === "TOO_LARGE" ? "Request too large" : msg.code === "BAD_TASK" ? "Task rejected" : "Rejected"}: ${msg.message}`);
        // Also remove the waiting Copilot bubble
        const rid = (msg as unknown as { request_id?: string }).request_id;
        if (rid) copilotListeners.forEach((fn) => fn({ request_id: rid, text: `⏳ ${msg.message}`, citations: [] }));
        // Only a request_id equal to the pending What-if counts as its error (other errors, for example BAD_TASK, do not close Simulating by mistake)
        if (whatifPending && rid === whatifPending) { const id = whatifPending; whatifPending = null; whatifErrorListeners.forEach((fn) => fn(msg.message, id)); }
      }
      break;
    }
    default: break;
  }
}

/** The backend is the authority: play/pause/speed follow the sim fields (for example, another tab pressed pause) */
function syncControls(t: TwinState) {
  const st = useStore.getState();
  if (st.speed !== t.sim.speed) st.setSpeed(t.sim.speed);
  const paused = t.sim.mode === "PAUSED";
  if (st.paused !== paused) st.setPaused(paused);
}

type Patch = Extract<ServerMessage, { type: "PATCH" }>;

function applyPatch(prev: TwinState, msg: Patch): TwinState {
  const p = msg.patch as Record<string, unknown>;
  const next: TwinState = { ...prev };
  if (p.sim) next.sim = { ...prev.sim, ...(p.sim as TwinState["sim"]) };
  if (p.kpi) next.kpi = p.kpi as TwinState["kpi"];
  if (p.subsystems) next.subsystems = p.subsystems as TwinState["subsystems"];
  if (p.recent_decisions) next.recent_decisions = p.recent_decisions as TwinState["recent_decisions"];
  if (p.robots) {
    const robots = { ...prev.robots };
    for (const [id, d] of Object.entries(p.robots as Record<string, Partial<RobotState>>)) robots[id] = { ...robots[id], ...d } as RobotState;
    next.robots = robots;
  }
  for (const key of COLLECTIONS) {
    const d = p[key] as Record<string, unknown> | undefined;
    if (!d) continue;
    const col = { ...(prev[key] as Record<string, unknown>) };
    for (const [id, v] of Object.entries(d)) { if (v === null) delete col[id]; else col[id] = v; }
    (next as unknown as Record<string, unknown>)[key] = col;
  }
  if (msg.events.length) next.recent_events = [...msg.events.slice().reverse(), ...prev.recent_events].slice(0, THRESHOLDS.EVENT_RING_SIZE);
  return next;
}

export type { HeatmapLayer };
