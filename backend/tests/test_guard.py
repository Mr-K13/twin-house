"""Batch 2: public demo protection — input limits, rate limit, Origin check, body size."""
from fastapi.testclient import TestClient
from app.main import app
from app.guard import limiter


def test_input_limits_rejected():
    with TestClient(app) as c:
        assert c.post("/api/inject", json={"kind": "TASK_BURST", "count": 500}).status_code == 400
        assert c.post("/api/inject", json={"kind": "HUMAN_INTRUSION", "zone_id": "B", "duration_ticks": 999999}).status_code == 400
        assert c.post("/api/copilot", json={"question": "x" * 5000}).status_code == 422
        assert c.post("/api/vlm/observe", json={"camera_id": "CAM-B01", "image_b64": "a" * 500_000}).status_code == 422
        r = c.post("/api/whatif", json={"injections": [{"kind": "ROBOT_FAILURE", "robot_id": "R01"}] * 20, "duration_ticks": 600})
        assert r.status_code == 400
        assert c.post("/api/sim", json={"action": "PLAY", "speed": 99}).status_code == 422
        # valid values still work
        assert c.post("/api/inject", json={"kind": "TASK_BURST", "count": 5}).status_code == 200


def test_rate_limit_rest_and_ws(monkeypatch):
    monkeypatch.setenv("TWIN_RATE_LIMIT", "1"); limiter.reset()
    with TestClient(app) as c:
        codes = [c.post("/api/inject", json={"kind": "CAMERA_OFFLINE", "camera_id": "CAM-B01"}).status_code for _ in range(25)]
        assert codes[:20] == [200] * 20 and codes[20] == 429
        assert "Retry-After" in c.post("/api/inject", json={"kind": "CAMERA_OFFLINE", "camera_id": "CAM-B01"}).headers
        # reads are not rate limited
        assert all(c.get("/api/health").status_code == 200 for _ in range(30))
        with c.websocket_connect("/ws") as ws:
            ws.receive_json()
            got = None
            for _ in range(30):
                ws.send_json({"type": "INJECT", "injection": {"kind": "CAMERA_OFFLINE", "camera_id": "CAM-B02"}})
            for _ in range(400):
                m = ws.receive_json()
                if m["type"] == "ERROR" and m["code"] == "RATE_LIMITED":
                    got = m; break
            assert got is not None


def test_origin_check(monkeypatch):
    monkeypatch.setenv("TWIN_CORS_ORIGINS", "https://ware-twin.vercel.app")
    monkeypatch.setenv("TWIN_CORS_REGEX", r"https://.*\.vercel\.app")
    with TestClient(app) as c:
        body = {"kind": "CAMERA_OFFLINE", "camera_id": "CAM-B01"}
        assert c.post("/api/inject", json=body).status_code == 403                                   # no Origin (curl)
        assert c.post("/api/inject", json=body, headers={"origin": "https://evil.example"}).status_code == 403
        assert c.post("/api/inject", json=body, headers={"origin": "https://ware-twin.vercel.app"}).status_code == 200
        assert c.post("/api/inject", json=body, headers={"origin": "https://ware-twin-git-x.vercel.app"}).status_code == 200
        assert c.get("/api/health").status_code == 200                                               # GET is not checked
        import pytest
        from starlette.websockets import WebSocketDisconnect
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/ws", headers={"origin": "https://evil.example"}) as ws:
                ws.receive_json()
        with c.websocket_connect("/ws", headers={"origin": "https://ware-twin.vercel.app"}) as ws:
            assert ws.receive_json()["type"] == "FULL"
    monkeypatch.setenv("TWIN_ALLOW_NO_ORIGIN", "1")
    with TestClient(app) as c:
        assert c.post("/api/inject", json=body).status_code == 200


def test_body_size_limit():
    with TestClient(app) as c:
        r = c.post("/api/copilot", content=b"{}", headers={"content-type": "application/json", "content-length": str(2_000_000)})
        assert r.status_code == 413


def test_task_location_validation():
    """P1: locations must exist, not be a charger, not be equal, and match the TaskType; both the engine layer and the API layer reject bad values."""
    from app.sim.engine import SimEngine
    from app.sim.navgrid import load_layout
    import pytest
    e = SimEngine(load_layout(), seed=1)
    with pytest.raises(ValueError): e.create_task("PICK", "NORMAL", "SHELF-A12", "NOT-A-LOCATION")
    with pytest.raises(ValueError): e.create_task("PICK", "NORMAL", "SHELF-A12", "CHG-01")
    with pytest.raises(ValueError): e.create_task("PICK", "NORMAL", "SHELF-A12", "SHELF-A12")
    with pytest.raises(ValueError): e.create_task("PICK", "NORMAL", "PACK-01", "SHELF-A12")   # PICK source must be a shelf
    e.create_task("PICK", "NORMAL", "SHELF-A12", "PACK-01")
    e.create_task("TRANSPORT", "HIGH", "PACK-01", "OUTBOUND-1")
    for _ in range(600): e.step()   # valid tasks run normally
    with TestClient(app) as c:
        r = c.post("/api/tasks", json={"type": "PICK", "source": "SHELF-A12", "destination": "NOT-A-LOCATION"})
        assert r.status_code == 400 and "destination" in r.text
        with c.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "CREATE_TASK", "task": {"type": "PICK", "source": "SHELF-A12", "destination": "NOPE"}})
            for _ in range(200):
                m = ws.receive_json()
                if m["type"] == "ERROR":
                    assert m["code"] == "BAD_TASK"; break
            else:
                raise AssertionError("no BAD_TASK error")
        # the simulation still advances after repeated bad task creation
        t0 = c.get("/api/health").json()["tick"]
        import time; time.sleep(0.5)
        assert c.get("/api/health").json()["tick"] > t0


