"""Engine tests — match frontend/tests/engine.test.ts."""
import json
from app.sim.navgrid import load_layout, build_nav_grid
from app.sim.astar import astar, to_cell, NavGrid
from app.sim.engine import SimEngine, mulberry32
from app.schema import TwinState

L = load_layout()


def test_prng_matches_js():
    r = mulberry32(7)
    assert [round(r(), 12) for _ in range(3)] == [0.011704753153, 0.061958257575, 0.976907632779]


def test_astar_path_valid():
    g = build_nav_grid(L)
    a = next(l for l in L["locations"] if l["id"] == "SHELF-A01")["access_point"]
    b = next(l for l in L["locations"] if l["id"] == "SHELF-D40")["access_point"]
    p = astar(g, to_cell(*a), to_cell(*b))
    assert p and len(p) > 50
    prev = to_cell(*a)
    for c, r in p:
        assert g.cells[r * g.cols + c] != 1
        assert max(abs(c - prev[0]), abs(r - prev[1])) == 1
        prev = (c, r)


def test_all_access_points_walkable():
    grids = {1: build_nav_grid(L), 2: build_nav_grid(L, 2)}
    for l in L["locations"]:
        g = grids[l.get("floor", 1)]
        c, r = to_cell(*l["access_point"])
        assert g.cells[r * g.cols + c] != 1, l["id"]


def test_astar_walled_goal_returns_none():
    cells = bytearray(25)
    for c, r in [(1, 1), (2, 1), (3, 1), (1, 2), (3, 2), (1, 3), (2, 3), (3, 3)]:
        cells[r * 5 + c] = 1
    assert astar(NavGrid(5, 5, cells), (0, 0), (2, 2)) is None


def test_20_minutes_no_collisions_and_schema_valid():
    """Collision definition: two robot centers < 0.5 m apart (brief cell sharing during diagonal crossing can occur and does not count as a collision)"""
    e = SimEngine(L, seed=7)
    min_d = 99.0
    for t in range(12000):
        e.step()
        if t % 10 == 0:
            rs = list(e.state["robots"].values())
            for r in rs:
                assert 0 <= r["battery"] <= 100
            for i in range(len(rs)):
                for j in range(i + 1, len(rs)):
                    if rs[i]["floor"] != rs[j]["floor"] or rs[i]["lift_id"] or rs[j]["lift_id"]:
                        continue   # 2D coordinates on different floors can overlap; physical separation applies only on the same floor
                    d = ((rs[i]["position"][0] - rs[j]["position"][0]) ** 2 + (rs[i]["position"][2] - rs[j]["position"][2]) ** 2) ** 0.5
                    min_d = min(min_d, d)
    assert e.state["kpi"]["operation"]["completed_today"] > 40
    assert min_d >= 0.5, min_d
    TwinState.model_validate(e.state)


def test_no_gridlock_under_compound_failure():
    """Demo 10: conveyor fault + human intrusion for 30 minutes; throughput must not fall to zero (deadlock breaker)"""
    e = SimEngine(L, seed=42)
    for _ in range(3000): e.step()
    e.inject({"kind": "CONVEYOR_FAILURE", "conveyor_id": "CV03"}); e.inject({"kind": "HUMAN_INTRUSION", "zone_id": "B", "duration_ticks": 2000})
    before = e.state["kpi"]["operation"]["completed_today"]
    for _ in range(18000): e.step()
    assert e.state["kpi"]["operation"]["completed_today"] - before > 120


def test_deterministic():
    a, b = SimEngine(L, seed=3), SimEngine(L, seed=3)
    for _ in range(3000):
        a.step(); b.step()
    assert json.dumps(a.state, sort_keys=True) == json.dumps(b.state, sort_keys=True)


