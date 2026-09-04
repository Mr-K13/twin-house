"""
Generate the warehouse_layout.json example.
Run: python gen_layout.py > warehouse_layout.json
Coordinates: x 0..100 (long side), z 0..70 (short side), in meters. z=0 is the "top" (the Inbound/Outbound dock side).
"""
import json

W, D = 100, 70
CELL = 1.0
F2_ELEV = 8.0            # Floor height of floor 2 (mezzanine)
F2 = (8, 40, 54, 62)     # Floor 2 footprint (x0, z0, x1, z1): above Zone C; the east side connects to the lifts in the central aisle

layout = {
    "schema_version": "1.0",
    "id": "wh-main-v1",
    "name": "Main Warehouse (100x70m)",
    "units": "m",
    "size": {"width": W, "depth": D, "height": 16},
    "floors": [
        {"id": 1, "name": "Floor 1", "elevation": 0.0},
        {"id": 2, "name": "Floor 2 · Mezzanine", "elevation": F2_ELEV,
         "footprint": [[F2[0], F2[1]], [F2[2], F2[1]], [F2[2], F2[3]], [F2[0], F2[3]]]},
    ],
    # Mezzanine support columns (§4.4): they stand on the F1 floor and hold the slab — the F1 navigation grid blocks the column base (0.9×0.9 base plate) as an obstacle
    "columns": [[10, 41.5], [22, 41.5], [34, 41.5], [46, 41.5],
                [10, 60.5], [22, 60.5], [34, 60.5], [46, 60.5],
                [10, 51], [46, 51]],
    "lifts": [],
    "grid": {"cell_size": CELL, "cols": int(W / CELL), "rows": int(D / CELL)},
    "zones": [],
    "docks": [],
    "racks": [],
    "conveyors": [],
    "stations": [],
    "charging_stations": [],
    "parking": [],
    "restricted_areas": [],
    "walkways": [],
    "cameras": [],
    "sensors": [],
    "locations": [],
    "obstacles": [   # Building structure columns (round-9d): the perimeter follows the walls; two internal columns fit into rack-row gaps (the generated (25,35)/(75,35) fell on conveyors and (50,35) fell in the central aisle — now corrected; the central aisle uses a long-span truss with no columns
        {"id": f"PILLAR-{i+1:02d}", "kind": "PILLAR", "rect": [round(x-0.25,2), round(z-0.25,2), round(x+0.25,2), round(z+0.25,2)]}
        for i, (x, z) in enumerate([(x, z) for x in range(0, 101, 25) for z in (0, 70)] + [(0, 35), (100, 35), (23.7, 29.2), (73.7, 29.2)])
    ],
    "spawn": {"robots": []},
}

# ── Zones: four quadrants; keep the central aisle (x 46..54) and the central conveyor corridor (z 32..38)
zones = {
    "A": (4, 10, 46, 32, "#3b82f6"),
    "B": (54, 10, 96, 32, "#a855f7"),
    "C": (4, 38, 46, 62, "#22c55e"),
    "D": (54, 38, 96, 62, "#f59e0b"),
}
for zid, (x0, z0, x1, z1, color) in zones.items():
    layout["zones"].append({
        "id": zid, "name": f"Zone {zid}", "color": color, "floor": 1,
        "polygon": [[x0, z0], [x1, z0], [x1, z1], [x0, z1]],
    })
# Floor 2 is one zone for the full floor
layout["zones"].append({
    "id": "M", "name": "Zone M (Mezzanine)", "color": "#14b8a6", "floor": 2,
    "polygon": [[F2[0], F2[1]], [F2[2], F2[1]], [F2[2], F2[3]], [F2[0], F2[3]]],
})

