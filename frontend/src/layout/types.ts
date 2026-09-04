/** Types for warehouse_layout.json; they match docs/layout/warehouse_layout_format.md */
export type P2 = [number, number];
export type P3 = [number, number, number];
export type Rect = [number, number, number, number];

export interface LayoutZone { id: string; name: string; color: string; polygon: P2[]; floor?: number }
export interface LayoutDock { id: string; kind: "INBOUND" | "OUTBOUND"; zone: string; rect: Rect; door: P2 }
export interface LayoutRack { id: string; zone: string; position: P3; size: P3; rotation: number; levels: number; model: string; blocks_grid: boolean; floor?: number }
export interface LayoutConveyor { id: string; name: string; zone: string; path: P2[]; width: number; speed_mps: number; direction: string; blocks_grid: boolean; /** The station that this conveyor supplies; on a fault, the unload time of that station increases */ feeds?: string }
export interface LayoutStation { id: string; kind: string; zone: string; rect: Rect; access_point: P2 }
export interface LayoutCharging { id: string; zone: string; position: P3; heading: number; power_kw: number; access_point: P2 }
export interface LayoutParking { id: string; zone: string; rect: Rect; slots: number }
export interface LayoutRestricted { id: string; name: string; rect: Rect; robots_allowed: boolean }
export interface LayoutWalkway { id: string; polygon: P2[]; robots_allowed: boolean; speed_limit_mps: number }
export interface LayoutCamera { id: string; zone: string; floor?: number; position: P3; look_at: P3; fov_deg: number; range_m: number }
export interface LayoutSensor { id: string; kind: string; zone: string; position: P3 }
export interface LayoutLocation { id: string; kind: string; zone: string; floor?: number; rack_id: string | null; level_range: [number, number] | null; access_point: P2 }
export interface LayoutSpawnRobot { id: string; position: P3; heading: number; battery: number; floor?: number }
export interface LayoutFloor { id: number; name: string; elevation: number; footprint?: P2[] }
export interface LayoutLift { id: string; cell: [number, number]; floors: number[]; ride_ticks: number }

export interface WarehouseLayout {
  schema_version: string;
  id: string;
  name: string;
  units: string;
  size: { width: number; depth: number; height: number };
  grid: { cell_size: number; cols: number; rows: number };
  floors: LayoutFloor[];
  /** Mezzanine support column positions (they stand on the F1 floor): the F1 navigation grid blocks the 0.9×0.9 m base plate as an obstacle */
  columns?: Array<[number, number]>;
  lifts: LayoutLift[];
  zones: LayoutZone[];
  docks: LayoutDock[];
  racks: LayoutRack[];
  conveyors: LayoutConveyor[];
  stations: LayoutStation[];
  charging_stations: LayoutCharging[];
  parking: LayoutParking[];
  restricted_areas: LayoutRestricted[];
  walkways: LayoutWalkway[];
  cameras: LayoutCamera[];
  sensors: LayoutSensor[];
  locations: LayoutLocation[];
  /** Building structure columns and other physical obstacles: the F1 navigation grid blocks the full area; WarehouseShell renders the columns from this */
  obstacles: Array<{ id: string; kind: string; rect: [number, number, number, number] }>;
  spawn: { robots: LayoutSpawnRobot[] };
}
