/**
 * Asset catalog: one entry per physical equipment type (rack, robot, conveyor, station, charging, lift, camera, sensor, dock).
 *  - Parameter schema: adapted from layout/types.ts and docs/layout/warehouse_layout_format.md.
 *  - Characteristics: every value is imported from SIM / THRESHOLDS / LIFT_SHAFT / TASK_RULES / the layout. No number is restated here,
 *    so the catalog cannot drift from the engine.
 *  - Instances: read from the bundled warehouse_layout.json (cells and variant counts are computed once at module load).
 */
import { layout } from "../state/store";
import type { WarehouseLayout, LayoutRack, LayoutSpawnRobot, LayoutConveyor, LayoutStation, LayoutCharging, LayoutLift, LayoutCamera, LayoutSensor, LayoutDock, P2, P3, Rect } from "../layout/types";
import { SIM, ROBOT_DEFAULTS, CONVEYOR_FAULT_DWELL } from "../simulation/engine";
import { THRESHOLDS } from "../schema/twin_state";
import { LIFT_SHAFT } from "../components/scene/Mezzanine";
import { TASK_RULES } from "../simulation/rules";

export interface SchemaField { name: string; type: string; unit?: string; description: string; optional?: boolean }
export interface Characteristic { label: string; value: string | number; unit?: string; source: string }
export type Cell = string | number;
export interface Column<T> { key: string; label: string; get: (row: T) => Cell }
export interface Variant<T> { label: string; key: (row: T) => Cell }

/** Author-facing definition, generic in the layout row type */
export interface AssetTypeDef<T extends object> {
  id: string; label: string; description: string;
  rows: (l: WarehouseLayout) => readonly T[];
  fields: SchemaField[];
  characteristics: Characteristic[];
  columns: Column<T>[];
  variants: Variant<T>[];
}

/** What the UI and the tests consume: the row type is closed over inside defineType */
export interface CatalogEntry {
  id: string; label: string; description: string;
  fields: SchemaField[];
  characteristics: Characteristic[];
  instances: readonly object[];
  columns: ReadonlyArray<{ key: string; label: string }>;
  rows: ReadonlyArray<{ id: string; cells: Record<string, Cell> }>;
  variants: ReadonlyArray<{ label: string; counts: Array<{ value: string; n: number }> }>;
}

/** Group rows by a derived key and count; most frequent first, ties in natural (numeric-aware) order */
export function countBy<T>(rows: readonly T[], key: (r: T) => Cell): Array<{ value: string; n: number }> {
  const m = new Map<string, number>();
  for (const r of rows) { const k = String(key(r)); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value, undefined, { numeric: true }));
}

export function defineType<T extends object>(d: AssetTypeDef<T>): CatalogEntry {
  const list = d.rows(layout);
  return {
    id: d.id, label: d.label, description: d.description, fields: d.fields, characteristics: d.characteristics,
    instances: list,
    columns: d.columns.map(({ key, label }) => ({ key, label })),
    rows: list.map((r) => ({ id: String(d.columns[0].get(r)), cells: Object.fromEntries(d.columns.map((c) => [c.key, c.get(r)])) })),
    variants: d.variants.map((v) => ({ label: v.label, counts: countBy(list, v.key) })),
  };
}

// ── formatters ───────────────────────────────────────────────
const deg = (rad: number) => Math.round((rad * 180) / Math.PI);
const p2 = ([x, z]: P2) => `${x}, ${z}`;
const p3 = ([x, y, z]: P3) => `${x}, ${y}, ${z}`;
const rect = ([x0, z0, x1, z1]: Rect) => `${x0},${z0} → ${x1},${z1}`;
const rectSize = ([x0, z0, x1, z1]: Rect) => `${+(x1 - x0).toFixed(1)}×${+(z1 - z0).toFixed(1)}`;
const secs = (ticks: number) => +(ticks * SIM.TICK_S).toFixed(1);
const perSec = (perTick: number) => +(perTick / SIM.TICK_S).toFixed(3);
const polylineLen = (path: P2[]) => +path.reduce((acc, p, i) => (i ? acc + Math.hypot(p[0] - path[i - 1][0], p[1] - path[i - 1][1]) : 0), 0).toFixed(1);
/** Which task types accept this location kind as a source / destination (derived from TASK_RULES) */
const roles = (kind: string) => Object.entries(TASK_RULES).flatMap(([t, [src, dst]]) => [...(src.has(kind) ? [`${t} source`] : []), ...(dst.has(kind) ? [`${t} destination`] : [])]).join(" · ") || "none";

