/**
 * Digital Twin simulation engine (Phase 2: runs locally; Phase 3 moves it unchanged to the Python backend)
 *
 * Principles
 *  - Deterministic: all random numbers come from a PRNG that the seed sets. The engine does not read the clock. Same seed + same input -> same result.
 *  - Pure data: state is a TwinState. It is JSON-serializable and can be copied (What-if).
 *  - Fixed tick = 100 ms of simulation time.
 *
 * Order in each tick: task generation -> task assignment -> per-robot FSM/movement/battery -> Zone/congestion statistics -> KPI -> event cleanup
 */
import type { WarehouseLayout, LayoutLocation } from "../layout/types";
import { buildNavGrid } from "../layout/navgrid";
import type {
  TwinState, PerceivedObstacle, RobotState, TaskState, TwinEvent, AlertState, AiDecision, DecisionCandidate,
  GridCell, RobotFsmState, RobotStatus, EventType, Severity, TaskPriority, ScenarioInjection,
} from "../schema/twin_state";
import { THRESHOLDS } from "../schema/twin_state";
import { astar, cellKey, cellCenter, isWalkable, nearestWalkable, toCell, type NavGrid } from "./astar";
import { taskError } from "./rules";

// ─────────────────────────────────────────────────────────────
// Parameters (kept in one place; the UI can adjust them later)
// ─────────────────────────────────────────────────────────────
export const SIM = {
  TICK_S: THRESHOLDS.TICK_MS / 1000,
  MAX_SPEED: 1.5,            // m/s
  ACCEL: 1.2,                // m/s²
  TURN_SLOW: 0.5,            // Speed limit ratio during a turn
  PICK_TICKS: 40,            // Pick dwell 4 s
  DROP_TICKS: 30,
  BATTERY_MOVE: 0.010,       // %/tick @ full speed
  BATTERY_LOAD: 0.004,       // Extra drain with a load
  BATTERY_IDLE: 0.0008,
  CHARGE_RATE: 0.06,         // %/tick  -> 0 -> 95% in about 160 s
  TASK_INTERVAL_TICKS: 70,   // One new task every 7 s on average
  MAX_WAITING_TASKS: 12,
  WAIT_REPLAN_TICKS: 25,     // Replan after the robot is blocked for 2.5 s
  WAIT_BACKOFF_TICKS: 80,    // Blocked for 8 s with no solution -> yield (deadlock breaker)
  STATION_ARRIVE_CELLS: 2,   // Within 2 grid cells of the station, front cell occupied, and no free service cell -> work in place
  SERVICE_RADIUS: 1,         // Walkable grid cells within 1 cell (Chebyshev) of a station/shelf access point = service cells, one robot per cell
  MIN_SEP: 0.9,              // Hard lower limit on the center distance between any two robots (m): do not take a step that gets closer and goes below this value (physical collision guard)
  LIFT_SEP: 0.6,             // "Docking mode" separation at the lift entrance (m): for slow micro moves in queue advance and cabin entry/exit; tighter than the aisle MIN_SEP
  // Lift door area geometry (round-8c): matches the Mezzanine shaft model (LIFT_SHAFT); tests prevent drift between the two
  LIFT_SHAFT_HALF_X: 1.4,    // Shaft half width (m): the door face is at cx - 1.4 (= shaft W 2.8 / 2)
  LIFT_DOOR_HALF_W: 1.12,    // Door opening half width (m) (= width of one LEAF of the double door)
  ROBOT_HALF_LEN: 0.475,     // AMR body half length (m): the throughGate threshold and door frame clearance derive from this
  ROBOT_HALF_W: 0.34,        // AMR body half width (m) (chassis Z width 0.68)
  // Phase 7: virtual LiDAR and local obstacle avoidance
  LIDAR_RANGE: 4.0,          // m
  LIDAR_FOV: Math.PI * 1.5,  // 270°
  PERC_STOP: 1.7,            // Dynamic obstacle ahead with center distance < 1.7 m -> stop (body 1.3 m, keep 0.4 m)
  PERC_SLOW: 2.8,            // < 2.8 m -> slow down
  PERC_LOOKAHEAD: 3,         // React only to dynamic obstacles on my next 3 grid cells of path (do not stop for crossing robots that are off the path)
  PERC_EVENT_TICKS: 200,     // Throttle for perception events from the same robot
  // Lift (spec §9.1; seconds x 10 = ticks)
  LIFT_DOOR_TICKS: 12,       // Door open/close 1.2 s
  LIFT_TRAVEL_TICKS: 60,     // Vertical travel 6.0 s (smoothstep easing)
  LIFT_LEVEL_TICKS: 5,       // Leveling 0.5 s
  LIFT_COOLDOWN_TICKS: 20,   // Cooldown after one trip 2.0 s
  LIFT_BOARD_SPEED: 0.6,     // Slow speed for cabin entry/exit (m/s)
  LIFT_QUEUE_SPEED: 0.9,     // Queue advance move speed (m/s)
  LIFT_RETRY_TICKS: 50,      // Retry interval when all lifts have faults
  LIFT_XFLOOR_PENALTY_M: 40, // Equivalent distance penalty for cross-floor task assignment (m)
  ON_TIME_LIMIT_TICKS: 2400, // A task completed within 4 min counts as on time
  IDLE_TO_PARK_TICKS: 300,   // Idle for 30 s -> return to the parking area
  KPI_EVERY: 10,
  SERIES_EVERY: 600,         // One throughput series point every 60 s
  EVENT_RING: THRESHOLDS.EVENT_RING_SIZE,
  ZONE_CAPACITY: 6,          // Robot count above which a zone counts as congested
};

export function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Per-robot runtime data that is private to the engine and does not enter TwinState */
interface RobotRt {
  /** Yield in progress: move to a nearby grid cell for now. On arrival, return to resumePoint and replan. */
  backingOff: boolean;
  resumePoint: [number, number] | null;
  dwell: number;                 // Remaining dwell ticks
  waitTicks: number;             // Accumulated blocked ticks
  target: GridCell | null;       // End point of the current path
  goalLoc: string | null;        // Location id of the current goal
  phase: "TO_SOURCE" | "TO_DEST" | "TO_CHARGER" | "TO_PARK" | null;
  chargerId: string | null;
  idleTicks: number;
  lastBatteryAlert: "NONE" | "WARN" | "CRIT";
  /** Perception: nearest dynamic obstacle straight ahead (robot / person id) and its center distance */
  frontId: string | null;
  frontDist: number;
  lastPercEvent: number;
  /** Cross-floor: the goal to continue to after the robot reaches the lift */
  pending: { point: [number, number]; phase: RobotRt["phase"]; locId: string | null; floor: number } | null;
  liftId: string | null;
  /** Three-stage lift exit (round-8d): turn to the door inside the cabin -> move straight out -> turn in place to the exit -> go to the exit */
  liftExitPhase: null | "TURN_OUT" | "OUT" | "TURN_EXIT" | "GO";
  /** Lift recorded in the audit at assignment time (round-6 P2): planTo prefers it for cross-floor plans, so Decision reasons match the real route */
  plannedLiftId: string | null;
  /** Lift sub-state machine (spec §10): null -> TO_LIFT -> QUEUED -> BOARDING -> RIDING -> ALIGHTING -> null */
  liftStage: null | "TO_LIFT" | "QUEUED" | "BOARDING" | "RIDING" | "ALIGHTING";
  liftEnqueuedTick: number;
  liftRetryTick: number;
  /** Fixed exit point for ALIGHTING (selected once; changed only after a long block). This prevents oscillation from a new target each tick. */
  liftExit: [number, number] | null;
  liftBlockedTicks: number;
}

export interface EngineOptions { seed?: number; initialState?: TwinState }

export class SimEngine {
  readonly layout: WarehouseLayout;
  /** Floor 1 grid (heatmap / traffic cost reuse it); see grids for the per-floor grids */
  readonly grid: NavGrid;
  readonly grids: Record<number, NavGrid>;
  state: TwinState;
  /** Long-term traffic accumulation (one per floor; very slow decay): used for HEATMAP and as the A* congestion cost */
  traffic: Record<number, Float32Array>;
  /** Short-term traffic (one per floor; fast decay, about 20 s of memory): used for TRAFFIC VIEW */
  trafficShort: Record<number, Float32Array>;
  private rng: () => number;
  private rt: Record<string, RobotRt> = {};
  private loc: Record<string, LayoutLocation>;
  private occupancy = new Map<string, string>(); // cellKey -> robotId
  private nextTaskTick = 0;
  private taskSeq = 3812;
  private eventSeq = 0;
  private decisionSeq = 0;
  private chargerBusy: Record<string, string | null> = {};
  private blockedZones = new Set<string>();
  /** Traffic congestion injection: zone -> { level, until } */
  private congestedZones = new Map<string, { level: number; until: number }>();
  private pendingInjections: ScenarioInjection[] = [];
  private taskTimes: number[] = [];
  private onTime = 0; private completedCount = 0;
  private lastSeriesTick = 0;

  constructor(layout: WarehouseLayout, opts: EngineOptions = {}) {
    this.layout = layout;
    this.grid = buildNavGrid(layout, 1);
    this.grids = { 1: this.grid };
    for (const f of layout.floors ?? []) if (f.id !== 1) this.grids[f.id] = buildNavGrid(layout, f.id);
    const n = this.grid.cols * this.grid.rows;
    this.traffic = {}; this.trafficShort = {};
    for (const f of layout.floors ?? [{ id: 1 }]) { this.traffic[f.id] = new Float32Array(n); this.trafficShort[f.id] = new Float32Array(n); }
    this.loc = Object.fromEntries(layout.locations.map((l) => [l.id, l]));
    const seed = opts.seed ?? 42;
    this.rng = mulberry32(seed);
    for (const c of layout.charging_stations) this.chargerBusy[c.id] = null;
    this.state = opts.initialState ? JSON.parse(JSON.stringify(opts.initialState)) : this.buildInitialState(seed);
    for (const r of Object.values(this.state.robots)) { if (!r.perception) r.perception = { state: "CLEAR", ahead_m: SIM.LIDAR_RANGE, nearest_m: null, obstacles: [] }; if (r.floor === undefined) r.floor = 1; if (r.lift_id === undefined) r.lift_id = null; if (r.lift_stage === undefined) r.lift_stage = null; }
    if (!this.state.lifts) this.state.lifts = {};
    for (const id of Object.keys(this.state.robots)) this.rt[id] = { backingOff: false, resumePoint: null, dwell: 0, waitTicks: 0, target: null, goalLoc: null, phase: null, chargerId: null, idleTicks: 0, lastBatteryAlert: "NONE", frontId: null, frontDist: Infinity, lastPercEvent: -1e9, pending: null, liftId: null, liftExitPhase: null, plannedLiftId: null, liftStage: null, liftEnqueuedTick: 0, liftRetryTick: 0, liftExit: null, liftBlockedTicks: 0 };
    this.nextTaskTick = this.state.sim.tick + 10;
    if (opts.initialState) this.rehydrate();   // WS drop -> LOCAL takes over: derive the private runtime from the public state, so the simulation stays truly continuous
  }

