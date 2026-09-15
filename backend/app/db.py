"""SQLite persistence layer for events / KPI / scenario workspace documents (first version; to move to PostgreSQL, change only this file)."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable


class TwinDB:
    def __init__(self, path: str | Path = "twin.db") -> None:
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, id TEXT, tick INTEGER, type TEXT, source TEXT, severity TEXT,
              message TEXT, robot_id TEXT, task_id TEXT, zone_id TEXT, conveyor_id TEXT, camera_id TEXT, payload TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_events_run_tick ON events(run_id, tick);
            CREATE TABLE IF NOT EXISTS kpi_snapshots (run_id TEXT, tick INTEGER, kpi TEXT, PRIMARY KEY(run_id, tick));
            CREATE TABLE IF NOT EXISTS decisions (run_id TEXT, id TEXT, tick INTEGER, decision TEXT, PRIMARY KEY(run_id, id));
            CREATE TABLE IF NOT EXISTS scenarios (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, size TEXT NOT NULL, instances TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            """
        )

    def ping(self) -> None:
        self.conn.execute("SELECT 1").fetchone()

    def insert_events(self, run_id: str, events: Iterable[dict[str, Any]]) -> None:
        rows = [(run_id, e["id"], e["tick"], e["type"], e["source"], e["severity"], e["message"], e.get("robot_id"), e.get("task_id"),
                 e.get("zone_id"), e.get("conveyor_id"), e.get("camera_id"), json.dumps(e.get("payload")) if e.get("payload") else None) for e in events]
        if rows:
            self.conn.executemany("INSERT INTO events(run_id,id,tick,type,source,severity,message,robot_id,task_id,zone_id,conveyor_id,camera_id,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
            self.conn.commit()

    def insert_kpi(self, run_id: str, tick: int, kpi: dict[str, Any]) -> None:
        self.conn.execute("INSERT OR REPLACE INTO kpi_snapshots(run_id,tick,kpi) VALUES(?,?,?)", (run_id, tick, json.dumps(kpi)))
        self.conn.commit()

    def insert_decisions(self, run_id: str, decisions: Iterable[dict[str, Any]]) -> None:
        rows = [(run_id, d["id"], d["tick"], json.dumps(d)) for d in decisions]
        if rows:
            self.conn.executemany("INSERT OR IGNORE INTO decisions(run_id,id,tick,decision) VALUES(?,?,?,?)", rows)
            self.conn.commit()

    def query_events(self, run_id: str, limit: int = 200, types: list[str] | None = None, severity: list[str] | None = None,
                     robot_id: str | None = None, zone_id: str | None = None, since_tick: int | None = None) -> list[dict[str, Any]]:
        q = "SELECT id,tick,type,source,severity,message,robot_id,task_id,zone_id,conveyor_id,camera_id,payload FROM events WHERE run_id=?"
        args: list[Any] = [run_id]
        if types:
            q += f" AND type IN ({','.join('?' * len(types))})"; args += types
        if severity:
            q += f" AND severity IN ({','.join('?' * len(severity))})"; args += severity
        if robot_id:
            q += " AND robot_id=?"; args.append(robot_id)
        if zone_id:
            q += " AND zone_id=?"; args.append(zone_id)
        if since_tick is not None:
            q += " AND tick>=?"; args.append(since_tick)
        q += " ORDER BY seq DESC LIMIT ?"; args.append(limit)
        cols = ["id", "tick", "type", "source", "severity", "message", "robot_id", "task_id", "zone_id", "conveyor_id", "camera_id", "payload"]
        out = []
        for row in self.conn.execute(q, args):
            d = {c: v for c, v in zip(cols, row) if v is not None}
            if "payload" in d:
                d["payload"] = json.loads(d["payload"])
            out.append(d)
        return out

    # ── Scenario workspace documents (setup editor): size and instances are stored as JSON text ──
    SCENARIO_COLS = ("id", "name", "size", "instances", "created_at", "updated_at")

    def list_scenarios(self) -> list[dict[str, Any]]:
        """Summaries without the instances, newest `updated_at` first; `instance_count` comes from the stored JSON array."""
        rows = self.conn.execute("SELECT id,name,size,json_array_length(instances),created_at,updated_at FROM scenarios ORDER BY updated_at DESC, id").fetchall()
        return [{"id": i, "name": n, "size": json.loads(sz), "instance_count": cnt, "created_at": ca, "updated_at": ua} for i, n, sz, cnt, ca, ua in rows]

    def get_scenario(self, sid: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT id,name,size,instances,created_at,updated_at FROM scenarios WHERE id=?", (sid,)).fetchone()
        if row is None:
            return None
        d = dict(zip(self.SCENARIO_COLS, row))
        d["size"] = json.loads(d["size"]); d["instances"] = json.loads(d["instances"])
        return d

    def upsert_scenario(self, doc: dict[str, Any]) -> None:
        self.conn.execute("INSERT OR REPLACE INTO scenarios(id,name,size,instances,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                          (doc["id"], doc["name"], json.dumps(doc["size"]), json.dumps(doc["instances"]), doc["created_at"], doc["updated_at"]))
        self.conn.commit()

    def delete_scenario(self, sid: str) -> bool:
        cur = self.conn.execute("DELETE FROM scenarios WHERE id=?", (sid,))
        self.conn.commit()
        return cur.rowcount > 0

    def close(self) -> None:
        self.conn.close()
