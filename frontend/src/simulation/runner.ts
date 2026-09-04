/**
 * Data source switch (Phase 3).
 *  - First, try a WebSocket connection to the backend. When connected, FULL/PATCH messages fully drive store.twin. The local engine stops.
 *  - If the connection fails (or drops), switch back to the local TypeScript engine (the Phase 2 rAF loop). The UI shows LOCAL.
 *  Control commands (play/pause/speed/reset/inject/create task) go to the current data source through simControl().
 */
import { useEffect } from "react";
import { SimEngine, SIM } from "./engine";
import { layout, useStore } from "../state/store";
import { wsConnect, wsDisconnect, wsSend } from "../services/ws";
import type { ScenarioInjection, TaskPriority, TaskType } from "../schema/twin_state";

let engine: SimEngine | null = null;
export function getEngine(): SimEngine {
  if (!engine) engine = new SimEngine(layout, { seed: useStore.getState().seed });
  return engine;
}
export function resetEngine(seed?: number) {
  engine = new SimEngine(layout, { seed: seed ?? useStore.getState().seed });
  useStore.getState().setTwin(engine.snapshot());
  return engine;
}

/** Single control entry point: online mode uses the WebSocket. Otherwise it operates the local engine. */
export const simControl = {
  play(speed?: 1 | 2 | 5 | 10) {
    const st = useStore.getState();
    st.setPaused(false); if (speed) st.setSpeed(speed); else if (st.speed === 0) st.setSpeed(1);
    if (st.source === "online") wsSend({ type: "SIM_CONTROL", action: "PLAY", speed: speed ?? (st.speed === 0 ? 1 : st.speed) });
  },
  pause() {
    useStore.getState().setPaused(true);
    if (useStore.getState().source === "online") wsSend({ type: "SIM_CONTROL", action: "PAUSE" });
  },
  reset() {
    const st = useStore.getState();
    if (st.source === "online") wsSend({ type: "SIM_CONTROL", action: "RESET" }); else resetEngine();
  },
  inject(injection: ScenarioInjection) {
    const st = useStore.getState();
    if (st.source === "online") wsSend({ type: "INJECT", injection }); else getEngine().inject(injection);
  },
  createTask(task: { type: TaskType; priority: TaskPriority; source: string; destination: string; load_units?: number }) {
    const st = useStore.getState();
    if (st.source === "online") { wsSend({ type: "CREATE_TASK", task: { load_units: 1, ...task } }); return; }
    try { getEngine().createTask(task); } catch (e) { st.setNotice(`Task rejected: ${(e as Error).message}`); }
  },
  clearInjection(kind: ScenarioInjection["kind"], target_id: string) {
    const st = useStore.getState();
    if (st.source === "online") wsSend({ type: "CLEAR_INJECTION", kind, target_id }); else getEngine().clearInjection(kind, target_id);
  },
  ackAlert(alert_id: string) {
    const st = useStore.getState();
    if (st.source === "online") wsSend({ type: "ACK_ALERT", alert_id }); else getEngine().ackAlert(alert_id);
  },
};

export function useSimulationRunner() {
  useEffect(() => {
    const st = useStore.getState();
    let raf = 0, last = performance.now(), acc = 0;
    const MAX_TICKS_PER_FRAME = 40;

    // Local engine loop. It advances only when source !== "online".
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.25, (now - last) / 1000); last = now;
      const s = useStore.getState();
      if (s.source === "online") { acc = 0; return; }
      if (s.paused || s.speed === 0) return;
      const eng = getEngine();
      acc += dt * s.speed;
      let n = 0;
      while (acc >= SIM.TICK_S && n < MAX_TICKS_PER_FRAME) { eng.step(); acc -= SIM.TICK_S; n++; }
      if (n > 0) { eng.state.sim.speed = s.speed; eng.state.sim.mode = "LIVE"; s.setTwin(eng.snapshot()); }
    };

    // Show the initial frame from the local engine first. This prevents a blank screen while the connection starts.
    st.setTwin(getEngine().snapshot());
    raf = requestAnimationFrame(loop);

    wsConnect((conn) => {
      const s = useStore.getState();
      if (conn === "online") {
        s.setSource("online"); s.setHeat(null);
      } else if (conn === "offline") {
        // Connection lost: the local engine takes over from the current frame state (keeps continuity). This prevents a jump back to tick 0.
        if (s.source === "online") { engine = new SimEngine(layout, { seed: s.seed, initialState: s.twin }); s.setHeat(null); }
        s.setSource("local");
      } else {
        if (s.source !== "online") s.setSource("connecting");
      }
    });
    // On StrictMode (mount -> cleanup -> mount) or a normal unmount, close the WebSocket and the listener together. Otherwise a duplicate connection remains.
    return () => { cancelAnimationFrame(raf); wsDisconnect(); };
  }, []);
}
