"""
Digital Twin simulation engine — Python port of frontend/src/simulation/engine.ts.

Mapping: the method names, tick order, FSM, score weights, and SIM parameters are identical to the TS version, one by one.
The state is a plain dict (identical to the TwinState JSON). Pydantic validation occurs at the API boundary.
"""
from __future__ import annotations

import math
from typing import Any, Optional

from .astar import NavGrid, astar, cell_center, is_walkable, nearest_walkable, to_cell
from .navgrid import build_nav_grid
from .rules import task_error

# ─────────────────────────────────────────────────────────────
# Constants (same as twin_state.ts THRESHOLDS / engine.ts SIM)
# ─────────────────────────────────────────────────────────────
TH = dict(BATTERY_WARNING=20, BATTERY_CRITICAL=10, BATTERY_CHARGE_TO=95, CONGESTION_WARNING=0.6,
          CONGESTION_BLOCK=0.85, TICK_MS=100, EVENT_RING_SIZE=500, THROUGHPUT_SERIES_SIZE=120)
SIM = dict(
    TICK_S=0.1, MAX_SPEED=1.5, ACCEL=1.2, TURN_SLOW=0.5, PICK_TICKS=40, DROP_TICKS=30,
    BATTERY_MOVE=0.010, BATTERY_LOAD=0.004, BATTERY_IDLE=0.0008, CHARGE_RATE=0.06,
    TASK_INTERVAL_TICKS=70, MAX_WAITING_TASKS=12, WAIT_REPLAN_TICKS=25, WAIT_BACKOFF_TICKS=80, STATION_ARRIVE_CELLS=2, SERVICE_RADIUS=1, MIN_SEP=0.9, ON_TIME_LIMIT_TICKS=2400,
    IDLE_TO_PARK_TICKS=300, KPI_EVERY=10, SERIES_EVERY=600, EVENT_RING=500, ZONE_CAPACITY=6,
    # Phase 7: virtual LiDAR and local obstacle avoidance (same as the TS engine)
    LIDAR_RANGE=4.0, LIDAR_FOV=math.pi * 1.5, PERC_STOP=1.7, PERC_SLOW=2.8, PERC_LOOKAHEAD=3, PERC_EVENT_TICKS=200,
    LIFT_SEP=0.6,   # "Dock mode" separation (m) at the lift entrance: for the low-speed micro-moves of queue advance and car entry/exit; tighter than the aisle MIN_SEP
    # Lift door area geometry (round-8c): matches the frontend Mezzanine shaft model (W 2.8 / double door, one LEAF 1.12)
    LIFT_SHAFT_HALF_X=1.4, LIFT_DOOR_HALF_W=1.12, ROBOT_HALF_LEN=0.475, ROBOT_HALF_W=0.34,
    LIFT_DOOR_TICKS=12, LIFT_TRAVEL_TICKS=60, LIFT_LEVEL_TICKS=5, LIFT_COOLDOWN_TICKS=20,
    LIFT_BOARD_SPEED=0.6, LIFT_QUEUE_SPEED=0.9, LIFT_RETRY_TICKS=50, LIFT_XFLOOR_PENALTY_M=40,
)

MASK = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & MASK


class Mulberry32:
    """PRNG that is bit-level identical to the JS version. It is an object (not a closure) so the engine can deepcopy → after a What-if copy, the random stream stays identical."""
    __slots__ = ("s",)

    def __init__(self, seed: int) -> None:
        self.s = seed & MASK

    def __call__(self) -> float:
        self.s = (self.s + 0x6D2B79F5) & MASK
        t = self.s
        t = _imul(t ^ (t >> 15), 1 | t)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) ^ t) & MASK
        return ((t ^ (t >> 14)) & MASK) / 4294967296


def mulberry32(seed: int) -> Mulberry32:
    return Mulberry32(seed)


def jsround(x: float) -> int:
    """JS Math.round: .5 rounds toward +infinity."""
    return math.floor(x + 0.5)


def js_to_fixed0(x: float) -> str:
    return str(jsround(x)) if x >= 0 else str(-jsround(-x))


def _sign(x: float) -> float:
    return 1.0 if x > 0 else -1.0 if x < 0 else 0.0


class RobotRt:
    __slots__ = ("dwell", "wait_ticks", "target", "goal_loc", "phase", "charger_id", "idle_ticks", "last_battery_alert", "backing_off", "resume_point",
                 "front_id", "front_dist", "last_perc_event", "pending", "lift_id", "lift_stage", "lift_enqueued_tick", "lift_retry_tick",
                 "lift_exit", "lift_blocked_ticks", "planned_lift_id", "lift_exit_phase")

    def __init__(self) -> None:
        self.backing_off = False; self.resume_point: Optional[tuple[float, float]] = None
        self.dwell = 0; self.wait_ticks = 0; self.target: Optional[tuple[int, int]] = None
        self.goal_loc: Optional[str] = None; self.phase: Optional[str] = None
        self.charger_id: Optional[str] = None; self.idle_ticks = 0; self.last_battery_alert = "NONE"
        self.front_id: Optional[str] = None; self.front_dist = math.inf; self.last_perc_event = -10**9
        self.pending: Optional[dict[str, Any]] = None; self.lift_id: Optional[str] = None
        self.lift_stage: Optional[str] = None; self.lift_enqueued_tick = 0; self.lift_retry_tick = 0
        self.lift_exit: Optional[tuple[float, float]] = None; self.lift_blocked_ticks = 0
        # Lift recorded in the audit at dispatch time (round-6 P2): _plan_to prefers it for a cross-floor move, so the Decision reasons match the real route
        self.planned_lift_id: Optional[str] = None
        # Three-stage lift exit (round-8d): TURN_OUT → OUT → TURN_EXIT → GO
        self.lift_exit_phase: Optional[str] = None