# ── Docks (top)
layout["docks"] = [
    {"id": "INBOUND-1", "kind": "INBOUND", "zone": "A", "rect": [20, 0, 32, 8], "door": [26, 0]},
    {"id": "INBOUND-2", "kind": "INBOUND", "zone": "A", "rect": [34, 0, 46, 8], "door": [40, 0]},
    {"id": "OUTBOUND-1", "kind": "OUTBOUND", "zone": "B", "rect": [54, 0, 66, 8], "door": [60, 0]},
    {"id": "OUTBOUND-2", "kind": "OUTBOUND", "zone": "B", "rect": [68, 0, 80, 8], "door": [74, 0]},
]

# ── Racks: 4 rows of double-sided racks per zone, 10 bays per row, 4 m aisles
rack_len, rack_depth, aisle = 3.0, 1.2, 4.0
loc_id_counter = {}
for zid, (x0, z0, x1, z1, _) in zones.items():
    n_rows = 4
    for r in range(n_rows):
        z = z0 + 3 + r * (rack_depth + aisle)
        for b in range(10):
            x = x0 + 2 + b * (rack_len + 0.6)
            rid = f"RACK-{zid}{r+1:d}{b+1:02d}"
            layout["racks"].append({
                "id": rid, "zone": zid,
                "position": [x, 0, z], "size": [rack_len, 6.0, rack_depth],
                "rotation": 0, "levels": 4, "model": "rack_double",
                "blocks_grid": True, "floor": 1,
            })
            # One accessible position (shelf location) on each side of each bay, for use as task source/destination
            for side, dz in (("N", -1.0), ("S", rack_depth + 1.0)):
                n = loc_id_counter.get(zid, 0) + 1
                loc_id_counter[zid] = n
                layout["locations"].append({
                    "id": f"SHELF-{zid}{n:02d}", "kind": "SHELF", "zone": zid, "floor": 1,
                    "rack_id": rid, "level_range": [1, 4],
                    "access_point": [round(x + rack_len / 2, 1), round(z + dz, 1)],
                })

# ── Floor 2 (mezzanine): 3 rack rows × 8 bays, 4 m aisles; the lifts on the east side connect to the central aisle
m_n = 0
for r in range(3):
    z = F2[1] + 4 + r * (rack_depth + aisle)
    for b in range(8):
        x = F2[0] + 3 + b * (rack_len + 0.6)
        rid = f"RACK-M{r+1}{b+1:02d}"
        layout["racks"].append({
            "id": rid, "zone": "M", "position": [x, 0, z], "size": [rack_len, 5.0, rack_depth],
            "rotation": 0, "levels": 3, "model": "rack_double", "blocks_grid": True, "floor": 2,
        })
        for side, dz in (("N", -1.0), ("S", rack_depth + 1.0)):
            m_n += 1
            layout["locations"].append({
                "id": f"SHELF-M{m_n:02d}", "kind": "SHELF", "zone": "M", "floor": 2,
                "rack_id": rid, "level_range": [1, 3],
                "access_point": [round(x + rack_len / 2, 1), round(z + dz, 1)],
            })

# ── Lifts (freight lifts): two, in the central aisle (passable on floor 1) and inside the floor 2 footprint
layout["lifts"] = [
    {"id": "LIFT-1", "cell": [51, 44], "floors": [1, 2], "ride_ticks": 60},
    {"id": "LIFT-2", "cell": [51, 56], "floors": [1, 2], "ride_ticks": 60},
]