const F_ID = (example: string): SchemaField => ({ name: "id", type: "string", description: `Unique id, e.g. ${example}` });
const F_ZONE: SchemaField = { name: "zone", type: "string", description: "Zone id this asset belongs to (A–D on floor 1, M on the mezzanine)" };
const F_FLOOR: SchemaField = { name: "floor", type: "integer", optional: true, description: "Floor id; default 1" };
const F_ACCESS: SchemaField = { name: "access_point", type: "[x, z]", unit: "m", description: "The passable cell where a robot stops to service this asset (A* target)" };

// ── types ────────────────────────────────────────────────────
const rack = defineType<LayoutRack>({
  id: "rack", label: "Rack", description: "Double-sided storage rack. The 3D scene draws all racks in one InstancedMesh. Each bay exposes one SHELF location per side, which is the only kind of location a PICK can start from.",
  rows: (l) => l.racks,
  fields: [
    F_ID("RACK-A01"), F_ZONE,
    { name: "position", type: "[x, y, z]", unit: "m", description: "Front-left corner; y = 0" },
    { name: "size", type: "[length, height, depth]", unit: "m", description: "Physical envelope" },
    { name: "rotation", type: "number", unit: "rad", description: "Yaw around the y axis; 0 points to +x" },
    { name: "levels", type: "integer", description: "Number of shelf levels; drives the box rendering and the location level_range" },
    { name: "model", type: "string", description: "GLB model name" },
    { name: "blocks_grid", type: "boolean", description: "true: the cells it occupies are obstacles in the navigation grid" },
    F_FLOOR,
  ],
  characteristics: [
    { label: "Service cells around a shelf access point", value: SIM.SERVICE_RADIUS, unit: "cells (Chebyshev)", source: "SIM.SERVICE_RADIUS" },
    { label: "Pick dwell at a shelf", value: secs(SIM.PICK_TICKS), unit: "s", source: "SIM.PICK_TICKS" },
    { label: "SHELF locations in this layout", value: layout.locations.filter((x) => x.kind === "SHELF").length, source: "layout.locations" },
    { label: "Task roles of a SHELF location", value: roles("SHELF"), source: "TASK_RULES" },
  ],
  columns: [
    { key: "id", label: "ID", get: (r) => r.id },
    { key: "zone", label: "Zone", get: (r) => r.zone },
    { key: "floor", label: "Floor", get: (r) => r.floor ?? 1 },
    { key: "pos", label: "Position x, z", get: (r) => `${r.position[0]}, ${r.position[2]}` },
    { key: "size", label: "Size L×H×D", get: (r) => r.size.join("×") },
    { key: "rot", label: "Rot °", get: (r) => deg(r.rotation) },
    { key: "levels", label: "Levels", get: (r) => r.levels },
    { key: "model", label: "Model", get: (r) => r.model },
    { key: "blocks", label: "Blocks grid", get: (r) => (r.blocks_grid ? "yes" : "no") },
  ],
  variants: [
    { label: "levels", key: (r) => r.levels },
    { label: "size", key: (r) => r.size.join("×") },
    { label: "floor", key: (r) => r.floor ?? 1 },
    { label: "zone", key: (r) => r.zone },
    { label: "model", key: (r) => r.model },
  ],
});

