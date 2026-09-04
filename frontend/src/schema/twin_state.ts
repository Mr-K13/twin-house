/**
 * Digital Twin Warehouse — Twin State data contract (TypeScript)
 *
 * Rules:
 *  1. This file is the single source of truth for the frontend and the backend. It maps field-by-field to twin_state.py.
 *  2. All types are pure data. They must not contain Three.js objects, functions, or class instances.
 *     This lets What-if Simulation copy the state directly with JSON.parse(JSON.stringify(state)).
 *  3. Coordinate system: right-handed, in meters. x = warehouse long side (0..100), z = warehouse short side (0..70), y = height.
 *     This matches warehouse_layout.json.
 *  4. Time: tick is the simulation time unit (a fixed 100 ms of simulation time). sim_time_ms = tick * 100.
 *     wall_time is only for UI display. It has no part in any logic.
 *  5. All enum values are uppercase strings. This makes logs easy to read and maps to Pydantic.
 */

// ─────────────────────────────────────────────────────────────
// Base types
// ─────────────────────────────────────────────────────────────

/** [x, y, z], meters */
export type Vec3 = [number, number, number];
/** [x, z], meters, for 2D navigation / paths */
export type Vec2 = [number, number];
/** Navigation grid cell coordinates [col, row], integers */
export type GridCell = [number, number];

export type RobotId = string;      // "R01" .. "R20"
export type TaskId = string;       // "A3812"
export type ZoneId = string;       // "A" | "B" | "C" | "D"
export type ConveyorId = string;   // "CV01"
export type CameraId = string;     // "CAM-B03"
export type SensorId = string;     // "S-A01"
export type EventId = string;      // ULID / uuid
export type AlertId = string;
export type LocationId = string;   // "SHELF-A12" | "PACK-01" | "CHG-03" | "INBOUND-1"

// ─────────────────────────────────────────────────────────────
// Enum
// ─────────────────────────────────────────────────────────────

/** Spec 3️⃣ Robot Status — the aggregate status for the UI */
export type RobotStatus =
  | "ACTIVE"
  | "CHARGING"
  | "IDLE"
  | "WARNING"
  | "ERROR"
  | "OFFLINE";

/** Spec 4️⃣ State Machine — the detailed state for the simulation engine. The UI uses RobotStatus. */
export type RobotFsmState =
  | "IDLE"
  | "TASK_ASSIGNED"
  | "NAVIGATING"
  | "PICKING"
  | "TRANSPORTING"
  | "DELIVERING"
  | "COMPLETED"
  | "OBSTACLE_DETECTED"
  | "REPLANNING"
  | "LOW_BATTERY"
  | "TASK_TRANSFER"
  | "GOING_TO_CHARGE"
  | "CHARGING"
  | "OFFLINE"
  | "ERROR";

export type TaskType = "PICK" | "TRANSPORT" | "REPLENISH" | "RETURN";
export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
export type TaskStatus =
  | "WAITING"        // Not assigned yet
  | "ASSIGNED"       // Assigned; the robot has not started yet
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TRANSFERRED";   // Transferred to a different robot (for example, low battery); the source task is archived, the new task gets parent_task_id

export type ConveyorStatus = "RUNNING" | "WARNING" | "STOPPED" | "MAINTENANCE" | "ERROR";
export type DeviceStatus = "ONLINE" | "DEGRADED" | "OFFLINE";
export type ZoneStatus = "NORMAL" | "CONGESTED" | "BLOCKED" | "RESTRICTED";
export type SubsystemStatus = "NORMAL" | "WARNING" | "ERROR";
export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type EventSource =
  | "ROBOT" | "SENSOR" | "CAMERA" | "VLM" | "CONVEYOR"
  | "SIMULATION" | "FLEET_MANAGER" | "PLANNER" | "USER" | "AI_AGENT" | "LIFT";

