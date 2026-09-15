import { describe, it, expect } from "vitest";
import { isValidElement } from "react";
import { ASSET_TYPES } from "../src/catalog/assetTypes";
import { ASSET_DEFS, ASSET_TYPE_IDS } from "../src/scenario/assetDefs";
import { SIZE_LIMITS, validateSize, nextInstanceId, clampToWarehouse, wrapRotation, rotateBy, makeInstance, placeOnSurface, footprintCorners, createSaveScheduler, type SchedulerTimer } from "../src/scenario/model";
import { parseRoute, routeHash } from "../src/router";
import type { AssetInstance, AssetTypeId, Scenario } from "../src/scenario/types";

const SIZE = { length: 60, width: 40, height: 10 };
const inst = (id: string, type: AssetTypeId = "rack"): AssetInstance => ({ id, type, position: [0, 0, 0], rotation: 0, params: {} });

describe("scenario size", () => {
  it("accepts the bounds and rejects values outside them", () => {
    expect(validateSize(SIZE)).toEqual([]);
    expect(validateSize({ length: 5, width: 500, height: 3 })).toEqual([]);
    expect(validateSize({ length: 500, width: 5, height: 40 })).toEqual([]);
    expect(validateSize({ length: 4.9, width: 40, height: 10 })).toEqual(["Length must be between 5 and 500 m"]);
    expect(validateSize({ length: 60, width: 501, height: 41 })).toEqual(["Width must be between 5 and 500 m", "Height must be between 3 and 40 m"]);
    expect(validateSize({ length: NaN, width: 40, height: 10 })).toEqual(["Length must be a number"]);
    expect(SIZE_LIMITS.height).toEqual([3, 40]);
  });
});

describe("instance ids", () => {
  it("uses the catalog-style prefix and the first free number per type", () => {
    expect(nextInstanceId("rack", [])).toBe("RACK-01");
    expect(nextInstanceId("rack", [inst("RACK-01"), inst("RACK-03")])).toBe("RACK-02");
    expect(nextInstanceId("robot", [inst("R01", "robot"), inst("R02", "robot")])).toBe("R03");
    expect(nextInstanceId("camera", [inst("RACK-01")])).toBe("CAM-01");
    expect(nextInstanceId("worker", [])).toBe("W-01");
    expect(nextInstanceId("forklift", [])).toBe("FL-01");
  });
});

describe("placement", () => {
  it("clamps every axis to the warehouse box", () => {
    expect(clampToWarehouse([-1, -2, -3], SIZE)).toEqual([0, 0, 0]);
    expect(clampToWarehouse([61, 11, 41], SIZE)).toEqual([60, 10, 40]);
    expect(clampToWarehouse([12.5, 6, 7.25], SIZE)).toEqual([12.5, 6, 7.25]);
  });
  it("makeInstance clones the defaults, starts at rotation 0 and lifts cameras to their mount height", () => {
    const r = makeInstance("rack", [10, 0, 5], []);
    expect(r).toMatchObject({ id: "RACK-01", type: "rack", position: [10, 0, 5], rotation: 0, params: { length: 8, height: 6, depth: 1.2, levels: 4 } });
    r.params.length = 99;
    expect(ASSET_DEFS.rack.defaults.length).toBe(8);
    expect(makeInstance("camera", [3, 0, 3], []).position).toEqual([3, 5, 3]);
    expect(makeInstance("sensor", [3, 6, 3], []).position).toEqual([3, 6, 3]);   // a snap type keeps the surface height it was given
  });
  it("placeOnSurface snaps to the hit point, keeps the camera mount height, and clamps to the warehouse", () => {
    expect(placeOnSurface("sensor", [20, 6, 10], SIZE, []).position).toEqual([20, 6, 10]);
    expect(placeOnSurface("camera", [20, 0, 10], SIZE, []).position).toEqual([20, 5, 10]);
    expect(placeOnSurface("robot", [-5, 0, 45], SIZE, []).position).toEqual([0, 0, 40]);
    expect(placeOnSurface("camera", [1, 0, 1], { ...SIZE, height: 4 }, []).position[1]).toBe(4);
    const second = placeOnSurface("rack", [1, 0, 1], SIZE, [inst("RACK-01")]);
    expect(second.id).toBe("RACK-02");
  });
});