const robot = defineType<LayoutSpawnRobot>({
  id: "robot", label: "Robot (AMR)", description: "Autonomous mobile robot. The layout only stores the spawn pose and battery; the body, speed, battery and perception characteristics come from the simulation engine and apply to every robot.",
  rows: (l) => l.spawn.robots,
  fields: [
    F_ID("R01"),
    { name: "position", type: "[x, y, z]", unit: "m", description: "Spawn position (snapped to the cell center at reset)" },
    { name: "heading", type: "number", unit: "rad", description: "Initial heading; 0 points to +x" },
    { name: "battery", type: "number", unit: "%", description: "Initial battery level" },
    F_FLOOR,
  ],
  characteristics: [
    { label: "Model", value: ROBOT_DEFAULTS.model, source: "ROBOT_DEFAULTS.model" },
    { label: "Load capacity", value: ROBOT_DEFAULTS.load_capacity, unit: "units", source: "ROBOT_DEFAULTS.load_capacity" },
    { label: "Body length × width", value: `${2 * SIM.ROBOT_HALF_LEN} × ${2 * SIM.ROBOT_HALF_W}`, unit: "m", source: "SIM.ROBOT_HALF_LEN / ROBOT_HALF_W" },
    { label: "Max speed", value: SIM.MAX_SPEED, unit: "m/s", source: "SIM.MAX_SPEED" },
    { label: "Acceleration", value: SIM.ACCEL, unit: "m/s²", source: "SIM.ACCEL" },
    { label: "Speed ratio during a turn", value: SIM.TURN_SLOW, unit: "×", source: "SIM.TURN_SLOW" },
    { label: "Min separation between robots", value: SIM.MIN_SEP, unit: "m", source: "SIM.MIN_SEP" },
    { label: "Separation in lift docking mode", value: SIM.LIFT_SEP, unit: "m", source: "SIM.LIFT_SEP" },
    { label: "LiDAR range", value: SIM.LIDAR_RANGE, unit: "m", source: "SIM.LIDAR_RANGE" },
    { label: "LiDAR field of view", value: deg(SIM.LIDAR_FOV), unit: "°", source: "SIM.LIDAR_FOV" },
    { label: "Stop when obstacle ahead closer than", value: SIM.PERC_STOP, unit: "m", source: "SIM.PERC_STOP" },
    { label: "Slow down when obstacle ahead closer than", value: SIM.PERC_SLOW, unit: "m", source: "SIM.PERC_SLOW" },
    { label: "Battery drain, moving at full speed", value: `${SIM.BATTERY_MOVE} (${perSec(SIM.BATTERY_MOVE)} %/s)`, unit: "%/tick", source: "SIM.BATTERY_MOVE" },
    { label: "Extra drain while loaded", value: SIM.BATTERY_LOAD, unit: "%/tick", source: "SIM.BATTERY_LOAD" },
    { label: "Idle drain", value: SIM.BATTERY_IDLE, unit: "%/tick", source: "SIM.BATTERY_IDLE" },
    { label: "Battery warning / critical", value: `${THRESHOLDS.BATTERY_WARNING} / ${THRESHOLDS.BATTERY_CRITICAL}`, unit: "%", source: "THRESHOLDS.BATTERY_*" },
    { label: "Pick dwell / drop dwell", value: `${secs(SIM.PICK_TICKS)} / ${secs(SIM.DROP_TICKS)}`, unit: "s", source: "SIM.PICK_TICKS / DROP_TICKS" },
    { label: "Idle time before returning to parking", value: secs(SIM.IDLE_TO_PARK_TICKS), unit: "s", source: "SIM.IDLE_TO_PARK_TICKS" },
    { label: "Replan after blocked for", value: secs(SIM.WAIT_REPLAN_TICKS), unit: "s", source: "SIM.WAIT_REPLAN_TICKS" },
  ],
  columns: [
    { key: "id", label: "ID", get: (r) => r.id },
    { key: "floor", label: "Floor", get: (r) => r.floor ?? 1 },
    { key: "pos", label: "Spawn x, z", get: (r) => `${r.position[0]}, ${r.position[2]}` },
    { key: "heading", label: "Heading °", get: (r) => deg(r.heading) },
    { key: "battery", label: "Battery %", get: (r) => r.battery },
  ],
  variants: [
    { label: "floor", key: (r) => r.floor ?? 1 },
    { label: "battery", key: (r) => `${Math.floor(r.battery / 10) * 10}s` },
  ],
});