export type EventType =
  // Robot
  | "ROBOT_STATE_CHANGED"
  | "ROBOT_BATTERY_LOW"
  | "ROBOT_BATTERY_CRITICAL"
  | "ROBOT_OFFLINE"
  | "ROBOT_ONLINE"
  | "ROBOT_COLLISION_AVOIDED"
  // Task
  | "TASK_CREATED"
  | "TASK_ASSIGNED"
  | "TASK_STARTED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TASK_TRANSFERRED"
  // Planning
  | "ROUTE_PLANNED"
  | "ROUTE_REPLANNED"
  | "OBSTACLE_DETECTED"
  // Zone / environment
  | "ZONE_BLOCKED"
  | "ZONE_UNBLOCKED"
  | "ZONE_CONGESTION_HIGH"
  | "HUMAN_DETECTED"
  | "HUMAN_CLEARED"
  // Lift (spec §19, full event chain)
  | "LIFT_REQUESTED"
  | "ROBOT_BOARDING_STARTED"
  | "LIFT_LEVELING"
  | "ROBOT_ALIGHTING_STARTED"
  | "LIFT_COOLDOWN_STARTED"
  | "LIFT_RESERVED"
  | "LIFT_QUEUE_ENTERED"
  | "LIFT_ARRIVED"
  | "LIFT_GATE_OPENED"
  | "ROBOT_BOARDED"
  | "LIFT_DEPARTED"
  | "ROBOT_EXITED"
  | "LIFT_FAULT"
  | "LIFT_RESERVATION_RELEASED"
  // Devices
  | "CONVEYOR_STATUS_CHANGED"
  | "CAMERA_STATUS_CHANGED"
  | "SENSOR_STATUS_CHANGED"
  // AI
  | "AI_DECISION"
  | "VLM_OBSERVATION"
  // Simulation control
  | "SIM_STARTED" | "SIM_PAUSED" | "SIM_RESUMED" | "SIM_RESET"
  | "SCENARIO_INJECTED";

// ─────────────────────────────────────────────────────────────
// Robot
// ─────────────────────────────────────────────────────────────

export interface PerceivedObstacle {
  kind: "ROBOT" | "HUMAN" | "RACK";
  id: string | null;
  distance_m: number;
  /** Bearing relative to the heading (degrees); left is positive, right is negative */
  bearing_deg: number;
}
export interface Perception {
  state: "CLEAR" | "SLOWING" | "STOPPED" | "OFF";
  /** Clear distance directly ahead (m), racks included */
  ahead_m: number;
  nearest_m: number | null;
  obstacles: PerceivedObstacle[];
}

export interface RobotState {
  id: RobotId;
  model: string;                 // "AMR-L" etc.; matches the GLB model name
  /** Current floor (1 = ground). The y of position is always 0; the renderer adds the floor height. */
  floor: number;
  /** Id of the lift that the robot rides; null = not on a lift */
  lift_id: string | null;
  /** Lift sub-state (spec §10); null = not in the lift sequence */
  lift_stage: "TO_LIFT" | "QUEUED" | "BOARDING" | "RIDING" | "ALIGHTING" | null;
  position: Vec3;
  /** Heading (radians) around the y axis; 0 = the +x direction */
  heading: number;
  velocity: number;              // m/s, scalar; heading gives the direction
  max_speed: number;             // m/s
  battery: number;               // 0..100
  status: RobotStatus;
  fsm: RobotFsmState;
  health: number;                // 0..100
  current_task_id: TaskId | null;
  destination: LocationId | null;
  /** Current path (grid cells); index 0 = the next grid cell */
  path: GridCell[];
  /** Index of progress along the path; the frontend uses it to interpolate */
  path_index: number;
  load: { current: number; capacity: number };
  zone: ZoneId | null;
  eta_s: number | null;          // Estimated seconds to the destination (simulation time)
  /** Tick when the robot entered the current fsm state; used for dwell time and the UI */
  fsm_since_tick: number;
  /** Cumulative statistics (for KPI) */
  stats: {
    distance_m: number;
    tasks_completed: number;
    energy_wh: number;
    busy_ticks: number;
    wait_ticks: number;
  };
  /** Phase 7: virtual LiDAR (270° / 4 m) perception and local obstacle-avoidance state */
  perception: Perception;
}

// ─────────────────────────────────────────────────────────────
// Task
// ─────────────────────────────────────────────────────────────

export interface TaskState {
  id: TaskId;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  source: LocationId;
  destination: LocationId;
  assigned_robot: RobotId | null;
  /** Set if this task comes from a transfer of a different task */
  parent_task_id: TaskId | null;
  created_tick: number;
  assigned_tick: number | null;
  started_tick: number | null;
  completed_tick: number | null;
  /** Deadline tick; can be null. On-time Rate uses this value. */
  deadline_tick: number | null;
  eta_s: number | null;
  /** Load quantity that the task needs; maps to RobotState.load */
  load_units: number;
}

