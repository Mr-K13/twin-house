import { describe, it, expect } from "vitest";
import { projectLayout, simReadiness } from "../src/scenario/projectLayout";
import { makeInstance } from "../src/scenario/model";
import { buildNavGrid } from "../src/layout/navgrid";
import { toCell } from "../src/simulation/astar";
import { SimEngine } from "../src/simulation/engine";
import type { P3 } from "../src/layout/types";
import type { AssetInstance, AssetTypeId, Scenario } from "../src/scenario/types";

/** A twin built the way the workspace builds one: makeInstance defaults, then an optional yaw / params */
function twin(items: Array<[AssetTypeId, P3, number?, Record<string, string | number>?]>): Scenario {
  const instances: AssetInstance[] = [];
  for (const [type, pos, rotation = 0, params = {}] of items) {
    const i = makeInstance(type, pos, instances);
    instances.push({ ...i, rotation, params: { ...i.params, ...params } });
  }
  return { id: "sc-test", name: "Test twin", size: { length: 60, width: 40, height: 10 }, instances, created_at: "", updated_at: "" };
}

const FULL = twin([
  ["rack", [15, 0, 12]],
  ["rack", [30, 0, 22], Math.PI / 2],
  ["robot", [5, 0, 20]],
  ["robot", [5, 0, 20]],                        // same spot: the projection spreads the spawns over free cells
  ["station", [48, 0, 32], 0, { kind: "PACKING" }],
  ["charging", [5, 0, 35]],
  ["dock", [20, 0, 2], 0, { kind: "INBOUND" }],
  ["dock", [40, 0, 2], 0, { kind: "OUTBOUND" }],
  ["camera", [30, 5, 30], Math.PI / 2],
  ["worker", [55, 0, 5]],
]);

describe("twin → layout projection", () => {
  const l = projectLayout(FULL);
  const grid = buildNavGrid(l, 1);
  const free = ([x, z]: [number, number]) => { const [c, r] = toCell(x, z); return c >= 0 && r >= 0 && c < grid.cols && r < grid.rows && grid.cells[r * grid.cols + c] !== 1; };

  it("sizes the frame from the twin and has one floor and one zone", () => {
    expect(l.size).toEqual({ width: 60, depth: 40, height: 10 });
    expect(l.grid).toEqual({ cell_size: 1, cols: 60, rows: 40 });
    expect(l.floors.map((f) => f.id)).toEqual([1]);
    expect(l.zones).toHaveLength(1);
  });
  it("places racks axis-aligned, swapping the extents of a rack turned 90°", () => {
    const [a, b] = l.racks;
    expect(a.position).toEqual([11, 0, 11.4]);
    expect(a.size).toEqual([8, 6, 1.2]);
    expect(b.size).toEqual([1.2, 6, 8]);
    expect([b.position[0], b.position[2]]).toEqual([29.4, 18]);
  });
  it("generates every task pool, with each access point and spawn on a free cell", () => {
    const kinds = new Set(l.locations.map((x) => x.kind));
    for (const k of ["SHELF", "PACKING", "INBOUND", "OUTBOUND", "CHARGING"]) expect(kinds.has(k), k).toBe(true);
    for (const x of l.locations) expect(free(x.access_point), x.id).toBe(true);
    expect(l.locations.filter((x) => x.rack_id === l.racks[0].id).length).toBeGreaterThanOrEqual(2);
    const spawns = l.spawn.robots.map((r) => `${r.position[0]},${r.position[2]}`);
    expect(new Set(spawns).size).toBe(2);
    for (const r of l.spawn.robots) expect(free([r.position[0], r.position[2]]), r.id).toBe(true);
    expect(simReadiness(l)).toEqual([]);
  });
  it("keeps decorative people and turns camera look-at points with the yaw", () => {
    expect(l.static_people?.map((p) => p.kind)).toEqual(["WORKER"]);
    const cam = l.cameras[0];
    expect(cam.position).toEqual([30, 5, 30]);
    expect(Math.abs(cam.look_at[0] - 30)).toBeLessThan(1e-6);   // looks along −z after a 90° turn of its +x view
    expect(cam.look_at[2]).toBeLessThan(30);
  });
  it("lists what keeps the robots idle", () => {
    expect(simReadiness(projectLayout(twin([["rack", [15, 0, 12]]])))).toEqual(["a robot", "a packing or sorting station", "an inbound dock", "an outbound dock"]);
    expect(simReadiness(projectLayout(twin([["robot", [5, 0, 5]], ["rack", [15, 0, 12]], ["station", [40, 0, 30]]])))).toEqual([]);
  });
});

describe("simulating a projected twin", () => {
  it("generates and completes tasks", () => {
    const eng = new SimEngine(projectLayout(FULL), { seed: 3 });
    for (let t = 0; t < 4000; t++) eng.step();
    expect(eng.state.kpi.operation.completed_today).toBeGreaterThan(0);
  });
  it("idles instead of throwing when a twin has no task pools", () => {
    const eng = new SimEngine(projectLayout(twin([["robot", [5, 0, 5]]])), { seed: 1 });
    for (let t = 0; t < 1000; t++) eng.step();
    expect(Object.keys(eng.state.tasks)).toHaveLength(0);
  });
});
