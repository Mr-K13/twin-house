/**
 * Projection of a user-built twin (Scenario) into the WarehouseLayout the console renders and the local SimEngine simulates. Pure: no React, no DOM.
 * Each instance's layout row comes from its asset definition (`ASSET_DEFS[type].toLayoutRow`, centred at the origin) and is placed at the instance.
 *
 * Approximations the console makes, because the navigation grid and several scene models are axis-aligned:
 *  - racks, stations, docks, conveyors and lifts turn by the instance yaw rounded to the nearest 90° (their extents swap at 90° / 270°);
 *  - a charger always faces −z (ChargerModel and the engine's docking pose are fixed to that direction);
 *  - robots, cameras, sensors, workers and forklifts keep their exact position and yaw.
 * The twin has one floor and one zone ("A", the whole floor). Task locations are generated: one SHELF per ~3 m bay on each rack face that has
 * a free aisle cell, one location per station (its kind) and per dock (INBOUND / OUTBOUND), one CHARGING location per charger. Every access
 * point and robot spawn is moved to the nearest free grid cell the robots can reach; a location with none within MAX_SNAP_CELLS is dropped.
 */
import type { LayoutCamera, LayoutCharging, LayoutConveyor, LayoutDock, LayoutLift, LayoutLocation, LayoutRack, LayoutSensor, LayoutSpawnRobot, LayoutStation, P2, Rect, WarehouseLayout } from "../layout/types";
import type { PersonState } from "../schema/twin_state";
import { buildNavGrid } from "../layout/navgrid";
import { isWalkable, type NavGrid } from "../simulation/astar";
import { ASSET_DEFS } from "./assetDefs";
import type { AssetInstance, Scenario } from "./types";

/** Aisle cells searched around an access point or a spawn before the location is dropped */
const MAX_SNAP_CELLS = 3;
/** Target bay length (m) along a rack face: one SHELF location per bay */
const BAY_M = 3;
export const TWIN_ZONE = { id: "A", name: "Floor", color: "#3b82f6" } as const;