# ── Conveyors: two central horizontal belts + one vertical belt on each side (round-9f):
#    The vertical belts sit at the walls, x=1.4 / 98.6 — the belt body blocks cells up to the wall, the narrow 1–2 cell lane at the wall disappears, and robots always use the inner 4–6 m lane;
#    The horizontal belts shorten to x 10–46 / 54–90 — a 5 m crossing gap stays outside the end equipment on each side (cols 3–7 / 92–96),
#    so traffic across z=35 spreads to west/center/east and does not all crowd into the central aisle at the lift lobby (that causes ALIGHTING starvation)
layout["conveyors"] = [
    {"id": "CV01", "name": "Conveyor #01", "zone": "A",
     "path": [[10, 35], [46, 35]], "width": 1.0, "speed_mps": 0.6, "direction": "FORWARD", "blocks_grid": True, "feeds": "PACK-02"},
    {"id": "CV02", "name": "Conveyor #02", "zone": "B",
     "path": [[54, 35], [90, 35]], "width": 1.0, "speed_mps": 0.6, "direction": "FORWARD", "blocks_grid": True, "feeds": "SORT-01"},
    {"id": "CV03", "name": "Conveyor #03", "zone": "D",
     "path": [[98.6, 35], [98.6, 60]], "width": 1.0, "speed_mps": 0.6, "direction": "FORWARD", "blocks_grid": True, "feeds": "PACK-01"},
    {"id": "CV04", "name": "Conveyor #04", "zone": "C",
     "path": [[1.4, 35], [1.4, 60]], "width": 1.0, "speed_mps": 0.6, "direction": "FORWARD", "blocks_grid": True, },
]

# ── Conveyor end equipment (round-9f): the physical footprint (±1.5 m) of the feed hopper / receiving machine goes into obstacles —
#    3D is visual only (Fixtures endEquip is placed at the path ends); the grid must block the same cells so that robots do not collide.
#    End points are de-duplicated (the west/east L corners share one machine). Single data source: derived from the conveyor end points.
_eq_pts: list[tuple[float, float]] = []
for _cv in layout["conveyors"]:
    for _p in (_cv["path"][0], _cv["path"][-1]):
        if (_p[0], _p[1]) not in _eq_pts:
            _eq_pts.append((_p[0], _p[1]))
layout["obstacles"] += [
    {"id": f"CVEQ-{i+1:02d}", "kind": "CONVEYOR_EQUIP",
     "rect": [round(x - 1.5, 2), round(z - 1.5, 2), round(x + 1.5, 2), round(z + 1.5, 2)]}
    for i, (x, z) in enumerate(_eq_pts)
]

# ── Stations: Packing / Sorting
layout["stations"] = [
    {"id": "PACK-01", "kind": "PACKING", "zone": "D", "rect": [82, 62, 96, 68], "access_point": [89, 61]},
    {"id": "PACK-02", "kind": "PACKING", "zone": "C", "rect": [4, 62, 18, 68], "access_point": [11, 61]},
    {"id": "SORT-01", "kind": "SORTING", "zone": "B", "rect": [82, 0, 96, 8], "access_point": [89, 9]},
]
for s in layout["stations"]:
    layout["locations"].append({"id": s["id"], "kind": s["kind"], "zone": s["zone"],
                                "rack_id": None, "level_range": None, "access_point": s["access_point"]})
for d in layout["docks"]:
    layout["locations"].append({"id": d["id"], "kind": d["kind"], "zone": d["zone"],
                                "rack_id": None, "level_range": None,
                                "access_point": [(d["rect"][0] + d["rect"][2]) / 2, d["rect"][3] + 1]})

# ── Charging: 6 stations at the bottom left
for i in range(6):
    x = 22 + i * 2.5
    layout["charging_stations"].append({
        # round-9e: the cabinet moves back to 66.4 (blocked cells); access point = the parking row (64.5, full cell center) — 1.0 m clearance between a charging robot and the corridor
        "id": f"CHG-{i+1:02d}", "zone": "C", "position": [x, 0, 66.4], "heading": 3.14159,
        "power_kw": 3.0, "access_point": [x, 64.5],
    })
    layout["locations"].append({"id": f"CHG-{i+1:02d}", "kind": "CHARGING", "zone": "C",
                                "rack_id": None, "level_range": None, "access_point": [x, 64.5]})

# ── Parking: bottom center
layout["parking"] = [{"id": "PARK-1", "zone": "C", "rect": [40, 63, 60, 68], "slots": 10}]

