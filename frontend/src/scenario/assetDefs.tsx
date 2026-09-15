/**
 * Editor definitions for every catalog asset type: default params, inspector schema, footprint / height, surface rule, 2D colour, and the
 * mapping from a placed AssetInstance to a layout-shaped row centred at the origin that the existing procedural models render (the same trick
 * CatalogPreview uses). EditorScene wraps `render(...)` in <group position rotation-y>, so move and rotate work uniformly for every type,
 * including the ones whose layout shape has no rotation (station / dock rect, conveyor path).
 * Sizes are imported from the engine and scene constants (SIM, LIFT_SHAFT, FORKLIFT_BODY) so they cannot drift from the models.
 */
import { useMemo } from "react";
import type { LayoutRack, LayoutSpawnRobot, LayoutConveyor, LayoutStation, LayoutCharging, LayoutLift, LayoutCamera, LayoutSensor, LayoutDock } from "../layout/types";
import type { PersonState } from "../schema/twin_state";
import { ASSET_TYPES } from "../catalog/assetTypes";
import { SIM } from "../simulation/engine";
import { RackInstances } from "../components/scene/RackInstances";
import { RobotMesh } from "../components/scene/Robots";
import { Conveyor, StationModel, ChargerModel, SensorModel } from "../components/scene/Fixtures";
import { Lift, LIFT_SHAFT } from "../components/scene/Mezzanine";
import { CameraModel } from "../components/scene/Cameras";
import { DockModel } from "../components/scene/WarehouseShell";
import { Worker, Forklift, FORKLIFT_BODY } from "../components/scene/People";
import { robotState } from "../components/ops/CatalogPreview";
import type { AssetInstance, AssetTypeId, ParamValue } from "./types";

export type Params = Record<string, ParamValue>;
/** One inspector field; numbers are clamped to [min, max] */
export interface ParamField { key: string; label: string; kind: "number" | "text" | "select"; unit?: string; min?: number; max?: number; step?: number; options?: readonly string[] }
export interface RenderOpts { onSelect: () => void }

export interface AssetDef {
  type: AssetTypeId;
  /** From the catalog entry */
  label: string;
  description: string;
  /** 2D fill and 3D selection / ghost colour */
  color: string;
  defaults: Params;
  paramSchema: ParamField[];
  /** x / z extents (m) at rotation 0 */
  footprint(params: Params): { w: number; d: number };
  height(params: Params): number;
  /** snap: sits on the floor or on a stackable top; free: keeps an editable height (camera mount) */
  surface: "snap" | "free";
  /** Other instances can be dropped on its top: an invisible cap at `height` is a raycast surface */
  stackable: boolean;
  /** Layout-shaped row centred at the origin, carrying every required catalog field so a scenario can be projected into a WarehouseLayout later */
  toLayoutRow(inst: AssetInstance): object;
  render(row: object, inst: AssetInstance, opts: RenderOpts): JSX.Element;
}

type Def<Row extends object> = Omit<AssetDef, "label" | "description" | "toLayoutRow" | "render"> & { toLayoutRow(inst: AssetInstance): Row; render(row: Row, inst: AssetInstance, opts: RenderOpts): JSX.Element };
function define<Row extends object>(d: Def<Row>): AssetDef {
  const entry = ASSET_TYPES.find((t) => t.id === d.type);
  if (!entry) throw new Error(`asset type "${d.type}" is missing from the catalog`);
  return { ...d, label: entry.label, description: entry.description } as unknown as AssetDef;
}
const num = (v: ParamValue | undefined, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: ParamValue | undefined, fallback: string) => (typeof v === "string" && v ? v : fallback);
/** Scenarios have no zones (plan non-goal); the field stays present so the catalog contract holds */
const ZONE = "";
const DEG = Math.PI / 180;