def test_low_battery_transfer_and_charge():
    e = SimEngine(L, seed=1)
    for _ in range(600): e.step()
    busy = next(r for r in e.state["robots"].values() if r["fsm"] == "TRANSPORTING")
    e.inject({"kind": "ROBOT_BATTERY_SET", "robot_id": busy["id"], "battery": 12})
    seen = set()
    for _ in range(4000):
        e.step(); seen.add(e.state["robots"][busy["id"]]["fsm"])
    assert "TASK_TRANSFER" in seen or "CHARGING" in seen
    assert e.state["robots"][busy["id"]]["battery"] > 12


def test_human_intrusion_blocks_and_clears():
    e = SimEngine(L, seed=5)
    for _ in range(1500): e.step()
    e.inject({"kind": "HUMAN_INTRUSION", "zone_id": "B", "duration_ticks": 600})
    e.step(); e.step()
    assert e.state["zones"]["B"]["status"] == "BLOCKED"
    for _ in range(700): e.step()
    assert e.state["zones"]["B"]["status"] != "BLOCKED"


def test_cross_floor_task_rides_lift():
    """Floor-2 shelf → floor-1 packing station: the robot rides a lift, the floor switches, and the task completes."""
    from app.sim.navgrid import load_layout
    e = SimEngine(load_layout(), seed=7)
    t = e.create_task("PICK", "CRITICAL", "SHELF-M05", "PACK-01")
    boarded = False; floors = set()
    for _ in range(24000):
        e.step()
        if t["assigned_robot"]:
            r = e.state["robots"][t["assigned_robot"]]
            floors.add(r["floor"])
            if r["lift_id"]:
                boarded = True
        if t["status"] == "COMPLETED":
            break
    assert t["status"] == "COMPLETED" and boarded and floors == {1, 2}


def test_floor2_grid_matches_ts_rules():
    from app.sim.navgrid import build_nav_grid, load_layout
    g2 = build_nav_grid(load_layout(), 2)
    at = lambda x, z: g2.cells[int(z) * g2.cols + int(x)]
    assert at(51.5, 44.5) == 1   # lift shaft = obstacle (round-8: cabin entry and exit use micro-move, not the grid)
    assert at(20.5, 47.5) != 1   # mezzanine walkway
    assert at(80, 20) == 1       # outside footprint


def test_pillars_blocked_and_charging_docks_on_pad():
    """round-9d: building pillars are in layout.obstacles and block the grid; a charging robot must stop exactly at the charging pad center, face the charger, and not overlap"""
    import math
    from app.sim.navgrid import build_nav_grid, load_layout
    from app.sim.engine import SimEngine
    L = load_layout()
    assert L.get("obstacles"), "layout.obstacles missing"
    g = build_nav_grid(L, 1)
    for o in L["obstacles"]:
        x0, z0, x1, z1 = o["rect"]
        for c in range(max(0, math.floor(x0)), min(g.cols, math.ceil(x1))):
            for r in range(max(0, math.floor(z0)), min(g.rows, math.ceil(z1))):
                assert g.cells[r * g.cols + c] == 1, f"{o['id']} cell ({c},{r}) not blocked"
        # A building pillar must not sit on a conveyor (round-9d visual bug: procedurally generated pillars cut into CV01/CV02)
        # -- check only PILLAR: CONVEYOR_EQUIP (round-9f endpoint machines) sits at conveyor endpoints by design
        if o["kind"] != "PILLAR":
            continue
        cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
        for cv in L["conveyors"]:
            for (ax, az), (bx, bz) in zip(cv["path"], cv["path"][1:]):
                if min(ax, bx) - 0.5 <= cx <= max(ax, bx) + 0.5 and min(az, bz) - 0.5 <= cz <= max(az, bz) + 0.5:
                    raise AssertionError(f"{o['id']} sits on conveyor {cv['id']}")
    e = SimEngine(L, seed=3)
    for rid in list(e.state["robots"].keys())[:3]:
        e.inject({"kind": "ROBOT_BATTERY_SET", "robot_id": rid, "battery": 25})
    pads = [(c["position"][0], c["position"][2] - 1.9) for c in L["charging_stations"]]
    seen = set()
    for _ in range(20000):
        e.step()
        chg = [r for r in e.state["robots"].values() if r["fsm"] == "CHARGING"]
        for r in chg:
            d = min(math.hypot(r["position"][0] - p[0], r["position"][2] - p[1]) for p in pads)
            assert d < 0.05, f"{r['id']} not docked on a pad (d={d:.2f})"
            assert abs(r["heading"] - math.pi / 2) < 0.01, f"{r['id']} not facing the charger"
        for i in range(len(chg)):
            for j in range(i + 1, len(chg)):
                assert not SimEngine.obb_overlap(chg[i]["position"][0], chg[i]["position"][2], chg[i]["heading"],
                                                 chg[j]["position"][0], chg[j]["position"][2], chg[j]["heading"]), \
                    f"{chg[i]['id']} overlaps {chg[j]['id']} while charging"
        seen |= {r["id"] for r in chg}
        if len(chg) >= 2:   # round-9e: two robots must charge at the same time -- a charging robot does not block the approach lane
            break
    assert len(seen) >= 2, "fewer than 2 robots ever charged"
    assert len(chg) >= 2, "second robot could not dock while first still charging (approach lane blocked)"