describe("rotation", () => {
  it("wraps into [0, 2π)", () => {
    expect(wrapRotation(0)).toBe(0);
    expect(wrapRotation(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2);
    expect(wrapRotation(2 * Math.PI)).toBe(0);
    expect(wrapRotation(5 * Math.PI)).toBeCloseTo(Math.PI);
    expect(rotateBy(0, -(15 * Math.PI) / 180)).toBeCloseTo((345 * Math.PI) / 180);
    expect(rotateBy((350 * Math.PI) / 180, (15 * Math.PI) / 180)).toBeCloseTo((5 * Math.PI) / 180);
  });
});

describe("footprintCorners", () => {
  const extents = (pts: Array<[number, number]>) => { const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]); return { x: Math.max(...xs) - Math.min(...xs), z: Math.max(...zs) - Math.min(...zs) }; };
  it("matches the footprint at rotation 0 and swaps extents at 90°", () => {
    const rack = makeInstance("rack", [20, 0, 10], []);
    const { w, d } = ASSET_DEFS.rack.footprint(rack.params);
    const e0 = extents(footprintCorners(rack, ASSET_DEFS.rack));
    expect(e0.x).toBeCloseTo(w); expect(e0.z).toBeCloseTo(d);
    const turned = { ...rack, rotation: Math.PI / 2 };
    const e = extents(footprintCorners(turned, ASSET_DEFS.rack));
    expect(e.x).toBeCloseTo(d); expect(e.z).toBeCloseTo(w);
  });
  it("follows the three.js rotation-y convention: +x turns towards −z for a positive yaw", () => {
    const c = { ...makeInstance("conveyor", [0, 0, 0], []), rotation: Math.PI / 2 };
    const pts = footprintCorners(c, ASSET_DEFS.conveyor);
    const L = ASSET_DEFS.conveyor.footprint(c.params).w;
    // the corner that was at (+L/2, −d/2) is now at z = −L/2
    expect(pts[1][1]).toBeCloseTo(-L / 2); expect(Math.abs(pts[1][0])).toBeLessThan(1);
  });
});

describe("save scheduler", () => {
  function fakeTimer() {
    let seq = 0; const timers = new Map<number, () => void>();
    const timer: SchedulerTimer = { set: (fn) => { const h = ++seq; timers.set(h, fn); return h; }, clear: (h) => { timers.delete(h as number); } };
    return { timer, fire: () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((f) => f()); }, armed: () => timers.size };
  }
  const doc = (n: number) => ({ id: "sc-1", name: `v${n}` }) as unknown as Scenario;
  it("coalesces several schedules into one save of the latest document", async () => {
    const saved: string[] = []; const t = fakeTimer();
    const s = createSaveScheduler<Scenario>(async (d) => { saved.push(d.name); }, 800, t.timer);
    s.schedule(doc(1)); s.schedule(doc(2)); s.schedule(doc(3));
    expect(t.armed()).toBe(1); expect(s.pending()).toBe(true); expect(saved).toEqual([]);
    t.fire(); await Promise.resolve();
    expect(saved).toEqual(["v3"]); expect(s.pending()).toBe(false); expect(t.armed()).toBe(0);
  });
  it("flush saves immediately with the given options and clears the pending document", async () => {
    const calls: Array<[string, boolean | undefined]> = []; const t = fakeTimer();
    const s = createSaveScheduler<Scenario>(async (d, o) => { calls.push([d.name, o.keepalive]); }, 800, t.timer);
    s.schedule(doc(1));
    await s.flush({ keepalive: true });
    expect(calls).toEqual([["v1", true]]); expect(s.pending()).toBe(false); expect(t.armed()).toBe(0);
    await s.flush();                                   // nothing pending: resolves without saving again
    expect(calls.length).toBe(1);
  });
  it("never overlaps saves: the next one waits for the one in flight", async () => {
    const order: string[] = []; const t = fakeTimer();
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const s = createSaveScheduler<Scenario>(async (d) => { order.push(`start ${d.name}`); if (d.name === "v1") await gate; order.push(`end ${d.name}`); }, 800, t.timer);
    s.schedule(doc(1)); const first = s.flush();
    s.schedule(doc(2)); const second = s.flush();
    await Promise.resolve();
    expect(order).toEqual(["start v1"]);
    release(); await first; await second;
    expect(order).toEqual(["start v1", "end v1", "start v2", "end v2"]);
  });
  it("keeps a failed document pending and retries it on the next flush, unless a newer one arrived", async () => {
    const saved: string[] = []; let fail = true; const t = fakeTimer();
    const s = createSaveScheduler<Scenario>(async (d) => { if (fail) throw new Error("backend unreachable"); saved.push(d.name); }, 800, t.timer);
    s.schedule(doc(1));
    await expect(s.flush()).rejects.toThrow("backend unreachable");
    expect(s.pending()).toBe(true);                    // nothing was lost
    fail = false;
    await s.flush();
    expect(saved).toEqual(["v1"]); expect(s.pending()).toBe(false);
    await s.flush();                                   // a settled chain does not replay the old failure
    fail = true; s.schedule(doc(2)); const failing = s.flush(); s.schedule(doc(3));
    await expect(failing).rejects.toThrow();
    fail = false; await s.flush();
    expect(saved).toEqual(["v1", "v3"]);               // the newer document wins over the failed one
  });
  it("cancel drops the pending document", () => {
    const t = fakeTimer(); const s = createSaveScheduler<Scenario>(async () => {}, 800, t.timer);
    s.schedule(doc(1)); s.cancel();
    expect(s.pending()).toBe(false); expect(t.armed()).toBe(0);
  });
});

