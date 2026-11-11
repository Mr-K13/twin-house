import { describe, it, expect } from "vitest";
import { placeLabels, type Box, type LabelItem } from "../src/components/ui/labelPlacement";

const overlaps = (a: Box, b: Box) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
const R = 1.1;
const bounds = { x0: -2, y0: -7, x1: 102, y1: 73 };
const label = (id: string, x: number, y: number): LabelItem => ({ id, x, y, w: 3 * 1.8 * 0.6 + 0.5, h: 1.8 * 1.15 });

describe("placeLabels", () => {
  it("keeps a lone label at its home spot, centred above the marker", () => {
    const out = placeLabels([label("R17", 14, 47)], { markR: R, gap: 0.3, bounds });
    const l = out.get("R17")!;
    expect(l.slot).toBe(0);
    expect(l.leader).toBe(false);
    expect(l.cx).toBe(14);
    expect(l.box.y1).toBeLessThanOrEqual(47 - R);
  });

  it("separates the Main Warehouse parking rows (2 m grid, labels wider than the spacing)", () => {
    const items: LabelItem[] = [];
    for (let i = 0; i < 10; i++) items.push(label(`R${String(i + 1).padStart(2, "0")}`, 40 + i * 2, 64));
    for (let i = 0; i < 6; i++) items.push(label(`R${11 + i}`, 40 + i * 2, 66));
    const out = placeLabels(items, { markR: R, gap: 0.3, bounds });
    const boxes = items.map((it) => out.get(it.id)!.box);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j]), `${items[i].id} / ${items[j].id}`).toBe(false);
      for (const m of items) expect(overlaps(boxes[i], { x0: m.x - R, y0: m.y - R, x1: m.x + R, y1: m.y + R }), `${items[i].id} covers ${m.id}`).toBe(false);
    }
    // A leader line runs straight from its marker to its label and crosses no other label or marker
    for (const it of items) {
      const l = out.get(it.id)!;
      if (!l.leader) continue;
      const above = l.cy < it.y;
      const lead = { x0: it.x - 0.01, x1: it.x + 0.01, y0: above ? l.box.y1 : it.y + R, y1: above ? it.y - R : l.box.y0 };
      for (const o of items) {
        if (o.id === it.id) continue;
        expect(overlaps(lead, out.get(o.id)!.box), `${it.id} leader crosses ${o.id} label`).toBe(false);
        expect(overlaps(lead, { x0: o.x - R, y0: o.y - R, x1: o.x + R, y1: o.y + R }), `${it.id} leader crosses ${o.id}`).toBe(false);
      }
    }
  });

  it("keeps a displaced label in its previous spot while that spot stays free", () => {
    const items = [label("A", 10, 10), label("B", 12, 10)];
    const first = placeLabels(items, { markR: R, gap: 0.3, bounds });
    const slotB = first.get("B")!.slot;
    expect(slotB).toBeGreaterThan(0);
    const again = placeLabels(items, { markR: R, gap: 0.3, bounds, previous: new Map([["B", slotB]]) });
    expect(again.get("B")!.slot).toBe(slotB);
  });

  it("gives the priority label its home spot", () => {
    const out = placeLabels([label("A", 10, 10), { ...label("B", 12, 10), priority: true }], { markR: R, gap: 0.3, bounds });
    expect(out.get("B")!.slot).toBe(0);
    expect(out.get("A")!.slot).toBeGreaterThan(0);
  });
});
