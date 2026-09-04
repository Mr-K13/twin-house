/**
 * Grid A* (8 directions, no corner cuts).
 * - grid.cells: 0 = walkable, 1 = obstacle, 2 = walkway (walkable, but at a higher cost)
 * - blocked: temporary obstacles (grid cells that other robots occupy, blocked Zones, etc.), passed as a set of "c,r" strings
 * - costMap: optional extra cost per grid cell (traffic congestion), length cols*rows
 * Returns the grid cell sequence without the start cell. Returns null when no path exists.
 * Pure function, no random numbers. The same input always gives the same output (the base for What-if reproducibility).
 */
import type { GridCell } from "../schema/twin_state";

export interface NavGrid { cols: number; rows: number; cells: Uint8Array }

const SQRT2 = Math.SQRT2;
const DIRS: Array<[number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

class MinHeap {
  private a: Array<{ k: number; v: number }> = [];
  get size() { return this.a.length; }
  push(k: number, v: number) {
    const a = this.a; a.push({ k, v }); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].k <= a[i].k) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop(): number {
    const a = this.a; const top = a[0].v; const last = a.pop()!;
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].k < a[m].k) m = l; if (r < a.length && a[r].k < a[m].k) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
}

export function cellKey(c: number, r: number) { return `${c},${r}`; }

export function isWalkable(grid: NavGrid, c: number, r: number, blocked?: Set<string>): boolean {
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false;
  if (grid.cells[r * grid.cols + c] === 1) return false;
  if (blocked && blocked.has(cellKey(c, r))) return false;
  return true;
}

export function astar(grid: NavGrid, start: GridCell, goal: GridCell, opts: { blocked?: Set<string>; costMap?: Float32Array; maxExpand?: number } = {}): GridCell[] | null {
  const { cols, rows, cells } = grid;
  const { blocked, costMap, maxExpand = 60000 } = opts;
  const idx = (c: number, r: number) => r * cols + c;
  if (!isWalkable(grid, goal[0], goal[1])) return null; // The goal is a wall (ignore blocked: the goal can be a temporarily occupied grid cell)
  const sIdx = idx(start[0], start[1]), gIdx = idx(goal[0], goal[1]);
  if (sIdx === gIdx) return [];
  const g = new Float64Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const h = (c: number, r: number) => { const dx = Math.abs(c - goal[0]), dz = Math.abs(r - goal[1]); return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz); };
  const open = new MinHeap();
  g[sIdx] = 0; open.push(h(start[0], start[1]), sIdx);
  let expanded = 0;
  while (open.size) {
    const cur = open.pop();
    if (cur === gIdx) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (++expanded > maxExpand) return null;
    const cc = cur % cols, cr = (cur - cc) / cols;
    for (const [dx, dz, base] of DIRS) {
      const nc = cc + dx, nr = cr + dz;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = idx(nc, nr);
      if (closed[ni]) continue;
      const v = cells[ni];
      if (v === 1) continue;
      if (blocked && ni !== gIdx && blocked.has(cellKey(nc, nr))) continue;
      // No corner cuts: for a diagonal move, both adjacent orthogonal grid cells must be walkable
      if (dx !== 0 && dz !== 0) {
        if (!isWalkable(grid, cc + dx, cr, blocked) || !isWalkable(grid, cc, cr + dz, blocked)) continue;
      }
      let cost = base * (v === 2 ? 1.6 : 1);
      if (costMap) cost += costMap[ni];
      const ng = g[cur] + cost;
      if (ng < g[ni]) { g[ni] = ng; came[ni] = cur; open.push(ng + h(nc, nr), ni); }
    }
  }
  if (came[gIdx] === -1) return null;
  const path: GridCell[] = [];
  for (let i = gIdx; i !== sIdx; i = came[i]) { const c = i % cols; path.push([c, (i - c) / cols]); }
  path.reverse();
  return path;
}

/** World coordinates -> grid cell */
export function toCell(x: number, z: number, cellSize = 1): GridCell { return [Math.floor(x / cellSize), Math.floor(z / cellSize)]; }
/** Grid cell center -> world coordinates */
export function cellCenter(c: GridCell, cellSize = 1): [number, number] { return [(c[0] + 0.5) * cellSize, (c[1] + 0.5) * cellSize]; }

/** Find the walkable grid cell nearest to (x,z) (a safeguard for when the access point is on a wall). */
export function nearestWalkable(grid: NavGrid, x: number, z: number, blocked?: Set<string>): GridCell {
  const [c0, r0] = toCell(x, z);
  if (isWalkable(grid, c0, r0, blocked)) return [c0, r0];
  for (let rad = 1; rad < 8; rad++) {
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
      if (isWalkable(grid, c0 + dc, r0 + dr, blocked)) return [c0 + dc, r0 + dr];
    }
  }
  return [c0, r0];
}
