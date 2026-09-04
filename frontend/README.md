# Digital Twin Warehouse — Frontend (Phase 1–6)

A browser-native 3D warehouse digital twin. Phase 1 delivers the "3D Foundation" (the full warehouse scene plus the interface layout). Phase 2 delivers the "Robot Simulation" (20 robots that operate in a local deterministic simulation engine).

## Start

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc type check + vite build -> dist/
npm run preview    # Preview dist/
npm test           # vitest: A* correctness, a 20-minute engine stress test, determinism, low-battery transfer, human intrusion blocking
npm run sim:stats  # Run 12000 ticks with no display and print the KPI (performance reference: ~0.1 ms/tick)
```

Requirement: Node 18+. The application needs no external resources (no HDR or GLB download). It runs offline.

## What Phase 1 delivers

- `AppShell`: A CSS Grid with three columns and a bottom row. It agrees with the layout of "expected interface.png".
- `Scene3D`: React Three Fiber (WebGL2). An InstancedMesh draws the racks and boxes in three draw calls. The scene also has conveyors, workstations, chargers, the parking area, restricted areas, docks, trucks, neon zone borders, 20 procedural AMRs, person and forklift NPCs, and the virtual cameras with their FOV cones.
- Quality levels Low / Medium / High (change them with the TopBar gear): Low has no shadows and no post-processing. Medium has shadows plus Bloom. High adds SSAO, Vignette, and ContactShadows.
- `MapView2D` / Traffic / Heatmap: These build the navigation grid from `warehouse_layout.json` and draw a 2D top view. Traffic and Heatmap currently use example hot areas.
- Interaction: Click a robot (in 3D or 2D) to select it. The Selected Robot panel in the right column updates, and the camera flies to that robot. Click a zone label to focus on the zone. Click an item in Alerts, Event Log, or Task Queue to go to the related robot. Click a Live Camera tab to change the camera.
- An FPS counter (lower right).

## What Phase 2 delivers

- `simulation/astar.ts`: An 8-direction grid A* (no corner cutting, a binary heap, temporary obstacles, and a congestion cost).
- `simulation/engine.ts`: A deterministic simulation engine (a fixed-seed PRNG, a 100 ms tick, and pure-data TwinState).
  - The robot state machine: IDLE -> TASK_ASSIGNED -> NAVIGATING -> PICKING -> TRANSPORTING -> DELIVERING -> COMPLETED; OBSTACLE_DETECTED -> REPLANNING; LOW_BATTERY -> TASK_TRANSFER -> GOING_TO_CHARGE -> CHARGING.
  - Movement: acceleration, deceleration in a turn, and the walkway speed limit. The engine uses grid cell occupancy plus a reservation of the next cell to prevent collisions. If a robot is blocked for 2.5 s, it replans automatically and treats the other robots as temporary obstacles.
  - Battery: The drain follows the speed and the load. A charge below 20% is a warning, and below 10% is critical. If the estimated remaining charge during a transport is too low, the robot transfers the task and goes to charge (6 chargers with a queue).
  - Tasks: The engine makes PICK / REPLENISH / TRANSPORT tasks automatically, each with a priority. The Fleet Manager assigns a task with a weighted score of distance, battery, load, congestion, and health. It also outputs an explainable candidate list (`recent_decisions`).
  - The engine produces the KPI, the zone congestion, the events (a ring of 500), the alerts, the throughput curve, and the traffic heatmap.
  - The scenario injection API (`engine.inject`): robot failure, battery set, conveyor failure, camera offline, human intrusion (block the zone and replan), and a task burst. The Phase 4 fault injection UI connects directly to this API.
- `simulation/runner.ts`: An rAF loop. It converts real time multiplied by the speed factor into a number of ticks, with a maximum of 40 ticks per frame.
- Frontend: exponential smoothing of the robot position (simulation at 10 Hz -> display at 60 Hz), wheel rotation, the true A* path line (orange with a load, blue to a charger), TopBar play/pause/reset/speed, the simulation clock (it starts at 08:00), and Map/Traffic/Heatmap read the traffic data of the engine.

## Directory

```
src/
  schema/twin_state.ts      # Data contract (matches docs/schema/twin_state.py)
  layout/warehouse_layout.json  # Single source of truth for the warehouse (made by docs/layout/gen_layout.py)
  layout/types.ts, navgrid.ts   # Layout types, navigation grid generation
  state/store.ts            # zustand: TwinState, selection, view, quality
  simulation/astar.ts       # A*
  simulation/engine.ts      # Simulation engine (the specification for the Phase 3 move to the backend)
  simulation/runner.ts      # The rAF loop between the engine and the store
  tests/engine.test.ts      # vitest
  components/shell/         # TopBar
  components/panels/        # Left column / right column / bottom row panels
  components/scene/         # The subcomponents of the 3D scene
  components/views/         # Viewport (tabs and toolbar), MapView2D
  components/ui/            # Shared components such as Panel, StatRow, and Icon