# ── Restricted / Walkways
layout["restricted_areas"] = [
    {"id": "RESTRICT-1", "name": "Maintenance bay", "rect": [0, 0, 18, 8], "robots_allowed": False},
]
layout["walkways"] = [
    {"id": "WALK-1", "polygon": [[0, 8], [100, 8], [100, 10], [0, 10]], "robots_allowed": True, "speed_limit_mps": 0.8},
    {"id": "WALK-2", "polygon": [[46, 10], [54, 10], [54, 62], [46, 62]], "robots_allowed": True, "speed_limit_mps": 1.0},
]

# ── Cameras: 3 per zone, mounted at aisle ends, looking along the aisle (aisle z = z0+1.1 + row*5.2)
layout["cameras"] = []
for zid, (x0, z0, x1, z1, _) in zones.items():
    spots = [(x0 + 0.6, z0 + 1.1 + 1 * 5.2, +1), (x1 - 0.6, z0 + 1.1 + 2 * 5.2, -1), (x0 + 0.6, z0 + 1.1 + 3 * 5.2, +1)]
    for i, (x, z, d) in enumerate(spots, 1):
        layout["cameras"].append({
            "id": f"CAM-{zid}{i:02d}", "zone": zid, "floor": 1, "position": [round(x, 1), 4.5, round(z, 1)],
            "look_at": [round(x + d * 18, 1), 0.5, round(z, 1)], "fov_deg": 65, "range_m": 30,
        })
layout["cameras"] += [
    {"id": "CAM-DOCK-IN", "zone": "A", "floor": 1, "position": [33, 6, 2], "look_at": [33, 0, 12], "fov_deg": 80, "range_m": 20},
    {"id": "CAM-DOCK-OUT", "zone": "B", "floor": 1, "position": [67, 6, 2], "look_at": [67, 0, 12], "fov_deg": 80, "range_m": 20},
    # Floor 2: the y of position/look_at is absolute height (floor at 8 m)
    {"id": "CAM-M01", "zone": "M", "floor": 2, "position": [9.0, F2_ELEV + 4.0, 46.6], "look_at": [27.0, F2_ELEV + 0.5, 46.6], "fov_deg": 65, "range_m": 30},
    {"id": "CAM-M02", "zone": "M", "floor": 2, "position": [53.0, F2_ELEV + 4.0, 51.8], "look_at": [35.0, F2_ELEV + 0.5, 51.8], "fov_deg": 65, "range_m": 30},
]

# ── Sensors
layout["sensors"] = [
    {"id": "S-A01", "kind": "PRESENCE", "zone": "A", "position": [26, 1, 9]},
    {"id": "S-B01", "kind": "PRESENCE", "zone": "B", "position": [74, 1, 9]},
    {"id": "S-C01", "kind": "LIDAR", "zone": "C", "position": [50, 1, 50]},
    {"id": "S-D01", "kind": "LIDAR", "zone": "D", "position": [50, 1, 20]},
    {"id": "S-CV03", "kind": "WEIGHT", "zone": "D", "position": [98.6, 0.5, 48]},
    {"id": "S-T01", "kind": "TEMP", "zone": "A", "position": [5, 3, 12]},
]

# ── Robot spawn: 20 robots; they start from parking and charging
for i in range(20):
    if i >= 16:   # R17–R20 spawn in the floor 2 aisle
        x = 14 + (i - 16) * 6.0
        z = 47
        layout["spawn"]["robots"].append({"id": f"R{i+1:02d}", "position": [x, 0, z], "heading": 0.0, "battery": 70 + (i * 7) % 30, "floor": 2})
    else:
        x = 40 + (i % 10) * 2.0
        z = 64 + (i // 10) * 2.0
        layout["spawn"]["robots"].append({"id": f"R{i+1:02d}", "position": [x, 0, z], "heading": -1.5708, "battery": 70 + (i * 7) % 30, "floor": 1})

print(json.dumps(layout, ensure_ascii=False, indent=2))