  /** Derive the private engine runtime from the public TwinState (round-6 P1): a moving robot does not "arrive instantly",
   *  lift trips do not break, and task/event/decision sequence numbers continue without repeats. For cases that cannot be derived, release the resources safely and replan. */
  private rehydrate() {
    const S = this.state;
    const num = (id: string) => { const m = /(\d+)$/.exec(id); return m ? parseInt(m[1], 10) : 0; };
    for (const id in S.tasks) this.taskSeq = Math.max(this.taskSeq, num(id) + 1);
    for (const e of S.recent_events) this.eventSeq = Math.max(this.eventSeq, num(e.id));
    for (const d of S.recent_decisions) this.decisionSeq = Math.max(this.decisionSeq, num(d.id));
    this.completedCount = S.kpi.operation.completed_today;
    this.onTime = Math.round(S.kpi.operation.on_time_rate * this.completedCount);
    // Average task time: the per-task history is not in TwinState. Fill synthetic records of equal value from the snapshot KPI average (round-7 P2-3).
    // -> The average stays the same after takeover. New completed tasks then slide in with the correct weight (a statistically equivalent restore with the same mean and weight).
    const avgTicks = Math.round(S.kpi.operation.avg_task_time_s / SIM.TICK_S);
    if (avgTicks > 0 && this.completedCount > 0) this.taskTimes = new Array(Math.min(this.completedCount, 200)).fill(avgTicks);
    const series = S.kpi.throughput_series;
    this.lastSeriesTick = series.length ? series[series.length - 1].tick : S.sim.tick;
    for (const zid in S.zones) if (S.zones[zid].blocked_reason) this.blockedZones.add(zid);
    for (const aid in S.alerts) if (aid.startsWith("traffic-")) { const zid = aid.slice(8); this.congestedZones.set(zid, { level: Math.max(0.3, S.zones[zid]?.congestion ?? 0.5), until: S.sim.tick + 600 }); }
    for (const rid in S.robots) {
      const r = S.robots[rid]; const rt = this.rt[rid];
      const task = r.current_task_id ? S.tasks[r.current_task_id] : undefined;
      rt.phase = r.fsm === "NAVIGATING" || r.fsm === "TASK_ASSIGNED" ? "TO_SOURCE"
        : r.fsm === "TRANSPORTING" ? "TO_DEST"
        : r.fsm === "GOING_TO_CHARGE" || r.fsm === "CHARGING" ? "TO_CHARGER"
        // Takeover during obstacle avoidance (round-7 P2-1): REPLANNING uses phase to select the state to return to, so derive it from the public state.
        // destination is a charging station -> TO_CHARGER; load already on the robot -> it cannot still be on the way to pick -> TO_DEST; has a task -> TO_SOURCE; otherwise TO_PARK (-> IDLE)
        : r.fsm === "OBSTACLE_DETECTED" || r.fsm === "REPLANNING"
          ? (r.destination && r.destination in this.chargerBusy ? "TO_CHARGER" : r.load.current > 0 ? "TO_DEST" : task ? "TO_SOURCE" : "TO_PARK")
        : null;
      rt.goalLoc = r.destination;
      if (r.path.length && r.path_index < r.path.length) { const last = r.path[r.path.length - 1]; rt.target = [last[0], last[1]]; }
      if (r.fsm === "PICKING") rt.dwell = Math.max(1, SIM.PICK_TICKS - (S.sim.tick - r.fsm_since_tick));
      // The remaining delivery time must include stationSlowdown (conveyor fault x4 / maintenance x2). Otherwise a delivery during a fault completes too early (round-7 P2-2).
      if (r.fsm === "DELIVERING") rt.dwell = Math.max(1, SIM.DROP_TICKS * (task ? this.stationSlowdown(task.destination) : 1) - (S.sim.tick - r.fsm_since_tick));
      if (rt.phase === "TO_CHARGER" && r.destination && r.destination in this.chargerBusy) { rt.chargerId = r.destination; this.chargerBusy[r.destination] = rid; }
      rt.lastBatteryAlert = r.battery < THRESHOLDS.BATTERY_CRITICAL ? "CRIT" : r.battery < THRESHOLDS.BATTERY_WARNING ? "WARN" : "NONE";
      if (r.lift_stage) {
        // Lift trip: queue / occupant / reserved_by are already in state.lifts. Restore pending and the sub-state here.
        let liftId = r.lift_id;
        if (!liftId) for (const lid in S.lifts) { const L = S.lifts[lid]; if (L.occupant === rid || L.reserved_by === rid || L.queue["1"].includes(rid) || L.queue["2"].includes(rid)) { liftId = lid; break; } }
        const loc = r.destination ? this.loc[r.destination] : undefined;
        const chg = !loc && r.destination ? this.layout.charging_stations.find((c) => c.id === r.destination) : undefined;
        const goal = loc ? { point: [loc.access_point[0], loc.access_point[1]] as [number, number], floor: loc.floor ?? 1 }
          : chg ? { point: [chg.access_point[0], chg.access_point[1]] as [number, number], floor: 1 } : null;
        if (liftId && goal) {
          rt.liftId = liftId; rt.liftStage = r.lift_stage;
          rt.pending = { point: goal.point, phase: rt.phase ?? "TO_SOURCE", locId: r.destination, floor: goal.floor };
          rt.liftEnqueuedTick = S.sim.tick;
          if (r.lift_stage !== "TO_LIFT") rt.target = null;   // QUEUED / BOARDING / RIDING / ALIGHTING use microMove, not the grid
        } else {
          // A complete trip cannot be derived: release the lift resources safely and replan (safer than movement with a partial state)
          this.releaseRobotFromLift(rid);
          r.path = []; r.path_index = 0; rt.target = null; rt.pending = null; rt.phase = null;
          this.setFsm(r, task ? "TASK_ASSIGNED" : "IDLE");
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Initial state
  // ─────────────────────────────────────────────────────────
  private buildInitialState(seed: number): TwinState {
    const L = this.layout;
    const robots: Record<string, RobotState> = {};
    for (const sp of L.spawn.robots) {
      robots[sp.id] = {
        id: sp.id, model: "AMR-L", position: [Math.floor(sp.position[0]) + 0.5, 0, Math.floor(sp.position[2]) + 0.5], heading: sp.heading, velocity: 0, max_speed: SIM.MAX_SPEED, floor: sp.floor ?? 1, lift_id: null, lift_stage: null,
        battery: sp.battery, status: "IDLE", fsm: "IDLE", health: 95 + Math.floor(this.rng() * 5), current_task_id: null, destination: null,
        path: [], path_index: 0, load: { current: 0, capacity: 4 }, zone: null, eta_s: null, fsm_since_tick: 0,
        stats: { distance_m: 0, tasks_completed: 0, energy_wh: 0, busy_ticks: 0, wait_ticks: 0 },
        perception: { state: "CLEAR", ahead_m: SIM.LIDAR_RANGE, nearest_m: null, obstacles: [] },
      };
    }
    return {
      schema_version: "1.0", layout_id: L.id,
      sim: { tick: 0, tick_ms: THRESHOLDS.TICK_MS, speed: 1, mode: "LIVE", seed, baseline_snapshot_id: null },
      robots, tasks: {},
      lifts: Object.fromEntries((L.lifts ?? []).map((l) => [l.id, {
        id: l.id, state: "IDLE" as const, floor: 1, target_floor: null, y: 0,
        door_f1: "CLOSED" as const, door_f2: "CLOSED" as const,
        occupant: null, reserved_by: null, queue: { "1": [], "2": [] } as Record<string, string[]>,
        until_tick: 0, fault: false, fault_remaining: 0, trips: 0, busy_ticks: 0, wait_total_ticks: 0, wait_n: 0,
      }])),
      zones: Object.fromEntries(L.zones.map((z) => [z.id, { id: z.id, status: "NORMAL" as const, robot_count: 0, congestion: 0, blocked_reason: null, blocked_since_tick: null }])),
      conveyors: Object.fromEntries(L.conveyors.map((c) => [c.id, { id: c.id, status: "RUNNING" as const, speed_mps: c.speed_mps, items_on_belt: 4, throughput_per_min: 4 }])),
      cameras: Object.fromEntries(L.cameras.map((c) => [c.id, { id: c.id, zone: c.zone, status: "ONLINE" as const, last_observation: null }])),
      sensors: Object.fromEntries(L.sensors.map((s) => [s.id, { id: s.id, kind: s.kind as never, zone: s.zone, status: "ONLINE" as const, value: null, unit: null }])),
      people: {}, alerts: {}, recent_events: [], recent_decisions: [],
      kpi: {
        tick: 0, fleet: { total: Object.keys(robots).length, active: 0, charging: 0, idle: Object.keys(robots).length, warning: 0, error: 0, offline: 0 },
        operation: { throughput_per_min: 0, completed_today: 0, completed_target: 150, pending: 0, ongoing: 0, avg_task_time_s: 0, on_time_rate: 1, avg_utilization: 0 },
        efficiency: { avg_travel_distance_m: 0, avg_wait_time_s: 0, congestion_index: 0, energy_kwh: 0 },
        throughput_series: [{ tick: 0, completed: 0, target: 0 }],
        lifts: { trips: 0, utilization: 0, avg_wait_s: 0, faults: 0 },
      },
      subsystems: { WAREHOUSE: "NORMAL", CONVEYORS: "NORMAL", CHARGING: "NORMAL", CCTV: "NORMAL", NETWORK: "NORMAL" },
    };
  }

  // ─────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────
  /** Inject a scenario (shared by Phase 4 fault injection and Phase 6 What-if) */
  inject(inj: ScenarioInjection) {
    this.pendingInjections.push(inj);
    this.emit("SCENARIO_INJECTED", "USER", "INFO", `Scenario injected: ${inj.kind}${"zone_id" in inj ? " (Zone " + inj.zone_id + ")" : "robot_id" in inj ? " (" + inj.robot_id + ")" : "conveyor_id" in inj ? " (" + inj.conveyor_id + ")" : "camera_id" in inj ? " (" + inj.camera_id + ")" : ""}`);
  }

  /** Clear an injection: the robot comes back online, the conveyor recovers, the camera comes online, the person leaves, the traffic congestion clears */
  clearInjection(kind: ScenarioInjection["kind"], targetId: string) {
    const S = this.state;
    switch (kind) {
      case "ROBOT_FAILURE": { const r = S.robots[targetId]; if (r && r.fsm === "OFFLINE") { this.setFsm(r, "IDLE"); this.rt[r.id].phase = null; this.rt[r.id].target = null; this.resolveAlert(`off-${r.id}`); this.emit("ROBOT_ONLINE", "USER", "INFO", `${r.id} back online`, { robot_id: r.id }); } break; }
      case "CONVEYOR_FAILURE": { const c = S.conveyors[targetId]; const lc = this.layout.conveyors.find((x) => x.id === targetId); if (c && lc) { c.status = "RUNNING"; c.speed_mps = lc.speed_mps; this.resolveAlert(`cv-${c.id}`); this.emit("CONVEYOR_STATUS_CHANGED", "CONVEYOR", "INFO", `${c.id} restored — RUNNING`, { conveyor_id: c.id }); } break; }
      case "CAMERA_OFFLINE": { const c = S.cameras[targetId]; if (c) { c.status = "ONLINE"; if (Object.values(S.cameras).every((x) => x.status === "ONLINE")) S.subsystems.CCTV = "NORMAL"; this.emit("CAMERA_STATUS_CHANGED", "CAMERA", "INFO", `${c.id} online`, { camera_id: c.id }); } break; }
      case "HUMAN_INTRUSION": { for (const pid in S.people) if (S.people[pid].zone === targetId) S.people[pid].expires_tick = S.sim.tick; break; }
      case "TRAFFIC_CONGESTION": { this.congestedZones.delete(targetId); this.emit("ZONE_UNBLOCKED", "USER", "INFO", `Zone ${targetId} traffic restriction lifted`, { zone_id: targetId }); break; }
      case "LIFT_FAULT": { const L = S.lifts[targetId]; if (L && L.fault) { L.fault = false; L.until_tick = S.sim.tick + L.fault_remaining; L.fault_remaining = 0; this.resolveAlert(`lift-${targetId}`); this.emit("LIFT_FAULT", "LIFT", "INFO", `${targetId} restored — resuming`, {}); } break; }
      default: break;
    }
  }

  /** The user creates a task manually */
  createTask(t: { type: TaskState["type"]; priority: TaskPriority; source: string; destination: string; load_units?: number }): TaskState {
    const err = taskError(this.loc, t.type, t.source, t.destination);
    if (err) throw new Error(err);
    const id = `A${this.taskSeq++}`;
    const task: TaskState = { id, type: t.type, priority: t.priority, status: "WAITING", source: t.source, destination: t.destination, assigned_robot: null, parent_task_id: null, created_tick: this.state.sim.tick, assigned_tick: null, started_tick: null, completed_tick: null, deadline_tick: this.state.sim.tick + SIM.ON_TIME_LIMIT_TICKS, eta_s: null, load_units: t.load_units ?? 1 };
    this.state.tasks[id] = task;
    this.emit("TASK_CREATED", "SIMULATION", "INFO", `Task #${id} created (${t.type} ${this.pretty(t.source)} → ${this.pretty(t.destination)})`, { task_id: id });
    return task;
  }

  /** Advance one tick */
  step() {
    const S = this.state; S.sim.tick++;
    const tick = S.sim.tick;
    this.applyInjections();
    this.generateTasks();
    this.assignTasks();
    this.rebuildOccupancy();
    this.stepLifts();
    for (const id of Object.keys(S.robots)) this.updatePerception(S.robots[id], this.rt[id]);
    for (const id of Object.keys(S.robots)) this.stepRobot(S.robots[id], this.rt[id]);
    this.updateZones();
    this.decayTraffic();
    if (tick % SIM.KPI_EVERY === 0) { this.updateKpi(); this.updateDevices(); }
    if (tick - this.lastSeriesTick >= SIM.SERIES_EVERY) this.pushSeries();
    this.pruneTasks();
  }

  /** Create a new reference snapshot for the UI (shallow copy, so React detects the change) */
  snapshot(): TwinState {
    const S = this.state;
    const robots: Record<string, RobotState> = {};
    for (const id in S.robots) robots[id] = { ...S.robots[id], position: [...S.robots[id].position] as [number, number, number], path: S.robots[id].path };
    return { ...S, sim: { ...S.sim }, robots, tasks: { ...S.tasks }, zones: { ...S.zones }, alerts: { ...S.alerts }, kpi: { ...S.kpi }, recent_events: S.recent_events.slice(), recent_decisions: S.recent_decisions.slice() };
  }

  // ─────────────────────────────────────────────────────────
  // Tasks
  // ─────────────────────────────────────────────────────────
  private generateTasks() {
    const S = this.state;
    if (S.sim.tick < this.nextTaskTick) return;
    this.nextTaskTick = S.sim.tick + Math.round(SIM.TASK_INTERVAL_TICKS * (0.5 + this.rng()));
    const waiting = Object.values(S.tasks).filter((t) => t.status === "WAITING").length;
    if (waiting >= SIM.MAX_WAITING_TASKS) return;
    const shelves = this.layout.locations.filter((l) => l.kind === "SHELF");
    const packs = this.layout.locations.filter((l) => l.kind === "PACKING" || l.kind === "SORTING");
    const inbound = this.layout.locations.filter((l) => l.kind === "INBOUND");
    const outbound = this.layout.locations.filter((l) => l.kind === "OUTBOUND");
    const pick = <T,>(a: T[]) => a[Math.floor(this.rng() * a.length)];
    const r = this.rng();
    const pr: TaskPriority = r < 0.15 ? "HIGH" : r < 0.18 ? "CRITICAL" : "NORMAL";
    if (r < 0.55) this.createTask({ type: "PICK", priority: pr, source: pick(shelves).id, destination: pick(packs).id });
    else if (r < 0.8) this.createTask({ type: "REPLENISH", priority: pr, source: pick(inbound).id, destination: pick(shelves).id });
    else this.createTask({ type: "TRANSPORT", priority: pr, source: pick(packs).id, destination: pick(outbound).id });
  }

  /** Fleet Manager (simplified): a weighted score of distance + battery + workload + congestion + health, with an explainable candidate list */
  private assignTasks() {
    const S = this.state;
    const prioRank: Record<TaskPriority, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
    const waiting = Object.values(S.tasks).filter((t) => t.status === "WAITING").sort((a, b) => prioRank[a.priority] - prioRank[b.priority] || a.created_tick - b.created_tick);
    if (!waiting.length) return;
    const idle = Object.values(S.robots).filter((r) => r.fsm === "IDLE" && r.status !== "OFFLINE" && r.status !== "ERROR" && r.battery > THRESHOLDS.BATTERY_WARNING);
    const weights = { distance: 0.35, battery: 0.25, workload: 0.15, congestion: 0.15, health: 0.10 };
    for (const task of waiting) {
      if (!idle.length) return;
      const src = this.loc[task.source]; if (!src) { task.status = "FAILED"; continue; }
      const srcFloor = src.floor ?? 1;
      const liftPick: Record<string, string> = {};   // Best lift computed for each candidate at this moment (round-6 P2: the audit is bound to the real route)
      const cands: DecisionCandidate[] = idle.map((r) => {
        // Cross-floor: ground distance + fixed penalty + estimated wait from the real lift state (queue length / busy / current floor), converted to an equivalent distance
        const flat = Math.hypot(r.position[0] - src.access_point[0], r.position[2] - src.access_point[1]);
        let d = flat, liftInfo: { id: string; waitS: number } | null = null;
        if (r.floor !== srcFloor) {
          const best = [...this.layout.lifts].map((l) => ({ l, cost: this.liftCost(r, l) })).sort((a, b) => a.cost - b.cost || a.l.id.localeCompare(b.l.id))[0];
          const waitS = best && best.cost < Infinity
            ? Math.round((best.cost - Math.hypot(r.position[0] - (best.l.cell[0] - 1.5), r.position[2] - (best.l.cell[1] + 0.5)) / (SIM.MAX_SPEED * 0.8)) * 10) / 10
            : 60;
          liftInfo = { id: best && best.cost < Infinity ? best.l.id : "—", waitS };
          if (liftInfo.id !== "—") liftPick[r.id] = liftInfo.id;
          d = flat + SIM.LIFT_XFLOOR_PENALTY_M + waitS * SIM.MAX_SPEED * 0.8;
        }
        const zone = r.zone ? S.zones[r.zone] : null;
        const cong = zone ? zone.congestion : 0;
        const workload: DecisionCandidate["workload"] = r.stats.tasks_completed > 8 ? "HIGH" : r.stats.tasks_completed > 4 ? "MEDIUM" : "LOW";
        const score = weights.distance * (1 - Math.min(1, d / 120)) + weights.battery * (r.battery / 100) + weights.workload * (workload === "LOW" ? 1 : workload === "MEDIUM" ? 0.6 : 0.2) + weights.congestion * (1 - cong) + weights.health * (r.health / 100);
        const reasons: string[] = liftInfo
          ? [`${flat.toFixed(0)}m ground`, `+${SIM.LIFT_XFLOOR_PENALTY_M}m cross-floor via ${liftInfo.id}`, `est. lift wait ${liftInfo.waitS}s`, `${r.battery.toFixed(0)}% battery`]
          : [`${d.toFixed(0)}m from task`, `${r.battery.toFixed(0)}% battery`, `${workload.toLowerCase()} workload`];
        if (cong < 0.3) reasons.push("no route congestion");
        return { robot_id: r.id, score: Math.round(score * 1000) / 1000, distance_m: Math.round(d), battery: Math.round(r.battery), workload, congestion: Math.round(cong * 100) / 100, health: r.health, reasons, rejected_reason: null };
      }).sort((a, b) => b.score - a.score);
      const best = cands[0];
      for (const c of cands.slice(1)) c.rejected_reason = c.battery < 40 ? "battery too low" : c.distance_m > best.distance_m * 1.5 ? "farther from task" : c.workload === "HIGH" ? "high workload" : "lower score";
      const robot = S.robots[best.robot_id];
      idle.splice(idle.indexOf(robot), 1);
      task.status = "ASSIGNED"; task.assigned_robot = robot.id; task.assigned_tick = S.sim.tick;
      robot.current_task_id = task.id;
      this.rt[robot.id].plannedLiftId = liftPick[robot.id] ?? null;   // For a cross-floor plan, planTo prefers the lift recorded in the audit
      this.setFsm(robot, "TASK_ASSIGNED");
      const decision: AiDecision = { id: `D${++this.decisionSeq}`, tick: S.sim.tick, kind: "TASK_ASSIGNMENT", task_id: task.id, selected_robot: robot.id, candidates: cands.slice(0, 5), weights, narrative: null };
      S.recent_decisions.unshift(decision); if (S.recent_decisions.length > 50) S.recent_decisions.pop();
      this.emit("TASK_ASSIGNED", "FLEET_MANAGER", "INFO", `Task #${task.id} assigned to ${robot.id} (${best.distance_m}m, ${best.battery}%)`, { task_id: task.id, robot_id: robot.id });
    }
  }

  private pruneTasks() {
    const S = this.state; const tick = S.sim.tick;
    for (const id in S.tasks) { const t = S.tasks[id]; if ((t.status === "COMPLETED" || t.status === "FAILED" || t.status === "TRANSFERRED" || t.status === "CANCELLED") && t.completed_tick !== null && tick - t.completed_tick > 3000) delete S.tasks[id]; }
  }

  // ─────────────────────────────────────────────────────────
  // Robot FSM
  // ─────────────────────────────────────────────────────────
  private setFsm(r: RobotState, fsm: RobotFsmState) {
    if (r.fsm === fsm) return;
    r.fsm = fsm; r.fsm_since_tick = this.state.sim.tick;
    r.status = this.statusOf(r);
  }
  private statusOf(r: RobotState): RobotStatus {
    if (r.fsm === "OFFLINE") return "OFFLINE";
    if (r.fsm === "ERROR") return "ERROR";
    if (r.fsm === "CHARGING") return "CHARGING";
    if (r.battery < THRESHOLDS.BATTERY_CRITICAL) return "ERROR";
    if (r.battery < THRESHOLDS.BATTERY_WARNING) return "WARNING";
    if (r.fsm === "IDLE") return "IDLE";
    return "ACTIVE";
  }

  // ─────────────────────────────────────────────────────────
  // Lift (spec §6/§9/§10/§11/§13/§14)
  //  The backend (this engine) is the only authority: doors, platform height, reservation, queue, and board/alight all live here. The frontend only interpolates and renders.
  //  Nodes: slot0(=approach/exit) -> slot1 -> slot2 on the west side of the shaft; cabin = the center of the lift grid cell.
  // ─────────────────────────────────────────────────────────
  private liftLayout(id: string) { return this.layout.lifts.find((l) => l.id === id)!; }
  private elevOf(floor: number): number { return this.layout.floors.find((f) => f.id === floor)?.elevation ?? 0; }
  /** Queue grid cells (round-9b moves them back one more cell): slot0 = cell−4, 1.916 m from the safe turn point.
   *  The sweep circle of an in-place turn (diagonal radius 0.584) against a queued robot at any heading (worst case also 0.584) needs >= 1.17 m to guarantee no contact.
   *  With the old cell−3 (0.916 m apart), two robots that face each other while parked (0.475+0.475=0.95) already overlap. */
  private liftSlot(l: (typeof this.layout.lifts)[number], i: number): [number, number] { return [l.cell[0] - 4 - i + 0.5, l.cell[1] + 0.5]; }
  private liftCabin(l: (typeof this.layout.lifts)[number]): [number, number] { return [l.cell[0] + 0.5, l.cell[1] + 0.5]; }
  /** Exit node (spec §6.4): separate from the queue line, and the straight line from the cabin to the exit must avoid all parked robots (queued/idle).
   *  Selected once (sticky); switch to the next candidate only after a long block. This prevents in-place oscillation from a new target each tick. */
  private pickLiftExit(l: (typeof this.layout.lifts)[number], floor: number, toward: [number, number] | null = null, skip = 0): [number, number] {
    const grid = this.grids[floor];
    const cabin = this.liftCabin(l);
    // All candidates are on the west side (the door side): the cabin exit uses two segments, "door axis -> gate -> exit", and does not cut across the fence/columns (round-8b)
    const cand: Array<[number, number]> = [[-2, -2], [-2, 2], [-3, -1], [-3, 1], [-3, -2], [-3, 2], [-2, 0]];
    const segClear = (ax: number, az: number, bx: number, bz: number) => {
      for (const o of Object.values(this.state.robots)) {
        if (o.floor !== floor || o.lift_id) continue;
        if (o.velocity > 0.1) continue;                     // Avoid only robots that stand still
        const dx = bx - ax, dz = bz - az; const len2 = dx * dx + dz * dz;
        const t = Math.max(0, Math.min(1, ((o.position[0] - ax) * dx + (o.position[2] - az) * dz) / (len2 || 1)));
        const d = Math.hypot(o.position[0] - (ax + dx * t), o.position[2] - (az + dz * t));
        if (d < SIM.LIFT_SEP) return false;                 // The door area uses the "docking mode" separation (round-8e); real movement is also gated by LIFT_SEP
      }
      return true;
    };
    const g = this.liftGatePoint(l);
    const clear = (to: [number, number]) =>   // Both segments must be clear: cabin -> gate and gate -> exit
      segClear(cabin[0], cabin[1], g[0], g[1]) && segClear(g[0], g[1], to[0], to[1]);
    // round-8e: exits no longer rotate in a fixed order. The rule is now "nearest to the next destination first". If the destination is south, exit south; the robot does not turn to the wrong side and detour.
    // The (-2,±2) candidates next to the fence get a 0.75 m penalty, so the route no longer runs parallel along the shaft border.
    // round-9b: standing clearance. After it stands on the exit, the robot must still turn in place to leave (diagonal radius + the other robot's half length). Do not select candidates too close to a parked robot.
    const STAND_CLEAR = Math.hypot(SIM.ROBOT_HALF_LEN, SIM.ROBOT_HALF_W) + SIM.ROBOT_HALF_LEN;
    const standClear = (p: [number, number]) => {
      for (const o of Object.values(this.state.robots)) {
        if (o.floor !== floor || o.lift_id || o.velocity > 0.1) continue;
        if (Math.hypot(p[0] - o.position[0], p[1] - o.position[2]) < STAND_CLEAR) return false;
      }
      return true;
    };
    const ok: Array<{ p: [number, number]; key: number }> = [];
    for (const [dc, dr] of cand) {
      const c = l.cell[0] + dc, r = l.cell[1] + dr;
      if (!isWalkable(grid, c, r)) continue;
      const p: [number, number] = [c + 0.5, r + 0.5];
      if (!clear(p) || !standClear(p)) continue;
      const hug = dc === -2 && dr !== 0 ? 0.75 : 0;
      ok.push({ p, key: (toward ? Math.hypot(p[0] - toward[0], p[1] - toward[1]) : 0) + hug });
    }
    ok.sort((a, b) => a.key - b.key);
    if (ok.length) return ok[skip % ok.length].p;
    return [l.cell[0] - 2 + 0.5, l.cell[1] - 2 + 0.5];
  }

  /** Gate pass point = safe turn point (round-8d): the exact center of the door axis (z = cz, no offset; an offset makes the body sweep across the door frame).
   *  x = door face − body diagonal radius − 0.10 m margin (≈ cx − 2.084): the sweep circle radius of a rectangular body that turns in place is
   *  √(half length² + half width²) ≈ 0.584 m. With only the half length, the body enters the door face at the worst angle. At this point the whole robot clears the door frame even during a turn.
   *  The queue line is at cell−4−i (round-9b). This point is ≈ 1.916 m from an occupied slot0, so the in-place turn sweep is also safe for queued robots. */
  private liftGatePoint(l: (typeof this.layout.lifts)[number]): [number, number] {
    const cx = l.cell[0] + 0.5, cz = l.cell[1] + 0.5;
    return [cx - (SIM.LIFT_SHAFT_HALF_X + Math.hypot(SIM.ROBOT_HALF_LEN, SIM.ROBOT_HALF_W) + 0.10), cz];
  }

  /** Test whether two rotated rectangular bodies (OBB) intersect. Uses the separating axis theorem (SAT); margin is the extra safety gap (round-9b). */
  static obbOverlap(ax: number, az: number, ah: number, bx: number, bz: number, bh: number, margin = 0): boolean {
    const hl = SIM.ROBOT_HALF_LEN, hw = SIM.ROBOT_HALF_W;
    const dx = bx - ax, dz = bz - az;
    for (const t of [ah, ah + Math.PI / 2, bh, bh + Math.PI / 2]) {
      const ux = Math.cos(t), uz = Math.sin(t);
      const ra = hl * Math.abs(ux * Math.cos(ah) + uz * Math.sin(ah)) + hw * Math.abs(-ux * Math.sin(ah) + uz * Math.cos(ah));
      const rb = hl * Math.abs(ux * Math.cos(bh) + uz * Math.sin(bh)) + hw * Math.abs(-ux * Math.sin(bh) + uz * Math.cos(bh));
      if (Math.abs(dx * ux + dz * uz) > ra + rb + margin) return false;   // Separating axis found -> no intersection
    }
    return true;
  }

  /** Straight-line micro move (cabin entry/exit / queue advance; does not use the grid). Returns whether the robot has arrived. */
  private microMove(r: RobotState, to: [number, number], speed: number, floorOverride: number | null = null): boolean {
    const fl = floorOverride ?? r.floor;
    const dx = to[0] - r.position[0], dz = to[1] - r.position[2];
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) { r.velocity = 0; return true; }
    const step = Math.min(dist, speed * SIM.TICK_S);
    const nx = r.position[0] + (dx / dist) * step, nz = r.position[2] + (dz / dist) * step;
    // Queue and cabin entry/exit keep the physical separation, but with the "docking mode" LIFT_SEP (0.6 m): slow (0.6–0.9 m/s) micro moves.
    // With the aisle MIN_SEP 0.9, the door axis corridor and the queue line lock each other at the 0.9 m gauge (BOARDING vs TO_LIFT standoff).
    const moveH = Math.atan2(dz, dx);
    for (const id in this.state.robots) {
      if (id === r.id) continue; const o = this.state.robots[id];
      if (o.floor !== fl || o.lift_id) continue;
      const dn = Math.hypot(nx - o.position[0], nz - o.position[2]);
      const dcur = Math.hypot(r.position[0] - o.position[0], r.position[2] - o.position[2]);
      if (dn < SIM.LIFT_SEP && dn < dcur) { r.velocity = 0; return false; }
      // round-9b: beyond the center distance, also verify that the rotated body OBBs do not intersect (+5 cm gap). Block only steps that get closer.
      // Allow separation moves that increase distance; otherwise an already overlapped state locks up.
      if (dn < dcur && dn < 1.5 && SimEngine.obbOverlap(nx, nz, moveH, o.position[0], o.position[2], o.heading, 0.05)) { r.velocity = 0; return false; }
    }
    r.position[0] = nx; r.position[2] = nz;
    r.heading = Math.atan2(dz, dx); r.velocity = speed;
    return false;
  }

  private setLiftStage(r: RobotState, rt: RobotRt, stage: RobotRt["liftStage"]) { rt.liftStage = stage; r.lift_stage = stage; }

  /** Remove the robot from the lift flow (fault reselect / robot offline / task cancel) */
  releaseRobotFromLift(robotId: string) {
    const S = this.state;
    for (const lid in S.lifts) {
      const L = S.lifts[lid];
      for (const f of ["1", "2"]) { const i = L.queue[f].indexOf(robotId); if (i >= 0) L.queue[f].splice(i, 1); }
      if (L.reserved_by === robotId) { L.reserved_by = null; this.emit("LIFT_RESERVATION_RELEASED", "LIFT", "LOW", `${lid} reservation released (${robotId})`, { robot_id: robotId }); }
      if (L.occupant === robotId) { L.occupant = null; if (L.state === "BOARDING" || L.state === "ALIGHTING") { L.state = "DOOR_CLOSING_AFTER_EXIT"; L.until_tick = this.state.sim.tick + SIM.LIFT_DOOR_TICKS; } }
    }
    const r = S.robots[robotId]; const rt = this.rt[robotId];
    if (r && rt) { r.lift_id = null; this.setLiftStage(r, rt, null); rt.liftExit = null; rt.liftBlockedTicks = 0; rt.liftExitPhase = null; }
  }

  /** Advance the state machine of every lift each tick (runs before the robots) */
  private stepLifts() {
    const S = this.state; const tick = S.sim.tick;
    for (const lid of Object.keys(S.lifts).sort()) {
      const L = S.lifts[lid];
      if (L.fault) continue;                             // FAULT: freeze everything (platform height included) and wait for clear
      if (L.state !== "IDLE" && L.state !== "COOLDOWN") L.busy_ticks++;
      // Platform height interpolation (smoothstep while MOVING; otherwise snap to the floor)
      if (L.state === "MOVING_UP" || L.state === "MOVING_DOWN") {
        const t = Math.min(1, Math.max(0, 1 - (L.until_tick - tick) / SIM.LIFT_TRAVEL_TICKS));
        const e = t * t * (3 - 2 * t);
        const y0 = this.elevOf(L.state === "MOVING_UP" ? 1 : 2), y1 = this.elevOf(L.state === "MOVING_UP" ? 2 : 1);
        L.y = y0 + (y1 - y0) * e;
      } else if (L.floor !== null) L.y = this.elevOf(L.floor);
      if (tick < L.until_tick) continue;
      switch (L.state) {
        case "IDLE": {
          // Scheduling: FIFO. Take the head of each floor's queue, compare entry times (first come, first served); on a tie, take Floor 1.
          if (!L.reserved_by) {
            const heads: Array<[string, number]> = [];
            for (const f of ["1", "2"]) if (L.queue[f].length) { const rid = L.queue[f][0]; heads.push([rid, this.rt[rid]?.liftEnqueuedTick ?? 0]); }
            heads.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
            if (heads.length) { L.reserved_by = heads[0][0]; this.emit("LIFT_RESERVED", "LIFT", "INFO", `${lid} reserved by ${L.reserved_by}`, { robot_id: L.reserved_by }); }
          }
          if (L.reserved_by) {
            const rr = S.robots[L.reserved_by];
            if (!rr || rr.status === "OFFLINE") { this.releaseRobotFromLift(L.reserved_by!); break; }
            if (L.floor === rr.floor) { L.state = "DOOR_OPENING"; L.until_tick = tick + SIM.LIFT_DOOR_TICKS; }
            else { L.target_floor = rr.floor; L.state = rr.floor === 2 ? "MOVING_UP" : "MOVING_DOWN"; L.floor = null; L.until_tick = tick + SIM.LIFT_TRAVEL_TICKS; }
          }
          break;
        }
        case "MOVING_UP": case "MOVING_DOWN": { L.state = "LEVELING"; L.until_tick = tick + SIM.LIFT_LEVEL_TICKS; this.emit("LIFT_LEVELING", "LIFT", "LOW", `${lid} leveling at Floor ${L.target_floor}`, {}); break; }
        case "LEVELING": {
          L.floor = L.target_floor!; L.target_floor = null; L.y = this.elevOf(L.floor);
          L.state = L.occupant ? "DOOR_OPENING_AT_DESTINATION" : "DOOR_OPENING";
          L.until_tick = tick + SIM.LIFT_DOOR_TICKS;
          this.emit("LIFT_ARRIVED", "LIFT", "INFO", `${lid} arrived at Floor ${L.floor}`, {});
          break;
        }
        case "DOOR_OPENING": {
          (L.floor === 1 ? (L.door_f1 = "OPEN") : (L.door_f2 = "OPEN"));
          L.state = "BOARDING";                          // Wait for the reserved robot to walk in (driven on the robot side)
          this.emit("LIFT_GATE_OPENED", "LIFT", "LOW", `${lid} Floor ${L.floor} gate opened`, {});
          break;
        }
        case "BOARDING": {
          const rr = L.reserved_by ? S.robots[L.reserved_by] : null;
          if (!rr || rr.status === "OFFLINE") {          // Reserver gone -> close the doors and return to IDLE
            if (L.reserved_by) this.releaseRobotFromLift(L.reserved_by);
            L.door_f1 = "CLOSED"; L.door_f2 = "CLOSED"; L.state = "COOLDOWN"; L.until_tick = tick + SIM.LIFT_COOLDOWN_TICKS;
            this.emit("LIFT_COOLDOWN_STARTED", "LIFT", "LOW", `${lid} cooldown`, {});
          }
          break;                                          // The robot side sets occupant -> DOOR_CLOSING
        }
        case "DOOR_CLOSING": {
          L.door_f1 = "CLOSED"; L.door_f2 = "CLOSED";
          if (L.occupant) {
            const rr = S.robots[L.occupant]; const dest = this.rt[L.occupant]?.pending?.floor ?? (rr.floor === 1 ? 2 : 1);
            L.target_floor = dest; L.state = dest === 2 ? "MOVING_UP" : "MOVING_DOWN"; L.floor = null; L.until_tick = tick + SIM.LIFT_TRAVEL_TICKS;
            L.trips++;
            this.emit("LIFT_DEPARTED", "LIFT", "INFO", `${lid} departed → Floor ${dest} (${L.occupant})`, { robot_id: L.occupant });
          } else { L.state = "COOLDOWN"; L.until_tick = tick + SIM.LIFT_COOLDOWN_TICKS; this.emit("LIFT_COOLDOWN_STARTED", "LIFT", "LOW", `${lid} cooldown`, {}); }
          break;
        }
        case "DOOR_OPENING_AT_DESTINATION": {
          (L.floor === 1 ? (L.door_f1 = "OPEN") : (L.door_f2 = "OPEN"));
          L.state = "ALIGHTING";                          // The robot side walks the occupant out
          this.emit("LIFT_GATE_OPENED", "LIFT", "LOW", `${lid} Floor ${L.floor} gate opened`, {});
          break;
        }
        case "ALIGHTING": break;                          // The robot side clears occupant -> DOOR_CLOSING_AFTER_EXIT
        case "DOOR_CLOSING_AFTER_EXIT": { L.door_f1 = "CLOSED"; L.door_f2 = "CLOSED"; L.state = "COOLDOWN"; L.until_tick = tick + SIM.LIFT_COOLDOWN_TICKS; this.emit("LIFT_COOLDOWN_STARTED", "LIFT", "LOW", `${lid} cooldown`, {}); break; }
        case "COOLDOWN": { L.state = "IDLE"; break; }
        default: break;
      }
    }
  }

  /** Robot-side lift flow. Returns true = the lift flow consumed this tick (the FSM does not continue). */
  private handleLift(r: RobotState, rt: RobotRt): boolean {
    const S = this.state; const tick = S.sim.tick;
    const stage = rt.liftStage;
    if (stage === null || stage === "TO_LIFT") {
      if (rt.target !== null) return false;              // Still on the A* path to the queue grid cell
      // Arrived at the queue grid cell -> join the queue
      const L = S.lifts[rt.liftId!];
      if (L.fault) return this.reRouteLift(r, rt);
      const f = String(r.floor);
      if (!L.queue[f].includes(r.id)) { L.queue[f].push(r.id); rt.liftEnqueuedTick = tick; this.emit("LIFT_QUEUE_ENTERED", "LIFT", "LOW", `${r.id} queued at ${rt.liftId} (F${r.floor}, #${L.queue[f].length})`, { robot_id: r.id }); }
      this.setLiftStage(r, rt, "QUEUED");
      return true;
    }
    const L = S.lifts[rt.liftId!];
    const lay = this.liftLayout(rt.liftId!);
    if (L.fault && stage !== "RIDING" && stage !== "ALIGHTING") return this.reRouteLift(r, rt);   // If already in the cabin or on the way out, wait in place for recovery
    switch (stage) {
      case "QUEUED": {
        const f = String(r.floor);
        const pos = L.queue[f].indexOf(r.id);
        if (pos < 0) { this.setLiftStage(r, rt, "TO_LIFT"); return true; }
        // round-9f: queue advance uses the "clear lane". A straight cut to the queue grid cell from the east side or off the axis enters the boarding corridor at an angle,
        // and forms an OBB deadlock with the queue head in BOARDING (each waits for the other to move; neither moves).
        // Rules: x already aligned -> enter the cell straight; on the axis and west of its own cell -> advance along the axis as normal;
        // otherwise first move sideways 1.8 m off the axis (a step away from the axis is never blocked) -> move parallel along the clear lane to the side of the cell -> enter the cell straight.
        const slot = this.liftSlot(lay, Math.min(pos, 2));
        const dxs = r.position[0] - slot[0], dzs = r.position[2] - slot[1];
        const side = dzs >= 0 ? 1 : -1;
        let goal: [number, number];
        if (Math.abs(dxs) < 0.25) goal = slot;
        else if (Math.abs(dzs) < 0.25 && dxs < 0.35) goal = slot;
        else if (Math.abs(dzs) > 1.55) goal = [slot[0], slot[1] + side * 1.8];
        else goal = [r.position[0], slot[1] + side * 1.8];
        this.microMove(r, goal, SIM.LIFT_QUEUE_SPEED);
        // Queue head + my reservation + door open -> start to board
        if (pos === 0 && L.reserved_by === r.id && L.state === "BOARDING" && L.floor === r.floor) {
          this.setLiftStage(r, rt, "BOARDING");
          this.emit("ROBOT_BOARDING_STARTED", "LIFT", "INFO", `${r.id} boarding ${rt.liftId} → Floor ${rt.pending!.floor}`, { robot_id: r.id });
        }
        return true;
      }
      case "BOARDING": {
        if (this.microMove(r, this.liftCabin(lay), SIM.LIFT_BOARD_SPEED)) {
          const f = String(r.floor);
          const i = L.queue[f].indexOf(r.id); if (i >= 0) L.queue[f].splice(i, 1);
          L.occupant = r.id; L.reserved_by = null; r.lift_id = rt.liftId;
          L.wait_total_ticks += tick - rt.liftEnqueuedTick; L.wait_n++;
          L.state = "DOOR_CLOSING"; L.until_tick = tick + SIM.LIFT_DOOR_TICKS;
          this.setLiftStage(r, rt, "RIDING");
          this.emit("ROBOT_BOARDED", "LIFT", "INFO", `${r.id} boarded ${rt.liftId}`, { robot_id: r.id });
        }
        return true;
      }
      case "RIDING": {
        r.velocity = 0;                                   // Position stays fixed at the cabin center; the frontend draws y from L.y
        const c = this.liftCabin(lay); r.position[0] = c[0]; r.position[2] = c[1];
        if (L.state === "ALIGHTING" && L.floor === rt.pending!.floor) {
          // Door open -> start to alight. Do NOT flip the floor yet (spec §2.2: switch only after the robot fully leaves the cabin/door area)
          this.setLiftStage(r, rt, "ALIGHTING");
          this.emit("ROBOT_ALIGHTING_STARTED", "LIFT", "INFO", `${r.id} alighting ${rt.liftId} at Floor ${L.floor}`, { robot_id: r.id });
        }
        return true;
      }
      case "ALIGHTING": {
        const tf = rt.pending!.floor;                      // Compute the exit and separation on the destination floor; r.floor flips only at the moment the robot reaches the exit
        if (!rt.liftExit) { rt.liftExit = this.pickLiftExit(lay, tf, rt.pending!.point); rt.liftBlockedTicks = 0; rt.liftExitPhase = null; }
        const gate = this.liftGatePoint(lay);
        // Three-stage lift exit (round-8d): first turn in place to the door inside the cabin -> move straight along the door axis and TRULY reach the safe turn point (door face − diagonal radius − 0.10 m)
        // -> turn in place toward the exit (speed 0, limited angular speed 4.0 rad/s, move only when the error is < 0.06 rad) -> go to the exit.
        // Movement and rotation no longer happen at the same time: the turn sweep (diagonal radius 0.584 m) stays clear of the door frame, and the view does not "swing while it moves".
        if (!rt.liftExitPhase) rt.liftExitPhase = "TURN_OUT";
        const rotateTo = (tx: number, tz: number): boolean => {
          const want = Math.atan2(tz - r.position[2], tx - r.position[0]);
          let dh = want - r.heading; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
          r.velocity = 0;
          r.heading += Math.sign(dh) * Math.min(Math.abs(dh), 4.0 * SIM.TICK_S);
          return Math.abs(dh) < 0.06;
        };
        let arrived = false;
        if (rt.liftExitPhase === "TURN_OUT") { if (rotateTo(gate[0], gate[1])) rt.liftExitPhase = "OUT"; }
        else if (rt.liftExitPhase === "OUT") { if (this.microMove(r, gate, SIM.LIFT_BOARD_SPEED, tf)) rt.liftExitPhase = "TURN_EXIT"; }
        else if (rt.liftExitPhase === "TURN_EXIT") { if (rotateTo(rt.liftExit[0], rt.liftExit[1])) rt.liftExitPhase = "GO"; }
        else arrived = this.microMove(r, rt.liftExit, SIM.LIFT_BOARD_SPEED, tf);
        if (!arrived && r.velocity === 0 && (rt.liftExitPhase === "OUT" || rt.liftExitPhase === "GO")) {
          if (++rt.liftBlockedTicks % 40 === 0) {   // Blocked for 4 s -> switch to another exit; after the switch, turn first, then move
            rt.liftExit = this.pickLiftExit(lay, tf, rt.pending!.point, rt.liftBlockedTicks / 40);
            if (rt.liftExitPhase === "GO") rt.liftExitPhase = "TURN_EXIT";
          }
        } else if (r.velocity > 0) rt.liftBlockedTicks = 0;
        if (arrived) {
          r.floor = tf;                                    // ✅ The robot enters the destination floor grid only at the moment it fully leaves the door area
          L.occupant = null; r.lift_id = null;
          L.state = "DOOR_CLOSING_AFTER_EXIT"; L.until_tick = tick + SIM.LIFT_DOOR_TICKS;
          this.emit("ROBOT_EXITED", "LIFT", "INFO", `${r.id} exited ${rt.liftId} on Floor ${r.floor}`, { robot_id: r.id });
          const p = rt.pending!; rt.pending = null; this.setLiftStage(r, rt, null); rt.liftId = null; rt.liftExit = null; rt.liftBlockedTicks = 0; rt.liftExitPhase = null;
          this.planTo(r, rt, p.point, p.phase, p.locId, p.floor);   // REPLANNING_AFTER_LIFT
        }
        return true;
      }
      default: return false;
    }
  }

  /** Lift fault: leave this lift's queue and select another lift; if both lifts have faults, retry in place at intervals */
  private reRouteLift(r: RobotState, rt: RobotRt): boolean {
    const tick = this.state.sim.tick;
    if (tick < rt.liftRetryTick) { r.velocity = 0; return true; }
    rt.liftRetryTick = tick + SIM.LIFT_RETRY_TICKS;
    const p = rt.pending!;
    this.releaseRobotFromLift(r.id);
    rt.pending = p;                                       // release clears the stage; keep pending
    const alive = this.layout.lifts.filter((l) => !this.state.lifts[l.id].fault);
    if (!alive.length) { r.velocity = 0; return true; }   // All lifts have faults: wait in place and retry after LIFT_RETRY_TICKS
    this.planTo(r, rt, p.point, p.phase, p.locId, p.floor);
    this.emit("ROUTE_REPLANNED", "LIFT", "MEDIUM", `${r.id} rerouted to ${rt.liftId} (lift fault)`, { robot_id: r.id });
    return true;
  }

  private stepRobot(r: RobotState, rt: RobotRt) {
    const S = this.state; const tick = S.sim.tick;
    if (r.fsm === "OFFLINE") { r.velocity = 0; return; }
    this.batteryTick(r, rt);
    const task = r.current_task_id ? S.tasks[r.current_task_id] : undefined;
    if (rt.pending && this.handleLift(r, rt)) {
      r.status = this.statusOf(r);
      if (r.fsm !== "IDLE" && r.fsm !== "CHARGING") r.stats.busy_ticks++;
      r.zone = this.zoneAt(r.position[0], r.position[2], r.floor);
      return;
    }

    switch (r.fsm) {
      case "IDLE": {
        r.velocity = 0; rt.idleTicks++;
        if (r.battery < THRESHOLDS.BATTERY_WARNING + 15 && this.freeCharger()) { this.goCharge(r, rt); break; }
        if (rt.idleTicks > SIM.IDLE_TO_PARK_TICKS && !rt.phase && r.floor === 1) { const p = this.parkSpot(r); if (p) { this.planTo(r, rt, p, "TO_PARK"); } }
        if (rt.phase === "TO_PARK") { this.moveAlongPath(r, rt); if (rt.target === null && !rt.pending) rt.phase = null; }
        break;
      }
      case "TASK_ASSIGNED": {
        rt.idleTicks = 0;
        if (!task) { this.setFsm(r, "IDLE"); break; }
        const src = this.loc[task.source];
        this.planTo(r, rt, src.access_point, "TO_SOURCE", task.source);
        task.status = "IN_PROGRESS"; task.started_tick = tick;
        this.setFsm(r, "NAVIGATING");
        break;
      }
      case "NAVIGATING": {
        if (!task) { this.setFsm(r, "IDLE"); break; }
        this.moveAlongPath(r, rt);
        if (rt.target === null && !rt.pending) { rt.dwell = SIM.PICK_TICKS; this.setFsm(r, "PICKING"); }
        break;
      }
      case "PICKING": {
        r.velocity = 0;
        if (--rt.dwell <= 0 && task) {
          const dest = this.loc[task.destination];
          if (!dest) { // Defense: the destination does not exist -> the task fails, the robot returns to IDLE, and the loop does not crash
            task.status = "FAILED"; task.completed_tick = tick;
            this.emit("TASK_FAILED", "SIMULATION", "HIGH", `Task #${task.id} failed: unknown destination ${task.destination}`, { robot_id: r.id, task_id: task.id });
            r.current_task_id = null; r.destination = null; rt.phase = null; rt.goalLoc = null; this.setFsm(r, "IDLE"); break;
          }
          r.load.current = Math.min(r.load.capacity, task.load_units);
          this.emit("TASK_STARTED", "ROBOT", "INFO", `${r.id} picked item at ${this.pretty(task.source)}`, { robot_id: r.id, task_id: task.id });
          this.planTo(r, rt, dest.access_point, "TO_DEST", task.destination);
          this.setFsm(r, "TRANSPORTING");
        }
        break;
      }
      case "TRANSPORTING": {
        if (!task) { this.setFsm(r, "IDLE"); break; }
        // Low battery: estimate whether the charge covers the remaining distance; otherwise transfer the task
        if (r.battery < THRESHOLDS.BATTERY_WARNING && rt.lastBatteryAlert !== "CRIT") {
          const remain = this.remainingPathLength(r);
          const need = remain * (SIM.BATTERY_MOVE + SIM.BATTERY_LOAD) / (SIM.MAX_SPEED * SIM.TICK_S) + 3;
          if (need > r.battery - THRESHOLDS.BATTERY_CRITICAL) { this.setFsm(r, "LOW_BATTERY"); break; }
        }
        this.moveAlongPath(r, rt);
        if (rt.target === null && !rt.pending) { rt.dwell = SIM.DROP_TICKS * this.stationSlowdown(task.destination); this.setFsm(r, "DELIVERING"); }
        break;
      }
      case "DELIVERING": {
        r.velocity = 0;
        if (--rt.dwell <= 0) { this.completeTask(r, rt); }
        break;
      }
      case "COMPLETED": {
        this.setFsm(r, "IDLE"); rt.idleTicks = 0;
        break;
      }
      case "LOW_BATTERY": {
        r.velocity = 0;
        this.setFsm(r, "TASK_TRANSFER");
        break;
      }
      case "TASK_TRANSFER": {
        if (task) {
          task.status = "TRANSFERRED"; task.completed_tick = tick;
          const nt = this.createTask({ type: task.type, priority: task.priority === "NORMAL" ? "HIGH" : task.priority, source: task.source, destination: task.destination, load_units: task.load_units });
          nt.parent_task_id = task.id;
          this.emit("TASK_TRANSFERRED", "FLEET_MANAGER", "MEDIUM", `${r.id} low battery — task #${task.id} re-queued as #${nt.id}`, { robot_id: r.id, task_id: nt.id });
          r.load.current = 0; r.current_task_id = null;
        }
        this.goCharge(r, rt);
        break;
      }
      case "GOING_TO_CHARGE": {
        this.moveAlongPath(r, rt);
        if (rt.target === null && !rt.pending) {
          this.setFsm(r, "CHARGING");
          // Dock alignment (round-9d): stop at the exact center of the robot's own blue charge pad, nose toward the station. The frontend tweens this as a docking motion.
          const chg = rt.chargerId ? this.layout.charging_stations.find((c) => c.id === rt.chargerId) : undefined;
          if (chg) { r.position[0] = chg.position[0]; r.position[2] = chg.position[2] - 1.9; r.heading = Math.PI / 2; r.velocity = 0; }   // −1.9 = center of the full parking-row grid cell (64.5): 1.0 m clearance from the south corridor, so a robot behind can pass
          this.emit("ROBOT_STATE_CHANGED", "ROBOT", "INFO", `${r.id} charging started (${r.battery.toFixed(0)}%)`, { robot_id: r.id });
        }
        break;
      }
      case "CHARGING": {
        r.velocity = 0;
        r.battery = Math.min(100, r.battery + SIM.CHARGE_RATE);
        if (r.battery >= THRESHOLDS.BATTERY_CHARGE_TO) {
          if (rt.chargerId) this.chargerBusy[rt.chargerId] = null; rt.chargerId = null;
          rt.lastBatteryAlert = "NONE"; this.resolveAlert(`bat-${r.id}`);
          this.setFsm(r, "IDLE"); rt.idleTicks = 0;
          this.emit("ROBOT_STATE_CHANGED", "ROBOT", "INFO", `${r.id} charging complete`, { robot_id: r.id });
        }
        break;
      }
      case "OBSTACLE_DETECTED": { this.setFsm(r, "REPLANNING"); break; }
      case "REPLANNING": {
        // Replan with the currently occupied grid cells as temporary obstacles
        if (rt.target) {
          const blocked = this.blockedCells(r.id, r.floor);
          const p = astar(this.grids[r.floor], toCell(r.position[0], r.position[2]), rt.target, { blocked, costMap: this.congestionCost(r.floor) });
          if (p) { r.path = p; r.path_index = 0; rt.waitTicks = 0; this.emit("ROUTE_REPLANNED", "PLANNER", "LOW", `${r.id} rerouted (${p.length} cells)`, { robot_id: r.id, task_id: r.current_task_id ?? undefined }); }
        }
        this.setFsm(r, rt.phase === "TO_DEST" ? "TRANSPORTING" : rt.phase === "TO_CHARGER" ? "GOING_TO_CHARGE" : rt.phase === "TO_PARK" ? "IDLE" : "NAVIGATING");
        break;
      }
      case "ERROR": { r.velocity = 0; break; }
    }
    r.status = this.statusOf(r);
    if (r.fsm !== "IDLE" && r.fsm !== "CHARGING") r.stats.busy_ticks++;
    r.zone = this.zoneAt(r.position[0], r.position[2], r.floor);
  }

  private completeTask(r: RobotState, rt: RobotRt) {
    const S = this.state; const task = r.current_task_id ? S.tasks[r.current_task_id] : undefined;
    if (task) {
      task.status = "COMPLETED"; task.completed_tick = S.sim.tick;
      const dur = S.sim.tick - (task.created_tick);
      this.taskTimes.push(dur); if (this.taskTimes.length > 200) this.taskTimes.shift();
      this.completedCount++; if (task.deadline_tick === null || S.sim.tick <= task.deadline_tick) this.onTime++;
      r.stats.tasks_completed++;
      this.emit("TASK_COMPLETED", "ROBOT", "INFO", `${r.id} completed task #${task.id} at ${this.pretty(task.destination)}`, { robot_id: r.id, task_id: task.id });
    }
    r.load.current = 0; r.current_task_id = null; r.destination = null; rt.phase = null; rt.goalLoc = null;
    this.setFsm(r, "COMPLETED");
  }

  // ─────────────────────────────────────────────────────────
  // Path and movement
  // ─────────────────────────────────────────────────────────
  /** Service cells of a station/shelf: walkable grid cells around the access point that no other robot targets or occupies. Pick the one nearest to this robot; return null when all are full. */
  private freeServiceCell(r: RobotState, point: [number, number]): GridCell | null {
    const grid = this.grids[r.floor];
    const ap = nearestWalkable(grid, point[0], point[1]);
    const claimed = new Set<string>();
    for (const id in this.state.robots) { if (id === r.id) continue; const o = this.state.robots[id]; if (o.floor !== r.floor) continue; const t = this.rt[id].target; if (t) claimed.add(cellKey(t[0], t[1])); const c = toCell(o.position[0], o.position[2]); claimed.add(cellKey(c[0], c[1])); }
    const my = toCell(r.position[0], r.position[2]);
    let best: GridCell | null = null, bestD = Infinity;
    for (let dr = -SIM.SERVICE_RADIUS; dr <= SIM.SERVICE_RADIUS; dr++) for (let dc = -SIM.SERVICE_RADIUS; dc <= SIM.SERVICE_RADIUS; dc++) {
      const c: GridCell = [ap[0] + dc, ap[1] + dr];
      if (!isWalkable(grid, c[0], c[1]) || claimed.has(cellKey(c[0], c[1]))) continue;
      const d = Math.hypot(c[0] - my[0], c[1] - my[1]) + Math.hypot(dc, dr) * 0.01; // Nearer first; at equal distance, the cell nearer to the access point first
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /** Select a lift: idle first, then nearest; on a tie, take the smaller id (deterministic) */
  /** Lift cost (spec §7.2): time to walk to the lift + queue estimate + lift positioning estimate; do not select a FAULT lift. Returns null = no lift available */
  liftCost(r: RobotState, l: (typeof this.layout.lifts)[number]): number {
    const L = this.state.lifts[l.id];
    if (L.fault) return Infinity;
    const approach = Math.hypot(r.position[0] - (l.cell[0] - 1.5), r.position[2] - (l.cell[1] + 0.5)) / (SIM.MAX_SPEED * 0.8);
    // The reserver stays in the queue until it boards. Add the extra +1 only when it is in neither queue (already left to board), to avoid a double count of the wait cost.
    const reservedExtra = L.reserved_by && !L.queue["1"].includes(L.reserved_by) && !L.queue["2"].includes(L.reserved_by) ? 1 : 0;
    const queueLen = L.queue["1"].length + L.queue["2"].length + reservedExtra;
    const perService = (SIM.LIFT_DOOR_TICKS * 4 + SIM.LIFT_TRAVEL_TICKS + SIM.LIFT_LEVEL_TICKS + SIM.LIFT_COOLDOWN_TICKS + 40) * SIM.TICK_S;
    const busy = L.state === "IDLE" ? 0 : perService * 0.5;
    const wrongFloor = L.floor !== null && L.floor !== r.floor ? SIM.LIFT_TRAVEL_TICKS * SIM.TICK_S : 0;
    return approach + queueLen * perService + busy + wrongFloor;
  }

  private pickLift(r: RobotState): (typeof this.layout.lifts)[number] | null {
    const c = [...this.layout.lifts].map((l) => ({ l, cost: this.liftCost(r, l) })).sort((a, b) => a.cost - b.cost || a.l.id.localeCompare(b.l.id));
    return c.length && c[0].cost < Infinity ? c[0].l : null;
  }

  private planTo(r: RobotState, rt: RobotRt, point: [number, number], phase: RobotRt["phase"], locId: string | null = null, targetFloor: number | null = null) {
    const tf = targetFloor ?? (locId ? this.loc[locId]?.floor ?? 1 : r.floor);
    if (tf !== r.floor) {
      // Cross-floor (spec §7): Origin -> queue grid cell (A*) -> lift state machine (stepLifts/handleLift) -> replan on the destination floor
      // Prefer the lift that the assignment audit recorded (reselect only when it has a FAULT); clear the record after use (round-6 P2)
      const preferred = rt.plannedLiftId ? this.layout.lifts.find((l) => l.id === rt.plannedLiftId && !this.state.lifts[l.id].fault) ?? null : null;
      rt.plannedLiftId = null;
      const lift = preferred ?? this.pickLift(r);
      rt.pending = { point, phase, locId, floor: tf };
      if (!lift) { rt.liftId = this.layout.lifts[0]?.id ?? null; this.setLiftStage(r, rt, "TO_LIFT"); rt.target = null; r.path = []; r.path_index = 0; rt.liftRetryTick = this.state.sim.tick + SIM.LIFT_RETRY_TICKS; return; }
      rt.liftId = lift.id;
      this.setLiftStage(r, rt, "TO_LIFT");
      this.emit("LIFT_REQUESTED", "LIFT", "LOW", `${r.id} requested ${lift.id} (F${r.floor} → F${tf})`, { robot_id: r.id });
      const L = this.state.lifts[lift.id];
      const slotIdx = Math.min(L.queue[String(r.floor)].length, 2);
      const sp = this.liftSlot(lift, slotIdx);
      const start = toCell(r.position[0], r.position[2]);
      const goal: GridCell = [Math.floor(sp[0]), Math.floor(sp[1])];
      const grid = this.grids[r.floor];
      const path = astar(grid, start, goal, { blocked: this.blockedCells(r.id, r.floor), costMap: this.congestionCost(r.floor) }) ?? astar(grid, start, goal) ?? [];
      r.path = path; r.path_index = 0; rt.target = goal; rt.phase = phase; rt.goalLoc = locId; rt.waitTicks = 0; rt.backingOff = false; rt.resumePoint = null;
      r.destination = locId;
      if (path.length === 0 && (start[0] !== goal[0] || start[1] !== goal[1])) rt.target = null;
      this.updateEta(r);
      return;
    }
    const start = toCell(r.position[0], r.position[2]);
    const grid = this.grids[r.floor];
    // TO_CHARGER does not use service cells (round-9d): service cells scatter robots into any free cell near the charging stations. For a charge, go straight to the entry cell of the robot's own station.
    const goal = (locId && phase !== "TO_CHARGER" ? this.freeServiceCell(r, point) : null) ?? nearestWalkable(grid, point[0], point[1]);
    const path = astar(grid, start, goal, { blocked: this.blockedCells(r.id, r.floor), costMap: this.congestionCost(r.floor) }) ?? astar(grid, start, goal) ?? [];
    r.path = path; r.path_index = 0; rt.target = goal; rt.phase = phase; rt.goalLoc = locId; rt.waitTicks = 0; rt.backingOff = false; rt.resumePoint = null;
    r.destination = locId;
    if (path.length === 0 && (start[0] !== goal[0] || start[1] !== goal[1])) { rt.target = null; }
    this.updateEta(r);
  }

  private moveAlongPath(r: RobotState, rt: RobotRt) {
    if (rt.target === null) return;
    if (r.path_index >= r.path.length) { rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; return; }
    const next = r.path[r.path_index];
    const [tx, tz] = cellCenter(next);
    const dx = tx - r.position[0], dz = tz - r.position[2];
    const dist = Math.hypot(dx, dz);
    // Occupancy check: wait when another robot occupies the next grid cell
    let occ = this.occupancy.get(cellKey(next[0], next[1]));
    const myCell = toCell(r.position[0], r.position[2]);
    const entering = !(myCell[0] === next[0] && myCell[1] === next[1]);
    // For a diagonal move, the two orthogonal neighbor cells must also hold no other robot (otherwise robots scrape at the corner)
    if (entering && !occ && next[0] !== myCell[0] && next[1] !== myCell[1]) {
      const a = this.occupancy.get(cellKey(next[0], myCell[1])), b = this.occupancy.get(cellKey(myCell[0], next[1]));
      if (a && a !== r.id) occ = a; else if (b && b !== r.id) occ = b;
    }
    // Perception layer: a dynamic obstacle (another robot / a person) straight ahead within PERC_STOP also counts as blocked. The robot stops one cell earlier than the cell reservation, so bodies no longer touch.
    let blockedBy: string | null = entering && occ && occ !== r.id ? occ : null;
    const percStop = rt.frontId !== null && rt.frontDist < SIM.PERC_STOP;
    if (!blockedBy && percStop) blockedBy = rt.frontId;
    if (blockedBy) {
      occ = blockedBy;
      // Blocked at the lobby entrance by queued robots on the way to the lift: treat this as arrival. After it joins the queue, the queue logic advances the robot to its slot.
      if (rt.liftStage === "TO_LIFT" && r.path.length - r.path_index <= 2) {
        rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; rt.waitTicks = 0; return;
      }
      if (percStop && r.perception.state !== "STOPPED") {
        r.perception.state = "STOPPED";
        if (this.state.sim.tick - rt.lastPercEvent > SIM.PERC_EVENT_TICKS && rt.frontId && this.state.robots[rt.frontId]) {
          rt.lastPercEvent = this.state.sim.tick;
          this.emit("OBSTACLE_DETECTED", "ROBOT", "LOW", `${r.id} LiDAR: ${rt.frontId} ahead ${rt.frontDist.toFixed(1)} m — holding`, { robot_id: r.id });
        }
      }
      const remaining0 = r.path.length - r.path_index;
      // Queue in front of a station: within N grid cells of the target, treat this as arrival and work in place (prevents a deadlock when 10 robots line up for the same cell)
      if (!rt.backingOff && remaining0 <= SIM.STATION_ARRIVE_CELLS && (rt.phase === "TO_SOURCE" || rt.phase === "TO_DEST")) {
        // First look for another free service cell (one robot per cell, no overlap); work in place only when all are truly full
        const loc = rt.goalLoc ? this.loc[rt.goalLoc] : null;
        const alt = loc ? this.freeServiceCell(r, loc.access_point) : null;
        if (alt && (alt[0] !== rt.target![0] || alt[1] !== rt.target![1])) {
          const p = astar(this.grids[r.floor], myCell, alt, { blocked: this.blockedCells(r.id, r.floor) });
          if (p && p.length) { r.path = p; r.path_index = 0; rt.target = alt; rt.waitTicks = 0; return; }
        }
        rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; r.eta_s = 0; rt.waitTicks = 0; return;
      }
      r.velocity = Math.max(0, r.velocity - SIM.ACCEL * SIM.TICK_S * 2);
      rt.waitTicks++; r.stats.wait_ticks++;
      const other = this.state.robots[occ];
      // Mutual block: the other robot's next cell is my cell, or its LiDAR also has me straight ahead (face to face)
      const mutual = !!other && ((other.path_index < other.path.length && other.path[other.path_index][0] === myCell[0] && other.path[other.path_index][1] === myCell[1]) || this.rt[other.id].frontId === r.id);
      if (mutual && rt.waitTicks > 10 && this.yieldsTo(r, other)) { this.backOff(r, rt); return; }
      if (rt.waitTicks === SIM.WAIT_REPLAN_TICKS) { this.emit("OBSTACLE_DETECTED", "ROBOT", "LOW", `${r.id} blocked by ${occ} — replanning`, { robot_id: r.id }); this.setFsm(r, "OBSTACLE_DETECTED"); }
      else if (rt.waitTicks >= SIM.WAIT_BACKOFF_TICKS) { this.backOff(r, rt); }
      return;
    }
    // Note: do not reset waitTicks here. Reset it only after the robot truly moves (round-8b).
    // Otherwise a pure physical-separation stop (the MIN_SEP check below) resets it to 1 each tick, the back-off threshold is never reached,
    // and two robots in a 0.9 m narrow aisle stand off forever.
    // Reserve the next cell at once, so other robots do not also select it within the same tick
    if (entering) {
      this.occupancy.set(cellKey(next[0], next[1]), r.id);
      // Diagonal: also reserve the two orthogonal neighbor cells, so no other robot cuts into the corner during this tick
      if (next[0] !== myCell[0] && next[1] !== myCell[1]) { const k1 = cellKey(next[0], myCell[1]), k2 = cellKey(myCell[0], next[1]); if (!this.occupancy.has(k1)) this.occupancy.set(k1, r.id); if (!this.occupancy.has(k2)) this.occupancy.set(k2, r.id); }
    }
    // Speed: accelerate to the limit; slow down for turns and near the end point
    const desiredHeading = Math.atan2(dz, dx);
    let dh = desiredHeading - r.heading; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    const turning = Math.abs(dh) > 0.3;
    const remaining = r.path.length - r.path_index;
    const slowing = rt.frontId !== null && rt.frontDist < SIM.PERC_SLOW;
    if (slowing) r.perception.state = "SLOWING";
    const vmax = r.max_speed * (turning ? SIM.TURN_SLOW : 1) * (remaining <= 1 ? 0.5 : 1) * (this.grids[r.floor].cells[next[1] * this.grid.cols + next[0]] === 2 ? 0.6 : 1) * (this.congestedZones.size ? this.zoneSpeedFactor(next, r.floor) : 1) * (slowing ? 0.45 : 1);
    r.velocity = Math.min(vmax, r.velocity + SIM.ACCEL * SIM.TICK_S);
    r.heading += Math.sign(dh) * Math.min(Math.abs(dh), 4.0 * SIM.TICK_S);
    const stepLen = Math.min(dist, r.velocity * SIM.TICK_S);
    if (dist > 1e-6) {
      const nx = r.position[0] + (dx / dist) * stepLen, nz = r.position[2] + (dz / dist) * stepLen;
      // Physical collision guard: this step gets me closer to some robot and (center distance < MIN_SEP, or the rotated body OBBs intersect +5cm) -> do not move (round-9b adds the OBB check)
      for (const id in this.state.robots) {
        if (id === r.id) continue; const o = this.state.robots[id];
        if (o.floor !== r.floor) continue;   // 2D coordinates overlap across floors; the physical separation applies only on the same floor
        const dn = Math.hypot(nx - o.position[0], nz - o.position[2]);
        const dcur = Math.hypot(r.position[0] - o.position[0], r.position[2] - o.position[2]);
        const hit = dn < dcur && (dn < SIM.MIN_SEP || (dn < 1.5 && SimEngine.obbOverlap(nx, nz, r.heading, o.position[0], o.position[2], o.heading, 0.05)));
        if (hit) { r.velocity = 0; rt.waitTicks++; r.stats.wait_ticks++; if (rt.waitTicks >= SIM.WAIT_BACKOFF_TICKS) this.backOff(r, rt); return; }
      }
      r.position[0] = nx; r.position[2] = nz;
      rt.waitTicks = 0;   // The block clears only after the robot truly moves
    }
    r.stats.distance_m += stepLen;
    // Traffic heatmap
    { const ci = myCell[1] * this.grid.cols + myCell[0]; const T = this.traffic[r.floor], TS = this.trafficShort[r.floor]; if (T && ci >= 0 && ci < T.length) { T[ci] += 1; TS[ci] += 1; } }
    if (dist - stepLen < 0.08) {
      r.path_index++;
      this.occupancy.set(cellKey(next[0], next[1]), r.id);
      if (r.path_index >= r.path.length) {
        rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; r.eta_s = 0;
        if (rt.backingOff && rt.resumePoint) {
          const rp = rt.resumePoint; rt.backingOff = false; rt.resumePoint = null;
          // round-9b: the recovery plan after a yield on the way TO_LIFT keeps the original lift (unless it has a fault).
          // Otherwise the cross-floor branch of planTo rerolls the lift selection and breaks the "assignment audit = real lift" consistency.
          if (rt.liftStage === "TO_LIFT" && rt.liftId && !this.state.lifts[rt.liftId]?.fault) rt.plannedLiftId = rt.liftId;
          this.planTo(r, rt, rp, rt.phase, rt.goalLoc);
        }
      }
    }
    if (this.state.sim.tick % 10 === 0) this.updateEta(r);
  }

  /** Who yields: an empty robot yields to a loaded robot; when equal, the robot with the larger id yields */
  private yieldsTo(me: RobotState, other: RobotState): boolean {
    if ((me.load.current > 0) !== (other.load.current > 0)) return me.load.current === 0;
    return me.id > other.id;
  }
  /** Yield: move to a nearby free grid cell that no robot plans to pass, then return to the original target and replan */
  private backOff(r: RobotState, rt: RobotRt) {
    if (rt.backingOff || !rt.target) { rt.waitTicks = 0; return; }
    const my = toCell(r.position[0], r.position[2]);
    const claimed = new Set<string>();
    for (const id in this.state.robots) { const o = this.state.robots[id]; if (o.id === r.id || o.floor !== r.floor) continue; const c = toCell(o.position[0], o.position[2]); claimed.add(cellKey(c[0], c[1])); for (let i = o.path_index; i < Math.min(o.path.length, o.path_index + 4); i++) claimed.add(cellKey(o.path[i][0], o.path[i][1])); }
    let best: GridCell | null = null, bestD = Infinity;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
      if (!dr && !dc) continue;
      const c: GridCell = [my[0] + dc, my[1] + dr];
      if (!isWalkable(this.grids[r.floor], c[0], c[1]) || claimed.has(cellKey(c[0], c[1]))) continue;
      const d = Math.abs(dr) + Math.abs(dc); if (d < bestD) { bestD = d; best = c; }
    }
    rt.waitTicks = 0;
    if (!best) return;
    const p = astar(this.grids[r.floor], my, best, { blocked: claimed });
    if (!p || !p.length) return;
    const [gx, gz] = cellCenter(rt.target);
    rt.resumePoint = [gx, gz]; rt.backingOff = true; rt.target = best;
    r.path = p; r.path_index = 0;
    this.emit("ROBOT_COLLISION_AVOIDED", "PLANNER", "LOW", `${r.id} yields (back-off ${p.length} cells)`, { robot_id: r.id });
  }

  private remainingPathLength(r: RobotState): number {
    let len = 0; let [px, pz] = [r.position[0], r.position[2]];
    for (let i = r.path_index; i < r.path.length; i++) { const [cx, cz] = cellCenter(r.path[i]); len += Math.hypot(cx - px, cz - pz); px = cx; pz = cz; }
    return len;
  }
  private updateEta(r: RobotState) { r.eta_s = r.path.length ? Math.round(this.remainingPathLength(r) / (r.max_speed * 0.8)) : null; }

  // ─────────────────────────────────────────────────────────
  // Phase 7: virtual LiDAR perception (270° / 4 m)
  //  - Dynamic obstacles: other robots and people (must be in the field of view with no shelf occlusion)
  //  - Static: step a ray along the heading to the first non-walkable grid cell -> ahead_m
  //  - The nearest dynamic obstacle straight ahead (bearing < 40°, lateral offset < 0.75 m) decides STOPPED / SLOWING
  // ─────────────────────────────────────────────────────────
  private lineOfSight(grid: NavGrid, x0: number, z0: number, x1: number, z1: number): boolean {
    const d = Math.hypot(x1 - x0, z1 - z0); const n = Math.max(1, Math.ceil(d / 0.5));
    for (let i = 1; i < n; i++) { const t = i / n; const c = toCell(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t); if (!isWalkable(grid, c[0], c[1])) return false; }
    return true;
  }
  private updatePerception(r: RobotState, rt: RobotRt) {
    const P = r.perception;
    if (r.fsm === "OFFLINE") { P.state = "OFF"; P.obstacles = []; P.nearest_m = null; P.ahead_m = 0; rt.frontId = null; rt.frontDist = Infinity; return; }
    const [x, , z] = r.position; const h = r.heading; const cosH = Math.cos(h), sinH = Math.sin(h);
    const grid = this.grids[r.floor];
    const obs: PerceivedObstacle[] = [];
    const consider = (kind: "ROBOT" | "HUMAN", id: string, ox: number, oz: number) => {
      const dx = ox - x, dz = oz - z; const dist = Math.hypot(dx, dz);
      if (dist > SIM.LIDAR_RANGE || dist < 1e-6) return;
      let b = Math.atan2(dz, dx) - h; while (b > Math.PI) b -= 2 * Math.PI; while (b < -Math.PI) b += 2 * Math.PI;
      if (Math.abs(b) > SIM.LIDAR_FOV / 2) return;
      if (!this.lineOfSight(grid, x, z, ox, oz)) return;
      obs.push({ kind, id, distance_m: Math.round(dist * 10) / 10, bearing_deg: Math.round((-b * 180) / Math.PI) });
    };
    for (const id in this.state.robots) { if (id === r.id) continue; const o = this.state.robots[id]; if (o.floor !== r.floor) continue; consider("ROBOT", id, o.position[0], o.position[2]); }
    for (const id in this.state.people) { const p = this.state.people[id]; if ((p.floor ?? 1) !== r.floor) continue; consider("HUMAN", id, p.position[0], p.position[2]); }
    // Ray straight ahead (static)
    let ahead = SIM.LIDAR_RANGE;
    for (let d = 0.5; d <= SIM.LIDAR_RANGE; d += 0.25) { const c = toCell(x + cosH * d, z + sinH * d); if (!isWalkable(grid, c[0], c[1])) { ahead = d; break; } }
    if (ahead < SIM.LIDAR_RANGE) obs.push({ kind: "RACK", id: null, distance_m: Math.round(ahead * 10) / 10, bearing_deg: 0 });
    obs.sort((a, b) => a.distance_m - b.distance_m || (a.id ?? "").localeCompare(b.id ?? ""));
    // Dynamic obstacles that block me: the nearest one on my next PERC_LOOKAHEAD grid cells of path (orthogonal neighbor cells of diagonal steps included)
    let frontId: string | null = null, frontDist = Infinity;
    if (r.path_index < r.path.length) {
      const onPath = new Set<string>(); let prev = toCell(x, z);
      for (let i = r.path_index; i < Math.min(r.path.length, r.path_index + SIM.PERC_LOOKAHEAD); i++) {
        const c = r.path[i]; onPath.add(cellKey(c[0], c[1]));
        if (c[0] !== prev[0] && c[1] !== prev[1]) { onPath.add(cellKey(c[0], prev[1])); onPath.add(cellKey(prev[0], c[1])); }
        prev = c;
      }
      for (const o of obs) {
        if (o.kind === "RACK" || o.id === null) continue;
        const pos = o.kind === "ROBOT" ? this.state.robots[o.id].position : this.state.people[o.id].position;
        const c = toCell(pos[0], pos[2]);
        if (onPath.has(cellKey(c[0], c[1])) && o.distance_m < frontDist) { frontDist = o.distance_m; frontId = o.id; }
      }
    }
    rt.frontId = frontId; rt.frontDist = frontDist;
    P.obstacles = obs.slice(0, 5);
    P.nearest_m = obs.length ? obs[0].distance_m : null;
    P.ahead_m = Math.round(Math.min(ahead, frontId ? frontDist : ahead) * 10) / 10;
    P.state = "CLEAR"; // moveAlongPath changes this to SLOWING / STOPPED as needed
  }

  private fkey(floor: number, c: number, r: number) { return `${floor}:${cellKey(c, r)}`; }

  private rebuildOccupancy() {
    this.occupancy.clear();
    for (const id in this.state.robots) {
      const r = this.state.robots[id];
      const c = toCell(r.position[0], r.position[2]); this.occupancy.set(this.fkey(r.floor, c[0], c[1]), id);
      // Also reserve the next cell, so two robots do not enter it at the same time; for a diagonal move, reserve both orthogonal neighbor cells too (prevents an X-shaped crossing scrape)
      if (r.path_index < r.path.length) {
        const n = r.path[r.path_index]; if (!this.occupancy.has(this.fkey(r.floor, n[0], n[1]))) this.occupancy.set(this.fkey(r.floor, n[0], n[1]), id);
        if (n[0] !== c[0] && n[1] !== c[1]) { for (const k of [this.fkey(r.floor, n[0], c[1]), this.fkey(r.floor, c[0], n[1])]) if (!this.occupancy.has(k)) this.occupancy.set(k, id); }
      }
    }
  }
  /** Occupied grid cells on the given floor (occupancy keys carry a floor prefix; strip it on return and feed the result to that floor's A*) */
  private blockedCells(selfId: string, floor: number): Set<string> {
    const s = new Set<string>();
    const pre = `${floor}:`;
    for (const [k, id] of this.occupancy) if (id !== selfId && k.startsWith(pre)) s.add(k.slice(pre.length));
    for (const zid of this.blockedZones) { const z = this.layout.zones.find((zz) => zz.id === zid); if (!z || (z.floor ?? 1) !== floor) continue; const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]); for (let c = Math.floor(Math.min(...xs)); c < Math.max(...xs); c++) for (let r = Math.floor(Math.min(...zs)); r < Math.max(...zs); r++) s.add(cellKey(c, r)); }
    return s;
  }
  private congestionCost(floor = 1): Float32Array | undefined {
    // Use the floor's traffic heatmap as extra cost, so robots spread naturally across aisles; injected traffic congestion zones add another layer of high cost
    const T = this.traffic[floor]; if (!T) return undefined;
    const out = new Float32Array(T.length);
    let max = 0; for (let i = 0; i < T.length; i++) if (T[i] > max) max = T[i];
    const zonesOnFloor = [...this.congestedZones.keys()].filter((zid) => (this.layout.zones.find((z) => z.id === zid)?.floor ?? 1) === floor);
    if (max < 1 && zonesOnFloor.length === 0) return undefined;
    if (max >= 1) for (let i = 0; i < out.length; i++) out[i] = (T[i] / max) * 0.8;
    for (const zid of zonesOnFloor) { const cz = this.congestedZones.get(zid)!; const z = this.layout.zones.find((zz) => zz.id === zid)!; const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]); for (let c = Math.floor(Math.min(...xs)); c < Math.max(...xs); c++) for (let r = Math.floor(Math.min(...zs)); r < Math.max(...zs); r++) out[r * this.grid.cols + c] += 3 * cz.level; }
    return out;
  }
  /** Injected traffic congestion: the speed limit ratio inside the zone */
  private zoneSpeedFactor(cell: GridCell, floor: number): number {
    for (const [zid, cz] of this.congestedZones) { const z = this.layout.zones.find((zz) => zz.id === zid); if (!z || (z.floor ?? 1) !== floor) continue; const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]); if (cell[0] >= Math.min(...xs) && cell[0] < Math.max(...xs) && cell[1] >= Math.min(...zs) && cell[1] < Math.max(...zs)) return 1 - 0.7 * cz.level; }
    return 1;
  }
  private decayTraffic() {
    if (this.state.sim.tick % 5 !== 0) return;
    for (const f in this.traffic) { const T = this.traffic[f], TS = this.trafficShort[f]; for (let i = 0; i < T.length; i++) { T[i] *= 0.9985; TS[i] *= 0.975; } }
  }

  // ─────────────────────────────────────────────────────────
  // Battery and charge
  // ─────────────────────────────────────────────────────────
  private batteryTick(r: RobotState, rt: RobotRt) {
    if (r.fsm === "CHARGING") return;
    const moving = r.velocity > 0.05;
    const drain = moving ? SIM.BATTERY_MOVE * (r.velocity / r.max_speed) + (r.load.current > 0 ? SIM.BATTERY_LOAD : 0) : SIM.BATTERY_IDLE;
    r.battery = Math.max(0, r.battery - drain);
    r.stats.energy_wh += drain * 0.5; // Assume a 50 Wh battery
    if (r.battery < THRESHOLDS.BATTERY_CRITICAL && rt.lastBatteryAlert !== "CRIT") {
      rt.lastBatteryAlert = "CRIT";
      this.emit("ROBOT_BATTERY_CRITICAL", "ROBOT", "CRITICAL", `${r.id} Battery Critical (${r.battery.toFixed(0)}%)`, { robot_id: r.id, zone_id: r.zone ?? undefined });
      this.raiseAlert(`bat-${r.id}`, "CRITICAL", `${r.id}  Battery Critical`, `${r.battery.toFixed(0)}% remaining`, { robot_id: r.id, zone_id: r.zone ?? undefined });
    } else if (r.battery < THRESHOLDS.BATTERY_WARNING && rt.lastBatteryAlert === "NONE") {
      rt.lastBatteryAlert = "WARN";
      this.emit("ROBOT_BATTERY_LOW", "ROBOT", "HIGH", `${r.id} Battery Low (${r.battery.toFixed(0)}%)`, { robot_id: r.id, zone_id: r.zone ?? undefined });
      this.raiseAlert(`bat-${r.id}`, "HIGH", `${r.id}  Battery Low`, `${r.battery.toFixed(0)}% remaining`, { robot_id: r.id, zone_id: r.zone ?? undefined });
    }
    if (r.battery <= 0 && r.fsm !== "ERROR") { this.setFsm(r, "ERROR"); this.emit("ROBOT_OFFLINE", "ROBOT", "CRITICAL", `${r.id} battery depleted — stopped`, { robot_id: r.id }); }
  }
  /** When the conveyor that feeds the station has a fault, the drop waits for manual work: dwell time x4 (this is the source of the Demo 04 bottleneck) */
  private stationSlowdown(locId: string): number {
    const cv = this.layout.conveyors.find((c) => c.feeds === locId);
    if (!cv) return 1;
    const st = this.state.conveyors[cv.id]?.status;
    return st === "ERROR" || st === "STOPPED" ? 4 : st === "WARNING" || st === "MAINTENANCE" ? 2 : 1;
  }
  /** Every 10 ticks: sensor readings and conveyor throughput (decorative, but derived from the real state) */
  private updateDevices() {
    const S = this.state; const robots = Object.values(S.robots);
    for (const id in S.sensors) {
      const s = S.sensors[id]; const ls = this.layout.sensors.find((x) => x.id === id); if (!ls || s.status === "OFFLINE") continue;
      const near = robots.filter((r) => Math.hypot(r.position[0] - ls.position[0], r.position[2] - ls.position[2]) < 10).length;
      if (s.kind === "PRESENCE") { s.value = near > 0 ? 1 : 0; s.unit = "bool"; }
      else if (s.kind === "LIDAR") { s.value = near; s.unit = "objects"; }
      else if (s.kind === "TEMP") { s.value = Math.round((21 + Math.sin(S.sim.tick / 3000) * 1.5) * 10) / 10; s.unit = "°C"; }
      else if (s.kind === "WEIGHT") { const cv = Object.values(S.conveyors).find((c) => c.id === "CV03"); s.value = cv ? cv.items_on_belt * 12 : 0; s.unit = "kg"; }
    }
    for (const id in S.conveyors) {
      const c = S.conveyors[id]; const lc = this.layout.conveyors.find((x) => x.id === id);
      if (c.status === "RUNNING") { const deliveries = robots.filter((r) => r.fsm === "DELIVERING" && lc && r.destination === lc.feeds).length; c.items_on_belt = Math.max(0, Math.min(12, c.items_on_belt + deliveries - (S.sim.tick % 30 === 0 ? 1 : 0))); c.throughput_per_min = Math.round((2 + c.items_on_belt * 0.3) * 10) / 10; }
      else { c.throughput_per_min = 0; }
    }
  }
  private freeCharger(): string | null { for (const id in this.chargerBusy) if (!this.chargerBusy[id]) return id; return null; }
  private goCharge(r: RobotState, rt: RobotRt) {
    const id = this.freeCharger();
    if (!id) { this.setFsm(r, "IDLE"); return; }
    const c = this.layout.charging_stations.find((cc) => cc.id === id)!;
    this.chargerBusy[id] = r.id; rt.chargerId = id;
    this.planTo(r, rt, c.access_point, "TO_CHARGER", id);
    this.setFsm(r, "GOING_TO_CHARGE");
  }
  private parkSpot(r: RobotState): [number, number] | null {
    const p = this.layout.parking[0]; if (!p) return null;
    const i = parseInt(r.id.replace(/\D/g, ""), 10) - 1;
    const x = Math.floor(p.rect[0] + 1 + (i % 10) * 2) + 0.5, z = Math.floor(p.rect[1] + 1 + Math.floor(i / 10) * 2.2) + 0.5;
    if (Math.hypot(r.position[0] - x, r.position[2] - z) < 1.5) return null;
    return [x, z];
  }

  // ─────────────────────────────────────────────────────────
  // Zone / KPI / events
  // ─────────────────────────────────────────────────────────
  private zoneAt(x: number, z: number, floor = 1): string | null {
    for (const zn of this.layout.zones) { if ((zn.floor ?? 1) !== floor) continue; const xs = zn.polygon.map((p) => p[0]), zs = zn.polygon.map((p) => p[1]); if (x >= Math.min(...xs) && x <= Math.max(...xs) && z >= Math.min(...zs) && z <= Math.max(...zs)) return zn.id; }
    return null;
  }
  private updateZones() {
    const S = this.state;
    const counts: Record<string, number> = {};
    for (const id in S.robots) { const z = S.robots[id].zone; if (z) counts[z] = (counts[z] ?? 0) + 1; }
    for (const zid in S.zones) {
      const z = S.zones[zid]; z.robot_count = counts[zid] ?? 0;
      const cap = (this.layout.zones.find((zz) => zz.id === zid)?.floor ?? 1) === 2 ? SIM.ZONE_CAPACITY + 2 : SIM.ZONE_CAPACITY;
      z.congestion = Math.min(1, z.robot_count / cap);
      if (this.blockedZones.has(zid)) { z.status = "BLOCKED"; continue; }
      const inj = this.congestedZones.get(zid); if (inj) z.congestion = Math.max(z.congestion, inj.level);
      const was = z.status;
      z.status = z.congestion >= THRESHOLDS.CONGESTION_WARNING ? "CONGESTED" : "NORMAL";
      if (z.status === "CONGESTED" && was !== "CONGESTED") this.emit("ZONE_CONGESTION_HIGH", "SIMULATION", "MEDIUM", `Zone ${zid} congestion high (${z.robot_count} robots)`, { zone_id: zid });
    }
  }
  private updateKpi() {
    const S = this.state; const K = S.kpi; const robots = Object.values(S.robots); const tasks = Object.values(S.tasks);
    K.tick = S.sim.tick;
    K.fleet = { total: robots.length, active: 0, charging: 0, idle: 0, warning: 0, error: 0, offline: 0 };
    for (const r of robots) K.fleet[r.status.toLowerCase() as keyof typeof K.fleet]++;
    const win = 3000; // 5 min
    const recent = tasks.filter((t) => t.status === "COMPLETED" && t.completed_tick !== null && S.sim.tick - t.completed_tick < win).length;
    K.operation = {
      throughput_per_min: Math.round((recent / Math.min(5, Math.max(1, S.sim.tick / 600))) * 10) / 10,
      completed_today: this.completedCount, completed_target: 150,
      pending: tasks.filter((t) => t.status === "WAITING").length,
      ongoing: tasks.filter((t) => t.status === "ASSIGNED" || t.status === "IN_PROGRESS").length,
      avg_task_time_s: this.taskTimes.length ? Math.round((this.taskTimes.reduce((a, b) => a + b, 0) / this.taskTimes.length) * SIM.TICK_S) : 0,
      on_time_rate: this.completedCount ? this.onTime / this.completedCount : 1,
      avg_utilization: S.sim.tick ? robots.reduce((a, r) => a + r.stats.busy_ticks, 0) / (robots.length * S.sim.tick) : 0,
    };
    const cong = Object.values(S.zones).reduce((a, z) => a + z.congestion, 0) / Math.max(1, Object.keys(S.zones).length);
    K.efficiency = {
      avg_travel_distance_m: Math.round(robots.reduce((a, r) => a + r.stats.distance_m, 0) / Math.max(1, this.completedCount)),
      avg_wait_time_s: Math.round((robots.reduce((a, r) => a + r.stats.wait_ticks, 0) / robots.length) * SIM.TICK_S),
      congestion_index: Math.round(cong * 100) / 100,
      energy_kwh: Math.round(robots.reduce((a, r) => a + r.stats.energy_wh, 0)) / 1000,
    };
    const lifts = Object.values(S.lifts);
    K.lifts = {
      trips: lifts.reduce((a, l) => a + l.trips, 0),
      utilization: S.sim.tick && lifts.length ? Math.round((lifts.reduce((a, l) => a + l.busy_ticks, 0) / (lifts.length * S.sim.tick)) * 1000) / 1000 : 0,
      avg_wait_s: (() => { const n = lifts.reduce((a, l) => a + l.wait_n, 0); return n ? Math.round((lifts.reduce((a, l) => a + l.wait_total_ticks, 0) / n) * SIM.TICK_S * 10) / 10 : 0; })(),
      faults: lifts.filter((l) => l.fault).length,
    };
    S.subsystems.CHARGING = Object.values(this.chargerBusy).every(Boolean) ? "WARNING" : "NORMAL";
    S.subsystems.CONVEYORS = Object.values(S.conveyors).some((c) => c.status === "ERROR") ? "ERROR" : Object.values(S.conveyors).some((c) => c.status !== "RUNNING") ? "WARNING" : "NORMAL";
    S.subsystems.WAREHOUSE = this.blockedZones.size ? "WARNING" : "NORMAL";
  }
  private pushSeries() {
    const S = this.state; this.lastSeriesTick = S.sim.tick;
    const minutes = S.sim.tick / 600;
    S.kpi.throughput_series.push({ tick: S.sim.tick, completed: this.completedCount, target: Math.round(minutes * 1.25) });
    if (S.kpi.throughput_series.length > THRESHOLDS.THROUGHPUT_SERIES_SIZE) S.kpi.throughput_series.shift();
  }

  private emit(type: EventType, source: TwinEvent["source"], severity: Severity, message: string, rel: Partial<Pick<TwinEvent, "robot_id" | "task_id" | "zone_id" | "conveyor_id" | "camera_id">> = {}) {
    const ev: TwinEvent = { id: `E${++this.eventSeq}`, tick: this.state.sim.tick, type, source, severity, message, ...rel };
    this.state.recent_events.unshift(ev);
    if (this.state.recent_events.length > SIM.EVENT_RING) this.state.recent_events.pop();
    return ev;
  }
  private raiseAlert(id: string, severity: Severity, title: string, detail: string, rel: Partial<Pick<AlertState, "robot_id" | "zone_id" | "conveyor_id">> = {}) {
    const ev = this.state.recent_events[0];
    this.state.alerts[id] = { id, created_tick: this.state.sim.tick, severity, title, detail, source_event_id: ev?.id ?? "", acknowledged: false, resolved_tick: null, ...rel };
  }
  private resolveAlert(id: string) { delete this.state.alerts[id]; }
  ackAlert(id: string) { const a = this.state.alerts[id]; if (a) a.acknowledged = true; }

  // ─────────────────────────────────────────────────────────
  // Scenario injection (Phase 4 uses it officially; the core kinds are implemented here first)
  // ─────────────────────────────────────────────────────────
  private applyInjections() {
    const S = this.state;
    const now = S.sim.tick;
    const keep: ScenarioInjection[] = [];
    for (const inj of this.pendingInjections) {
      if (inj.at_tick !== undefined && inj.at_tick > now) { keep.push(inj); continue; }
      switch (inj.kind) {
        case "LIFT_FAULT": {
          const L = S.lifts[inj.lift_id]; if (!L || L.fault) break;
          L.fault = true;
          L.fault_remaining = Math.max(0, L.until_tick - now);   // Freeze the timer: on clear, continue from the remaining progress; the platform does not teleport
          // Reservers/queued robots not yet on board switch to the other lift via reRouteLift on the next tick; a robot already in the cabin stays in place (it must not teleport)
          this.emit("LIFT_FAULT", "LIFT", L.occupant ? "CRITICAL" : "HIGH", `${inj.lift_id} FAULT${L.occupant ? ` — ${L.occupant} inside, platform stalled` : ""}`, { robot_id: L.occupant ?? undefined });
          this.raiseAlert(`lift-${inj.lift_id}`, L.occupant ? "CRITICAL" : "HIGH", `${inj.lift_id}  Fault`, L.occupant ? `Platform stalled with ${L.occupant} aboard` : "Out of service", {});
          break;
        }
        case "ROBOT_FAILURE": { const r = S.robots[inj.robot_id]; if (r) { this.setFsm(r, "OFFLINE"); r.velocity = 0; const t = r.current_task_id ? S.tasks[r.current_task_id] : null; if (t) { t.status = "TRANSFERRED"; t.completed_tick = now; const nt = this.createTask({ type: t.type, priority: "HIGH", source: t.source, destination: t.destination }); nt.parent_task_id = t.id; } r.current_task_id = null; r.path = []; this.releaseRobotFromLift(r.id); this.rt[r.id].pending = null; this.emit("ROBOT_OFFLINE", "USER", "CRITICAL", `${r.id} failure injected — OFFLINE`, { robot_id: r.id }); this.raiseAlert(`off-${r.id}`, "CRITICAL", `${r.id}  Offline`, "Robot failure", { robot_id: r.id }); } break; }
        case "ROBOT_BATTERY_SET": { const r = S.robots[inj.robot_id]; if (r) { r.battery = inj.battery; this.rt[r.id].lastBatteryAlert = "NONE"; } break; }
        case "CONVEYOR_FAILURE": { const c = S.conveyors[inj.conveyor_id]; if (c) { c.status = "ERROR"; c.speed_mps = 0; this.emit("CONVEYOR_STATUS_CHANGED", "CONVEYOR", "HIGH", `${inj.conveyor_id} failure — STOPPED`, { conveyor_id: c.id }); this.raiseAlert(`cv-${c.id}`, "HIGH", `Conveyor ${c.id}  Error`, "Throughput impact: HIGH", { conveyor_id: c.id }); } break; }
        case "CAMERA_OFFLINE": { const c = S.cameras[inj.camera_id]; if (c) { c.status = "OFFLINE"; S.subsystems.CCTV = "WARNING"; this.emit("CAMERA_STATUS_CHANGED", "CAMERA", "MEDIUM", `${c.id} offline`, { camera_id: c.id }); } break; }
        case "HUMAN_INTRUSION": {
          const z = this.layout.zones.find((zz) => zz.id === inj.zone_id); if (!z) break;
          const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]);
          const pid = `H-${inj.zone_id}-${now}`;
          S.people[pid] = { id: pid, kind: "WORKER", position: [(Math.min(...xs) + Math.max(...xs)) / 2, 0, Math.min(...zs) + 6.3], heading: 0, zone: inj.zone_id, floor: z.floor ?? 1, expires_tick: now + inj.duration_ticks };
          this.blockedZones.add(inj.zone_id); S.zones[inj.zone_id].blocked_reason = "Human detected"; S.zones[inj.zone_id].blocked_since_tick = now;
          this.emit("HUMAN_DETECTED", "VLM", "HIGH", `Human detected — Zone ${inj.zone_id}`, { zone_id: inj.zone_id });
          this.emit("ZONE_BLOCKED", "SIMULATION", "HIGH", `Zone ${inj.zone_id} marked BLOCKED`, { zone_id: inj.zone_id });
          this.raiseAlert(`zone-${inj.zone_id}`, "HIGH", `Zone ${inj.zone_id}  Human Detected`, "Route blocked", { zone_id: inj.zone_id });
          for (const id in S.robots) { const r = S.robots[id]; if (r.path.length && r.path.slice(r.path_index).some(([c, rr]) => c >= Math.min(...xs) && c < Math.max(...xs) && rr >= Math.min(...zs) && rr < Math.max(...zs))) this.setFsm(r, "OBSTACLE_DETECTED"); }
          break;
        }
        case "TRAFFIC_CONGESTION": {
          this.congestedZones.set(inj.zone_id, { level: inj.level, until: now + inj.duration_ticks });
          this.emit("ZONE_CONGESTION_HIGH", "USER", "MEDIUM", `Traffic congestion injected — Zone ${inj.zone_id} (level ${Math.round(inj.level * 100)}%)`, { zone_id: inj.zone_id });
          this.raiseAlert(`traffic-${inj.zone_id}`, "MEDIUM", `Zone ${inj.zone_id}  Traffic Delay`, `Speed limited to ${Math.round((1 - 0.7 * inj.level) * 100)}%`, { zone_id: inj.zone_id });
          for (const id in S.robots) { const r = S.robots[id]; if (r.path.length > r.path_index + 3 && r.fsm !== "IDLE") this.setFsm(r, "OBSTACLE_DETECTED"); }
          break;
        }
        case "TASK_BURST": { for (let i = 0; i < inj.count; i++) { this.nextTaskTick = now; this.generateTasks(); } break; }
      }
    }
    this.pendingInjections = keep;
    for (const [zid, cz] of this.congestedZones) if (now >= cz.until) { this.congestedZones.delete(zid); this.resolveAlert(`traffic-${zid}`); this.emit("ZONE_UNBLOCKED", "SIMULATION", "INFO", `Zone ${zid} traffic back to normal`, { zone_id: zid }); }
    // People leave when their time expires
    for (const pid in S.people) { const p = S.people[pid]; if (p.expires_tick !== null && now >= p.expires_tick) { delete S.people[pid]; if (p.zone && !Object.values(S.people).some((q) => q.zone === p.zone)) { this.blockedZones.delete(p.zone); S.zones[p.zone].blocked_reason = null; S.zones[p.zone].blocked_since_tick = null; this.resolveAlert(`zone-${p.zone}`); this.emit("HUMAN_CLEARED", "VLM", "INFO", `Zone ${p.zone} clear`, { zone_id: p.zone }); this.emit("ZONE_UNBLOCKED", "SIMULATION", "INFO", `Zone ${p.zone} unblocked`, { zone_id: p.zone }); } } }
  }

  private pretty(locId: string): string {
    const l = this.loc[locId]; if (!l) return locId;
    if (l.kind === "SHELF") return `Shelf ${locId.replace("SHELF-", "")}`;
    if (l.kind === "PACKING") return locId.replace("PACK-", "Packing ");
    if (l.kind === "SORTING") return "Sorting";
    if (l.kind === "CHARGING") return locId.replace("CHG-", "Charger ");
    return locId.replace("-", " ");
  }
}