/** RackInstances rebuilds its instance matrices whenever `racks` changes: keep the one-element array stable per row */
function RackOne({ row }: { row: LayoutRack }) {
  const racks = useMemo(() => [row], [row]);
  return <RackInstances racks={racks} castShadow={false} />;
}

const rack = define<LayoutRack>({
  type: "rack", color: "#f59e0b", surface: "snap", stackable: true,
  defaults: { length: 8, height: 6, depth: 1.2, levels: 4 },
  paramSchema: [
    { key: "length", label: "Length", kind: "number", unit: "m", min: 1, max: 60, step: 0.5 },
    { key: "height", label: "Height", kind: "number", unit: "m", min: 1, max: 20, step: 0.5 },
    { key: "depth", label: "Depth", kind: "number", unit: "m", min: 0.5, max: 5, step: 0.1 },
    { key: "levels", label: "Levels", kind: "number", min: 1, max: 12, step: 1 },
  ],
  footprint: (p) => ({ w: num(p.length, 8), d: num(p.depth, 1.2) }),
  height: (p) => num(p.height, 6),
  toLayoutRow: (i) => {
    const L = num(i.params.length, 8), H = num(i.params.height, 6), D = num(i.params.depth, 1.2);
    return { id: i.id, zone: ZONE, position: [-L / 2, 0, -D / 2], size: [L, H, D], rotation: 0, levels: Math.max(1, Math.round(num(i.params.levels, 4))), model: "rack_std", blocks_grid: true, floor: 1 };
  },
  render: (row) => <RackOne row={row} />,
});

const robot = define<LayoutSpawnRobot>({
  type: "robot", color: "#22c55e", surface: "snap", stackable: false,
  defaults: { battery: 100 },
  paramSchema: [{ key: "battery", label: "Battery", kind: "number", unit: "%", min: 0, max: 100, step: 1 }],
  footprint: () => ({ w: 2 * SIM.ROBOT_HALF_LEN, d: 2 * SIM.ROBOT_HALF_W }),
  height: () => 0.5,
  toLayoutRow: (i) => ({ id: i.id, position: [0, 0, 0], heading: 0, battery: num(i.params.battery, 100), floor: 1 }),
  // smooth={false}: RobotMesh snaps to r.position (the local origin) every frame; the parent group carries the transform
  render: (row, _inst, { onSelect }) => <RobotMesh r={robotState(row, 0)} selected={false} onSelect={onSelect} showLabel={false} lite smooth={false} />,
});

const conveyor = define<LayoutConveyor>({
  type: "conveyor", color: "#22d3ee", surface: "snap", stackable: true,
  defaults: { length: 12, width: 0.8, speed_mps: 1.2, direction: "FORWARD" },
  paramSchema: [
    { key: "length", label: "Length", kind: "number", unit: "m", min: 2, max: 100, step: 0.5 },
    { key: "width", label: "Belt width", kind: "number", unit: "m", min: 0.3, max: 3, step: 0.1 },
    { key: "speed_mps", label: "Speed", kind: "number", unit: "m/s", min: 0.1, max: 5, step: 0.1 },
    { key: "direction", label: "Direction", kind: "select", options: ["FORWARD", "REVERSE"] },
  ],
  footprint: (p) => ({ w: num(p.length, 12), d: num(p.width, 0.8) }),
  height: () => 0.9,
  toLayoutRow: (i) => {
    const L = num(i.params.length, 12);
    return { id: i.id, name: `Conveyor ${i.id.replace(/^\D+/, "") || i.id}`, zone: ZONE, path: [[-L / 2, 0], [L / 2, 0]], width: num(i.params.width, 0.8), speed_mps: num(i.params.speed_mps, 1.2), direction: str(i.params.direction, "FORWARD"), blocks_grid: true };
  },
  // Conveyor sizes its parcel set once at mount: remount when the length changes
  render: (row) => <Conveyor key={row.path[1][0] - row.path[0][0]} c={row} />,
});