describe("hash router", () => {
  it("parses every route and falls back to the console for junk", () => {
    expect(parseRoute("")).toEqual({ page: "console" });
    expect(parseRoute("#/")).toEqual({ page: "console" });
    expect(parseRoute("#/scenarios")).toEqual({ page: "scenarios" });
    expect(parseRoute("#/scenarios/")).toEqual({ page: "scenarios" });
    expect(parseRoute("#/workspace/sc-0123456789ab")).toEqual({ page: "workspace", id: "sc-0123456789ab" });
    expect(parseRoute("#/workspace/a%20b")).toEqual({ page: "workspace", id: "a b" });
    expect(parseRoute("#/workspace/")).toEqual({ page: "console" });
    expect(parseRoute("#/workspace/a/b")).toEqual({ page: "console" });
    expect(parseRoute("#/nope")).toEqual({ page: "console" });
    expect(parseRoute("#/workspace/%E0%A4%A")).toEqual({ page: "console" });
  });
  it("round-trips through routeHash", () => {
    for (const r of [{ page: "console" }, { page: "scenarios" }, { page: "workspace", id: "sc-1" }, { page: "workspace", id: "a b/c" }] as const) expect(parseRoute(routeHash(r))).toEqual(r);
  });
});

describe("asset editor definitions ↔ catalog contract", () => {
  it("every catalog type has an editor definition and vice versa, in catalog order", () => {
    expect([...ASSET_TYPE_IDS]).toEqual(ASSET_TYPES.map((t) => t.id));
    expect(Object.keys(ASSET_DEFS).sort()).toEqual(ASSET_TYPES.map((t) => t.id).sort());
  });
  it("toLayoutRow carries every required catalog field and the catalog label", () => {
    for (const t of ASSET_TYPES) {
      const def = ASSET_DEFS[t.id as AssetTypeId];
      expect(def.label).toBe(t.label); expect(def.description).toBe(t.description);
      const row = def.toLayoutRow(makeInstance(def.type, [0, 0, 0], [])) as Record<string, unknown>;
      for (const f of t.fields.filter((x) => !x.optional)) expect(f.name in row, `${t.id}.${f.name}`).toBe(true);
    }
  });
  it("footprint and height are positive, only the camera is free-height, and render returns an element", () => {
    for (const type of ASSET_TYPE_IDS) {
      const def = ASSET_DEFS[type];
      const i = makeInstance(type, [1, 0, 1], []);
      const { w, d } = def.footprint(i.params);
      expect(w, type).toBeGreaterThan(0); expect(d, type).toBeGreaterThan(0); expect(def.height(i.params), type).toBeGreaterThan(0);
      expect(def.surface).toBe(type === "camera" ? "free" : "snap");
      expect(def.color).toMatch(/^#[0-9a-f]{6}$/i);
      for (const f of def.paramSchema) expect(f.key in def.defaults, `${type}.${f.key}`).toBe(true);
      expect(isValidElement(def.render(def.toLayoutRow(i), i, { onSelect: () => {} })), type).toBe(true);
    }
    expect(ASSET_TYPE_IDS.filter((t) => ASSET_DEFS[t].stackable)).toEqual(["rack", "conveyor"]);
  });
  it("layout rows are centred on the origin", () => {
    const rack = ASSET_DEFS.rack.toLayoutRow(makeInstance("rack", [0, 0, 0], [])) as { position: number[]; size: number[] };
    expect(rack.position[0] + rack.size[0] / 2).toBeCloseTo(0); expect(rack.position[2] + rack.size[2] / 2).toBeCloseTo(0);
    const st = ASSET_DEFS.station.toLayoutRow(makeInstance("station", [0, 0, 0], [])) as { rect: number[] };
    expect(st.rect[0] + st.rect[2]).toBeCloseTo(0); expect(st.rect[1] + st.rect[3]).toBeCloseTo(0);
    const cv = ASSET_DEFS.conveyor.toLayoutRow(makeInstance("conveyor", [0, 0, 0], [])) as { path: number[][] };
    expect(cv.path[0][0] + cv.path[1][0]).toBeCloseTo(0);
  });
});
