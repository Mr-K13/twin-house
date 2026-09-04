import type { WarehouseLayout } from "./types";

/**
 * Build the navigation grid from the layout. 0 = passable, 1 = obstacle, 2 = walkway (passable but slower).
 * The format guide gives the rules ("navigation grid generation rules"). The backend Python must implement the same rules and use the same layout for comparison tests.
 */
export function buildNavGrid(layout: WarehouseLayout, floor = 1): { cols: number; rows: number; cells: Uint8Array } {
  const { cols, rows, cell_size: cs } = layout.grid;
  const cells = new Uint8Array(cols * rows);
  // The lift shaft (steel frame + safety mesh) is a physical obstacle on every floor: normal paths must go around it.
  // Cab entry and exit use only the microMove of the lift state machine (not the grid).
  // round-9g: the shaft 3D shell is W 2.8 × D 3.6 (Mezzanine LIFT_SHAFT). On the x axis, a block of ±1.4 (3 cells,
  // covers 2.8 + margin on each side) is sufficient. On the z axis, a block of only ±1.4 (3 cells = 3.0 m) lets the north and south mesh each extend
  // 0.4 m into passable cells — a robot that moves along them (half width 0.34, rotation sweep 0.58) cuts into the mesh and corner posts.
  // Thus block z ±1.9 (5 cells). This covers the 3.6 m shaft depth + sweep margin. The queue cells (cell-4-i), the door relay cells,
  // and all exit candidate points (dc −2/−3) stay outside the blocked area and stay passable.
  const blockLifts = () => {
    for (const l of layout.lifts ?? []) {
      const x = l.cell[0] + 0.5, z = l.cell[1] + 0.5;
      const c0 = Math.max(0, Math.floor((x - 1.4) / cs)), c1 = Math.min(cols - 1, Math.ceil((x + 1.4) / cs) - 1);
      const r0 = Math.max(0, Math.floor((z - 1.9) / cs)), r1 = Math.min(rows - 1, Math.ceil((z + 1.9) / cs) - 1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * cols + c] = 1;
    }
  };
  if (floor !== 1) {
    // Floor 2 (mezzanine): outside the footprint there is no floor slab = obstacle; inside the footprint is passable, minus the racks on that floor
    cells.fill(1);
    const fp = layout.floors.find((f) => f.id === floor)?.footprint;
    if (fp) {
      const xs = fp.map((p) => p[0]), zs = fp.map((p) => p[1]);
      const c0 = Math.max(0, Math.floor(Math.min(...xs) / cs)), c1 = Math.min(cols - 1, Math.ceil(Math.max(...xs) / cs) - 1);
      const r0 = Math.max(0, Math.floor(Math.min(...zs) / cs)), r1 = Math.min(rows - 1, Math.ceil(Math.max(...zs) / cs) - 1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * cols + c] = 0;
    }
    for (const r of layout.racks) if (r.blocks_grid && (r.floor ?? 1) === floor) {
      const x0 = r.position[0], z0 = r.position[2], x1 = x0 + r.size[0], z1 = z0 + r.size[2];
      const c0 = Math.max(0, Math.floor(x0 / cs)), c1 = Math.min(cols - 1, Math.ceil(x1 / cs) - 1);
      const r0 = Math.max(0, Math.floor(z0 / cs)), r1 = Math.min(rows - 1, Math.ceil(z1 / cs) - 1);
      for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) cells[rr * cols + cc] = 1;
    }
    blockLifts();
    return { cols, rows, cells };
  }
  const fillRect = (x0: number, z0: number, x1: number, z1: number, v: number) => {
    const c0 = Math.max(0, Math.floor(x0 / cs)), c1 = Math.min(cols - 1, Math.ceil(x1 / cs) - 1);
    const r0 = Math.max(0, Math.floor(z0 / cs)), r1 = Math.min(rows - 1, Math.ceil(z1 / cs) - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * cols + c] = v;
  };
  for (const w of layout.walkways) {
    const xs = w.polygon.map((p) => p[0]), zs = w.polygon.map((p) => p[1]);
    fillRect(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), 2);
  }
  for (const r of layout.racks) if (r.blocks_grid && (r.floor ?? 1) === 1) fillRect(r.position[0], r.position[2], r.position[0] + r.size[0], r.position[2] + r.size[2], 1);
  for (const c of layout.conveyors) if (c.blocks_grid) {
    for (let i = 0; i < c.path.length - 1; i++) {
      const [ax, az] = c.path[i], [bx, bz] = c.path[i + 1], hw = c.width / 2;
      fillRect(Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw, 1);
    }
  }
  for (const ra of layout.restricted_areas) if (!ra.robots_allowed) fillRect(ra.rect[0], ra.rect[1], ra.rect[2], ra.rect[3], 1);
  for (const s of layout.stations) fillRect(s.rect[0], s.rect[1], s.rect[2], s.rect[3], 1);
  // Mezzanine support columns (they stand on the F1 floor and hold the slab): block the 0.9×0.9 m base plate as an obstacle — paths must go around the columns, not through them
  for (const [cx, cz] of layout.columns ?? []) fillRect(cx - 0.45, cz - 0.45, cx + 0.45, cz + 0.45, 1);
  // Building structure columns and other physical obstacles (round-9d): block the full area — before, only the 3D scene generated them, the grid did not know them, and robots went through the columns
  for (const o of layout.obstacles ?? []) fillRect(o.rect[0], o.rect[1], o.rect[2], o.rect[3], 1);
  // Charger cabinet body (round-9e): the cabinet is physical — after the block, the corridor stays one cell south of the parking row, and nothing passes through the cabinet
  for (const c of layout.charging_stations) fillRect(c.position[0] - 0.45, c.position[2] - 0.4, c.position[0] + 0.45, c.position[2] + 0.5, 1);
  blockLifts();
  return { cols, rows, cells };
}