const conveyor = defineType<LayoutConveyor>({
  id: "conveyor", label: "Conveyor", description: "Belt conveyor along a 2D polyline. It is an obstacle in the navigation grid, so robots cannot cross it; split the path into two conveyors to leave a crossing. When it feeds a station and fails, unloading at that station slows down (the Demo 04 bottleneck).",
  rows: (l) => l.conveyors,
  fields: [
    F_ID("CV01"),
    { name: "name", type: "string", description: "Display name, e.g. Conveyor #03" },
    F_ZONE,
    { name: "path", type: "[[x, z], …]", unit: "m", description: "Polyline of at least 2 points" },
    { name: "width", type: "number", unit: "m", description: "Belt width" },
    { name: "speed_mps", type: "number", unit: "m/s", description: "Belt speed" },
    { name: "direction", type: "FORWARD | REVERSE", description: "Travel direction along the path" },
    { name: "blocks_grid", type: "boolean", description: "true: the belt cells are obstacles in the navigation grid" },
    { name: "feeds", type: "string", optional: true, description: "Id of the station this conveyor supplies" },
  ],
  characteristics: [
    { label: "Station dwell multiplier while the feeding conveyor is faulted", value: CONVEYOR_FAULT_DWELL.FAULT, unit: "×", source: "CONVEYOR_FAULT_DWELL.FAULT" },
    { label: "Station dwell multiplier while degraded / in maintenance", value: CONVEYOR_FAULT_DWELL.DEGRADED, unit: "×", source: "CONVEYOR_FAULT_DWELL.DEGRADED" },
    { label: "Crossable by robots", value: "no (obstacle; split the path for a crossing)", source: "docs/layout/warehouse_layout_format.md" },
  ],
  columns: [
    { key: "id", label: "ID", get: (r) => r.id },
    { key: "name", label: "Name", get: (r) => r.name },
    { key: "zone", label: "Zone", get: (r) => r.zone },
    { key: "from", label: "From → To", get: (r) => `${p2(r.path[0])} → ${p2(r.path[r.path.length - 1])}` },
    { key: "len", label: "Length m", get: (r) => polylineLen(r.path) },
    { key: "width", label: "Width m", get: (r) => r.width },
    { key: "speed", label: "Speed m/s", get: (r) => r.speed_mps },
    { key: "dir", label: "Direction", get: (r) => r.direction },
    { key: "feeds", label: "Feeds", get: (r) => r.feeds ?? "—" },
    { key: "blocks", label: "Blocks grid", get: (r) => (r.blocks_grid ? "yes" : "no") },
  ],
  variants: [
    { label: "direction", key: (r) => r.direction },
    { label: "speed", key: (r) => `${r.speed_mps} m/s` },
    { label: "width", key: (r) => `${r.width} m` },
    { label: "feeds", key: (r) => r.feeds ?? "—" },
  ],
});

const station = defineType<LayoutStation>({
  id: "station", label: "Station", description: "Packing, sorting and other workstations. Each station creates a task location with the same id; robots stop at the access point outside the rect.",
  rows: (l) => l.stations,
  fields: [
    F_ID("PACK-01"),
    { name: "kind", type: "PACKING | SORTING | …", description: "Station kind; also the kind of the generated location" },
    F_ZONE,
    { name: "rect", type: "[x0, z0, x1, z1]", unit: "m", description: "Footprint" },
    F_ACCESS,
  ],
  characteristics: [
    { label: "Arrive-in-place radius when the front cell is busy", value: SIM.STATION_ARRIVE_CELLS, unit: "cells", source: "SIM.STATION_ARRIVE_CELLS" },
    { label: "Service cells around the access point", value: SIM.SERVICE_RADIUS, unit: "cells (Chebyshev)", source: "SIM.SERVICE_RADIUS" },
    { label: "Drop dwell", value: secs(SIM.DROP_TICKS), unit: "s", source: "SIM.DROP_TICKS" },
    { label: "Task roles of a PACKING location", value: roles("PACKING"), source: "TASK_RULES" },
    { label: "Task roles of a SORTING location", value: roles("SORTING"), source: "TASK_RULES" },
  ],
  columns: [
    { key: "id", label: "ID", get: (r) => r.id },
    { key: "kind", label: "Kind", get: (r) => r.kind },
    { key: "zone", label: "Zone", get: (r) => r.zone },
    { key: "rect", label: "Rect", get: (r) => rect(r.rect) },
    { key: "size", label: "Size W×D m", get: (r) => rectSize(r.rect) },
    { key: "access", label: "Access point", get: (r) => p2(r.access_point) },
    { key: "fedBy", label: "Fed by", get: (r) => layout.conveyors.find((c) => c.feeds === r.id)?.id ?? "—" },
  ],
  variants: [
    { label: "kind", key: (r) => r.kind },
    { label: "zone", key: (r) => r.zone },
  ],
});