def test_engine_survives_bad_destination_in_state():
    """Even when a task carries a destination that does not exist (for example, from an old snapshot), the engine only marks it FAILED and does not crash."""
    from app.sim.engine import SimEngine
    from app.sim.navgrid import load_layout
    e = SimEngine(load_layout(), seed=1)
    t = e.create_task("PICK", "NORMAL", "SHELF-A12", "PACK-01"); t["destination"] = "NOT-A-LOCATION"
    for _ in range(1500): e.step()
    assert t["status"] == "FAILED"
    assert all(r["fsm"] != "PICKING" or r["current_task_id"] != t["id"] for r in e.state["robots"].values())


def test_body_cap_counts_real_bytes():
    """With no Content-Length (chunked) or a fake header, the cap still applies to the real bytes."""
    with TestClient(app) as c:
        big = b'{"question": "' + b"a" * 600_000 + b'"}'
        def gen():
            for i in range(0, len(big), 65536): yield big[i:i + 65536]
        r = c.post("/api/copilot", content=gen(), headers={"content-type": "application/json"})
        assert r.status_code == 413
        r = c.post("/api/copilot", content=big, headers={"content-type": "application/json", "content-length": "10"})
        assert r.status_code in (400, 413)


def test_xff_uses_last_hop(monkeypatch):
    from app.guard import client_key
    monkeypatch.setenv("TWIN_TRUSTED_PROXIES", "1")
    assert client_key({"x-forwarded-for": "1.1.1.1, 9.9.9.9"}, "10.0.0.1") == "9.9.9.9"   # the spoofed 1.1.1.1 is not used
    monkeypatch.setenv("TWIN_TRUSTED_PROXIES", "0")
    assert client_key({"x-forwarded-for": "1.1.1.1"}, "10.0.0.1") == "10.0.0.1"


def test_origin_regex_only_own_project(monkeypatch):
    from app.guard import origin_allowed
    monkeypatch.setenv("TWIN_CORS_ORIGINS", "https://ware-twin.vercel.app")
    monkeypatch.setenv("TWIN_CORS_REGEX", r"https://ware-twin(-[a-z0-9-]+)?\.vercel\.app")
    assert origin_allowed("https://ware-twin-git-main-waynechou-bots-projects.vercel.app")
    assert not origin_allowed("https://evil.vercel.app")
    assert not origin_allowed("https://ware-twin.vercel.app.evil.com")


def test_rate_limiter_gc(monkeypatch):
    from app.guard import RateLimiter, LIMITS
    monkeypatch.setenv("TWIN_RATE_LIMIT", "1")
    rl = RateLimiter(); rl.GC_EVERY = 10
    for i in range(10): rl.check("mutate", f"ip{i}")
    assert len(rl._hits) <= 10
    import time
    monkeypatch.setattr(time, "monotonic", lambda: time.time() + 10_000)   # 10,000 seconds later
    for i in range(10): rl.check("mutate", f"new{i}")
    assert all(k[1].startswith("new") for k in rl._hits)   # old keys are cleared


def test_whatif_rate_limit_error_carries_request_id(monkeypatch):
    monkeypatch.setenv("TWIN_RATE_LIMIT", "1"); limiter.reset()
    from app.guard import LIMITS
    monkeypatch.setitem(LIMITS, "whatif", (1, 60.0))   # the second request is rejected
    with TestClient(app) as c:
        with c.websocket_connect("/ws") as ws:
            ws.receive_json()
            req = {"scenario_name": "t", "injections": [{"kind": "ROBOT_FAILURE", "robot_id": "R01"}], "duration_ticks": 60, "run_baseline": False}
            ws.send_json({"type": "WHATIF_RUN", "request": req, "request_id": "w-41"})
            ws.send_json({"type": "WHATIF_RUN", "request": req, "request_id": "w-42"})
            for _ in range(400):
                m = ws.receive_json()
                if m["type"] == "ERROR":
                    assert m["code"] == "RATE_LIMITED" and m["request_id"] == "w-42"; break
            else:
                raise AssertionError("no ERROR")


def test_ws_bucket_rate_limit_carries_request_id(monkeypatch):
    """The ws bucket rate limit (before validate) must also return the request_id, so What-if does not stay stuck at Simulating."""
    monkeypatch.setenv("TWIN_RATE_LIMIT", "1"); limiter.reset()
    from app.guard import LIMITS
    monkeypatch.setitem(LIMITS, "ws", (1, 60.0))
    with TestClient(app) as c:
        with c.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "RESYNC"})
            ws.send_json({"type": "WHATIF_RUN", "request": {"scenario_name": "t", "injections": [], "duration_ticks": 60}, "request_id": "w-9"})
            for _ in range(200):
                m = ws.receive_json()
                if m["type"] == "ERROR" and m["code"] == "RATE_LIMITED":
                    assert m["request_id"] == "w-9"; break
            else:
                raise AssertionError("no RATE_LIMITED")


def test_server_message_schema_matches_wire_format():
    """The Python ServerMessage contract must validate the WHATIF_RESULT / ERROR actually sent (with request_id)."""
    from app.schema import MsgError
    MsgError.model_validate({"type": "ERROR", "code": "RATE_LIMITED", "message": "x", "request_id": "w-1"})
    MsgError.model_validate({"type": "ERROR", "code": "BAD_MESSAGE", "message": "x"})