def test_conveyor_end_equipment_blocked_and_lanes_wide():
    """round-9f: endpoint machine footprints are in layout.obstacles and block the grid; vertical conveyors sit against the wall --
    the 1–2 cell wall-side narrow lane is gone (robots no longer move along the wall), inner lanes are ≥4 cells wide; in simulation robots do not enter any machine/pillar area"""
    from app.sim.navgrid import build_nav_grid, load_layout
    from app.sim.engine import SimEngine
    L = load_layout()
    eq = [o for o in L["obstacles"] if o["kind"] == "CONVEYOR_EQUIP"]
    assert eq, "CONVEYOR_EQUIP obstacles missing"
    for cv in L["conveyors"]:   # Each conveyor must have a machine footprint at both ends (single data source: endpoint ±1.5 m)
        for px, pz in (cv["path"][0], cv["path"][-1]):
            assert any(o["rect"][0] <= px <= o["rect"][2] and o["rect"][1] <= pz <= o["rect"][3] for o in eq), \
                f"{cv['id']} endpoint ({px},{pz}) has no CONVEYOR_EQUIP obstacle"
    g = build_nav_grid(L, 1)
    at = lambda c, r: g.cells[r * g.cols + c]
    for r in range(34, 61):     # vertical conveyor body: fully blocked between conveyor and wall (no wall-side narrow lane)
        assert at(0, r) == 1 and at(1, r) == 1, f"west wall strip row {r} not sealed"
        assert at(98, r) == 1 and at(99, r) == 1, f"east wall strip row {r} not sealed"
    for r in range(37, 58):     # conveyor side outside machine areas: inner lane stays clear (west 4 cells, east 5 cells)
        for c in (2, 3, 4, 5):
            assert at(c, r) != 1, f"west inner lane ({c},{r}) blocked"
        for c in (93, 94, 95, 96, 97):
            assert at(c, r) != 1, f"east inner lane ({c},{r}) blocked"
    for r in range(33, 37):     # all three crossings over z=35 (west/center/east) must stay open -- traffic must not all funnel into the central aisle at the lift lobby
        for c in (*range(3, 8), *range(48, 52), *range(92, 97)):
            assert at(c, r) != 1, f"crossing cell ({c},{r}) blocked"
    e = SimEngine(L, seed=11)
    rects = [o["rect"] for o in L["obstacles"]]
    for _ in range(6000):
        e.step()
        for r in e.state["robots"].values():
            if r["floor"] != 1 or r["lift_id"]:
                continue
            x, z = r["position"][0], r["position"][2]
            for x0, z0, x1, z1 in rects:
                assert not (x0 + 0.1 < x < x1 - 0.1 and z0 + 0.1 < z < z1 - 0.1), \
                    f"{r['id']} inside obstacle at ({x:.2f},{z:.2f})"