const charging = defineType<LayoutCharging>({
  id: "charging", label: "Charging station", description: "Docking charger for one robot. power_kw is layout metadata for the 3D model; the simulation charges every robot at the flat CHARGE_RATE below. Charging stations are never task locations.",
  rows: (l) => l.charging_stations,
  fields: [
    F_ID("CHG-01"), F_ZONE,
    { name: "position", type: "[x, y, z]", unit: "m", description: "Charger position" },
    { name: "heading", type: "number", unit: "rad", description: "Docking direction" },
    { name: "power_kw", type: "number", unit: "kW", description: "Nominal charger power (metadata; not used by the engine)" },
    F_ACCESS,
  ],
  characteristics: [
    { label: "Charge rate", value: `${SIM.CHARGE_RATE} (${perSec(SIM.CHARGE_RATE)} %/s)`, unit: "%/tick", source: "SIM.CHARGE_RATE" },
    { label: "Charge target", value: THRESHOLDS.BATTERY_CHARGE_TO, unit: "%", source: "THRESHOLDS.BATTERY_CHARGE_TO" },
    { label: "Time from empty to charge target", value: Math.round((THRESHOLDS.BATTERY_CHARGE_TO / SIM.CHARGE_RATE) * SIM.TICK_S), unit: "s", source: "BATTERY_CHARGE_TO / CHARGE_RATE" },
    { label: "Robot goes to charge below", value: THRESHOLDS.BATTERY_WARNING, unit: "%", source: "THRESHOLDS.BATTERY_WARNING" },
    { label: "Battery critical", value: THRESHOLDS.BATTERY_CRITICAL, unit: "%", source: "THRESHOLDS.BATTERY_CRITICAL" },
    { label: "Task roles", value: roles("CHARGING"), source: "TASK_RULES" },
  ],
  columns: [
    { key: "id", label: "ID", get: (r) => r.id },
    { key: "zone", label: "Zone", get: (r) => r.zone },
    { key: "pos", label: "Position x, z", get: (r) => `${r.position[0]}, ${r.position[2]}` },
    { key: "heading", label: "Heading °", get: (r) => deg(r.heading) },
    { key: "power", label: "Power kW", get: (r) => r.power_kw },
    { key: "access", label: "Access point", get: (r) => p2(r.access_point) },
  ],
  variants: [
    { label: "power", key: (r) => `${r.power_kw} kW` },
    { label: "zone", key: (r) => r.zone },
  ],
});

