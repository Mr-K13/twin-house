# Digital Twin Warehouse — Backend (Phase 3–5)

```
Simulation (asyncio) → Twin State → WebSocket FULL / PATCH → Browser → 3D Scene
```

FastAPI + Pydantic v2 + WebSocket + SQLite. The simulation engine is the Python port of `frontend/src/simulation/engine.ts` (the method names, the tick order, the FSM, the weights, and the parameters each agree).

## Start

```bash
cd backend
python -m venv .venv && .venv\Scripts\activate     # Windows; macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Then run the frontend with `npm run dev` in a second terminal. At start, the frontend connects to `ws://localhost:8000/ws`. A blue **BACKEND** in the TopBar means that it uses the backend. If it cannot connect, it goes back to the local frontend engine automatically and shows an orange **LOCAL**. After the backend starts, the frontend connects again in 3 seconds.

Environment variables: `TWIN_SEED` (the default is 42) and `TWIN_DB` (the default is `twin.db`). For the protection of a public deployment (`TWIN_CORS_ORIGINS`, `TWIN_CORS_REGEX`, `TWIN_TRUSTED_PROXIES`, `TWIN_RATE_LIMIT`, `TWIN_HEALTH_STALL_S`), see `.env.example` and "Running it in public" in the root README. The frontend can use `VITE_WS_URL` to replace the backend address.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q          # 32 tests: bit-level PRNG agreement with JS, A*, a 20-minute stress test, determinism, low battery, human intrusion, perception, the REST and WebSocket protocol, AI, What-if, and the protection layer (rate limit / Origin / body limit / task locations)
```

## AI (Phase 5)

Run `cp .env.example .env` and add `OPENAI_API_KEY` (the backend reads .env automatically; the frontend never touches the key). `GET /api/ai/status` shows whether the system uses the LLM or the fallback.

- **Copilot** `app/ai/copilot.py`: `summarize_state()` reduces TwinState to an operations summary of approximately 3k tokens (KPI, fleet, zones, conveyors, alerts, the last 5 decisions, and the last 30 events that are not LOW). It then calls Chat Completions with the forced JSON schema `{text, citations, confidence}`. A citation filter keeps only an id that exists in the snapshot. If the call fails, or if there is no key, the system uses `rule_based_answer()`. This function does a rule-based analysis for six types of question: throughput, assignment, fault prediction, congestion, and improvement advice. The answer also has citations.
- **VLM** `app/ai/vlm.py`: The frontend sends the Live Camera JPEG. The vision model returns the forced JSON `{event, severity, blocked, confidence, bbox, description}`. The telemetry hint gives only the number of robots. It does not give the position of a person, so it does not disclose the answer. With no key, `simulated_observation()` uses the ground truth. The result goes into `cameras[id].last_observation`, and the system sends a `VLM_OBSERVATION` event. When `TWIN_VLM_ACTS=1`, a human_detected value of 0.7 or more blocks the zone (`engine.block_zone`). The default is off.
- All LLM calls are in `asyncio.to_thread`, so they do not stop the simulation loop.

## API

| Path | Description |
|---|---|
| `WS /ws` | After the connection, the client first receives `FULL`, then a `PATCH` on each tick, and two `HEATMAP` layers every 30 ticks (TRAFFIC short-term / CONGESTION long-term). It accepts `SIM_CONTROL` `INJECT` `CLEAR_INJECTION` `CREATE_TASK` `ACK_ALERT` `RESYNC` `COPILOT_ASK` (which returns `COPILOT_REPLY`), and `WHATIF_RUN` (which returns `WHATIF_RESULT`; only one runs at a time, at 4 per minute for each IP) |
| `GET /api/health` | The tick, the speed, the number of connections, and the true tick rate. If the simulation task stops, or if there is no movement for 10 seconds, it returns `503` (Render uses this to restart) |
| `GET /api/state` | The full TwinState |
| `GET /api/state/validate` | Uses Pydantic to make sure that the current state agrees with the contract |
| `GET /api/events?limit&type&severity&robot_id&zone_id&since_tick` | Queries the events from SQLite (for the Audit Log) |
| `GET /api/decisions` | The most recent Fleet Manager decisions (with the candidate scores and the rejection reasons) |
| `GET /api/kpi` `GET /api/layout` | |
| `POST /api/inject` | body = ScenarioInjection, for example `{"kind":"HUMAN_INTRUSION","zone_id":"B","duration_ticks":600}` |
| `POST /api/inject/clear` | `{"kind":"CONVEYOR_FAILURE","target_id":"CV03"}` clears the injection |
| `POST /api/tasks` | body = NewTask |
| `POST /api/copilot` | `{"question": "..."}` → `{text, citations, confidence, model}` |
| `POST /api/vlm/observe` | `{"camera_id": "CAM-B01", "image_b64": "data:image/jpeg;base64,..."}` → VlmObservation (if image_b64 is absent, the result is simulated) |
| `GET /api/ai/status` | Whether the LLM is on, the model name, and vlm_acts |
| `POST /api/sim` | `{"action":"PLAY"|"PAUSE"|"RESET","speed":1|2|5|10}` |

## PATCH protocol

One `{"type":"PATCH","base_tick","tick","patch","events"}` message on each tick:

- `patch.sim` is always present. `patch.robots[id]` has only the fields that changed (`path` is present only when the path changes). The frontend merges with `{...prev, ...patch}`.
- `tasks / zones / conveyors / cameras / sensors / people / alerts` use the id as the key and send only the items that changed. A value of `null` means a deletion.
- `kpi` goes every 10 ticks, `subsystems` on a change, and `recent_decisions` when there is a new decision.
- `events` is the array of events that this tick made. The frontend prepends them to the ring (500).
- If the frontend finds that `base_tick` does not agree with the local tick (for example, after the browser tab sleeps), it sends `RESYNC` to request a `FULL`.

Measured bandwidth: approximately 12 KB/s at 1x, and approximately 120 KB/s at 10x (one connection).

## Performance

The Python engine takes 0.3 ms/tick (20 robots, a 7,000-cell A*). A speed of 10x needs 100 ticks per second, which is approximately 30 ms of CPU. This gives a large margin. The simulation loop does a maximum of 40 ticks per frame, so it does not run too fast if the browser tab or the machine stops for a time.

## Agreement with the TypeScript engine

`tests/test_engine.py::test_prng_matches_js` makes sure that the random number stream is bit-level identical. Thus the task generation sequence, the assignment results, and the FSM transitions agree fully for the first 1,500 ticks. After that, the positions diverge slowly (the final KPI difference is less than 5%). The cause is a different tie-break order in A* for **paths with equal cost** (the heap implementations are different). Both are legal shortest paths. What-if thus runs fully in the backend (it clones the same engine) and does not rely on bit-level agreement between the frontend and the backend. A common heap tie-break rule is on the roadmap.

## Directory

```
app/main.py          FastAPI, WebSocket, simulation loop, diff
app/db.py            SQLite (events / kpi_snapshots / decisions)
app/schema.py        Pydantic contract (= docs/schema/twin_state.py)
app/sim/astar.py     A*
app/sim/navgrid.py   layout -> navigation grid
app/sim/engine.py    Simulation engine
app/warehouse_layout.json   The same file as the frontend
tests/
```
