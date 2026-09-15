"""Scenario workspace documents (/api/scenarios): CRUD round trip, contract validation, 404s and the dedicated auto-save rate-limit bucket."""
from fastapi.testclient import TestClient
from app.main import app
from app.guard import limiter

SIZE = {"length": 60, "width": 40, "height": 10}
RACK = {"id": "RACK-01", "type": "rack", "position": [10, 0, 5], "rotation": 0, "params": {"length": 8, "height": 6, "depth": 1.2, "levels": 4}}
CAM = {"id": "CAM-01", "type": "camera", "position": [3, 5, 3], "rotation": 1.57, "params": {"fov_deg": 70, "range_m": 25, "pitch_deg": 35, "mount_h": 5}}


def _create(c: TestClient, name: str = "Test") -> dict:
    r = c.post("/api/scenarios", json={"name": name, "size": SIZE})
    assert r.status_code == 201, r.text
    return r.json()


def test_scenario_crud_roundtrip():
    with TestClient(app) as c:
        doc = _create(c)
        sid = doc["id"]
        try:
            assert sid.startswith("sc-") and len(sid) == 15
            assert doc["instances"] == [] and doc["created_at"] == doc["updated_at"] and doc["size"] == SIZE
            summary = next(s for s in c.get("/api/scenarios").json() if s["id"] == sid)
            assert "instances" not in summary and summary["instance_count"] == 0 and summary["name"] == "Test"
            assert c.get(f"/api/scenarios/{sid}").json() == doc

            r = c.put(f"/api/scenarios/{sid}", json={"name": "Renamed", "size": SIZE, "instances": [RACK, CAM]})
            assert r.status_code == 200, r.text
            saved = r.json()
            assert saved["id"] == sid and saved["name"] == "Renamed" and saved["created_at"] == doc["created_at"]
            assert saved["updated_at"] >= doc["updated_at"]
            assert [i["id"] for i in saved["instances"]] == ["RACK-01", "CAM-01"]
            assert saved["instances"][0]["params"]["levels"] == 4 and saved["instances"][1]["params"]["mount_h"] == 5
            summary = next(s for s in c.get("/api/scenarios").json() if s["id"] == sid)
            assert summary["instance_count"] == 2 and summary["name"] == "Renamed" and summary["updated_at"] == saved["updated_at"]
            assert c.get(f"/api/scenarios/{sid}").json() == saved          # the document survives a reload
        finally:
            assert c.delete(f"/api/scenarios/{sid}").status_code == 204
        assert c.get(f"/api/scenarios/{sid}").status_code == 404
        assert c.delete(f"/api/scenarios/{sid}").status_code == 404
        assert all(s["id"] != sid for s in c.get("/api/scenarios").json())


def test_scenario_contract_validation():
    with TestClient(app) as c:
        assert c.post("/api/scenarios", json={"name": "", "size": SIZE}).status_code == 422
        assert c.post("/api/scenarios", json={"name": "x", "size": {**SIZE, "length": 1}}).status_code == 422
        assert c.post("/api/scenarios", json={"name": "x", "size": {**SIZE, "height": 41}}).status_code == 422
        base = {"name": "Validation", "size": SIZE}
        assert c.put("/api/scenarios/sc-missing000", json={**base, "instances": []}).status_code == 404
        doc = _create(c, "Validation")
        sid = doc["id"]
        try:
            assert c.put(f"/api/scenarios/{sid}", json={**base, "instances": [{**RACK, "type": "bogus"}]}).status_code == 422
            assert c.put(f"/api/scenarios/{sid}", json={**base, "size": {**SIZE, "length": 1}, "instances": []}).status_code == 422
            assert c.put(f"/api/scenarios/{sid}", json={**base, "instances": [{**RACK, "id": f"R{i}"} for i in range(2001)]}).status_code == 422
            assert c.put(f"/api/scenarios/{sid}", json={**base, "instances": [{**RACK, "params": {"note": "x" * 201}}]}).status_code == 422
            assert c.put(f"/api/scenarios/{sid}", json={**base, "instances": [{**RACK, "params": {f"k{i}": i for i in range(33)}}]}).status_code == 422
            assert c.put(f"/api/scenarios/{sid}", json={**base, "instances": [{**RACK, "unknown": 1}]}).status_code == 422
            assert c.put(f"/api/scenarios/{sid}", json={**base, "instances": [{**RACK, "position": [1, 2]}]}).status_code == 422
            assert c.get(f"/api/scenarios/{sid}").json() == doc               # rejected writes leave the document untouched
            ok = c.put(f"/api/scenarios/{sid}", json={**base, "instances": [{**RACK, "id": f"R{i}"} for i in range(2000)]})
            assert ok.status_code == 200 and len(ok.json()["instances"]) == 2000
        finally:
            c.delete(f"/api/scenarios/{sid}")


def test_scenario_autosave_bucket_is_separate_from_mutate(monkeypatch):
    """120 saves per minute pass on the `scenario` bucket and the 121st is 429, while the `mutate` bucket (20/min) is untouched."""
    monkeypatch.setenv("TWIN_RATE_LIMIT", "1"); limiter.reset()
    with TestClient(app) as c:
        doc = _create(c, "Bucket")                       # mutate call 1
        sid = doc["id"]
        try:
            body = {"name": "Bucket", "size": SIZE, "instances": [RACK]}
            codes = [c.put(f"/api/scenarios/{sid}", json=body).status_code for _ in range(121)]
            assert codes[:120] == [200] * 120 and codes[120] == 429
            r = c.put(f"/api/scenarios/{sid}", json=body)
            assert r.status_code == 429 and "Retry-After" in r.headers and "scenario" in r.json()["detail"]
            assert c.get(f"/api/scenarios/{sid}").status_code == 200       # reads are never limited
            extra = _create(c, "Bucket 2")                                 # mutate call 2: the saves did not consume the mutate budget
            assert c.delete(f"/api/scenarios/{extra['id']}").status_code == 204   # mutate call 3
        finally:
            c.delete(f"/api/scenarios/{sid}")