const lift = defineType<LayoutLift>({
  id: "lift", label: "Lift", description: "Material lift between floors. It carries one robot at a time; robots queue at the door, board at a slow speed, ride, and exit. The shaft geometry in the 3D scene and the engine door constants are kept equal by a test.",
  rows: (l) => l.lifts,
  fields: [
    F_ID("LIFT-1"),
    { name: "cell", type: "[col, row]", unit: "cells", description: "Grid cell of the cabin; must be passable on every floor it serves" },
    { name: "floors", type: "integer[]", description: "Floor ids the lift connects" },
    { name: "ride_ticks", type: "integer", unit: "ticks", description: "Nominal ride time in the layout" },
  ],
  characteristics: [
    { label: "Capacity", value: "1 robot", source: "docs/layout/warehouse_layout_format.md" },
    { label: "Door open / close", value: `${SIM.LIFT_DOOR_TICKS} ticks (${secs(SIM.LIFT_DOOR_TICKS)} s)`, source: "SIM.LIFT_DOOR_TICKS" },
    { label: "Vertical travel", value: `${SIM.LIFT_TRAVEL_TICKS} ticks (${secs(SIM.LIFT_TRAVEL_TICKS)} s)`, source: "SIM.LIFT_TRAVEL_TICKS" },
    { label: "Leveling", value: `${SIM.LIFT_LEVEL_TICKS} ticks (${secs(SIM.LIFT_LEVEL_TICKS)} s)`, source: "SIM.LIFT_LEVEL_TICKS" },
    { label: "Cooldown after a trip", value: `${SIM.LIFT_COOLDOWN_TICKS} ticks (${secs(SIM.LIFT_COOLDOWN_TICKS)} s)`, source: "SIM.LIFT_COOLDOWN_TICKS" },
    { label: "Boarding speed", value: SIM.LIFT_BOARD_SPEED, unit: "m/s", source: "SIM.LIFT_BOARD_SPEED" },
    { label: "Queue advance speed", value: SIM.LIFT_QUEUE_SPEED, unit: "m/s", source: "SIM.LIFT_QUEUE_SPEED" },
    { label: "Separation at the door", value: SIM.LIFT_SEP, unit: "m", source: "SIM.LIFT_SEP" },
    { label: "Shaft W × D", value: `${LIFT_SHAFT.W} × ${LIFT_SHAFT.D}`, unit: "m", source: "Mezzanine.LIFT_SHAFT" },
    { label: "Door opening width", value: 2 * SIM.LIFT_DOOR_HALF_W, unit: "m", source: "SIM.LIFT_DOOR_HALF_W" },
    { label: "Door leaf width", value: LIFT_SHAFT.LEAF, unit: "m", source: "Mezzanine.LIFT_SHAFT.LEAF" },
    { label: "Retry interval when all lifts are faulted", value: secs(SIM.LIFT_RETRY_TICKS), unit: "s", source: "SIM.LIFT_RETRY_TICKS" },
    { label: "Cross-floor assignment penalty", value: SIM.LIFT_XFLOOR_PENALTY_M, unit: "m equivalent", source: "SIM.LIFT_XFLOOR_PENALTY_M" },
  ],
  columns: [
    { key: "id", label: "ID", get: (r) => r.id },
    { key: "cell", label: "Cell c, r", get: (r) => `${r.cell[0]}, ${r.cell[1]}` },
    { key: "floors", label: "Floors", get: (r) => r.floors.join(" ↔ ") },
    { key: "ride", label: "Ride ticks", get: (r) => r.ride_ticks },
    { key: "rideS", label: "Ride s", get: (r) => secs(r.ride_ticks) },
  ],
  variants: [
    { label: "floors", key: (r) => r.floors.join("↔") },
    { label: "ride", key: (r) => `${r.ride_ticks} ticks` },
  ],
});