// ─────────────────────────────────────────────────────────────
// Environment: Zone / Conveyor / Camera / Sensor / People
// ─────────────────────────────────────────────────────────────

export interface ZoneState {
  id: ZoneId;
  status: ZoneStatus;
  robot_count: number;
  /** 0..1; the Fleet Manager and the Heatmap use this value */
  congestion: number;
  blocked_reason: string | null;
  blocked_since_tick: number | null;
}

export interface ConveyorState {
  id: ConveyorId;
  status: ConveyorStatus;
  speed_mps: number;
  /** Number of packages on the conveyor (for visuals) */
  items_on_belt: number;
  throughput_per_min: number;
}

export interface CameraState {
  id: CameraId;
  zone: ZoneId;
  status: DeviceStatus;
  /** Most recent VLM observation; it gets a value in Phase 5 */
  last_observation: VlmObservation | null;
}

export interface SensorState {
  id: SensorId;
  kind: "LIDAR" | "IR" | "WEIGHT" | "TEMP" | "PRESENCE";
  zone: ZoneId;
  status: DeviceStatus;
  value: number | null;
  unit: string | null;
}

/** NPCs such as workers / forklifts. In the first version they appear only during fault injection. */
export type LiftFsmState =
  | "IDLE" | "MOVING_UP" | "MOVING_DOWN" | "LEVELING"
  | "DOOR_OPENING" | "BOARDING" | "DOOR_CLOSING"
  | "DOOR_OPENING_AT_DESTINATION" | "ALIGHTING" | "DOOR_CLOSING_AFTER_EXIT"
  | "COOLDOWN";

/** Lift (freight lift) state — the backend is the only authority; the frontend only interpolates the door/platform animation (spec §2.1/§9.2) */
export interface LiftState {
  id: string;
  state: LiftFsmState;
  /** Current floor; null while the lift moves (spec: a moving lift does not belong to any floor) */
  floor: number | null;
  target_floor: number | null;
  /** Platform height (m); during MOVING the engine interpolates it with smoothstep */
  y: number;
  door_f1: "OPEN" | "CLOSED";
  door_f2: "OPEN" | "CLOSED";
  occupant: RobotId | null;
  reserved_by: RobotId | null;
  /** Queue for each floor (FIFO); key = "1" | "2" */
  queue: Record<string, RobotId[]>;
  until_tick: number;
  fault: boolean;
  /** Remaining timer ticks frozen at the FAULT; on release, until_tick = now + fault_remaining, and the platform continues from the frozen position (no jump) */
  fault_remaining: number;
  trips: number;
  busy_ticks: number;
  wait_total_ticks: number;
  wait_n: number;
}

export interface PersonState {
  id: string;
  kind: "WORKER" | "FORKLIFT";
  position: Vec3;
  heading: number;
  zone: ZoneId | null;
  floor?: number;
  /** The entity disappears at this tick; null = permanent (remove manually) */
  expires_tick: number | null;
}

// ─────────────────────────────────────────────────────────────
// Event / Alert / AI Decision
// ─────────────────────────────────────────────────────────────

export interface TwinEvent {
  id: EventId;
  tick: number;
  type: EventType;
  source: EventSource;
  severity: Severity;
  /** One human-readable line; the Event Log shows it directly */
  message: string;
  /** Related entities; the UI uses them for click navigation */
  robot_id?: RobotId;
  task_id?: TaskId;
  zone_id?: ZoneId;
  conveyor_id?: ConveyorId;
  camera_id?: CameraId;
  /** Extra data specific to the event, not strongly typed (but it must serialize to JSON) */
  payload?: Record<string, unknown>;
  /** Event that caused this event (trace chain, for example HUMAN_DETECTED → ZONE_BLOCKED → ROUTE_REPLANNED) */
  caused_by?: EventId;
}

export interface AlertState {
  id: AlertId;
  created_tick: number;
  severity: Severity;
  title: string;               // "R07 Battery Low"
  detail: string;              // "8% remaining"
  zone_id?: ZoneId;
  robot_id?: RobotId;
  conveyor_id?: ConveyorId;
  source_event_id: EventId;
  acknowledged: boolean;
  resolved_tick: number | null;
}