/** Quarter turns (0..3) of the yaw rounded to the nearest 90° */
const quarter = (yaw: number) => (((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4);
/** three.js rotation-y of a local x/z point, by whole quarter turns (exact) or by any angle */
function turnQ([x, z]: P2, q: number): P2 {
  switch (q) { case 1: return [z, -x]; case 2: return [-x, -z]; case 3: return [-z, x]; default: return [x, z]; }
}
function turn([x, z]: P2, yaw: number): P2 { const c = Math.cos(yaw), s = Math.sin(yaw); return [x * c + z * s, -x * s + z * c]; }
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const at = (i: AssetInstance, p: P2): P2 => [round3(i.position[0] + p[0]), round3(i.position[2] + p[1])];
function rectAt(i: AssetInstance, [x0, z0, x1, z1]: Rect, q: number): Rect {
  const a = turnQ([x0, z0], q), b = turnQ([x1, z1], q);
  const [ax, az] = at(i, a), [bx, bz] = at(i, b);
  return [Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)];
}

export function projectLayout(s: Scenario): WarehouseLayout {
  const { length: L, width: W, height: H } = s.size;
  const racks: LayoutRack[] = [], robots: LayoutSpawnRobot[] = [], conveyors: LayoutConveyor[] = [], stations: LayoutStation[] = [];
  const chargers: LayoutCharging[] = [], lifts: LayoutLift[] = [], cameras: LayoutCamera[] = [], sensors: LayoutSensor[] = [], docks: LayoutDock[] = [];
  const people: PersonState[] = [];
  /** Wanted access points, resolved against the grid once every obstacle is known */
  const wanted: Array<{ loc: Omit<LayoutLocation, "access_point">; points: P2[] }> = [];

  for (const i of s.instances) {
    const def = ASSET_DEFS[i.type], q = quarter(i.rotation);
    switch (i.type) {
      case "rack": {
        const r = def.toLayoutRow(i) as LayoutRack;
        const [x0, z0, x1, z1] = rectAt(i, [r.position[0], r.position[2], r.position[0] + r.size[0], r.position[2] + r.size[2]], q);
        const rack: LayoutRack = { ...r, zone: TWIN_ZONE.id, position: [x0, i.position[1], z0], size: [round3(x1 - x0), r.size[1], round3(z1 - z0)], rotation: 0 };
        racks.push(rack);
        // Bays along the long side; each bay can be served from both faces (like the Main Warehouse's double-sided aisles)
        const alongX = x1 - x0 >= z1 - z0, len = alongX ? x1 - x0 : z1 - z0, n = Math.max(1, Math.round(len / BAY_M));
        for (let b = 0; b < n; b++) {
          const t = (alongX ? x0 : z0) + ((b + 0.5) * len) / n;
          for (const face of alongX ? [z0 - 0.5, z1 + 0.5] : [x0 - 0.5, x1 + 0.5]) {
            wanted.push({ loc: { id: `SHELF-${i.id}-${wanted.filter((w) => w.loc.rack_id === i.id).length + 1}`, kind: "SHELF", zone: TWIN_ZONE.id, floor: 1, rack_id: i.id, level_range: [1, rack.levels] }, points: [alongX ? [t, face] : [face, t]] });
          }
        }
        break;
      }
      case "robot": {
        const r = def.toLayoutRow(i) as LayoutSpawnRobot;
        // RobotMesh draws rotation-y = −heading
        robots.push({ ...r, position: [i.position[0], 0, i.position[2]], heading: -i.rotation, floor: 1 });
        break;
      }
      case "conveyor": {
        const c = def.toLayoutRow(i) as LayoutConveyor;
        conveyors.push({ ...c, zone: TWIN_ZONE.id, path: c.path.map((p) => at(i, turnQ(p, q))) });
        break;
      }
      case "station": {
        const st = def.toLayoutRow(i) as LayoutStation;
        const station: LayoutStation = { ...st, zone: TWIN_ZONE.id, rect: rectAt(i, st.rect, q), access_point: at(i, turnQ(st.access_point, q)) };
        stations.push(station);
        wanted.push({ loc: { id: st.id, kind: st.kind, zone: TWIN_ZONE.id, rack_id: null, level_range: null }, points: [station.access_point] });
        break;
      }
      case "charging": {
        const c = def.toLayoutRow(i) as LayoutCharging;
        const charger: LayoutCharging = { ...c, zone: TWIN_ZONE.id, position: [round3(i.position[0] + c.position[0]), 0, round3(i.position[2] + c.position[2])], access_point: at(i, c.access_point) };
        chargers.push(charger);
        wanted.push({ loc: { id: c.id, kind: "CHARGING", zone: TWIN_ZONE.id, rack_id: null, level_range: null }, points: [charger.access_point] });
        break;
      }
      case "lift": {
        const l = def.toLayoutRow(i) as LayoutLift;
        const [cx, cz] = at(i, l.cell);
        lifts.push({ ...l, cell: [cx, cz], floors: [1], travel_m: typeof i.params.travel_m === "number" ? i.params.travel_m : undefined });
        break;
      }
      case "camera": {
        const c = def.toLayoutRow(i) as LayoutCamera;
        const [lx, lz] = turn([c.look_at[0], c.look_at[2]], i.rotation);
        cameras.push({ ...c, zone: TWIN_ZONE.id, floor: 1, position: [i.position[0], i.position[1], i.position[2]], look_at: [round3(i.position[0] + lx), round3(i.position[1] + c.look_at[1]), round3(i.position[2] + lz)] });
        break;
      }
      case "sensor": {
        const se = def.toLayoutRow(i) as LayoutSensor;
        sensors.push({ ...se, zone: TWIN_ZONE.id, position: [i.position[0], i.position[1] + se.position[1], i.position[2]] });
        break;
      }
      case "dock": {
        const d = def.toLayoutRow(i) as LayoutDock;
        const [, dz0, , dz1] = d.rect;
        docks.push({ ...d, zone: TWIN_ZONE.id, rect: rectAt(i, d.rect, q), door: at(i, turnQ(d.door, q)) });
        // Robots load / unload 1 m past the inner edge of the apron (the Main Warehouse's docks do the same)
        wanted.push({ loc: { id: d.id, kind: d.kind, zone: TWIN_ZONE.id, rack_id: null, level_range: null }, points: [at(i, turnQ([0, dz1 + 1], q)), at(i, turnQ([0, (dz0 + dz1) / 2], q))] });
        break;
      }
      case "worker":
      case "forklift": {
        const p = def.toLayoutRow(i) as PersonState;
        people.push({ ...p, position: [i.position[0], i.position[1], i.position[2]], heading: i.rotation });
        break;
      }
    }
  }

  const layout: WarehouseLayout = {
    schema_version: "1.0", id: `twin-${s.id}`, name: s.name, units: "m",
    size: { width: L, depth: W, height: H },
    grid: { cell_size: 1, cols: Math.ceil(L), rows: Math.ceil(W) },
    floors: [{ id: 1, name: "Floor 1", elevation: 0 }],
    lifts,
    zones: [{ ...TWIN_ZONE, floor: 1, polygon: [[0, 0], [L, 0], [L, W], [0, W]] }],
    docks, racks, conveyors, stations, charging_stations: chargers,
    parking: [], restricted_areas: [], walkways: [], cameras, sensors,
    locations: [], obstacles: [],
    spawn: { robots },
    static_people: people,
  };

  const grid = buildNavGrid(layout, 1);
  const taken = new Set<number>();
  for (const r of robots) {
    const c = nearestFree(grid, r.position[0], r.position[2], (k) => !taken.has(k), Math.max(grid.cols, grid.rows));
    if (c === null) continue;
    taken.add(c); r.position = [(c % grid.cols) + 0.5, 0, Math.floor(c / grid.cols) + 0.5];
  }
  // Only cells the robots can reach count as aisles (a pocket walled in by racks would leave tasks unserviceable)
  const reach = robots.length ? reachable(grid, [...taken]) : null;
  for (const w of wanted) {
    for (const [x, z] of w.points) {
      const c = nearestFree(grid, x, z, (k) => !reach || reach.has(k), MAX_SNAP_CELLS);
      if (c === null) continue;
      layout.locations.push({ ...w.loc, access_point: [(c % grid.cols) + 0.5, Math.floor(c / grid.cols) + 0.5] });
      break;
    }
  }
  return layout;
}

/** Nearest walkable cell index (row-major) to (x, z) within `radius` rings (Chebyshev) that passes `ok`; null when there is none */
function nearestFree(grid: NavGrid, x: number, z: number, ok: (k: number) => boolean, radius: number): number | null {
  const c0 = Math.floor(x), r0 = Math.floor(z);
  for (let rad = 0; rad <= radius; rad++) {
    let best: number | null = null, bestD = Infinity;
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
      const c = c0 + dc, r = r0 + dr, k = r * grid.cols + c;
      if (!isWalkable(grid, c, r) || !ok(k)) continue;
      const d = Math.hypot(c + 0.5 - x, r + 0.5 - z);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best !== null) return best;
  }
  return null;
}