```

## Performance advice for an Intel Arc laptop

The default is Medium. If the FPS is less than 30, first change to Low (the TopBar gear). Then decrease the `dpr` limit in `Scene3D.tsx` to 1. The Live Camera panel is a second WebGL context (`frameloop="demand"`, it redraws only on a change). After the robots start to move in Phase 2, it changes to a constant 5 FPS update.

## What Phase 3 delivers

- `services/ws.ts`: The WebSocket client. FULL replaces the full state. PATCH merges by id (null = delete). Events prepend. If `base_tick` does not agree, the client does a RESYNC automatically. It also does a RESYNC when the browser tab comes back to the foreground. It reconnects 3 seconds after a disconnection.
- `simulation/runner.ts`: The data source changes automatically. If the backend connects, the backend drives the store fully (the TopBar shows a blue BACKEND). If the backend does not connect, or if the connection stops, the local engine continues from the state currently on the display (an orange LOCAL). The display does not go back to tick 0.
- `simControl`: One entry point for play, pause, speed, reset, inject, and create task. When online, it sends a WebSocket command. If not, it operates the local engine. The backend is the authority: if another browser tab does a pause, this tab also pauses.
- Heatmap / Traffic: When online, they read the HEATMAP layer that the backend sends every 30 ticks. When local, they read the local engine.

## What Phase 4 delivers (Operations)

- **Scenarios drawer** (TopBar ⚡): Robot Failure / Low Battery / Conveyor Failure / Human Intrusion / Traffic Congestion / Camera Failure / Task Burst, and the three-in-one of Demo 10. The "Active" area below shows the injections that TwinState indicates are in effect. One click on Clear removes them (the robot recovers, the conveyor starts, the camera goes online, the person leaves, and the speed limit stops).
- **AI Ops drawer** (TopBar 🧠): 8 KPI tiles plus the Fleet Manager decision cards (✓ reasons, the reason for each rejected candidate, and a snapshot of the weights). This is the explainability of specification 2️⃣5️⃣. The Phase 5 Copilot conversation connects to the same drawer.
- **Audit Log** (the bell, or View All in the Event Log): When online, it gets 500 records from the backend SQLite. When local, it uses the ring. It has severity, source, and keyword filters, CSV / JSON export, and a click on a row goes to the robot.
- **Tasks** (View All Tasks): All tasks with a timeline and the parent task. It also has a create task form (the source and destination come from layout.locations).
- **Robot Detail** (View Details): All fields of specification 3️⃣ plus the cumulative statistics, the events of that robot, and the Fail / Restore / Battery->8% buttons.
- You can acknowledge an alert with ✓. Live Camera has A / B / C / D / Dock tabs, and an offline camera shows NO SIGNAL. Task Overview also shows Utilization.
- Engine (the TS and Python versions agree): A conveyor failure multiplies the unload time of the station that it supplies by 4 (`layout.conveyors[].feeds`). This is the bottleneck of Demo 04. A traffic congestion injection is a speed limit in the zone plus an A* cost. The sensor readings and the conveyor throughput come from the true state. You can clear all injections.

## What Phase 5 delivers (AI)

- **Operations Copilot** (the AI Ops drawer): suggested question chips, a conversation, and clickable R03 / A3812 / E123 references in an answer (a robot goes to the selection, a task goes to the task table, and an event goes to the Audit Log). A `request_id` matches each reply, so multiple questions in flight do not get mixed. If the backend has an `OPENAI_API_KEY`, it uses the LLM (structured JSON output, and a citation is only permitted for an id that exists in the snapshot). If not, it uses rule-based analysis. The UI shows `gpt-4o-mini` or `rule-based`.
- **VLM Perception** (Live Camera): Analyze makes the current image into a 512px JPEG and sends it to `/api/vlm/observe`. The detection boxes and the confidence values come back and go on top of the image. The 5 s auto mode gives continuous monitoring. With no key, the backend uses the ground truth to simulate the result (it shows `sim`).
- Engine (the TS and Python versions agree): **deadlock breaker** — if a robot is 3 cells or less from a station and the cell in front is occupied, it works in place (10 robots no longer queue for the same cell). If two robots block each other, the empty robot yields to the loaded robot, or the robot with the higher number yields (it backs off to an adjacent free cell and then returns). A diagonal move also reserves the two orthogonal neighbor cells (this prevents an X-shaped collision). The three-in-one Demo 10 no longer deadlocks in 30 minutes (263 tasks, against 44 before the correction).
- Tests: The collision test now uses the physical distance (a distance of less than 0.5 m between any two robots is a failure). There is also a minimum throughput for 30 minutes with combined faults.

## What Phase 6 delivers (What-if)

- **What-if drawer** (TopBar ⑂): Select the scenarios (R07 failure, Conveyor #03, a person in Zone B, congestion in Zone C, a camera, Peak demand +20 tasks, R03 low battery), a duration of 1–10 minutes, and whether to compare against the baseline. Then press RUN. The backend copies the LIVE engine two times (the same tick and the same random state), runs both, and returns: a comparison table of 12 metrics with the Baseline / Scenario / Δ values (red or green follows the "higher is better" rule), the AI advice, and the key events in the scenario. **Apply scenario to LIVE** sends the same set of injections to LIVE. LIVE is not affected at any time.

## Phase 7 (Robotics Extension) interface

- ROS 2 / Webots: The backend `SimEngine.step()` is the only point that moves the simulation forward. Change `robots[id].position/heading` to read from a ROS topic, and change `path` to send a nav goal. Nothing else changes (tasks, KPI, events, and AI). The `TwinState` contract does not change, and the frontend needs no modification.
- Known limits: The robots have only grid cell avoidance. There is no true multi-robot cooperative planning (CBS). Idle robots that return to the parking area can wait for each other for a short time. The Live Camera panel is a second WebGL context. On a low-performance GPU, consider a change to a RenderTarget texture.

## Deployment

The frontend is a set of static files. The backend is a long-running WebSocket service (you cannot use serverless).

**Backend -> Render (free)**: New -> Blueprint -> point it at the repo. Render reads `backend/render.yaml`. After the deployment, you get `https://<name>.onrender.com`. Go to Environment and change `TWIN_CORS_ORIGINS` to the frontend domain. The free plan sleeps after 15 minutes of no activity, and it needs approximately 30 seconds to wake. During this time the frontend shows LOCAL and uses the local engine. When the backend wakes, the frontend connects again automatically.
You can also deploy `backend/Dockerfile` to Fly.io (`fly.toml` is included), Railway, or Cloud Run.

**Frontend -> Vercel**: Import the repo, set Root Directory to `frontend`, and add the environment variable `VITE_WS_URL = wss://<name>.onrender.com/ws` (note that it is **wss**; an HTTPS page cannot connect to ws). `vercel.json` already has the Vite and SPA rewrite configuration.

GitHub Pages is also possible. But you must add `base: "/<repo-name>/"` to `vite.config.ts`, and set `VITE_WS_URL` in the build step of the Actions workflow.
