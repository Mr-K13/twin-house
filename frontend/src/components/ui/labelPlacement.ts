/**
 * Greedy collision-free label placement for point markers (robot labels on the 2D map and in the 3D view). Units are whatever the caller
 * uses (SVG metres or screen pixels) with y growing downwards. Each label tries a ring of positions around its marker, then tiers further
 * above / below (drawn with a leader line), and takes the first one that overlaps no placed label, no marker, no obstacle, and stays in bounds.
 * A leader line's corridor counts as occupied too: it may not cross another label or marker, and later labels may not sit on it.
 * When nothing fits it takes the candidate with the least overlap. `previous` keeps a displaced label where it was while that spot stays
 * free (unless its home spot is free again), so labels do not hop between positions as robots move or the camera orbits.
 */
export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface LabelItem { id: string; x: number; y: number; w: number; h: number; priority?: boolean }
/** Label centre, its box, the candidate index (feed back as `previous`), and whether it sits far enough away to need a leader line */
export interface Placement { cx: number; cy: number; box: Box; slot: number; leader: boolean }
export interface PlaceOptions {
  /** Half-size of the square each marker occupies */
  markR: number;
  /** Clearance between a label and its marker, and between stacked tiers */
  gap: number;
  /** Number of far tiers tried above and below the marker */
  tiers?: number;
  bounds?: Box;
  obstacles?: readonly Box[];
  previous?: ReadonlyMap<string, number>;
}

const boxAt = (cx: number, cy: number, w: number, h: number): Box => ({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 });
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const inside = (a: Box, b: Box) => a.x0 >= b.x0 && a.y0 >= b.y0 && a.x1 <= b.x1 && a.y1 <= b.y1;

/** Candidate centres in preference order: N, NE, NW, E, W, S, SE, SW, then N / S tiers 1..tiers (leader line) */
function candidates(it: LabelItem, r: number, g: number, tiers: number): Array<{ cx: number; cy: number; leader: boolean }> {
  const { x, y, w, h } = it;
  const d = r * 0.7 + g;
  const north = y - r - g - h / 2, south = y + r + g + h / 2;
  const out = [
    { cx: x, cy: north }, { cx: x + d + w / 2, cy: y - d - h / 2 }, { cx: x - d - w / 2, cy: y - d - h / 2 },
    { cx: x + r + g + w / 2, cy: y }, { cx: x - r - g - w / 2, cy: y },
    { cx: x, cy: south }, { cx: x + d + w / 2, cy: y + d + h / 2 }, { cx: x - d - w / 2, cy: y + d + h / 2 },
  ].map((c) => ({ ...c, leader: false }));
  for (let k = 1; k <= tiers; k++) out.push({ cx: x, cy: north - k * (h + g), leader: true }, { cx: x, cy: south + k * (h + g), leader: true });
  return out;
}

export function placeLabels(items: readonly LabelItem[], o: PlaceOptions): Map<string, Placement> {
  const { markR: r, gap: g, tiers = 3, bounds, obstacles = [], previous } = o;
  const marks = new Map(items.map((it) => [it.id, { x0: it.x - r, y0: it.y - r, x1: it.x + r, y1: it.y + r }]));
  const fixed = [...marks.values(), ...obstacles];
  const placed: Box[] = [];
  const out = new Map<string, Placement>();
  const order = [...items].sort((a, b) => Number(!!b.priority) - Number(!!a.priority));
  for (const it of order) {
    const cands = candidates(it, r, g, tiers);
    const prev = previous?.get(it.id);
    // Home first (so a label that left a cluster returns next to its marker), then the previous spot, then the rest
    const tryOrder = prev !== undefined && prev > 0 && prev < cands.length ? [0, prev, ...cands.keys()] : [...cands.keys()];
    const own = marks.get(it.id)!;
    let best: { slot: number; box: Box; lead: Box | null; cost: number } | null = null;
    for (const slot of tryOrder) {
      const c = cands[slot];
      const box = boxAt(c.cx, c.cy, it.w, it.h);
      // Vertical corridor from the marker edge to the label edge, about a line's width (a third of the gap)
      const lw = g / 6;
      const lead = c.leader ? (c.cy < it.y ? { x0: it.x - lw, y0: box.y1, x1: it.x + lw, y1: it.y - r } : { x0: it.x - lw, y0: it.y + r, x1: it.x + lw, y1: box.y0 }) : null;
      // Out-of-bounds candidates only win when every in-bounds one collides
      let cost = bounds && !inside(box, bounds) ? 1e9 : 0;
      for (const b of placed) cost += overlap(box, b) + (lead ? overlap(lead, b) : 0);
      for (const b of fixed) cost += overlap(box, b) + (lead && b !== own ? overlap(lead, b) : 0);
      if (cost === 0) { best = { slot, box, lead, cost }; break; }
      if (!best || cost < best.cost) best = { slot, box, lead, cost };
    }
    const c = cands[best!.slot];
    placed.push(best!.box);
    if (best!.lead) placed.push(best!.lead);
    out.set(it.id, { cx: c.cx, cy: c.cy, box: best!.box, slot: best!.slot, leader: c.leader });
  }
  return out;
}