const camera = defineType<LayoutCamera>({
  id: "camera", label: "Camera (CCTV)", description: "Virtual CCTV. The 3D scene builds a PerspectiveCamera from these parameters and renders it to a RenderTarget; the VLM observes a screenshot of that target.",
  rows: (l) => l.cameras,
  fields: [
    F_ID("CAM-B03"), F_ZONE, F_FLOOR,
    { name: "position", type: "[x, y, z]", unit: "m", description: "Mount position, including height" },
    { name: "look_at", type: "[x, y, z]", unit: "m", description: "Aim point" },
    { name: "fov_deg", type: "number", unit: "°", description: "Vertical field of view" },
    { name: "range_m", type: "number", unit: "m", description: "Nominal viewing range" },
  ],
  characteristics: [
    { label: "Rendering", value: "PerspectiveCamera → RenderTarget (3D scene)", source: "docs/layout/warehouse_layout_format.md" },
    { label: "Failure injection", value: "CAMERA_OFFLINE (feed goes dark, VLM sees nothing)", source: "Scenarios drawer" },
  ],
  columns: [
    { key: "id", label: "ID", get: (r) => r.id },
    { key: "zone", label: "Zone", get: (r) => r.zone },
    { key: "floor", label: "Floor", get: (r) => r.floor ?? 1 },
    { key: "pos", label: "Position x, y, z", get: (r) => p3(r.position) },
    { key: "look", label: "Look-at", get: (r) => p3(r.look_at) },
    { key: "fov", label: "FOV °", get: (r) => r.fov_deg },
    { key: "range", label: "Range m", get: (r) => r.range_m },
  ],
  variants: [
    { label: "fov", key: (r) => `${r.fov_deg}°` },
    { label: "range", key: (r) => `${r.range_m} m` },
    { label: "floor", key: (r) => r.floor ?? 1 },
    { label: "zone", key: (r) => r.zone },
  ],
});

const sensor = defineType<LayoutSensor>({
  id: "sensor", label: "Sensor", description: "Fixed IoT sensor. Readings are decorative but derived from the real state every 10 ticks; sensors do not change the simulation.",
  rows: (l) => l.sensors,
  fields: [
    F_ID("SNS-01"),
    { name: "kind", type: "LIDAR | IR | WEIGHT | TEMP | PRESENCE", description: "Sensor kind; sets the unit of the runtime reading" },
    F_ZONE,
    { name: "position", type: "[x, y, z]", unit: "m", description: "Mount position" },
  ],
  characteristics: [
    { label: "Reading refresh", value: `every ${SIM.KPI_EVERY} ticks (${secs(SIM.KPI_EVERY)} s)`, source: "SIM.KPI_EVERY / engine.updateDevices" },
    { label: "Effect on the simulation", value: "none (status display only)", source: "docs/layout/warehouse_layout_format.md" },
  ],
  columns: [
    { key: "id", label: "ID", get: (r) => r.id },
    { key: "kind", label: "Kind", get: (r) => r.kind },
    { key: "zone", label: "Zone", get: (r) => r.zone },
    { key: "pos", label: "Position x, y, z", get: (r) => p3(r.position) },
  ],
  variants: [
    { label: "kind", key: (r) => r.kind },
    { label: "zone", key: (r) => r.zone },
  ],
});

const dock = defineType<LayoutDock>({
  id: "dock", label: "Dock", description: "Inbound or outbound loading dock on the z = 0 wall. Each dock creates a task location with the same id.",
  rows: (l) => l.docks,
  fields: [
    F_ID("INBOUND-1"),
    { name: "kind", type: "INBOUND | OUTBOUND", description: "Dock direction; also the kind of the generated location" },
    F_ZONE,
    { name: "rect", type: "[x0, z0, x1, z1]", unit: "m", description: "Footprint" },
    { name: "door", type: "[x, z]", unit: "m", description: "Door position used to draw the door in 3D" },
  ],
  characteristics: [
    { label: "Task roles of an INBOUND location", value: roles("INBOUND"), source: "TASK_RULES" },
    { label: "Task roles of an OUTBOUND location", value: roles("OUTBOUND"), source: "TASK_RULES" },
  ],
  columns: [
    { key: "id", label: "ID", get: (r) => r.id },
    { key: "kind", label: "Kind", get: (r) => r.kind },
    { key: "zone", label: "Zone", get: (r) => r.zone },
    { key: "rect", label: "Rect", get: (r) => rect(r.rect) },
    { key: "size", label: "Size W×D m", get: (r) => rectSize(r.rect) },
    { key: "door", label: "Door", get: (r) => p2(r.door) },
  ],
  variants: [
    { label: "kind", key: (r) => r.kind },
    { label: "zone", key: (r) => r.zone },
  ],
});

export const ASSET_TYPES: readonly CatalogEntry[] = [rack, robot, conveyor, station, charging, lift, camera, sensor, dock];