const station = define<LayoutStation>({
  type: "station", color: "#818cf8", surface: "snap", stackable: false,
  defaults: { kind: "PACKING", width: 8, depth: 4 },
  paramSchema: [
    { key: "kind", label: "Kind", kind: "select", options: ["PACKING", "SORTING"] },
    { key: "width", label: "Width", kind: "number", unit: "m", min: 2, max: 40, step: 0.5 },
    { key: "depth", label: "Depth", kind: "number", unit: "m", min: 1, max: 20, step: 0.5 },
  ],
  footprint: (p) => ({ w: num(p.width, 8), d: num(p.depth, 4) }),
  height: () => 1.4,
  toLayoutRow: (i) => {
    const w = num(i.params.width, 8), d = num(i.params.depth, 4);
    return { id: i.id, kind: str(i.params.kind, "PACKING"), zone: ZONE, rect: [-w / 2, -d / 2, w / 2, d / 2], access_point: [0, d / 2 + 1] };
  },
  render: (row) => <StationModel s={row} lite />,
});

const charging = define<LayoutCharging>({
  type: "charging", color: "#3b82f6", surface: "snap", stackable: false,
  defaults: { power_kw: 7 },
  paramSchema: [{ key: "power_kw", label: "Power", kind: "number", unit: "kW", min: 1, max: 50, step: 0.5 }],
  // ChargerModel: a 0.8 × 0.4 pillar at its position and a 1.6 × 1.6 floor pad 1.9 m in front (−z); with the pillar at z = +1.25 the pair is a 1.6 × 2.9 envelope centred on the origin
  footprint: () => ({ w: 1.6, d: 2.9 }),
  height: () => 1.2,
  toLayoutRow: (i) => ({ id: i.id, zone: ZONE, position: [0, 0, 1.25], heading: 0, power_kw: num(i.params.power_kw, 7), access_point: [0, -0.65] }),
  render: (row) => <ChargerModel c={row} lite />,
});

const lift = define<LayoutLift>({
  type: "lift", color: "#a78bfa", surface: "snap", stackable: false,
  defaults: { travel_m: 6 },
  paramSchema: [{ key: "travel_m", label: "Travel height", kind: "number", unit: "m", min: 2, max: 30, step: 0.5 }],
  footprint: () => ({ w: LIFT_SHAFT.W, d: LIFT_SHAFT.D }),
  height: (p) => num(p.travel_m, 6) + 2.4,
  // Lift draws its shaft at cell + 0.5, so a −0.5 cell centres it on the origin
  toLayoutRow: (i) => ({ id: i.id, cell: [-0.5, -0.5], floors: [1, 2], ride_ticks: 60 }),
  render: (row, inst) => <Lift l={row} elev={num(inst.params.travel_m, 6)} lite />,
});

const camera = define<LayoutCamera>({
  type: "camera", color: "#facc15", surface: "free", stackable: false,
  // mount_h is the drop height; afterwards the instance's y is the single truth (the inspector edits it as "Mount height")
  defaults: { mount_h: 5, fov_deg: 70, range_m: 25, pitch_deg: 35 },
  paramSchema: [
    { key: "fov_deg", label: "Field of view", kind: "number", unit: "°", min: 10, max: 170, step: 5 },
    { key: "range_m", label: "Range", kind: "number", unit: "m", min: 2, max: 100, step: 1 },
    { key: "pitch_deg", label: "Pitch down", kind: "number", unit: "°", min: 0, max: 90, step: 5 },
  ],
  footprint: () => ({ w: 0.6, d: 0.6 }),
  height: () => 0.8,
  // Looks along +x, pitched down; the group rotation turns it
  toLayoutRow: (i) => {
    const r = num(i.params.range_m, 25), p = num(i.params.pitch_deg, 35) * DEG;
    return { id: i.id, zone: ZONE, floor: 1, position: [0, 0, 0], look_at: [r * Math.cos(p), -r * Math.sin(p), 0], fov_deg: num(i.params.fov_deg, 70), range_m: r };
  },
  render: (row) => <CameraModel c={row} active />,
});