/** Walkable cells connected (4-neighbour) to any of the start cells */
function reachable(grid: NavGrid, starts: number[]): Set<number> {
  const seen = new Set(starts), queue = [...starts];
  while (queue.length) {
    const k = queue.pop()!, c = k % grid.cols, r = Math.floor(k / grid.cols);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr, nk = nr * grid.cols + nc;
      if (!seen.has(nk) && isWalkable(grid, nc, nr)) { seen.add(nk); queue.push(nk); }
    }
  }
  return seen;
}

/**
 * What keeps the robots idle in this layout: empty when at least one robot exists and at least one task type (PICK: shelf → station,
 * REPLENISH: inbound dock → shelf, TRANSPORT: station → outbound dock) has both ends; otherwise the missing pieces, in words.
 */
export function simReadiness(l: WarehouseLayout): string[] {
  const has = (...kinds: string[]) => l.locations.some((x) => kinds.includes(x.kind));
  const shelf = has("SHELF"), station = has("PACKING", "SORTING"), inbound = has("INBOUND"), outbound = has("OUTBOUND");
  const missing: string[] = [];
  if (l.spawn.robots.length === 0) missing.push("a robot");
  if ((shelf && station) || (inbound && shelf) || (station && outbound)) return missing;
  if (!shelf) missing.push(l.racks.length ? "a rack with a free aisle beside it" : "a rack");
  if (!station) missing.push(l.stations.length ? "a packing or sorting station with a free cell in front" : "a packing or sorting station");
  if (!inbound) missing.push("an inbound dock");
  if (!outbound) missing.push("an outbound dock");
  return missing;
}