/** Spec 2️⃣5️⃣ AI Decision Explainability; in Phase 4 the rule engine creates it, in Phase 5 an LLM can add the narrative */
export interface DecisionCandidate {
  robot_id: RobotId;
  score: number;
  distance_m: number;
  battery: number;
  workload: "LOW" | "MEDIUM" | "HIGH";
  congestion: number;
  health: number;
  reasons: string[];           // "✓ 34m from task"
  rejected_reason: string | null;
}

export interface AiDecision {
  id: string;
  tick: number;
  kind: "TASK_ASSIGNMENT" | "TASK_TRANSFER" | "REROUTE" | "CHARGE_SCHEDULING";
  task_id: TaskId | null;
  selected_robot: RobotId | null;
  candidates: DecisionCandidate[];
  /** Snapshot of the rule-engine weights; makes the decision reproducible */
  weights: Record<string, number>;
  /** Optional: natural-language explanation from an LLM */
  narrative: string | null;
}

export interface VlmObservation {
  tick: number;
  camera_id: CameraId;
  event: "human_detected" | "obstacle" | "spill" | "none";
  zone: ZoneId;
  severity: Severity;
  blocked: boolean;
  confidence: number;          // 0..1
  raw: string | null;          // Raw model reply, for debugging
  bbox?: number[] | null;      // normalized [x, y, w, h]
  description?: string | null;
}

// ─────────────────────────────────────────────────────────────
// KPI
// ─────────────────────────────────────────────────────────────

export interface KpiSnapshot {
  tick: number;
  fleet: {
    total: number;
    active: number;
    charging: number;
    idle: number;
    warning: number;
    error: number;
    offline: number;
  };
  operation: {
    throughput_per_min: number;       // Tasks completed in the last N minutes / N
    completed_today: number;
    completed_target: number;
    pending: number;
    ongoing: number;
    avg_task_time_s: number;
    on_time_rate: number;             // 0..1
    avg_utilization: number;          // 0..1
  };
  efficiency: {
    avg_travel_distance_m: number;
    avg_wait_time_s: number;
    congestion_index: number;         // 0..1, weighted across zones
    energy_kwh: number;
  };
  /** For the frontend Throughput line chart; fixed length (for example 120 points), a ring buffer on the backend */
  throughput_series: Array<{ tick: number; completed: number; target: number }>;
  /** Lift KPI (spec §21) */
  lifts: { trips: number; utilization: number; avg_wait_s: number; faults: number };
}

// ─────────────────────────────────────────────────────────────
// Heatmap
// ─────────────────────────────────────────────────────────────

export interface HeatmapLayer {
  kind: "TRAFFIC" | "WAIT" | "CONGESTION";
  /** Floor of the data (each floor has separate statistics) */
  floor: number;
  cols: number;
  rows: number;
  /** row-major, length = cols*rows, normalized to 0..1 */
  values: number[];
  window_ticks: number;               // Statistics window
}

// ─────────────────────────────────────────────────────────────
// Simulation control and Scenario
// ─────────────────────────────────────────────────────────────

export type SimMode = "LIVE" | "PAUSED" | "WHATIF";

export interface SimulationState {
  tick: number;
  tick_ms: number;                    // Fixed at 100
  speed: 0 | 1 | 2 | 5 | 10;          // Speed multiplier; 0 = paused
  mode: SimMode;
  seed: number;                       // Random seed for deterministic simulation
  /** Baseline snapshot id for the What-if run */
  baseline_snapshot_id: string | null;
}

export type ScenarioInjection =
  | { kind: "ROBOT_FAILURE"; robot_id: RobotId; at_tick?: number }
  | { kind: "ROBOT_BATTERY_SET"; robot_id: RobotId; battery: number; at_tick?: number }
  | { kind: "CONVEYOR_FAILURE"; conveyor_id: ConveyorId; at_tick?: number }
  | { kind: "CAMERA_OFFLINE"; camera_id: CameraId; at_tick?: number }
  | { kind: "HUMAN_INTRUSION"; zone_id: ZoneId; duration_ticks: number; at_tick?: number }
  | { kind: "TRAFFIC_CONGESTION"; zone_id: ZoneId; level: number; duration_ticks: number; at_tick?: number }
  | { kind: "TASK_BURST"; count: number; priority: TaskPriority; at_tick?: number }
  | { kind: "LIFT_FAULT"; lift_id: string; at_tick?: number };