const sensor = define<LayoutSensor>({
  type: "sensor", color: "#f472b6", surface: "snap", stackable: false,
  defaults: { kind: "LIDAR" },
  paramSchema: [{ key: "kind", label: "Kind", kind: "select", options: ["LIDAR", "IR", "WEIGHT", "TEMP", "PRESENCE"] }],
  footprint: () => ({ w: 0.4, d: 0.4 }),
  height: () => 0.4,
  toLayoutRow: (i) => ({ id: i.id, kind: str(i.params.kind, "LIDAR"), zone: ZONE, position: [0, 0.18, 0] }),
  render: (row) => <SensorModel s={row} />,
});

/** DockModel draws a fixed 5.5 m door panel under a 6.2 m header bar (WarehouseShell.tsx); the apron footprint uses that width */
const DOCK_W = 6.2;
const dock = define<LayoutDock>({
  type: "dock", color: "#10b981", surface: "snap", stackable: false,
  defaults: { kind: "INBOUND", depth: 4 },
  paramSchema: [
    { key: "kind", label: "Kind", kind: "select", options: ["INBOUND", "OUTBOUND"] },
    { key: "depth", label: "Apron depth", kind: "number", unit: "m", min: 1, max: 20, step: 0.5 },
  ],
  footprint: (p) => ({ w: DOCK_W, d: num(p.depth, 4) }),
  // header light bar at 5 m
  height: () => 5.2,
  toLayoutRow: (i) => {
    const d = num(i.params.depth, 4);
    return { id: i.id, kind: str(i.params.kind, "INBOUND") as LayoutDock["kind"], zone: ZONE, rect: [-DOCK_W / 2, -d / 2, DOCK_W / 2, d / 2], door: [0, -d / 2] };
  },
  // DockModel draws its door panel at z ≈ 0 and the truck trailer outside (−z): shift it so the door sits on the −z edge of the apron footprint
  render: (row, inst) => <group position={[0, 0, -num(inst.params.depth, 4) / 2]}><DockModel d={row} /></group>,
});

const person = (i: AssetInstance, kind: PersonState["kind"]): PersonState => ({ id: i.id, kind, position: [0, 0, 0], heading: 0, zone: null, floor: 1, expires_tick: null });
const worker = define<PersonState>({
  type: "worker", color: "#fb923c", surface: "snap", stackable: false,
  defaults: {}, paramSchema: [],
  footprint: () => ({ w: 0.6, d: 0.6 }),
  height: () => 1.8,
  toLayoutRow: (i) => person(i, "WORKER"),
  render: (row) => <Worker position={row.position} heading={row.heading} />,
});
const forklift = define<PersonState>({
  type: "forklift", color: "#f97316", surface: "snap", stackable: false,
  defaults: {}, paramSchema: [],
  footprint: () => ({ w: FORKLIFT_BODY.L, d: FORKLIFT_BODY.W }),
  height: () => FORKLIFT_BODY.MAST_H,
  toLayoutRow: (i) => person(i, "FORKLIFT"),
  render: (row) => <Forklift position={row.position} heading={row.heading} />,
});

export const ASSET_DEFS: Record<AssetTypeId, AssetDef> = { rack, robot, conveyor, station, charging, lift, camera, sensor, dock, worker, forklift };
/** In catalog order, so the palette lists the types the way the Asset Catalog does */
export const ASSET_TYPE_IDS: readonly AssetTypeId[] = ASSET_TYPES.map((t) => t.id).filter((id): id is AssetTypeId => id in ASSET_DEFS);
export const assetLabel = (type: AssetTypeId) => ASSET_DEFS[type].label;
export const assetDescription = (type: AssetTypeId) => ASSET_DEFS[type].description;
