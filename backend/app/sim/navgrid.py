"""Build the navigation grid from warehouse_layout.json — Python version of frontend/src/layout/navgrid.ts. The rules must match the frontend exactly."""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .astar import NavGrid


def load_layout(path: str | Path | None = None) -> dict[str, Any]:
    p = Path(path) if path else Path(__file__).resolve().parent.parent / "warehouse_layout.json"
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def build_nav_grid(layout: dict[str, Any], floor: int = 1) -> NavGrid:
    cols, rows, cs = layout["grid"]["cols"], layout["grid"]["rows"], layout["grid"]["cell_size"]
    cells = bytearray(cols * rows)

    def block_lifts() -> None:
        # The lift shaft (steel frame + safety mesh) is a physical obstacle on each floor: normal paths must go around it.
        # Robots enter and exit the lift car only with the micro-move of the lift state machine (not through the grid).
        # round-9g: the shaft 3D shape is W 2.8 x D 3.6. In x, a block of +/-1.4 (3 grid cells) is enough. If z also blocks only +/-1.4,
        # the north and south mesh panels extend 0.4 m into walkable grid cells, and a robot that moves along them cuts into the mesh and corner posts.
        # Thus z blocks +/-1.9 (5 grid cells). The queue cells, the door-axis relay cells, and the exit candidate points are outside this range (same rule as TS).
        for l in layout.get("lifts", []):
            x = l["cell"][0] + 0.5; z = l["cell"][1] + 0.5
            c0 = max(0, math.floor((x - 1.4) / cs)); c1 = min(cols - 1, math.ceil((x + 1.4) / cs) - 1)
            r0 = max(0, math.floor((z - 1.9) / cs)); r1 = min(rows - 1, math.ceil((z + 1.9) / cs) - 1)
            for r in range(r0, r1 + 1):
                base = r * cols
                for c in range(c0, c1 + 1):
                    cells[base + c] = 1

    if floor != 1:
        # Floor 2 (mezzanine): all grid cells outside the footprint are obstacles. Grid cells inside the footprint are walkable, minus the racks on that floor (same rule as TS).
        for i in range(len(cells)):
            cells[i] = 1
        fp = next((f.get("footprint") for f in layout.get("floors", []) if f["id"] == floor), None)
        if fp:
            xs = [p[0] for p in fp]; zs = [p[1] for p in fp]
            c0 = max(0, math.floor(min(xs) / cs)); c1 = min(cols - 1, math.ceil(max(xs) / cs) - 1)
            r0 = max(0, math.floor(min(zs) / cs)); r1 = min(rows - 1, math.ceil(max(zs) / cs) - 1)
            for r in range(r0, r1 + 1):
                base = r * cols
                for c in range(c0, c1 + 1):
                    cells[base + c] = 0
        for rk in layout["racks"]:
            if rk["blocks_grid"] and rk.get("floor", 1) == floor:
                x, _, z = rk["position"]; w, _, d = rk["size"]
                c0 = max(0, math.floor(x / cs)); c1 = min(cols - 1, math.ceil((x + w) / cs) - 1)
                r0 = max(0, math.floor(z / cs)); r1 = min(rows - 1, math.ceil((z + d) / cs) - 1)
                for r in range(r0, r1 + 1):
                    base = r * cols
                    for c in range(c0, c1 + 1):
                        cells[base + c] = 1
        block_lifts()
        return NavGrid(cols=cols, rows=rows, cells=cells)

    def fill_rect(x0: float, z0: float, x1: float, z1: float, v: int) -> None:
        c0 = max(0, math.floor(x0 / cs)); c1 = min(cols - 1, math.ceil(x1 / cs) - 1)
        r0 = max(0, math.floor(z0 / cs)); r1 = min(rows - 1, math.ceil(z1 / cs) - 1)
        for r in range(r0, r1 + 1):
            base = r * cols
            for c in range(c0, c1 + 1):
                cells[base + c] = v

    for w in layout["walkways"]:
        xs = [p[0] for p in w["polygon"]]; zs = [p[1] for p in w["polygon"]]
        fill_rect(min(xs), min(zs), max(xs), max(zs), 2)
    for r in layout["racks"]:
        if r["blocks_grid"] and r.get("floor", 1) == 1:
            x, _, z = r["position"]; w, _, d = r["size"]
            fill_rect(x, z, x + w, z + d, 1)
    for c in layout["conveyors"]:
        if c["blocks_grid"]:
            for i in range(len(c["path"]) - 1):
                (ax, az), (bx, bz) = c["path"][i], c["path"][i + 1]
                hw = c["width"] / 2
                fill_rect(min(ax, bx) - hw, min(az, bz) - hw, max(ax, bx) + hw, max(az, bz) + hw, 1)
    for ra in layout["restricted_areas"]:
        if not ra["robots_allowed"]:
            fill_rect(*ra["rect"], 1)
    for s in layout["stations"]:
        fill_rect(*s["rect"], 1)
    # Mezzanine support columns (they stand on the F1 floor and hold the upper deck): block the 0.9x0.9 m base plate as an obstacle — paths must go around a column, not through it.
    for cx, cz in layout.get("columns", []):
        fill_rect(cx - 0.45, cz - 0.45, cx + 0.45, cz + 0.45, 1)
    # Building structure columns and other physical obstacles (round-9d): block the full area — before, they existed only in the generated 3D scene, the grid did not know them, and robots moved through the columns.
    for o in layout.get("obstacles", []):
        fill_rect(o["rect"][0], o["rect"][1], o["rect"][2], o["rect"][3], 1)
    # Charger cabinets (round-9e): the cabinet is a physical object — after the block, the corridor stays one grid cell south of the parking row, and no robot moves through the cabinet.
    for c in layout["charging_stations"]:
        fill_rect(c["position"][0] - 0.45, c["position"][2] - 0.4, c["position"][0] + 0.45, c["position"][2] + 0.5, 1)
    block_lifts()
    return NavGrid(cols=cols, rows=rows, cells=cells)