class SimEngine:
    def __init__(self, layout: dict[str, Any], seed: int = 42, initial_state: Optional[dict[str, Any]] = None) -> None:
        self.layout = layout
        self.grid: NavGrid = build_nav_grid(layout, 1)
        self.grids: dict[int, NavGrid] = {1: self.grid}
        for f in layout.get("floors", []):
            if f["id"] != 1:
                self.grids[f["id"]] = build_nav_grid(layout, f["id"])

        n = self.grid.cols * self.grid.rows
        # Traffic heatmap: one per floor (round-5 fix: floor 2 no longer shows the floor 1 data)
        _floors = layout.get("floors") or [{"id": 1}]
        self.traffic: dict[int, list[float]] = {f["id"]: [0.0] * n for f in _floors}
        self.traffic_short: dict[int, list[float]] = {f["id"]: [0.0] * n for f in _floors}
        self.loc = {l["id"]: l for l in layout["locations"]}
        self.rng = mulberry32(seed)
        self.rt: dict[str, RobotRt] = {}
        self.occupancy: dict[tuple[int, int, int], str] = {}   # (floor, col, row) → robot_id
        self.task_seq = 3812; self.event_seq = 0; self.decision_seq = 0
        self.charger_busy: dict[str, Optional[str]] = {c["id"]: None for c in layout["charging_stations"]}
        self.blocked_zones: set[str] = set()
        self.congested_zones: dict[str, dict[str, float]] = {}   # zone → {level, until}
        self.pending_injections: list[dict[str, Any]] = []
        self.task_times: list[int] = []
        self.on_time = 0; self.completed_count = 0; self.last_series_tick = 0
        self.state: dict[str, Any] = (__import__("copy").deepcopy(initial_state) if initial_state else self._build_initial_state(seed))
        for r in self.state["robots"].values():   # Compatibility with old snapshots
            r.setdefault("perception", {"state": "CLEAR", "ahead_m": SIM["LIDAR_RANGE"], "nearest_m": None, "obstacles": []})
            r.setdefault("floor", 1); r.setdefault("lift_id", None); r.setdefault("lift_stage", None)
        if "lifts" not in self.state:
            self.state["lifts"] = self._initial_lifts()
        for L in self.state["lifts"].values():   # Compatibility with old snapshots
            L.setdefault("fault_remaining", 0)
        for rid in self.state["robots"]:
            self.rt[rid] = RobotRt()
        self.next_task_tick = self.state["sim"]["tick"] + 10
        # Events created in each new tick (for the WebSocket PATCH); the caller clears the list
        self.new_events: list[dict[str, Any]] = []
        self._zone_bounds = {z["id"]: (min(p[0] for p in z["polygon"]), min(p[1] for p in z["polygon"]),
                                       max(p[0] for p in z["polygon"]), max(p[1] for p in z["polygon"])) for z in layout["zones"]}
        self._zone_floor = {z["id"]: z.get("floor", 1) for z in layout["zones"]}

    # ─────────────────────────────────────────────────────────
    def _initial_lifts(self) -> dict[str, Any]:
        return {l["id"]: {
            "id": l["id"], "state": "IDLE", "floor": 1, "target_floor": None, "y": 0.0,
            "door_f1": "CLOSED", "door_f2": "CLOSED",
            "occupant": None, "reserved_by": None, "queue": {"1": [], "2": []},
            "until_tick": 0, "fault": False, "fault_remaining": 0, "trips": 0, "busy_ticks": 0, "wait_total_ticks": 0, "wait_n": 0,
        } for l in self.layout.get("lifts", [])}

    def _build_initial_state(self, seed: int) -> dict[str, Any]:
        L = self.layout
        robots: dict[str, Any] = {}
        for sp in L["spawn"]["robots"]:
            robots[sp["id"]] = {
                "id": sp["id"], "model": "AMR-L", "position": [math.floor(sp["position"][0]) + 0.5, 0, math.floor(sp["position"][2]) + 0.5], "heading": sp["heading"],
                "floor": sp.get("floor", 1), "lift_id": None, "lift_stage": None,
                "velocity": 0, "max_speed": SIM["MAX_SPEED"], "battery": sp["battery"], "status": "IDLE", "fsm": "IDLE",
                "health": 95 + math.floor(self.rng() * 5), "current_task_id": None, "destination": None, "path": [], "path_index": 0,
                "load": {"current": 0, "capacity": 4}, "zone": None, "eta_s": None, "fsm_since_tick": 0,
                "stats": {"distance_m": 0, "tasks_completed": 0, "energy_wh": 0, "busy_ticks": 0, "wait_ticks": 0},
                "perception": {"state": "CLEAR", "ahead_m": SIM["LIDAR_RANGE"], "nearest_m": None, "obstacles": []},
            }
        n = len(robots)
        return {
            "schema_version": "1.0", "layout_id": L["id"],
            "sim": {"tick": 0, "tick_ms": TH["TICK_MS"], "speed": 1, "mode": "LIVE", "seed": seed, "baseline_snapshot_id": None},
            "robots": robots, "tasks": {}, "lifts": self._initial_lifts(),
            "zones": {z["id"]: {"id": z["id"], "status": "NORMAL", "robot_count": 0, "congestion": 0, "blocked_reason": None, "blocked_since_tick": None} for z in L["zones"]},
            "conveyors": {c["id"]: {"id": c["id"], "status": "RUNNING", "speed_mps": c["speed_mps"], "items_on_belt": 4, "throughput_per_min": 4} for c in L["conveyors"]},
            "cameras": {c["id"]: {"id": c["id"], "zone": c["zone"], "status": "ONLINE", "last_observation": None} for c in L["cameras"]},
            "sensors": {s["id"]: {"id": s["id"], "kind": s["kind"], "zone": s["zone"], "status": "ONLINE", "value": None, "unit": None} for s in L["sensors"]},
            "people": {}, "alerts": {}, "recent_events": [], "recent_decisions": [],
            "kpi": {
                "tick": 0, "fleet": {"total": n, "active": 0, "charging": 0, "idle": n, "warning": 0, "error": 0, "offline": 0},
                "operation": {"throughput_per_min": 0, "completed_today": 0, "completed_target": 150, "pending": 0, "ongoing": 0, "avg_task_time_s": 0, "on_time_rate": 1, "avg_utilization": 0},
                "efficiency": {"avg_travel_distance_m": 0, "avg_wait_time_s": 0, "congestion_index": 0, "energy_kwh": 0},
                "throughput_series": [{"tick": 0, "completed": 0, "target": 0}],
            "lifts": {"trips": 0, "utilization": 0, "avg_wait_s": 0, "faults": 0},
            },
            "subsystems": {"WAREHOUSE": "NORMAL", "CONVEYORS": "NORMAL", "CHARGING": "NORMAL", "CCTV": "NORMAL", "NETWORK": "NORMAL"},
        }

    # ─────────────────────────────────────────────────────────
    # Public API
    # ─────────────────────────────────────────────────────────
    def clone(self) -> "SimEngine":
        """Full copy (state + FSM runtime + chargers + random state). layout and grid are read-only, shared and not copied."""
        import copy
        new = SimEngine.__new__(SimEngine)
        for k, v in self.__dict__.items():
            if k in ("layout", "grid", "grids", "loc", "_zone_bounds", "_zone_floor"):
                setattr(new, k, v)
            else:
                setattr(new, k, copy.deepcopy(v))
        new.new_events = []
        return new

    def inject(self, inj: dict[str, Any]) -> None:
        self.pending_injections.append(inj)
        tgt = inj.get("zone_id") and f" (Zone {inj['zone_id']})" or inj.get("robot_id") and f" ({inj['robot_id']})" or inj.get("conveyor_id") and f" ({inj['conveyor_id']})" or inj.get("camera_id") and f" ({inj['camera_id']})" or ""
        self.emit("SCENARIO_INJECTED", "USER", "INFO", f"Scenario injected: {inj['kind']}{tgt}")

    def block_zone(self, zone_id: str, reason: str, duration_ticks: int) -> None:
        """Zone block triggered by perception (VLM): no person model is placed, only a block plus a release at expiry."""
        S = self.state; now = S["sim"]["tick"]
        if zone_id not in S["zones"]: return
        pid = f"VLM-{zone_id}-{now}"
        b = self._zone_bounds[zone_id]
        S["people"][pid] = {"id": pid, "kind": "WORKER", "position": [(b[0] + b[2]) / 2, 0, b[1] + 6.3], "heading": 0, "zone": zone_id, "floor": self._zone_floor.get(zone_id, 1), "expires_tick": now + duration_ticks}
        if zone_id not in self.blocked_zones:
            self.blocked_zones.add(zone_id); S["zones"][zone_id]["blocked_reason"] = reason; S["zones"][zone_id]["blocked_since_tick"] = now
            self.emit("ZONE_BLOCKED", "VLM", "HIGH", f"Zone {zone_id} marked BLOCKED ({reason})", zone_id=zone_id)
            self._raise_alert(f"zone-{zone_id}", "HIGH", f"Zone {zone_id}  Human Detected", "VLM · route blocked", zone_id=zone_id)
            x0, z0, x1, z1 = b
            for r in S["robots"].values():
                if r["path"] and any(x0 <= c[0] < x1 and z0 <= c[1] < z1 for c in r["path"][r["path_index"]:]):
                    self._set_fsm(r, "OBSTACLE_DETECTED")

    def clear_injection(self, kind: str, target_id: str) -> None:
        """Clear an injection: the robot comes back online, the conveyor restarts, the camera comes online, the person leaves, the traffic congestion clears."""
        S = self.state
        if kind == "ROBOT_FAILURE":
            r = S["robots"].get(target_id)
            if r and r["fsm"] == "OFFLINE":
                self._set_fsm(r, "IDLE"); self.rt[r["id"]].phase = None; self.rt[r["id"]].target = None
                self._resolve_alert(f"off-{r['id']}"); self.emit("ROBOT_ONLINE", "USER", "INFO", f"{r['id']} back online", robot_id=r["id"])
        elif kind == "CONVEYOR_FAILURE":
            c = S["conveyors"].get(target_id); lc = next((x for x in self.layout["conveyors"] if x["id"] == target_id), None)
            if c and lc:
                c["status"] = "RUNNING"; c["speed_mps"] = lc["speed_mps"]; self._resolve_alert(f"cv-{c['id']}")
                self.emit("CONVEYOR_STATUS_CHANGED", "CONVEYOR", "INFO", f"{c['id']} restored — RUNNING", conveyor_id=c["id"])
        elif kind == "CAMERA_OFFLINE":
            c = S["cameras"].get(target_id)
            if c:
                c["status"] = "ONLINE"
                if all(x["status"] == "ONLINE" for x in S["cameras"].values()): S["subsystems"]["CCTV"] = "NORMAL"
                self.emit("CAMERA_STATUS_CHANGED", "CAMERA", "INFO", f"{c['id']} online", camera_id=c["id"])
        elif kind == "HUMAN_INTRUSION":
            for p in S["people"].values():
                if p["zone"] == target_id: p["expires_tick"] = S["sim"]["tick"]
        elif kind == "TRAFFIC_CONGESTION":
            self.congested_zones.pop(target_id, None)
            self.emit("ZONE_UNBLOCKED", "USER", "INFO", f"Zone {target_id} traffic restriction lifted", zone_id=target_id)
        elif kind == "LIFT_FAULT":
            L = S["lifts"].get(target_id)
            if L and L["fault"]:
                L["fault"] = False
                # Continue from the frozen remaining progress (round-5 fix: the platform does not teleport)
                L["until_tick"] = S["sim"]["tick"] + L.get("fault_remaining", 0)
                L["fault_remaining"] = 0
                self._resolve_alert(f"lift-{target_id}")
                self.emit("LIFT_FAULT", "LIFT", "INFO", f"{target_id} restored — resuming")

    def create_task(self, type_: str, priority: str, source: str, destination: str, load_units: int = 1) -> dict[str, Any]:
        err = task_error(self.loc, type_, source, destination)
        if err:
            raise ValueError(err)
        tid = f"A{self.task_seq}"; self.task_seq += 1
        tick = self.state["sim"]["tick"]
        task = {"id": tid, "type": type_, "priority": priority, "status": "WAITING", "source": source, "destination": destination,
                "assigned_robot": None, "parent_task_id": None, "created_tick": tick, "assigned_tick": None, "started_tick": None,
                "completed_tick": None, "deadline_tick": tick + SIM["ON_TIME_LIMIT_TICKS"], "eta_s": None, "load_units": load_units}
        self.state["tasks"][tid] = task
        self.emit("TASK_CREATED", "SIMULATION", "INFO", f"Task #{tid} created ({type_} {self.pretty(source)} → {self.pretty(destination)})", task_id=tid)
        return task

    def ack_alert(self, aid: str) -> None:
        a = self.state["alerts"].get(aid)
        if a:
            a["acknowledged"] = True

    def step(self) -> None:
        S = self.state
        S["sim"]["tick"] += 1
        tick = S["sim"]["tick"]
        self._apply_injections()
        self._generate_tasks()
        self._assign_tasks()
        self._rebuild_occupancy()
        self._step_lifts()
        for rid in list(S["robots"].keys()):
            self._update_perception(S["robots"][rid], self.rt[rid])
        for rid in list(S["robots"].keys()):
            self._step_robot(S["robots"][rid], self.rt[rid])
        self._update_zones()
        self._decay_traffic()
        if tick % SIM["KPI_EVERY"] == 0:
            self._update_kpi(); self._update_devices()
        if tick - self.last_series_tick >= SIM["SERIES_EVERY"]:
            self._push_series()
        self._prune_tasks()

    # ─────────────────────────────────────────────────────────
    # Tasks
    # ─────────────────────────────────────────────────────────
    def _generate_tasks(self) -> None:
        S = self.state
        if S["sim"]["tick"] < self.next_task_tick:
            return
        self.next_task_tick = S["sim"]["tick"] + jsround(SIM["TASK_INTERVAL_TICKS"] * (0.5 + self.rng()))
        waiting = sum(1 for t in S["tasks"].values() if t["status"] == "WAITING")
        if waiting >= SIM["MAX_WAITING_TASKS"]:
            return
        locs = self.layout["locations"]
        shelves = [l for l in locs if l["kind"] == "SHELF"]
        packs = [l for l in locs if l["kind"] in ("PACKING", "SORTING")]
        inbound = [l for l in locs if l["kind"] == "INBOUND"]
        outbound = [l for l in locs if l["kind"] == "OUTBOUND"]

        def pick(a: list) -> Any:
            return a[math.floor(self.rng() * len(a))]

        r = self.rng()
        pr = "HIGH" if r < 0.15 else "CRITICAL" if r < 0.18 else "NORMAL"
        if r < 0.55:
            self.create_task("PICK", pr, pick(shelves)["id"], pick(packs)["id"])
        elif r < 0.8:
            self.create_task("REPLENISH", pr, pick(inbound)["id"], pick(shelves)["id"])
        else:
            self.create_task("TRANSPORT", pr, pick(packs)["id"], pick(outbound)["id"])

    def _assign_tasks(self) -> None:
        S = self.state
        prio_rank = {"CRITICAL": 0, "HIGH": 1, "NORMAL": 2, "LOW": 3}
        waiting = sorted((t for t in S["tasks"].values() if t["status"] == "WAITING"), key=lambda t: (prio_rank[t["priority"]], t["created_tick"]))
        if not waiting:
            return
        idle = [r for r in S["robots"].values() if r["fsm"] == "IDLE" and r["status"] not in ("OFFLINE", "ERROR") and r["battery"] > TH["BATTERY_WARNING"]]
        weights = {"distance": 0.35, "battery": 0.25, "workload": 0.15, "congestion": 0.15, "health": 0.10}
        for task in waiting:
            if not idle:
                return
            src = self.loc.get(task["source"])
            if not src:
                task["status"] = "FAILED"; continue
            src_floor = src.get("floor", 1)
            lift_pick: dict[str, str] = {}   # Best lift computed for each candidate at this moment (round-6 P2: the audit is bound to the real route)
            cands = []
            for r in idle:
                # Cross-floor: ground distance + fixed penalty + estimated wait from the "real lift state" (queue length / busy / current floor), converted to an equivalent distance
                flat = math.hypot(r["position"][0] - src["access_point"][0], r["position"][2] - src["access_point"][1])
                d = flat; lift_info = None
                if r["floor"] != src_floor:
                    ranked = sorted(({"l": l, "cost": self.lift_cost(r, l)} for l in self.layout["lifts"]), key=lambda x: (x["cost"], x["l"]["id"]))
                    best_l = ranked[0] if ranked else None
                    if best_l and best_l["cost"] < math.inf:
                        approach = math.hypot(r["position"][0] - (best_l["l"]["cell"][0] - 1.5), r["position"][2] - (best_l["l"]["cell"][1] + 0.5)) / (SIM["MAX_SPEED"] * 0.8)
                        wait_s = jsround((best_l["cost"] - approach) * 10) / 10
                        lift_info = {"id": best_l["l"]["id"], "waitS": wait_s}
                        lift_pick[r["id"]] = best_l["l"]["id"]
                    else:
                        lift_info = {"id": "—", "waitS": 60}
                    d = flat + SIM["LIFT_XFLOOR_PENALTY_M"] + lift_info["waitS"] * SIM["MAX_SPEED"] * 0.8
                zone = S["zones"].get(r["zone"]) if r["zone"] else None
                cong = zone["congestion"] if zone else 0
                tc = r["stats"]["tasks_completed"]
                workload = "HIGH" if tc > 8 else "MEDIUM" if tc > 4 else "LOW"
                score = (weights["distance"] * (1 - min(1, d / 120)) + weights["battery"] * (r["battery"] / 100)
                         + weights["workload"] * (1 if workload == "LOW" else 0.6 if workload == "MEDIUM" else 0.2)
                         + weights["congestion"] * (1 - cong) + weights["health"] * (r["health"] / 100))
                if lift_info:
                    reasons = [f"{js_to_fixed0(flat)}m ground", f"+{SIM['LIFT_XFLOOR_PENALTY_M']}m cross-floor via {lift_info['id']}",
                               f"est. lift wait {lift_info['waitS']:g}s", f"{js_to_fixed0(r['battery'])}% battery"]
                else:
                    reasons = [f"{js_to_fixed0(d)}m from task", f"{js_to_fixed0(r['battery'])}% battery", f"{workload.lower()} workload"]
                if cong < 0.3:
                    reasons.append("no route congestion")
                cands.append({"robot_id": r["id"], "score": jsround(score * 1000) / 1000, "distance_m": jsround(d), "battery": jsround(r["battery"]),
                              "workload": workload, "congestion": jsround(cong * 100) / 100, "health": r["health"], "reasons": reasons, "rejected_reason": None})
            cands.sort(key=lambda c: -c["score"])
            best = cands[0]
            for c in cands[1:]:
                c["rejected_reason"] = ("battery too low" if c["battery"] < 40 else "farther from task" if c["distance_m"] > best["distance_m"] * 1.5
                                        else "high workload" if c["workload"] == "HIGH" else "lower score")
            robot = S["robots"][best["robot_id"]]
            idle.remove(robot)
            task["status"] = "ASSIGNED"; task["assigned_robot"] = robot["id"]; task["assigned_tick"] = S["sim"]["tick"]
            robot["current_task_id"] = task["id"]
            self.rt[robot["id"]].planned_lift_id = lift_pick.get(robot["id"])   # For a cross-floor move, _plan_to prefers the lift recorded in the audit
            self._set_fsm(robot, "TASK_ASSIGNED")
            self.decision_seq += 1
            S["recent_decisions"].insert(0, {"id": f"D{self.decision_seq}", "tick": S["sim"]["tick"], "kind": "TASK_ASSIGNMENT", "task_id": task["id"],
                                             "selected_robot": robot["id"], "candidates": cands[:5], "weights": weights, "narrative": None})
            if len(S["recent_decisions"]) > 50:
                S["recent_decisions"].pop()
            self.emit("TASK_ASSIGNED", "FLEET_MANAGER", "INFO", f"Task #{task['id']} assigned to {robot['id']} ({best['distance_m']}m, {best['battery']}%)", task_id=task["id"], robot_id=robot["id"])

    def _prune_tasks(self) -> None:
        S = self.state; tick = S["sim"]["tick"]
        for tid in [tid for tid, t in S["tasks"].items() if t["status"] in ("COMPLETED", "FAILED", "TRANSFERRED", "CANCELLED") and t["completed_tick"] is not None and tick - t["completed_tick"] > 3000]:
            del S["tasks"][tid]

    # ─────────────────────────────────────────────────────────
    # FSM
    # ─────────────────────────────────────────────────────────
    def _set_fsm(self, r: dict[str, Any], fsm: str) -> None:
        if r["fsm"] == fsm:
            return
        r["fsm"] = fsm; r["fsm_since_tick"] = self.state["sim"]["tick"]
        r["status"] = self._status_of(r)

    @staticmethod
    def _status_of(r: dict[str, Any]) -> str:
        f = r["fsm"]
        if f == "OFFLINE": return "OFFLINE"
        if f == "ERROR": return "ERROR"
        if f == "CHARGING": return "CHARGING"
        if r["battery"] < TH["BATTERY_CRITICAL"]: return "ERROR"
        if r["battery"] < TH["BATTERY_WARNING"]: return "WARNING"
        if f == "IDLE": return "IDLE"
        return "ACTIVE"

    # ─────────────────────────────────────────────────────────
    # Lifts (spec §6/§9/§10/§11/§13/§14) — same logic as the TS engine; this engine (backend) is the single authority
    # ─────────────────────────────────────────────────────────
    def _lift_layout(self, lid: str) -> dict[str, Any]:
        return next(l for l in self.layout["lifts"] if l["id"] == lid)

    def _elev_of(self, floor: int) -> float:
        return next((f["elevation"] for f in self.layout.get("floors", []) if f["id"] == floor), 0.0)

    @staticmethod
    def _lift_slot(l: dict[str, Any], i: int) -> tuple[float, float]:
        # Queue cells (round-9b: moved back one more grid cell): slot0 = cell−4, 1.916 m from the turn-safe point.
        # An in-place rotation sweep (diagonal radius 0.584) against a queued robot with any heading (worst case 0.584) needs >= 1.17 m to guarantee no contact.
        # With the old cell−3 (0.916 m apart), two robots that stand face to face (0.475+0.475=0.95) already overlap.
        return (l["cell"][0] - 4 - i + 0.5, l["cell"][1] + 0.5)

    @staticmethod
    def _lift_cabin(l: dict[str, Any]) -> tuple[float, float]:
        return (l["cell"][0] + 0.5, l["cell"][1] + 0.5)

    def _lift_gate_point(self, l: dict[str, Any]) -> tuple[float, float]:
        """Gate pass point = turn-safe point (round-8d): exact center of the door axis (z = cz, no offset — an offset makes the robot body sweep across the door frame).
        x = door face − robot [diagonal radius] − 0.10 m margin (≈ cx − 2.084): the sweep circle radius of the rectangular robot body in an in-place rotation is
        sqrt(half-length² + half-width²) ≈ 0.584 m. Use of only the half-length cuts into the door face at the worst angle — at this point the full robot can even rotate without contact with the door frame.
        The queue line is at cell−4−i (round-9b); this point is ≈ 1.916 m from an occupied slot0 — the in-place rotation sweep is also safe for queued robots."""
        cx = l["cell"][0] + 0.5; cz = l["cell"][1] + 0.5
        return (cx - (SIM["LIFT_SHAFT_HALF_X"] + math.hypot(SIM["ROBOT_HALF_LEN"], SIM["ROBOT_HALF_W"]) + 0.10), cz)

    def _pick_lift_exit(self, l: dict[str, Any], floor: int, toward: Optional[tuple[float, float]] = None, skip: int = 0) -> tuple[float, float]:
        """Exit nodes (spec §6.4): separate from the queue line. A robot that leaves the lift car moves in two segments, "door axis → gate → exit" (round-8b).
        Both segments must avoid all robots that stand still. The exit is selected once (sticky); it changes only after a long block — same as TS."""
        grid = self.grids[floor]
        cabin = self._lift_cabin(l)

        def seg_clear(ax: float, az: float, bx: float, bz: float) -> bool:
            dx = bx - ax; dz = bz - az; len2 = dx * dx + dz * dz or 1.0
            for o in self.state["robots"].values():
                if o["floor"] != floor or o["lift_id"] or o["velocity"] > 0.1:
                    continue
                t = max(0.0, min(1.0, ((o["position"][0] - ax) * dx + (o["position"][2] - az) * dz) / len2))
                d = math.hypot(o["position"][0] - (ax + dx * t), o["position"][2] - (az + dz * t))
                if d < SIM["LIFT_SEP"]:   # The door area uses the "dock mode" separation (round-8e); the real movement is also limited by LIFT_SEP
                    return False
            return True

        g = self._lift_gate_point(l)

        def clear(to: tuple[float, float]) -> bool:   # Both segments must be clear: lift car → gate, gate → exit
            return seg_clear(cabin[0], cabin[1], g[0], g[1]) and seg_clear(g[0], g[1], to[0], to[1])

        # round-8e: the exits no longer rotate in a fixed order; now "nearest to the next destination first" — if the destination is south, exit south, with no wrong turn and no detour.
        # The (-2, ±2) exits along the fence get a 0.75 m penalty, so the route no longer runs parallel along the shaft frame.
        # round-9b: stand clearance — after the robot stands on the exit, it must still turn in place to leave (diagonal radius + the other robot's half-length); do not select a candidate too close to a robot that stands still.
        stand_clear_r = math.hypot(SIM["ROBOT_HALF_LEN"], SIM["ROBOT_HALF_W"]) + SIM["ROBOT_HALF_LEN"]

        def stand_clear(p: tuple[float, float]) -> bool:
            for o in self.state["robots"].values():
                if o["floor"] != floor or o["lift_id"] or o["velocity"] > 0.1:
                    continue
                if math.hypot(p[0] - o["position"][0], p[1] - o["position"][2]) < stand_clear_r:
                    return False
            return True

        ok: list[tuple[float, tuple[float, float]]] = []
        for dc, dr in ((-2, -2), (-2, 2), (-3, -1), (-3, 1), (-3, -2), (-3, 2), (-2, 0)):
            c = l["cell"][0] + dc; r_ = l["cell"][1] + dr
            if not is_walkable(grid, c, r_):
                continue
            pnt = (c + 0.5, r_ + 0.5)
            if not clear(pnt) or not stand_clear(pnt):
                continue
            hug = 0.75 if (dc == -2 and dr != 0) else 0.0
            key = (math.hypot(pnt[0] - toward[0], pnt[1] - toward[1]) if toward else 0.0) + hug
            ok.append((key, pnt))
        ok.sort(key=lambda x: x[0])
        if ok:
            return ok[skip % len(ok)][1]
        return (l["cell"][0] - 2 + 0.5, l["cell"][1] - 2 + 0.5)

    @staticmethod
    def obb_overlap(ax: float, az: float, ah: float, bx: float, bz: float, bh: float, margin: float = 0.0) -> bool:
        """Test if two rotated rectangular robot bodies (OBB) intersect — separating axis theorem (SAT); margin is an extra safety gap (round-9b)."""
        hl = SIM["ROBOT_HALF_LEN"]; hw = SIM["ROBOT_HALF_W"]
        dx = bx - ax; dz = bz - az
        for t in (ah, ah + math.pi / 2, bh, bh + math.pi / 2):
            ux = math.cos(t); uz = math.sin(t)
            ra = hl * abs(ux * math.cos(ah) + uz * math.sin(ah)) + hw * abs(-ux * math.sin(ah) + uz * math.cos(ah))
            rb = hl * abs(ux * math.cos(bh) + uz * math.sin(bh)) + hw * abs(-ux * math.sin(bh) + uz * math.cos(bh))
            if abs(dx * ux + dz * uz) > ra + rb + margin:
                return False   # A separating axis exists → no intersection
        return True

    def _micro_move(self, r: dict[str, Any], to: tuple[float, float], speed: float, floor_override: Optional[int] = None) -> bool:
        fl = floor_override if floor_override is not None else r["floor"]
        dx = to[0] - r["position"][0]; dz = to[1] - r["position"][2]
        dist = math.hypot(dx, dz)
        if dist < 0.05:
            r["velocity"] = 0; return True
        step = min(dist, speed * SIM["TICK_S"])
        nx = r["position"][0] + (dx / dist) * step; nz = r["position"][2] + (dz / dist) * step
        # Queue advance and lift car entry/exit keep a physical separation, but use the "dock mode" LIFT_SEP (0.6 m): low-speed micro-moves.
        # With the aisle MIN_SEP 0.9, the door-axis corridor and the queue line deadlock each other at the 0.9 m gauge (BOARDING ↔ TO_LIFT standoff).
        move_h = math.atan2(dz, dx)
        for oid, o in self.state["robots"].items():
            if oid == r["id"] or o["floor"] != fl or o["lift_id"]:
                continue
            dn = math.hypot(nx - o["position"][0], nz - o["position"][2])
            dcur = math.hypot(r["position"][0] - o["position"][0], r["position"][2] - o["position"][2])
            if dn < SIM["LIFT_SEP"] and dn < dcur:
                r["velocity"] = 0; return False
            # round-9b: in addition to the center distance, verify that the "rotated robot body OBB" does not intersect (+5 cm gap) — block only a step that "comes closer".
            # Let a separation move that increases distance pass; otherwise an existing overlapped state locks up.
            if dn < dcur and dn < 1.5 and self.obb_overlap(nx, nz, move_h, o["position"][0], o["position"][2], o["heading"], 0.05):
                r["velocity"] = 0; return False
        r["position"][0] = nx; r["position"][2] = nz
        r["heading"] = math.atan2(dz, dx); r["velocity"] = speed
        return False

    def _set_lift_stage(self, r: dict[str, Any], rt: RobotRt, stage: Optional[str]) -> None:
        rt.lift_stage = stage; r["lift_stage"] = stage

    def release_robot_from_lift(self, robot_id: str) -> None:
        S = self.state
        for lid, L in S["lifts"].items():
            for f in ("1", "2"):
                if robot_id in L["queue"][f]:
                    L["queue"][f].remove(robot_id)
            if L["reserved_by"] == robot_id:
                L["reserved_by"] = None
                self.emit("LIFT_RESERVATION_RELEASED", "LIFT", "LOW", f"{lid} reservation released ({robot_id})", robot_id=robot_id)
            if L["occupant"] == robot_id:
                L["occupant"] = None
                if L["state"] in ("BOARDING", "ALIGHTING"):
                    L["state"] = "DOOR_CLOSING_AFTER_EXIT"; L["until_tick"] = S["sim"]["tick"] + SIM["LIFT_DOOR_TICKS"]
        r = S["robots"].get(robot_id); rt = self.rt.get(robot_id)
        if r is not None and rt is not None:
            r["lift_id"] = None; self._set_lift_stage(r, rt, None); rt.lift_exit = None; rt.lift_blocked_ticks = 0; rt.lift_exit_phase = None

    def _step_lifts(self) -> None:
        S = self.state; tick = S["sim"]["tick"]
        for lid in sorted(S["lifts"].keys()):
            L = S["lifts"][lid]
            if L["fault"]:
                continue
            if L["state"] not in ("IDLE", "COOLDOWN"):
                L["busy_ticks"] += 1
            if L["state"] in ("MOVING_UP", "MOVING_DOWN"):
                t = min(1.0, max(0.0, 1 - (L["until_tick"] - tick) / SIM["LIFT_TRAVEL_TICKS"]))
                e = t * t * (3 - 2 * t)
                y0 = self._elev_of(1 if L["state"] == "MOVING_UP" else 2)
                y1 = self._elev_of(2 if L["state"] == "MOVING_UP" else 1)
                L["y"] = y0 + (y1 - y0) * e
            elif L["floor"] is not None:
                L["y"] = self._elev_of(L["floor"])
            if tick < L["until_tick"]:
                continue
            st = L["state"]
            if st == "IDLE":
                if not L["reserved_by"]:
                    heads = []
                    for f in ("1", "2"):
                        if L["queue"][f]:
                            rid = L["queue"][f][0]
                            heads.append((self.rt[rid].lift_enqueued_tick if rid in self.rt else 0, rid))
                    heads.sort()
                    if heads:
                        L["reserved_by"] = heads[0][1]
                        self.emit("LIFT_RESERVED", "LIFT", "INFO", f"{lid} reserved by {L['reserved_by']}", robot_id=L["reserved_by"])
                if L["reserved_by"]:
                    rr = S["robots"].get(L["reserved_by"])
                    if not rr or rr["status"] == "OFFLINE":
                        self.release_robot_from_lift(L["reserved_by"])
                    elif L["floor"] == rr["floor"]:
                        L["state"] = "DOOR_OPENING"; L["until_tick"] = tick + SIM["LIFT_DOOR_TICKS"]
                    else:
                        L["target_floor"] = rr["floor"]
                        L["state"] = "MOVING_UP" if rr["floor"] == 2 else "MOVING_DOWN"
                        L["floor"] = None; L["until_tick"] = tick + SIM["LIFT_TRAVEL_TICKS"]
            elif st in ("MOVING_UP", "MOVING_DOWN"):
                L["state"] = "LEVELING"; L["until_tick"] = tick + SIM["LIFT_LEVEL_TICKS"]
                self.emit("LIFT_LEVELING", "LIFT", "LOW", f"{lid} leveling at Floor {L['target_floor']}")
            elif st == "LEVELING":
                L["floor"] = L["target_floor"]; L["target_floor"] = None; L["y"] = self._elev_of(L["floor"])
                L["state"] = "DOOR_OPENING_AT_DESTINATION" if L["occupant"] else "DOOR_OPENING"
                L["until_tick"] = tick + SIM["LIFT_DOOR_TICKS"]
                self.emit("LIFT_ARRIVED", "LIFT", "INFO", f"{lid} arrived at Floor {L['floor']}")
            elif st == "DOOR_OPENING":
                if L["floor"] == 1: L["door_f1"] = "OPEN"
                else: L["door_f2"] = "OPEN"
                L["state"] = "BOARDING"
                self.emit("LIFT_GATE_OPENED", "LIFT", "LOW", f"{lid} Floor {L['floor']} gate opened")
            elif st == "BOARDING":
                rr = S["robots"].get(L["reserved_by"]) if L["reserved_by"] else None
                if not rr or rr["status"] == "OFFLINE":
                    if L["reserved_by"]:
                        self.release_robot_from_lift(L["reserved_by"])
                    L["door_f1"] = "CLOSED"; L["door_f2"] = "CLOSED"
                    L["state"] = "COOLDOWN"; L["until_tick"] = tick + SIM["LIFT_COOLDOWN_TICKS"]
                    self.emit("LIFT_COOLDOWN_STARTED", "LIFT", "LOW", f"{lid} cooldown")
            elif st == "DOOR_CLOSING":
                L["door_f1"] = "CLOSED"; L["door_f2"] = "CLOSED"
                if L["occupant"]:
                    rr = S["robots"][L["occupant"]]
                    rt = self.rt.get(L["occupant"])
                    dest = rt.pending["floor"] if rt and rt.pending else (2 if rr["floor"] == 1 else 1)
                    L["target_floor"] = dest
                    L["state"] = "MOVING_UP" if dest == 2 else "MOVING_DOWN"
                    L["floor"] = None; L["until_tick"] = tick + SIM["LIFT_TRAVEL_TICKS"]
                    L["trips"] += 1
                    self.emit("LIFT_DEPARTED", "LIFT", "INFO", f"{lid} departed → Floor {dest} ({L['occupant']})", robot_id=L["occupant"])
                else:
                    L["state"] = "COOLDOWN"; L["until_tick"] = tick + SIM["LIFT_COOLDOWN_TICKS"]
                    self.emit("LIFT_COOLDOWN_STARTED", "LIFT", "LOW", f"{lid} cooldown")
            elif st == "DOOR_OPENING_AT_DESTINATION":
                if L["floor"] == 1: L["door_f1"] = "OPEN"
                else: L["door_f2"] = "OPEN"
                L["state"] = "ALIGHTING"
                self.emit("LIFT_GATE_OPENED", "LIFT", "LOW", f"{lid} Floor {L['floor']} gate opened")
            elif st == "DOOR_CLOSING_AFTER_EXIT":
                L["door_f1"] = "CLOSED"; L["door_f2"] = "CLOSED"
                L["state"] = "COOLDOWN"; L["until_tick"] = tick + SIM["LIFT_COOLDOWN_TICKS"]
                self.emit("LIFT_COOLDOWN_STARTED", "LIFT", "LOW", f"{lid} cooldown")
            elif st == "COOLDOWN":
                L["state"] = "IDLE"

    def _handle_lift(self, r: dict[str, Any], rt: RobotRt) -> bool:
        S = self.state; tick = S["sim"]["tick"]
        stage = rt.lift_stage
        if stage is None or stage == "TO_LIFT":
            if rt.target is not None:
                return False
            L = S["lifts"][rt.lift_id]
            if L["fault"]:
                return self._re_route_lift(r, rt)
            f = str(r["floor"])
            if r["id"] not in L["queue"][f]:
                L["queue"][f].append(r["id"]); rt.lift_enqueued_tick = tick
                self.emit("LIFT_QUEUE_ENTERED", "LIFT", "LOW", f"{r['id']} queued at {rt.lift_id} (F{r['floor']}, #{len(L['queue'][f])})", robot_id=r["id"])
            self._set_lift_stage(r, rt, "QUEUED")
            return True
        L = S["lifts"][rt.lift_id]
        lay = self._lift_layout(rt.lift_id)
        if L["fault"] and stage not in ("RIDING", "ALIGHTING"):
            return self._re_route_lift(r, rt)
        if stage == "QUEUED":
            f = str(r["floor"])
            pos = L["queue"][f].index(r["id"]) if r["id"] in L["queue"][f] else -1
            if pos < 0:
                self._set_lift_stage(r, rt, "TO_LIFT"); return True
            # round-9f: queue advance follows the "clear lane". A straight cut to the queue cell from the east side / off the axis enters the boarding corridor at an angle,
            # and forms a mutual OBB lock with the queue head in BOARDING (one waits for the other to yield, one waits for the other to leave; neither moves).
            # Rule: x already aligned → enter the queue cell straight in; on the axis and west of the own queue cell → normal advance along the axis;
            # all other cases first move sideways 1.8 m off the axis (a step away from the axis is never blocked) → move parallel along the clear lane to the side of the queue cell → enter the queue cell straight in.
            slot = self._lift_slot(lay, min(pos, 2))
            dxs = r["position"][0] - slot[0]; dzs = r["position"][2] - slot[1]
            side = 1.0 if dzs >= 0 else -1.0
            if abs(dxs) < 0.25:
                goal = slot
            elif abs(dzs) < 0.25 and dxs < 0.35:
                goal = slot
            elif abs(dzs) > 1.55:
                goal = (slot[0], slot[1] + side * 1.8)
            else:
                goal = (r["position"][0], slot[1] + side * 1.8)
            self._micro_move(r, goal, SIM["LIFT_QUEUE_SPEED"])
            if pos == 0 and L["reserved_by"] == r["id"] and L["state"] == "BOARDING" and L["floor"] == r["floor"]:
                self._set_lift_stage(r, rt, "BOARDING")
                self.emit("ROBOT_BOARDING_STARTED", "LIFT", "INFO", f"{r['id']} boarding {rt.lift_id} → Floor {rt.pending['floor']}", robot_id=r["id"])
            return True
        if stage == "BOARDING":
            if self._micro_move(r, self._lift_cabin(lay), SIM["LIFT_BOARD_SPEED"]):
                f = str(r["floor"])
                if r["id"] in L["queue"][f]:
                    L["queue"][f].remove(r["id"])
                L["occupant"] = r["id"]; L["reserved_by"] = None; r["lift_id"] = rt.lift_id
                L["wait_total_ticks"] += tick - rt.lift_enqueued_tick; L["wait_n"] += 1
                L["state"] = "DOOR_CLOSING"; L["until_tick"] = tick + SIM["LIFT_DOOR_TICKS"]
                self._set_lift_stage(r, rt, "RIDING")
                self.emit("ROBOT_BOARDED", "LIFT", "INFO", f"{r['id']} boarded {rt.lift_id}", robot_id=r["id"])
            return True
        if stage == "RIDING":
            r["velocity"] = 0
            c = self._lift_cabin(lay); r["position"][0] = c[0]; r["position"][2] = c[1]
            if L["state"] == "ALIGHTING" and L["floor"] == rt.pending["floor"]:
                # The door is open → start to exit. The floor value must NOT change yet (spec §2.2: it changes only after the robot fully leaves the lift car / door area)
                self._set_lift_stage(r, rt, "ALIGHTING")
                self.emit("ROBOT_ALIGHTING_STARTED", "LIFT", "INFO", f"{r['id']} alighting {rt.lift_id} at Floor {L['floor']}", robot_id=r["id"])
            return True
        if stage == "ALIGHTING":
            tf = rt.pending["floor"]   # Compute the exit and separation fully on the destination floor; r["floor"] changes only at the moment the robot arrives at the exit
            if rt.lift_exit is None:
                rt.lift_exit = self._pick_lift_exit(lay, tf, tuple(rt.pending["point"])); rt.lift_blocked_ticks = 0; rt.lift_exit_phase = None
            gate = self._lift_gate_point(lay)
            # Three-stage lift exit (round-8d): in the lift car, first turn in place toward the door → move straight along the door axis until the robot REALLY arrives at the turn-safe point (door face − diagonal radius − 0.10 m)
            # → rotate in place toward the exit (speed 0, limited angular speed 4.0 rad/s, move only when the error is < 0.06 rad) → move to the exit.
            # Translation and rotation no longer occur at the same time: the rotation sweep (diagonal radius 0.584 m) stays away from the door frame at all times, and the view does not show a "swing while it moves".
            if not rt.lift_exit_phase:
                rt.lift_exit_phase = "TURN_OUT"

            def rotate_to(tx: float, tz: float) -> bool:
                want = math.atan2(tz - r["position"][2], tx - r["position"][0])
                dh = want - r["heading"]
                while dh > math.pi: dh -= 2 * math.pi
                while dh < -math.pi: dh += 2 * math.pi
                r["velocity"] = 0
                r["heading"] += _sign(dh) * min(abs(dh), 4.0 * SIM["TICK_S"])
                return abs(dh) < 0.06

            arrived = False
            if rt.lift_exit_phase == "TURN_OUT":
                if rotate_to(gate[0], gate[1]):
                    rt.lift_exit_phase = "OUT"
            elif rt.lift_exit_phase == "OUT":
                if self._micro_move(r, gate, SIM["LIFT_BOARD_SPEED"], tf):
                    rt.lift_exit_phase = "TURN_EXIT"
            elif rt.lift_exit_phase == "TURN_EXIT":
                if rotate_to(rt.lift_exit[0], rt.lift_exit[1]):
                    rt.lift_exit_phase = "GO"
            else:
                arrived = self._micro_move(r, rt.lift_exit, SIM["LIFT_BOARD_SPEED"], tf)
            if not arrived and r["velocity"] == 0 and rt.lift_exit_phase in ("OUT", "GO"):
                rt.lift_blocked_ticks += 1
                if rt.lift_blocked_ticks % 40 == 0:   # After a 4-second block, change the exit; after a change, first turn, then move
                    rt.lift_exit = self._pick_lift_exit(lay, tf, tuple(rt.pending["point"]), rt.lift_blocked_ticks // 40)
                    if rt.lift_exit_phase == "GO":
                        rt.lift_exit_phase = "TURN_EXIT"
            elif r["velocity"] > 0:
                rt.lift_blocked_ticks = 0
            if arrived:
                r["floor"] = tf   # ✅ The robot enters the destination floor grid only at the moment it fully leaves the door area
                L["occupant"] = None; r["lift_id"] = None
                L["state"] = "DOOR_CLOSING_AFTER_EXIT"; L["until_tick"] = tick + SIM["LIFT_DOOR_TICKS"]
                self.emit("ROBOT_EXITED", "LIFT", "INFO", f"{r['id']} exited {rt.lift_id} on Floor {r['floor']}", robot_id=r["id"])
                p = rt.pending; rt.pending = None; self._set_lift_stage(r, rt, None); rt.lift_id = None
                rt.lift_exit = None; rt.lift_blocked_ticks = 0; rt.lift_exit_phase = None
                self._plan_to(r, rt, tuple(p["point"]), p["phase"], p["loc_id"], p["floor"])
            return True
        return False

    def _re_route_lift(self, r: dict[str, Any], rt: RobotRt) -> bool:
        tick = self.state["sim"]["tick"]
        if tick < rt.lift_retry_tick:
            r["velocity"] = 0; return True
        rt.lift_retry_tick = tick + SIM["LIFT_RETRY_TICKS"]
        p = rt.pending
        self.release_robot_from_lift(r["id"])
        rt.pending = p
        alive = [l for l in self.layout["lifts"] if not self.state["lifts"][l["id"]]["fault"]]
        if not alive:
            r["velocity"] = 0; return True
        self._plan_to(r, rt, tuple(p["point"]), p["phase"], p["loc_id"], p["floor"])
        self.emit("ROUTE_REPLANNED", "LIFT", "MEDIUM", f"{r['id']} rerouted to {rt.lift_id} (lift fault)", robot_id=r["id"])
        return True

    def _step_robot(self, r: dict[str, Any], rt: RobotRt) -> None:
        S = self.state; tick = S["sim"]["tick"]
        if r["fsm"] == "OFFLINE":
            r["velocity"] = 0; return
        self._battery_tick(r, rt)
        task = S["tasks"].get(r["current_task_id"]) if r["current_task_id"] else None
        if rt.pending is not None and self._handle_lift(r, rt):
            r["status"] = self._status_of(r)
            if r["fsm"] not in ("IDLE", "CHARGING"):
                r["stats"]["busy_ticks"] += 1
            r["zone"] = self._zone_at(r["position"][0], r["position"][2], r["floor"])
            return
        f = r["fsm"]
        if f == "IDLE":
            r["velocity"] = 0; rt.idle_ticks += 1
            if r["battery"] < TH["BATTERY_WARNING"] + 15 and self._free_charger():
                self._go_charge(r, rt)
            else:
                if rt.idle_ticks > SIM["IDLE_TO_PARK_TICKS"] and not rt.phase and r["floor"] == 1:
                    p = self._park_spot(r)
                    if p:
                        self._plan_to(r, rt, p, "TO_PARK")
                if rt.phase == "TO_PARK":
                    self._move_along_path(r, rt)
                    if rt.target is None and rt.pending is None:
                        rt.phase = None
        elif f == "TASK_ASSIGNED":
            rt.idle_ticks = 0
            if not task:
                self._set_fsm(r, "IDLE")
            else:
                src = self.loc[task["source"]]
                self._plan_to(r, rt, tuple(src["access_point"]), "TO_SOURCE", task["source"])
                task["status"] = "IN_PROGRESS"; task["started_tick"] = tick
                self._set_fsm(r, "NAVIGATING")
        elif f == "NAVIGATING":
            if not task:
                self._set_fsm(r, "IDLE")
            else:
                self._move_along_path(r, rt)
                if rt.target is None and rt.pending is None:
                    rt.dwell = SIM["PICK_TICKS"]; self._set_fsm(r, "PICKING")
        elif f == "PICKING":
            r["velocity"] = 0
            rt.dwell -= 1
            if rt.dwell <= 0 and task:
                dest = self.loc.get(task["destination"])
                if not dest:   # Defense: the task destination does not exist (normally cannot occur; create_task validates it) → the task fails, the robot returns to IDLE; the loop must not crash
                    task["status"] = "FAILED"; task["completed_tick"] = tick
                    self.emit("TASK_FAILED", "SIMULATION", "HIGH", f"Task #{task['id']} failed: unknown destination {task['destination']}", robot_id=r["id"], task_id=task["id"])
                    r["current_task_id"] = None; r["destination"] = None; rt.phase = None; rt.goal_loc = None
                    self._set_fsm(r, "IDLE"); return
                r["load"]["current"] = min(r["load"]["capacity"], task["load_units"])
                self.emit("TASK_STARTED", "ROBOT", "INFO", f"{r['id']} picked item at {self.pretty(task['source'])}", robot_id=r["id"], task_id=task["id"])
                self._plan_to(r, rt, tuple(dest["access_point"]), "TO_DEST", task["destination"])
                self._set_fsm(r, "TRANSPORTING")
        elif f == "TRANSPORTING":
            if not task:
                self._set_fsm(r, "IDLE")
            else:
                low = False
                if r["battery"] < TH["BATTERY_WARNING"] and rt.last_battery_alert != "CRIT":
                    remain = self._remaining_path_length(r)
                    need = remain * (SIM["BATTERY_MOVE"] + SIM["BATTERY_LOAD"]) / (SIM["MAX_SPEED"] * SIM["TICK_S"]) + 3
                    if need > r["battery"] - TH["BATTERY_CRITICAL"]:
                        self._set_fsm(r, "LOW_BATTERY"); low = True
                if not low:
                    self._move_along_path(r, rt)
                    if rt.target is None and rt.pending is None:
                        rt.dwell = SIM["DROP_TICKS"] * self._station_slowdown(task["destination"]); self._set_fsm(r, "DELIVERING")
        elif f == "DELIVERING":
            r["velocity"] = 0
            rt.dwell -= 1
            if rt.dwell <= 0:
                self._complete_task(r, rt)
        elif f == "COMPLETED":
            self._set_fsm(r, "IDLE"); rt.idle_ticks = 0
        elif f == "LOW_BATTERY":
            r["velocity"] = 0; self._set_fsm(r, "TASK_TRANSFER")
        elif f == "TASK_TRANSFER":
            if task:
                task["status"] = "TRANSFERRED"; task["completed_tick"] = tick
                nt = self.create_task(task["type"], "HIGH" if task["priority"] == "NORMAL" else task["priority"], task["source"], task["destination"], task["load_units"])
                nt["parent_task_id"] = task["id"]
                self.emit("TASK_TRANSFERRED", "FLEET_MANAGER", "MEDIUM", f"{r['id']} low battery — task #{task['id']} re-queued as #{nt['id']}", robot_id=r["id"], task_id=nt["id"])
                r["load"]["current"] = 0; r["current_task_id"] = None
            self._go_charge(r, rt)
        elif f == "GOING_TO_CHARGE":
            self._move_along_path(r, rt)
            if rt.target is None and rt.pending is None:
                self._set_fsm(r, "CHARGING")
                # Dock alignment (round-9d): stop at the exact center of the blue charge plate of the robot's own charger, nose toward the charger — the frontend tween shows it as a dock move
                chg = next((c for c in self.layout["charging_stations"] if c["id"] == rt.charger_id), None) if rt.charger_id else None
                if chg:
                    # −1.9 = center of the full parking-row grid cell (64.5): 1.0 m clearance to the south corridor, so a robot behind can pass (round-9e queue deadlock fix)
                    r["position"][0] = chg["position"][0]; r["position"][2] = chg["position"][2] - 1.9
                    r["heading"] = math.pi / 2; r["velocity"] = 0
                self.emit("ROBOT_STATE_CHANGED", "ROBOT", "INFO", f"{r['id']} charging started ({js_to_fixed0(r['battery'])}%)", robot_id=r["id"])
        elif f == "CHARGING":
            r["velocity"] = 0
            r["battery"] = min(100, r["battery"] + SIM["CHARGE_RATE"])
            if r["battery"] >= TH["BATTERY_CHARGE_TO"]:
                if rt.charger_id:
                    self.charger_busy[rt.charger_id] = None
                rt.charger_id = None
                rt.last_battery_alert = "NONE"; self._resolve_alert(f"bat-{r['id']}")
                self._set_fsm(r, "IDLE"); rt.idle_ticks = 0
                self.emit("ROBOT_STATE_CHANGED", "ROBOT", "INFO", f"{r['id']} charging complete", robot_id=r["id"])
        elif f == "OBSTACLE_DETECTED":
            self._set_fsm(r, "REPLANNING")
        elif f == "REPLANNING":
            if rt.target:
                p = astar(self.grids[r["floor"]], to_cell(r["position"][0], r["position"][2]), rt.target, blocked=self._blocked_cells(r["id"], r["floor"]), cost_map=self._congestion_cost(r["floor"]))
                if p is not None:
                    r["path"] = [list(c) for c in p]; r["path_index"] = 0; rt.wait_ticks = 0
                    self.emit("ROUTE_REPLANNED", "PLANNER", "LOW", f"{r['id']} rerouted ({len(p)} cells)", robot_id=r["id"], task_id=r["current_task_id"])
            self._set_fsm(r, "TRANSPORTING" if rt.phase == "TO_DEST" else "GOING_TO_CHARGE" if rt.phase == "TO_CHARGER" else "IDLE" if rt.phase == "TO_PARK" else "NAVIGATING")
        elif f == "ERROR":
            r["velocity"] = 0
        r["status"] = self._status_of(r)
        if r["fsm"] not in ("IDLE", "CHARGING"):
            r["stats"]["busy_ticks"] += 1
        r["zone"] = self._zone_at(r["position"][0], r["position"][2], r["floor"])

    def _complete_task(self, r: dict[str, Any], rt: RobotRt) -> None:
        S = self.state
        task = S["tasks"].get(r["current_task_id"]) if r["current_task_id"] else None
        if task:
            task["status"] = "COMPLETED"; task["completed_tick"] = S["sim"]["tick"]
            self.task_times.append(S["sim"]["tick"] - task["created_tick"])
            if len(self.task_times) > 200:
                self.task_times.pop(0)
            self.completed_count += 1
            if task["deadline_tick"] is None or S["sim"]["tick"] <= task["deadline_tick"]:
                self.on_time += 1
            r["stats"]["tasks_completed"] += 1
            self.emit("TASK_COMPLETED", "ROBOT", "INFO", f"{r['id']} completed task #{task['id']} at {self.pretty(task['destination'])}", robot_id=r["id"], task_id=task["id"])
        r["load"]["current"] = 0; r["current_task_id"] = None; r["destination"] = None; rt.phase = None; rt.goal_loc = None
        self._set_fsm(r, "COMPLETED")

    # ─────────────────────────────────────────────────────────
    # Paths and movement
    # ─────────────────────────────────────────────────────────
    def _free_service_cell(self, r: dict[str, Any], point: tuple[float, float]) -> Optional[tuple[int, int]]:
        """Service cell of a station or shelf: a walkable grid cell around the access point, not a target of and not occupied by another robot; pick the nearest to the robot. Return None when all are full."""
        grid = self.grids[r["floor"]]
        ap = nearest_walkable(grid, point[0], point[1])
        claimed: set[tuple[int, int]] = set()
        for rid, o in self.state["robots"].items():
            if rid == r["id"] or o["floor"] != r["floor"]:
                continue
            t = self.rt[rid].target
            if t: claimed.add((t[0], t[1]))
            claimed.add(to_cell(o["position"][0], o["position"][2]))
        my = to_cell(r["position"][0], r["position"][2])
        best: Optional[tuple[int, int]] = None; best_d = math.inf
        R = SIM["SERVICE_RADIUS"]
        for dr in range(-R, R + 1):
            for dc in range(-R, R + 1):
                c = (ap[0] + dc, ap[1] + dr)
                if not is_walkable(grid, c[0], c[1]) or c in claimed:
                    continue
                d = math.hypot(c[0] - my[0], c[1] - my[1]) + math.hypot(dc, dr) * 0.01
                if d < best_d:
                    best_d = d; best = c
        return best

    def lift_cost(self, r: dict[str, Any], l: dict[str, Any]) -> float:
        """Lift cost (spec §7.2): travel to the lift + queue estimate + positioning estimate; FAULT = inf (same as TS)."""
        L = self.state["lifts"][l["id"]]
        if L["fault"]:
            return math.inf
        approach = math.hypot(r["position"][0] - (l["cell"][0] - 1.5), r["position"][2] - (l["cell"][1] + 0.5)) / (SIM["MAX_SPEED"] * 0.8)
        # The robot with the reservation stays in the queue until it boards; add the extra +1 only when it is "in no queue" (it left the queue and boards now). This prevents a double count of the wait cost.
        rb = L["reserved_by"]
        reserved_extra = 1 if rb and rb not in L["queue"]["1"] and rb not in L["queue"]["2"] else 0
        queue_len = len(L["queue"]["1"]) + len(L["queue"]["2"]) + reserved_extra
        per_service = (SIM["LIFT_DOOR_TICKS"] * 4 + SIM["LIFT_TRAVEL_TICKS"] + SIM["LIFT_LEVEL_TICKS"] + SIM["LIFT_COOLDOWN_TICKS"] + 40) * SIM["TICK_S"]
        busy = 0 if L["state"] == "IDLE" else per_service * 0.5
        wrong_floor = SIM["LIFT_TRAVEL_TICKS"] * SIM["TICK_S"] if (L["floor"] is not None and L["floor"] != r["floor"]) else 0
        return approach + queue_len * per_service + busy + wrong_floor

    def _pick_lift(self, r: dict[str, Any]) -> Optional[dict[str, Any]]:
        c = sorted(({"l": l, "cost": self.lift_cost(r, l)} for l in self.layout["lifts"]), key=lambda x: (x["cost"], x["l"]["id"]))
        return c[0]["l"] if c and c[0]["cost"] < math.inf else None

    def _plan_to(self, r: dict[str, Any], rt: RobotRt, point: tuple[float, float], phase: str, loc_id: Optional[str] = None, target_floor: Optional[int] = None) -> None:
        tf = target_floor if target_floor is not None else (self.loc[loc_id].get("floor", 1) if loc_id and loc_id in self.loc else r["floor"])
        if tf != r["floor"]:
            # Cross-floor (spec §7): Origin → queue cell (A*) → lift state machine → replan on the destination floor
            # Prefer the lift recorded in the audit at dispatch time (re-pick only when that lift is in FAULT); clear the record after use (round-6 P2)
            preferred = None
            if rt.planned_lift_id:
                pl = next((l for l in self.layout["lifts"] if l["id"] == rt.planned_lift_id), None)
                if pl is not None and not self.state["lifts"][pl["id"]]["fault"]:
                    preferred = pl
            rt.planned_lift_id = None
            lift = preferred or self._pick_lift(r)
            rt.pending = {"point": point, "phase": phase, "loc_id": loc_id, "floor": tf}
            if lift is None:   # All lifts in fault: wait in place, retry periodically
                rt.lift_id = self.layout["lifts"][0]["id"] if self.layout["lifts"] else None
                self._set_lift_stage(r, rt, "TO_LIFT")
                rt.target = None; r["path"] = []; r["path_index"] = 0
                rt.lift_retry_tick = self.state["sim"]["tick"] + SIM["LIFT_RETRY_TICKS"]
                return
            rt.lift_id = lift["id"]
            self._set_lift_stage(r, rt, "TO_LIFT")
            self.emit("LIFT_REQUESTED", "LIFT", "LOW", f"{r['id']} requested {lift['id']} (F{r['floor']} → F{tf})", robot_id=r["id"])
            L = self.state["lifts"][lift["id"]]
            slot_idx = min(len(L["queue"][str(r["floor"])]), 2)
            sp = self._lift_slot(lift, slot_idx)
            start = to_cell(r["position"][0], r["position"][2])
            goal = (math.floor(sp[0]), math.floor(sp[1]))
            grid = self.grids[r["floor"]]
            path = astar(grid, start, goal, blocked=self._blocked_cells(r["id"], r["floor"]), cost_map=self._congestion_cost(r["floor"]))
            if path is None:
                path = astar(grid, start, goal)
            if path is None:
                path = []
            r["path"] = [list(c) for c in path]; r["path_index"] = 0
            rt.target = goal; rt.phase = phase; rt.goal_loc = loc_id; rt.wait_ticks = 0; rt.backing_off = False; rt.resume_point = None
            r["destination"] = loc_id
            if not path and start != goal:
                rt.target = None
            self._update_eta(r)
            return
        start = to_cell(r["position"][0], r["position"][2])
        grid = self.grids[r["floor"]]
        # TO_CHARGER does not use a service cell (round-9d): a service cell scatters robots over any free grid cell near the chargers — a charge move must go directly to the entry cell of the robot's own charger
        goal = (self._free_service_cell(r, point) if loc_id and phase != "TO_CHARGER" else None) or nearest_walkable(grid, point[0], point[1])
        path = astar(grid, start, goal, blocked=self._blocked_cells(r["id"], r["floor"]), cost_map=self._congestion_cost(r["floor"]))
        if path is None:
            path = astar(grid, start, goal)
        if path is None:
            path = []
        r["path"] = [list(c) for c in path]; r["path_index"] = 0
        rt.target = goal; rt.phase = phase; rt.goal_loc = loc_id; rt.wait_ticks = 0; rt.backing_off = False; rt.resume_point = None
        r["destination"] = loc_id
        if not path and start != goal:
            rt.target = None
        self._update_eta(r)

    def _move_along_path(self, r: dict[str, Any], rt: RobotRt) -> None:
        if rt.target is None:
            return
        if r["path_index"] >= len(r["path"]):
            rt.target = None; r["velocity"] = 0; r["path"] = []; r["path_index"] = 0; return
        nxt = r["path"][r["path_index"]]
        ncell = (nxt[0], nxt[1])
        tx, tz = cell_center(ncell)
        pos = r["position"]
        dx = tx - pos[0]; dz = tz - pos[2]
        dist = math.hypot(dx, dz)
        fl = r["floor"]
        occ = self.occupancy.get((fl, ncell[0], ncell[1]))
        my_cell = to_cell(pos[0], pos[2])
        entering = my_cell != ncell
        if entering and not occ and ncell[0] != my_cell[0] and ncell[1] != my_cell[1]:
            a = self.occupancy.get((fl, ncell[0], my_cell[1])); b = self.occupancy.get((fl, my_cell[0], ncell[1]))
            if a and a != r["id"]: occ = a
            elif b and b != r["id"]: occ = b
        # Perception layer: a dynamic obstacle < PERC_STOP ahead on the path also counts as a block (stop one grid cell earlier than the cell reservation, so robot bodies no longer touch)
        blocked_by = occ if (entering and occ and occ != r["id"]) else None
        perc_stop = rt.front_id is not None and rt.front_dist < SIM["PERC_STOP"]
        if not blocked_by and perc_stop:
            blocked_by = rt.front_id
        if blocked_by:
            occ = blocked_by
            # On the way to the lift, a queued robot blocks the lobby entrance: count this as arrival; after the robot joins the queue, the queue logic advances it
            if rt.lift_stage == "TO_LIFT" and len(r["path"]) - r["path_index"] <= 2:
                rt.target = None; r["velocity"] = 0; r["path"] = []; r["path_index"] = 0; rt.wait_ticks = 0; return
            if perc_stop and r["perception"]["state"] != "STOPPED":
                r["perception"]["state"] = "STOPPED"
                if self.state["sim"]["tick"] - rt.last_perc_event > SIM["PERC_EVENT_TICKS"] and rt.front_id and rt.front_id in self.state["robots"]:
                    rt.last_perc_event = self.state["sim"]["tick"]
                    self.emit("OBSTACLE_DETECTED", "ROBOT", "LOW", f"{r['id']} LiDAR: {rt.front_id} ahead {rt.front_dist:.1f} m — holding", robot_id=r["id"])
            remaining0 = len(r["path"]) - r["path_index"]
            # Queue at a station: at <= N grid cells from the target, count this as arrival and work in place
            if not rt.backing_off and remaining0 <= SIM["STATION_ARRIVE_CELLS"] and rt.phase in ("TO_SOURCE", "TO_DEST"):
                # First look for another free service cell (one grid cell per robot, no overlap); work in place only when all are really full
                loc = self.loc.get(rt.goal_loc) if rt.goal_loc else None
                alt = self._free_service_cell(r, tuple(loc["access_point"])) if loc else None
                if alt and rt.target and (alt[0] != rt.target[0] or alt[1] != rt.target[1]):
                    p = astar(self.grids[fl], my_cell, alt, blocked=self._blocked_cells(r["id"], fl))
                    if p:
                        r["path"] = [list(c) for c in p]; r["path_index"] = 0; rt.target = alt; rt.wait_ticks = 0; return
                rt.target = None; r["velocity"] = 0; r["path"] = []; r["path_index"] = 0; r["eta_s"] = 0; rt.wait_ticks = 0; return
            r["velocity"] = max(0, r["velocity"] - SIM["ACCEL"] * SIM["TICK_S"] * 2)
            rt.wait_ticks += 1; r["stats"]["wait_ticks"] += 1
            other = self.state["robots"].get(occ)
            mutual = bool(other) and ((other["path_index"] < len(other["path"]) and tuple(other["path"][other["path_index"]]) == my_cell) or self.rt[other["id"]].front_id == r["id"])
            if mutual and rt.wait_ticks > 10 and self._yields_to(r, other):
                self._back_off(r, rt); return
            if rt.wait_ticks == SIM["WAIT_REPLAN_TICKS"]:
                self.emit("OBSTACLE_DETECTED", "ROBOT", "LOW", f"{r['id']} blocked by {occ} — replanning", robot_id=r["id"])
                self._set_fsm(r, "OBSTACLE_DETECTED")
            elif rt.wait_ticks >= SIM["WAIT_BACKOFF_TICKS"]:
                self._back_off(r, rt)
            return
        # Note: wait_ticks does not reset to zero here — it resets only after the robot "really moved" (round-8b).
        # Otherwise a stop from the pure physical separation (the MIN_SEP check below) resets it to 1 each tick, it never reaches the back-off threshold,
        # and two robots in a 0.9 m narrow aisle standoff deadlock forever.
        if entering:
            self.occupancy[(fl, ncell[0], ncell[1])] = r["id"]   # Reserve the next grid cell immediately
            if ncell[0] != my_cell[0] and ncell[1] != my_cell[1]:   # Diagonal: also reserve the two orthogonal neighbor grid cells
                for k in ((fl, ncell[0], my_cell[1]), (fl, my_cell[0], ncell[1])):
                    if k not in self.occupancy: self.occupancy[k] = r["id"]
        desired = math.atan2(dz, dx)
        dh = desired - r["heading"]
        while dh > math.pi: dh -= 2 * math.pi
        while dh < -math.pi: dh += 2 * math.pi
        turning = abs(dh) > 0.3
        remaining = len(r["path"]) - r["path_index"]
        walk = self.grids[fl].cells[ncell[1] * self.grid.cols + ncell[0]] == 2
        slowing = rt.front_id is not None and rt.front_dist < SIM["PERC_SLOW"]
        if slowing:
            r["perception"]["state"] = "SLOWING"
        vmax = r["max_speed"] * (SIM["TURN_SLOW"] if turning else 1) * (0.5 if remaining <= 1 else 1) * (0.6 if walk else 1) * (self._zone_speed_factor(ncell, fl) if self.congested_zones else 1) * (0.45 if slowing else 1)
        r["velocity"] = min(vmax, r["velocity"] + SIM["ACCEL"] * SIM["TICK_S"])
        r["heading"] += _sign(dh) * min(abs(dh), 4.0 * SIM["TICK_S"])
        step_len = min(dist, r["velocity"] * SIM["TICK_S"])
        if dist > 1e-6:
            nx = pos[0] + (dx / dist) * step_len; nz = pos[2] + (dz / dist) * step_len
            # Physical collision guard: this step makes me "come closer" to some robot and (center distance < MIN_SEP, or the rotated robot body OBB intersects +5cm) → do not move (round-9b adds the OBB test)
            for oid, o in self.state["robots"].items():
                if oid == r["id"] or o["floor"] != fl:
                    continue
                dn = math.hypot(nx - o["position"][0], nz - o["position"][2])
                dcur = math.hypot(pos[0] - o["position"][0], pos[2] - o["position"][2])
                hit = dn < dcur and (dn < SIM["MIN_SEP"] or (dn < 1.5 and self.obb_overlap(nx, nz, r["heading"], o["position"][0], o["position"][2], o["heading"], 0.05)))
                if hit:
                    r["velocity"] = 0; rt.wait_ticks += 1; r["stats"]["wait_ticks"] += 1
                    if rt.wait_ticks >= SIM["WAIT_BACKOFF_TICKS"]:
                        self._back_off(r, rt)
                    return
            pos[0] = nx; pos[2] = nz
            rt.wait_ticks = 0   # The block clears only after the robot really moved
        r["stats"]["distance_m"] += step_len
        # Traffic heatmap (one per floor)
        T = self.traffic.get(fl); TS_ = self.traffic_short.get(fl)
        if T is not None:
            ci = my_cell[1] * self.grid.cols + my_cell[0]
            if 0 <= ci < len(T):
                T[ci] += 1; TS_[ci] += 1
        if dist - step_len < 0.08:
            r["path_index"] += 1
            self.occupancy[(fl, ncell[0], ncell[1])] = r["id"]
            if r["path_index"] >= len(r["path"]):
                rt.target = None; r["velocity"] = 0; r["path"] = []; r["path_index"] = 0; r["eta_s"] = 0
                if rt.backing_off and rt.resume_point:
                    rp = rt.resume_point; rt.backing_off = False; rt.resume_point = None
                    # round-9b: after a yield on the way in TO_LIFT, the recovery plan keeps the original lift (unless it is in fault) —
                    # otherwise the cross-floor branch of _plan_to re-rolls the lift selection and breaks the "dispatch audit = real lift" consistency
                    if rt.lift_stage == "TO_LIFT" and rt.lift_id and not self.state["lifts"].get(rt.lift_id, {}).get("fault"):
                        rt.planned_lift_id = rt.lift_id
                    self._plan_to(r, rt, rp, rt.phase or "TO_SOURCE", rt.goal_loc)
        if self.state["sim"]["tick"] % 10 == 0:
            self._update_eta(r)

    @staticmethod
    def _yields_to(me: dict[str, Any], other: dict[str, Any]) -> bool:
        """Who yields: an empty robot yields to a loaded robot; when equal, the robot with the higher id yields."""
        if (me["load"]["current"] > 0) != (other["load"]["current"] > 0):
            return me["load"]["current"] == 0
        return me["id"] > other["id"]

    def _back_off(self, r: dict[str, Any], rt: RobotRt) -> None:
        """Yield: move to a nearby free grid cell that no robot will pass, then return to the original target and replan."""
        if rt.backing_off or rt.target is None:
            rt.wait_ticks = 0; return
        my = to_cell(r["position"][0], r["position"][2])
        claimed: set[tuple[int, int]] = set()
        for o in self.state["robots"].values():
            if o["id"] == r["id"] or o["floor"] != r["floor"]: continue
            claimed.add(to_cell(o["position"][0], o["position"][2]))
            for c in o["path"][o["path_index"]:o["path_index"] + 4]:
                claimed.add((c[0], c[1]))
        best = None; best_d = 99
        for dr in range(-3, 4):
            for dc in range(-3, 4):
                if not dr and not dc: continue
                c = (my[0] + dc, my[1] + dr)
                if not is_walkable(self.grids[r["floor"]], c[0], c[1]) or c in claimed: continue
                d = abs(dr) + abs(dc)
                if d < best_d: best_d = d; best = c
        rt.wait_ticks = 0
        if best is None: return
        p = astar(self.grids[r["floor"]], my, best, blocked=claimed)
        if not p: return
        gx, gz = cell_center(rt.target)
        rt.resume_point = (gx, gz); rt.backing_off = True; rt.target = best
        r["path"] = [list(c) for c in p]; r["path_index"] = 0
        self.emit("ROBOT_COLLISION_AVOIDED", "PLANNER", "LOW", f"{r['id']} yields (back-off {len(p)} cells)", robot_id=r["id"])

    def _remaining_path_length(self, r: dict[str, Any]) -> float:
        length = 0.0; px, pz = r["position"][0], r["position"][2]
        for i in range(r["path_index"], len(r["path"])):
            cx, cz = cell_center((r["path"][i][0], r["path"][i][1]))
            length += math.hypot(cx - px, cz - pz); px, pz = cx, cz
        return length

    def _update_eta(self, r: dict[str, Any]) -> None:
        r["eta_s"] = jsround(self._remaining_path_length(r) / (r["max_speed"] * 0.8)) if r["path"] else None

    # ─────────────────────────────────────────────────────────
    # Phase 7: virtual LiDAR perception (270° / 4 m), same logic as the TS engine
    # ─────────────────────────────────────────────────────────
    def _line_of_sight(self, grid: NavGrid, x0: float, z0: float, x1: float, z1: float) -> bool:
        d = math.hypot(x1 - x0, z1 - z0); n = max(1, math.ceil(d / 0.5))
        for i in range(1, n):
            t = i / n
            c = to_cell(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)
            if not is_walkable(grid, c[0], c[1]):
                return False
        return True

    def _update_perception(self, r: dict[str, Any], rt: RobotRt) -> None:
        P = r["perception"]
        if r["fsm"] == "OFFLINE":
            P["state"] = "OFF"; P["obstacles"] = []; P["nearest_m"] = None; P["ahead_m"] = 0
            rt.front_id = None; rt.front_dist = math.inf; return
        x, z = r["position"][0], r["position"][2]; h = r["heading"]; cos_h = math.cos(h); sin_h = math.sin(h)
        grid = self.grids[r["floor"]]
        obs: list[dict[str, Any]] = []

        def consider(kind: str, oid: str, ox: float, oz: float) -> None:
            dx = ox - x; dz = oz - z; dist = math.hypot(dx, dz)
            if dist > SIM["LIDAR_RANGE"] or dist < 1e-6:
                return
            b = math.atan2(dz, dx) - h
            while b > math.pi: b -= 2 * math.pi
            while b < -math.pi: b += 2 * math.pi
            if abs(b) > SIM["LIDAR_FOV"] / 2:
                return
            if not self._line_of_sight(grid, x, z, ox, oz):
                return
            obs.append({"kind": kind, "id": oid, "distance_m": jsround(dist * 10) / 10, "bearing_deg": jsround(-b * 180 / math.pi)})

        for oid, o in self.state["robots"].items():
            if oid != r["id"] and o["floor"] == r["floor"]:
                consider("ROBOT", oid, o["position"][0], o["position"][2])
        for pid, p in self.state["people"].items():
            if p.get("floor", 1) == r["floor"]:
                consider("HUMAN", pid, p["position"][0], p["position"][2])
        ahead = SIM["LIDAR_RANGE"]
        d = 0.5
        while d <= SIM["LIDAR_RANGE"] + 1e-9:
            c = to_cell(x + cos_h * d, z + sin_h * d)
            if not is_walkable(grid, c[0], c[1]):
                ahead = d; break
            d += 0.25
        if ahead < SIM["LIDAR_RANGE"]:
            obs.append({"kind": "RACK", "id": None, "distance_m": jsround(ahead * 10) / 10, "bearing_deg": 0})
        obs.sort(key=lambda o: (o["distance_m"], o["id"] or ""))
        front_id: Optional[str] = None; front_dist = math.inf
        if r["path_index"] < len(r["path"]):
            on_path: set[tuple[int, int]] = set(); prev = to_cell(x, z)
            for i in range(r["path_index"], min(len(r["path"]), r["path_index"] + SIM["PERC_LOOKAHEAD"])):
                c = (r["path"][i][0], r["path"][i][1]); on_path.add(c)
                if c[0] != prev[0] and c[1] != prev[1]:
                    on_path.add((c[0], prev[1])); on_path.add((prev[0], c[1]))
                prev = c
            for o in obs:
                if o["kind"] == "RACK" or o["id"] is None:
                    continue
                pos = self.state["robots"][o["id"]]["position"] if o["kind"] == "ROBOT" else self.state["people"][o["id"]]["position"]
                if to_cell(pos[0], pos[2]) in on_path and o["distance_m"] < front_dist:
                    front_dist = o["distance_m"]; front_id = o["id"]
        rt.front_id = front_id; rt.front_dist = front_dist
        P["obstacles"] = obs[:5]
        P["nearest_m"] = obs[0]["distance_m"] if obs else None
        P["ahead_m"] = jsround(min(ahead, front_dist if front_id else ahead) * 10) / 10
        P["state"] = "CLEAR"

    def _rebuild_occupancy(self) -> None:
        self.occupancy.clear()
        for rid, r in self.state["robots"].items():
            fl = r["floor"]
            c = to_cell(r["position"][0], r["position"][2]); self.occupancy[(fl, c[0], c[1])] = rid
            if r["path_index"] < len(r["path"]):
                n = (fl, r["path"][r["path_index"]][0], r["path"][r["path_index"]][1])
                if n not in self.occupancy:
                    self.occupancy[n] = rid
                if n[1] != c[0] and n[2] != c[1]:   # Diagonal: also reserve the orthogonal neighbor grid cells
                    for k in ((fl, n[1], c[1]), (fl, c[0], n[2])):
                        if k not in self.occupancy: self.occupancy[k] = rid

    def _blocked_cells(self, self_id: str, floor: int) -> set[tuple[int, int]]:
        s = {(k[1], k[2]) for k, v in self.occupancy.items() if v != self_id and k[0] == floor}
        for zid in self.blocked_zones:
            z = next((zz for zz in self.layout["zones"] if zz["id"] == zid), None)
            if not z or z.get("floor", 1) != floor:
                continue
            b = self._zone_bounds.get(zid)
            if not b: continue
            x0, z0, x1, z1 = b
            for c in range(math.floor(x0), math.floor(x1)):
                for r in range(math.floor(z0), math.floor(z1)):
                    s.add((c, r))
        return s

    def _congestion_cost(self, floor: int = 1) -> Optional[list[float]]:
        """Use the traffic heatmap of the floor as extra cost (round-5 fix: one per floor); an injected congestion zone adds cost only on the same floor."""
        T = self.traffic.get(floor)
        if T is None:
            return None
        mx = max(T) if T else 0
        zones_on_floor = [zid for zid in self.congested_zones if self._zone_floor.get(zid, 1) == floor]
        if mx < 1 and not zones_on_floor:
            return None
        out = [t * (0.8 / mx) for t in T] if mx >= 1 else [0.0] * len(T)
        for zid in zones_on_floor:
            cz = self.congested_zones[zid]
            b = self._zone_bounds.get(zid)
            if not b: continue
            x0, z0, x1, z1 = b; add = 3 * cz["level"]; cols = self.grid.cols
            for rr in range(math.floor(z0), math.ceil(z1)):
                base = rr * cols
                for c in range(math.floor(x0), math.ceil(x1)):
                    out[base + c] += add
        return out

    def _zone_speed_factor(self, cell: tuple[int, int], floor: int) -> float:
        for zid, cz in self.congested_zones.items():
            z = next((zz for zz in self.layout["zones"] if zz["id"] == zid), None)
            if not z or z.get("floor", 1) != floor:
                continue
            b = self._zone_bounds.get(zid)
            if b and b[0] <= cell[0] < b[2] and b[1] <= cell[1] < b[3]:
                return 1 - 0.7 * cz["level"]
        return 1.0

    def _decay_traffic(self) -> None:
        if self.state["sim"]["tick"] % 5 == 0:
            for f in self.traffic:
                self.traffic[f] = [t * 0.9985 for t in self.traffic[f]]
                self.traffic_short[f] = [t * 0.975 for t in self.traffic_short[f]]

    # ─────────────────────────────────────────────────────────
    # Battery
    # ─────────────────────────────────────────────────────────
    def _battery_tick(self, r: dict[str, Any], rt: RobotRt) -> None:
        if r["fsm"] == "CHARGING":
            return
        moving = r["velocity"] > 0.05
        drain = (SIM["BATTERY_MOVE"] * (r["velocity"] / r["max_speed"]) + (SIM["BATTERY_LOAD"] if r["load"]["current"] > 0 else 0)) if moving else SIM["BATTERY_IDLE"]
        r["battery"] = max(0, r["battery"] - drain)
        r["stats"]["energy_wh"] += drain * 0.5
        b = r["battery"]
        if b < TH["BATTERY_CRITICAL"] and rt.last_battery_alert != "CRIT":
            rt.last_battery_alert = "CRIT"
            self.emit("ROBOT_BATTERY_CRITICAL", "ROBOT", "CRITICAL", f"{r['id']} Battery Critical ({js_to_fixed0(b)}%)", robot_id=r["id"], zone_id=r["zone"])
            self._raise_alert(f"bat-{r['id']}", "CRITICAL", f"{r['id']}  Battery Critical", f"{js_to_fixed0(b)}% remaining", robot_id=r["id"], zone_id=r["zone"])
        elif b < TH["BATTERY_WARNING"] and rt.last_battery_alert == "NONE":
            rt.last_battery_alert = "WARN"
            self.emit("ROBOT_BATTERY_LOW", "ROBOT", "HIGH", f"{r['id']} Battery Low ({js_to_fixed0(b)}%)", robot_id=r["id"], zone_id=r["zone"])
            self._raise_alert(f"bat-{r['id']}", "HIGH", f"{r['id']}  Battery Low", f"{js_to_fixed0(b)}% remaining", robot_id=r["id"], zone_id=r["zone"])
        if b <= 0 and r["fsm"] != "ERROR":
            self._set_fsm(r, "ERROR")
            self.emit("ROBOT_OFFLINE", "ROBOT", "CRITICAL", f"{r['id']} battery depleted — stopped", robot_id=r["id"])

    def _station_slowdown(self, loc_id: str) -> int:
        """When the conveyor that feeds the station is in fault, the unload waits for manual work: dwell time x4 (the bottleneck source in Demo 04)."""
        cv = next((c for c in self.layout["conveyors"] if c.get("feeds") == loc_id), None)
        if not cv: return 1
        st = self.state["conveyors"].get(cv["id"], {}).get("status")
        return 4 if st in ("ERROR", "STOPPED") else 2 if st in ("WARNING", "MAINTENANCE") else 1

    def _update_devices(self) -> None:
        S = self.state; robots = list(S["robots"].values()); tick = S["sim"]["tick"]
        for sid, s in S["sensors"].items():
            ls = next((x for x in self.layout["sensors"] if x["id"] == sid), None)
            if not ls or s["status"] == "OFFLINE": continue
            near = sum(1 for r in robots if math.hypot(r["position"][0] - ls["position"][0], r["position"][2] - ls["position"][2]) < 10)
            if s["kind"] == "PRESENCE": s["value"] = 1 if near > 0 else 0; s["unit"] = "bool"
            elif s["kind"] == "LIDAR": s["value"] = near; s["unit"] = "objects"
            elif s["kind"] == "TEMP": s["value"] = jsround((21 + math.sin(tick / 3000) * 1.5) * 10) / 10; s["unit"] = "°C"
            elif s["kind"] == "WEIGHT": cv = S["conveyors"].get("CV03"); s["value"] = cv["items_on_belt"] * 12 if cv else 0; s["unit"] = "kg"
        for cid, c in S["conveyors"].items():
            lc = next((x for x in self.layout["conveyors"] if x["id"] == cid), None)
            if c["status"] == "RUNNING":
                deliveries = sum(1 for r in robots if r["fsm"] == "DELIVERING" and lc and r["destination"] == lc.get("feeds"))
                c["items_on_belt"] = max(0, min(12, c["items_on_belt"] + deliveries - (1 if tick % 30 == 0 else 0)))
                c["throughput_per_min"] = jsround((2 + c["items_on_belt"] * 0.3) * 10) / 10
            else:
                c["throughput_per_min"] = 0

    def _free_charger(self) -> Optional[str]:
        for cid, v in self.charger_busy.items():
            if not v:
                return cid
        return None

    def _go_charge(self, r: dict[str, Any], rt: RobotRt) -> None:
        cid = self._free_charger()
        if not cid:
            self._set_fsm(r, "IDLE"); return
        c = next(cc for cc in self.layout["charging_stations"] if cc["id"] == cid)
        self.charger_busy[cid] = r["id"]; rt.charger_id = cid
        self._plan_to(r, rt, tuple(c["access_point"]), "TO_CHARGER", cid)
        self._set_fsm(r, "GOING_TO_CHARGE")

    def _park_spot(self, r: dict[str, Any]) -> Optional[tuple[float, float]]:
        parks = self.layout["parking"]
        if not parks:
            return None
        p = parks[0]
        i = int("".join(ch for ch in r["id"] if ch.isdigit())) - 1
        x = math.floor(p["rect"][0] + 1 + (i % 10) * 2) + 0.5; z = math.floor(p["rect"][1] + 1 + (i // 10) * 2.2) + 0.5
        if math.hypot(r["position"][0] - x, r["position"][2] - z) < 1.5:
            return None
        return (x, z)

    # ─────────────────────────────────────────────────────────
    # Zone / KPI / events
    # ─────────────────────────────────────────────────────────
    def _zone_at(self, x: float, z: float, floor: int = 1) -> Optional[str]:
        for zid, (x0, z0, x1, z1) in self._zone_bounds.items():
            if self._zone_floor.get(zid, 1) != floor:
                continue
            if x0 <= x <= x1 and z0 <= z <= z1:
                return zid
        return None

    def _update_zones(self) -> None:
        S = self.state
        counts: dict[str, int] = {}
        for r in S["robots"].values():
            if r["zone"]:
                counts[r["zone"]] = counts.get(r["zone"], 0) + 1
        for zid, z in S["zones"].items():
            z["robot_count"] = counts.get(zid, 0)
            cap = SIM["ZONE_CAPACITY"] + 2 if self._zone_floor.get(zid, 1) == 2 else SIM["ZONE_CAPACITY"]
            z["congestion"] = min(1, z["robot_count"] / cap)
            if zid in self.blocked_zones:
                z["status"] = "BLOCKED"; continue
            inj = self.congested_zones.get(zid)
            if inj: z["congestion"] = max(z["congestion"], inj["level"])
            was = z["status"]
            z["status"] = "CONGESTED" if z["congestion"] >= TH["CONGESTION_WARNING"] else "NORMAL"
            if z["status"] == "CONGESTED" and was != "CONGESTED":
                self.emit("ZONE_CONGESTION_HIGH", "SIMULATION", "MEDIUM", f"Zone {zid} congestion high ({z['robot_count']} robots)", zone_id=zid)

    def _update_kpi(self) -> None:
        S = self.state; K = S["kpi"]; robots = list(S["robots"].values()); tasks = list(S["tasks"].values()); tick = S["sim"]["tick"]
        K["tick"] = tick
        fleet = {"total": len(robots), "active": 0, "charging": 0, "idle": 0, "warning": 0, "error": 0, "offline": 0}
        for r in robots:
            fleet[r["status"].lower()] += 1
        K["fleet"] = fleet
        win = 3000
        recent = sum(1 for t in tasks if t["status"] == "COMPLETED" and t["completed_tick"] is not None and tick - t["completed_tick"] < win)
        K["operation"] = {
            "throughput_per_min": jsround((recent / min(5, max(1, tick / 600))) * 10) / 10,
            "completed_today": self.completed_count, "completed_target": 150,
            "pending": sum(1 for t in tasks if t["status"] == "WAITING"),
            "ongoing": sum(1 for t in tasks if t["status"] in ("ASSIGNED", "IN_PROGRESS")),
            "avg_task_time_s": jsround((sum(self.task_times) / len(self.task_times)) * SIM["TICK_S"]) if self.task_times else 0,
            "on_time_rate": (self.on_time / self.completed_count) if self.completed_count else 1,
            "avg_utilization": (sum(r["stats"]["busy_ticks"] for r in robots) / (len(robots) * tick)) if tick else 0,
        }
        cong = sum(z["congestion"] for z in S["zones"].values()) / max(1, len(S["zones"]))
        K["efficiency"] = {
            "avg_travel_distance_m": jsround(sum(r["stats"]["distance_m"] for r in robots) / max(1, self.completed_count)),
            "avg_wait_time_s": jsround((sum(r["stats"]["wait_ticks"] for r in robots) / len(robots)) * SIM["TICK_S"]),
            "congestion_index": jsround(cong * 100) / 100,
            "energy_kwh": jsround(sum(r["stats"]["energy_wh"] for r in robots)) / 1000,
        }
        lifts = list(S["lifts"].values())
        wait_n = sum(l["wait_n"] for l in lifts)
        K["lifts"] = {
            "trips": sum(l["trips"] for l in lifts),
            "utilization": round(sum(l["busy_ticks"] for l in lifts) / (len(lifts) * S["sim"]["tick"]), 3) if S["sim"]["tick"] and lifts else 0,
            "avg_wait_s": round(sum(l["wait_total_ticks"] for l in lifts) / wait_n * SIM["TICK_S"], 1) if wait_n else 0,
            "faults": sum(1 for l in lifts if l["fault"]),
        }
        S["subsystems"]["CHARGING"] = "WARNING" if all(self.charger_busy.values()) else "NORMAL"
        cvs = S["conveyors"].values()
        S["subsystems"]["CONVEYORS"] = "ERROR" if any(c["status"] == "ERROR" for c in cvs) else "WARNING" if any(c["status"] != "RUNNING" for c in cvs) else "NORMAL"
        S["subsystems"]["WAREHOUSE"] = "WARNING" if self.blocked_zones else "NORMAL"

    def _push_series(self) -> None:
        S = self.state; self.last_series_tick = S["sim"]["tick"]
        S["kpi"]["throughput_series"].append({"tick": S["sim"]["tick"], "completed": self.completed_count, "target": jsround(S["sim"]["tick"] / 600 * 1.25)})
        if len(S["kpi"]["throughput_series"]) > TH["THROUGHPUT_SERIES_SIZE"]:
            S["kpi"]["throughput_series"].pop(0)

    def emit(self, type_: str, source: str, severity: str, message: str, **rel: Any) -> dict[str, Any]:
        self.event_seq += 1
        ev = {"id": f"E{self.event_seq}", "tick": self.state["sim"]["tick"], "type": type_, "source": source, "severity": severity, "message": message}
        for k, v in rel.items():
            if v is not None:
                ev[k] = v
        self.state["recent_events"].insert(0, ev)
        if len(self.state["recent_events"]) > SIM["EVENT_RING"]:
            self.state["recent_events"].pop()
        self.new_events.append(ev)
        return ev

    def _raise_alert(self, aid: str, severity: str, title: str, detail: str, **rel: Any) -> None:
        ev = self.state["recent_events"][0] if self.state["recent_events"] else None
        a = {"id": aid, "created_tick": self.state["sim"]["tick"], "severity": severity, "title": title, "detail": detail,
             "source_event_id": ev["id"] if ev else "", "acknowledged": False, "resolved_tick": None}
        for k, v in rel.items():
            if v is not None:
                a[k] = v
        self.state["alerts"][aid] = a

    def _resolve_alert(self, aid: str) -> None:
        self.state["alerts"].pop(aid, None)

    # ─────────────────────────────────────────────────────────
    # Scenario injection
    # ─────────────────────────────────────────────────────────
    def _apply_injections(self) -> None:
        S = self.state; now = S["sim"]["tick"]; keep = []
        for inj in self.pending_injections:
            if inj.get("at_tick") is not None and inj["at_tick"] > now:
                keep.append(inj); continue
            k = inj["kind"]
            if k == "ROBOT_FAILURE":
                r = S["robots"].get(inj["robot_id"])
                if r:
                    self._set_fsm(r, "OFFLINE"); r["velocity"] = 0
                    t = S["tasks"].get(r["current_task_id"]) if r["current_task_id"] else None
                    if t:
                        t["status"] = "TRANSFERRED"; t["completed_tick"] = now
                        nt = self.create_task(t["type"], "HIGH", t["source"], t["destination"]); nt["parent_task_id"] = t["id"]
                    r["current_task_id"] = None; r["path"] = []
                    self.release_robot_from_lift(r["id"]); self.rt[r["id"]].pending = None
                    self.emit("ROBOT_OFFLINE", "USER", "CRITICAL", f"{r['id']} failure injected — OFFLINE", robot_id=r["id"])
                    self._raise_alert(f"off-{r['id']}", "CRITICAL", f"{r['id']}  Offline", "Robot failure", robot_id=r["id"])
            elif k == "ROBOT_BATTERY_SET":
                r = S["robots"].get(inj["robot_id"])
                if r:
                    r["battery"] = inj["battery"]; self.rt[r["id"]].last_battery_alert = "NONE"
            elif k == "CONVEYOR_FAILURE":
                c = S["conveyors"].get(inj["conveyor_id"])
                if c:
                    c["status"] = "ERROR"; c["speed_mps"] = 0
                    self.emit("CONVEYOR_STATUS_CHANGED", "CONVEYOR", "HIGH", f"{inj['conveyor_id']} failure — STOPPED", conveyor_id=c["id"])
                    self._raise_alert(f"cv-{c['id']}", "HIGH", f"Conveyor {c['id']}  Error", "Throughput impact: HIGH", conveyor_id=c["id"])
            elif k == "CAMERA_OFFLINE":
                c = S["cameras"].get(inj["camera_id"])
                if c:
                    c["status"] = "OFFLINE"; S["subsystems"]["CCTV"] = "WARNING"
                    self.emit("CAMERA_STATUS_CHANGED", "CAMERA", "MEDIUM", f"{c['id']} offline", camera_id=c["id"])
            elif k == "HUMAN_INTRUSION":
                zid = inj["zone_id"]; b = self._zone_bounds.get(zid)
                if b:
                    x0, z0, x1, z1 = b
                    pid = f"H-{zid}-{now}"
                    S["people"][pid] = {"id": pid, "kind": "WORKER", "position": [(x0 + x1) / 2, 0, z0 + 6.3], "heading": 0, "zone": zid, "floor": self._zone_floor.get(zid, 1), "expires_tick": now + inj["duration_ticks"]}
                    self.blocked_zones.add(zid); S["zones"][zid]["blocked_reason"] = "Human detected"; S["zones"][zid]["blocked_since_tick"] = now
                    self.emit("HUMAN_DETECTED", "VLM", "HIGH", f"Human detected — Zone {zid}", zone_id=zid)
                    self.emit("ZONE_BLOCKED", "SIMULATION", "HIGH", f"Zone {zid} marked BLOCKED", zone_id=zid)
                    self._raise_alert(f"zone-{zid}", "HIGH", f"Zone {zid}  Human Detected", "Route blocked", zone_id=zid)
                    for r in S["robots"].values():
                        if r["path"] and any(x0 <= c[0] < x1 and z0 <= c[1] < z1 for c in r["path"][r["path_index"]:]):
                            self._set_fsm(r, "OBSTACLE_DETECTED")
            elif k == "TRAFFIC_CONGESTION":
                zid = inj["zone_id"]
                self.congested_zones[zid] = {"level": inj["level"], "until": now + inj["duration_ticks"]}
                self.emit("ZONE_CONGESTION_HIGH", "USER", "MEDIUM", f"Traffic congestion injected — Zone {zid} (level {jsround(inj['level'] * 100)}%)", zone_id=zid)
                self._raise_alert(f"traffic-{zid}", "MEDIUM", f"Zone {zid}  Traffic Delay", f"Speed limited to {jsround((1 - 0.7 * inj['level']) * 100)}%", zone_id=zid)
                for r in S["robots"].values():
                    if len(r["path"]) > r["path_index"] + 3 and r["fsm"] != "IDLE": self._set_fsm(r, "OBSTACLE_DETECTED")
            elif k == "TASK_BURST":
                for _ in range(inj["count"]):
                    self.next_task_tick = now; self._generate_tasks()
            elif k == "LIFT_FAULT":
                L = S["lifts"].get(inj["lift_id"])
                if L and not L["fault"]:
                    L["fault"] = True
                    L["fault_remaining"] = max(0, L["until_tick"] - now)   # Freeze the timer: at clear time, continue from the remaining progress; the platform does not teleport
                    self.emit("LIFT_FAULT", "LIFT", "CRITICAL" if L["occupant"] else "HIGH",
                              f"{inj['lift_id']} FAULT" + (f" — {L['occupant']} inside, platform stalled" if L["occupant"] else ""),
                              robot_id=L["occupant"])
                    self._raise_alert(f"lift-{inj['lift_id']}", "CRITICAL" if L["occupant"] else "HIGH", f"{inj['lift_id']}  Fault",
                                      f"Platform stalled with {L['occupant']} aboard" if L["occupant"] else "Out of service")
        self.pending_injections = keep
        for zid in [z for z, cz in self.congested_zones.items() if now >= cz["until"]]:
            del self.congested_zones[zid]; self._resolve_alert(f"traffic-{zid}")
            self.emit("ZONE_UNBLOCKED", "SIMULATION", "INFO", f"Zone {zid} traffic back to normal", zone_id=zid)
        for pid in list(S["people"].keys()):
            p = S["people"][pid]
            if p["expires_tick"] is not None and now >= p["expires_tick"]:
                del S["people"][pid]
                z = p["zone"]
                if z and not any(q["zone"] == z for q in S["people"].values()):
                    self.blocked_zones.discard(z); S["zones"][z]["blocked_reason"] = None; S["zones"][z]["blocked_since_tick"] = None
                    self._resolve_alert(f"zone-{z}")
                    self.emit("HUMAN_CLEARED", "VLM", "INFO", f"Zone {z} clear", zone_id=z)
                    self.emit("ZONE_UNBLOCKED", "SIMULATION", "INFO", f"Zone {z} unblocked", zone_id=z)

    def pretty(self, loc_id: str) -> str:
        l = self.loc.get(loc_id)
        if not l: return loc_id
        k = l["kind"]
        if k == "SHELF": return "Shelf " + loc_id.replace("SHELF-", "")
        if k == "PACKING": return loc_id.replace("PACK-", "Packing ")
        if k == "SORTING": return "Sorting"
        if k == "CHARGING": return loc_id.replace("CHG-", "Charger ")
        return loc_id.replace("-", " ", 1)