export interface WhatIfRequest {
  scenario_name: string;
  injections: ScenarioInjection[];
  duration_ticks: number;             // Spec: 60 seconds = 600 ticks
  /** Run a baseline without injections in parallel for comparison (true recommended) */
  run_baseline: boolean;
}

export interface WhatIfResult {
  request: WhatIfRequest;
  baseline_kpi: KpiSnapshot;
  scenario_kpi: KpiSnapshot;
  /** Difference (scenario - baseline); the frontend shows it directly as ±% */
  delta: Record<string, number>;
  key_events: TwinEvent[];
  ai_recommendation: string | null;   // Phase 6
}

// ─────────────────────────────────────────────────────────────
// Twin State (root)
// ─────────────────────────────────────────────────────────────

export interface TwinState {
  schema_version: "1.0";
  layout_id: string;                  // Matches the id in warehouse_layout.json
  sim: SimulationState;
  /** Dictionaries keyed by id: diff / patch friendly, O(1) lookup */
  robots: Record<RobotId, RobotState>;
  tasks: Record<TaskId, TaskState>;
  lifts: Record<string, LiftState>;
  zones: Record<ZoneId, ZoneState>;
  conveyors: Record<ConveyorId, ConveyorState>;
  cameras: Record<CameraId, CameraState>;
  sensors: Record<SensorId, SensorState>;
  people: Record<string, PersonState>;
  /** Keeps only unresolved alerts; the history is in events */
  alerts: Record<AlertId, AlertState>;
  /** The last N events (ring buffer, for example 500); the full history is in the backend DB */
  recent_events: TwinEvent[];
  recent_decisions: AiDecision[];
  kpi: KpiSnapshot;
  subsystems: Record<"WAREHOUSE" | "CONVEYORS" | "CHARGING" | "CCTV" | "NETWORK", SubsystemStatus>;
}

// ─────────────────────────────────────────────────────────────
// WebSocket message protocol
// ─────────────────────────────────────────────────────────────

/**
 * Strategy: send FULL once on connection, then send PATCH each tick (changed fields only).
 * If the frontend sees patch.base_tick !== the local tick, it sends RESYNC to request FULL.
 * High-frequency fields (robots.*.position / heading / velocity / battery) update each tick;
 * other fields enter the patch only when they change.
 */
export type ServerMessage =
  | { type: "FULL"; state: TwinState }
  | { type: "PATCH"; base_tick: number; tick: number; patch: DeepPartial<TwinState>; events: TwinEvent[] }
  | { type: "HEATMAP"; layer: HeatmapLayer }
  | { type: "WHATIF_RESULT"; request_id?: string | null; result: WhatIfResult }
  | { type: "COPILOT_REPLY"; request_id: string; text: string; citations: Array<{ event_id?: EventId; robot_id?: RobotId; task_id?: TaskId }>; model?: string }
  | { type: "ERROR"; code: string; message: string; request_id?: string | null };

export type ClientMessage =
  | { type: "RESYNC" }
  | { type: "SIM_CONTROL"; action: "PLAY" | "PAUSE" | "RESET"; speed?: SimulationState["speed"] }
  | { type: "INJECT"; injection: ScenarioInjection }
  | { type: "CLEAR_INJECTION"; kind: ScenarioInjection["kind"]; target_id: string }
  | { type: "CREATE_TASK"; task: Pick<TaskState, "type" | "priority" | "source" | "destination" | "load_units"> & { deadline_s?: number } }
  | { type: "ACK_ALERT"; alert_id: AlertId }
  | { type: "SELECT_ROBOT"; robot_id: RobotId | null }           // Tells the backend to raise the update rate for this robot (optional)
  | { type: "WHATIF_RUN"; request: WhatIfRequest; request_id?: string }
  | { type: "COPILOT_ASK"; request_id: string; question: string };

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// ─────────────────────────────────────────────────────────────
// Threshold constants (shared by frontend and backend; change values here, not in the logic)
// ─────────────────────────────────────────────────────────────

export const THRESHOLDS = {
  BATTERY_WARNING: 20,
  BATTERY_CRITICAL: 10,
  BATTERY_CHARGE_TO: 95,
  CONGESTION_WARNING: 0.6,
  CONGESTION_BLOCK: 0.85,
  TICK_MS: 100,
  EVENT_RING_SIZE: 500,
  THROUGHPUT_SERIES_SIZE: 120,
} as const;
