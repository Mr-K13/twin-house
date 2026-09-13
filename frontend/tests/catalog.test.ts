import { describe, it, expect } from "vitest";
import { ASSET_TYPES, countBy } from "../src/catalog/assetTypes";
import { PREVIEWS } from "../src/components/ops/CatalogPreview";

describe("asset catalog", () => {
  it("ids are unique and non-empty", () => {
    const ids = ASSET_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toBeTruthy();
  });
  it("every type resolves to a non-empty instance list with one row per instance", () => {
    for (const t of ASSET_TYPES) { expect(t.instances.length, t.id).toBeGreaterThan(0); expect(t.rows.length, t.id).toBe(t.instances.length); }
  });
  it("every schema field exists on at least one instance", () => {
    for (const t of ASSET_TYPES) for (const f of t.fields) expect(t.instances.some((o) => f.name in o), `${t.id}.${f.name}`).toBe(true);
  });
  it("required (non-optional) fields exist on every instance", () => {
    for (const t of ASSET_TYPES) for (const f of t.fields.filter((x) => !x.optional)) expect(t.instances.every((o) => f.name in o), `${t.id}.${f.name}`).toBe(true);
  });
  it("row cells cover every column and row ids are unique per type", () => {
    for (const t of ASSET_TYPES) {
      expect(new Set(t.rows.map((r) => r.id)).size, t.id).toBe(t.rows.length);
      for (const r of t.rows) for (const c of t.columns) expect(r.cells, `${t.id}.${c.key}`).toHaveProperty(c.key);
    }
  });
  it("characteristics have a label, a value and a source", () => {
    for (const t of ASSET_TYPES) for (const c of t.characteristics) { expect(c.label, t.id).toBeTruthy(); expect(c.value, `${t.id}: ${c.label}`).not.toBe(""); expect(c.source, `${t.id}: ${c.label}`).toBeTruthy(); }
  });
  it("every type has a 3D preview that frames its first instance", () => {
    for (const t of ASSET_TYPES) {
      const p = PREVIEWS[t.id]; expect(p, t.id).toBeDefined();
      const o = t.instances[0] as never;
      expect(p.center(o).length).toBe(3); expect(p.dist(o), t.id).toBeGreaterThan(0); expect(p.render(o), t.id).toBeTruthy();
    }
  });
  it("countBy groups and sorts by count desc", () => {
    expect(countBy([1, 2, 2, 3, 3, 3], (x) => x)).toEqual([{ value: "3", n: 3 }, { value: "2", n: 2 }, { value: "1", n: 1 }]);
  });
  it("rack variants match the bundled layout", () => {
    const rack = ASSET_TYPES.find((t) => t.id === "rack")!;
    expect(rack.variants.find((v) => v.label === "levels")!.counts).toEqual([{ value: "4", n: 160 }, { value: "3", n: 24 }]);
  });
});
