# warehouse_layout.json format

## Purpose

This file is the single source of truth for the warehouse. The 3D scene (Three.js), the navigation grid (A*), the Map View, the Heatmap, the camera list, and the task source/destination all come from this one layout. No component can hard-code its own coordinates. This gives two advantages: change one file, and the four views stay in agreement; What-if and the tests can also load a different layout for comparison.

Related files: `gen_layout.py` (the script that makes the example; change the parameters and run it again), `warehouse_layout.json` (the example: 100x70 m, 4 zones, 160 racks, 3 conveyors, 6 charging stations, 14 cameras, 20 robot spawn points), and `layout_preview.png` (a top view preview).

## Coordinate system

The system is right-handed. The unit is the meter. `x` is the long side of the warehouse (0 -> 100), `z` is the short side (0 -> 70), and `y` is the height. `z = 0` is the dock side (Inbound / Outbound). `z = 70` is the charging and packing side. Write all 2D fields as `[x, z]`. Write all 3D fields as `[x, y, z]`. `rotation` and `heading` are radians around the y axis, and 0 points to +x. Write a rectangle `rect` as `[x0, z0, x1, z1]`. Write a polygon `polygon` as `[[x, z], ...]`, in clockwise or counterclockwise order.

## Top-level structure

```jsonc
{
  "schema_version": "1.0",
  "id": "wh-main-v1",              // TwinState.layout_id matches this value
  "name": "Main Warehouse (100x70m)",
  "units": "m",
  "size":  { "width": 100, "depth": 70, "height": 12 },
  "grid":  { "cell_size": 1.0, "cols": 100, "rows": 70 },   // Navigation grid resolution
  "zones": [...], "docks": [...], "racks": [...], "conveyors": [...],
  "stations": [...], "charging_stations": [...], "parking": [...],
  "restricted_areas": [...], "walkways": [...],
  "cameras": [...], "sensors": [...],
  "locations": [...],             // All reachable positions that a task can refer to
  "obstacles": [...],             // Static objects (pillars, temporary stacks)
  "spawn": { "robots": [...] }
}
```

## Fields in each section

**zones** — One record for each zone: `id` ("A".."D", the same as the key in TwinState.zones), `name`, `color` (a hex value that the UI and the 3D border share), and `polygon`. The design keeps a central aisle (x 46-54) and a conveyor corridor (z 32-38) between the zones. Robots can also move outside a zone. A zone is only a logical unit for statistics and for blocking.

**docks** — `id`, `kind` (INBOUND | OUTBOUND), `zone`, `rect`, and `door` (the 2D position of the door, used to draw the door in 3D). Each dock automatically makes one reachable position in `locations` with the same id.

**racks** — This is the largest section. The 3D scene draws it in one pass with an InstancedMesh. Fields: `id`, `zone`, `position` (the front left corner, y=0), `size` (`[length, height, depth]`), `rotation`, `levels` (the number of levels, used to draw the boxes), `model` (the GLB name), and `blocks_grid` (true means that the cells it occupies are obstacles in the navigation grid).

**conveyors** — `id` ("CV01", the same as the key in TwinState.conveyors), `name` (the UI shows "Conveyor #03"), `zone`, `path` (a 2D polyline point list), `width`, `speed_mps`, `direction` (FORWARD | REVERSE), `blocks_grid`, and `feeds` (the id of the station that this conveyor supplies; when the conveyor fails, the unload dwell time at that station increases by 4 times, which is the cause of the Demo 04 bottleneck). A conveyor is an obstacle, and a robot cannot cross it. If you need a crossing point, divide the `path` into two conveyors at that point.

**stations** — Packing, sorting, and other workstations: `id`, `kind`, `zone`, `rect`, and `access_point` (the 2D point where the robot stops; it must be outside the rect and on a passable cell). These also make the related `locations` automatically.

**charging_stations** — `id` ("CHG-01"), `zone`, `position`, `heading` (the docking direction), `power_kw` (the charge rate for the battery model), and `access_point`.

**parking** — `id`, `zone`, `rect`, and `slots`. This is the standby area for idle robots. The Fleet Manager sends IDLE robots back to this area.

**restricted_areas** — `rect` plus `robots_allowed: false`. The navigation grid marks these cells as obstacles directly.

**walkways** — Pedestrian ways: `polygon`, `robots_allowed`, and `speed_limit_mps`. A robot can pass, but it must decrease speed. During a Human Intrusion injection, people appear along a walkway first.

**cameras** — `id` ("CAM-B03"), `zone`, `position` (includes the height), `look_at`, `fov_deg`, and `range_m`. The Virtual CCTV in the 3D scene uses these parameters to make a PerspectiveCamera that renders to a RenderTarget. Phase 5 sends a screenshot of that RenderTarget to the VLM.

**sensors** — `id`, `kind` (LIDAR | IR | WEIGHT | TEMP | PRESENCE), `zone`, and `position`. In the first version these are only scene decoration and status display. They do not change the simulation.

**locations** — The dictionary of positions that the task system knows. Each record has `id`, `kind` (SHELF | PACKING | SORTING | INBOUND | OUTBOUND | CHARGING), `zone`, `rack_id` (only for SHELF), `level_range`, and `access_point`. **TaskState.source and TaskState.destination can only contain an id from this list.** The simulation engine uses `access_point` as the target cell for A*. In the example, each rack bay has one SHELF location on each side (`SHELF-A01` ... `SHELF-A80`). The 4 zones thus have 320 accessible storage positions. With the docks, stations, and charging stations, there are 333 records.

**obstacles** — Temporary obstacles: `id`, `rect` or `polygon`, and `blocks_grid`. The example is empty. You can add obstacles dynamically during a fault injection (for example, dropped goods). But for dynamic obstacles, use TwinState.people / events. Do not write back to the layout.

**spawn.robots** — The initial `id`, `position`, `heading`, and `battery` of the 20 robots. A simulation RESET rebuilds the robots from this data.

## Rules to make the navigation grid

`size` and `grid.cell_size` set the grid (the example is 100x70 = 7,000 cells). A cell is an obstacle if, and only if, it intersects a rack or conveyor with `blocks_grid: true`, a `restricted_areas` entry, or the outer wall of the warehouse. A walkway is not an obstacle, but its cells have a `speed_factor` (a limit of 0.8 m/s). This rule is a pure function `buildNavGrid(layout) -> Uint8Array`. The frontend and the backend each have one implementation. A unit test compares the results of the two with the same layout. This makes sure that the walls in the Map View agree with the walls that the backend A* knows.

## Validation rules (check these at load time)

All `id` values must be unique in the file. Each `locations[].access_point` must be on a passable cell. Each `spawn.robots[].position` must be on a passable cell, and the positions must not overlap. Each `zone` reference must exist in `zones`. Each `conveyors[].path` must have a minimum of 2 points. A rack must not go outside the warehouse boundary. Write these checks as `validate_layout(layout)`, which returns a list of errors. Run it once for each layout file in CI.

## Design intent of the example

The example intentionally follows the layout of the target interface image: the docks are at the top, Zone A/B fill the upper half, Zone C/D fill the lower half, the conveyors cross the center and turn to Packing on the right side (Conveyor #03), the charging stations are at the lower left, and the parking area is at the bottom center. Conveyor #03 is at the end of Zone D and goes to PACK-01. Thus Demo 04, "Conveyor #03 stops", causes a real bottleneck at the packing end. It is not only a color change.

To change the size or the density, change the parameters at the top of `gen_layout.py` (`W, D`, the number of rows in each zone `n_rows`, and the number of bays in each row) and generate the layout again.


## floors / lifts (Phase 8)

- `floors`: `[{id, name, elevation, footprint?}]` — The list of floors. `elevation` is the height of the top surface of the floor slab (m). `footprint` is the polygon of the floor slab above level 1. The area outside the footprint has no floor slab, and it is an obstacle.
- `lifts`: `[{id, cell:[c,r], floors:[…], ride_ticks}]` — Material lifts. The `cell` must be passable on all floors that the lift connects. A lift carries one robot at a time. `ride_ticks` is the ride time.
- `columns`: `[[x, z], …]` — The positions of the mezzanine support columns. They stand on the F1 ground and hold the floor slab. The F1 navigation grid blocks a 0.9x0.9 m column base as an obstacle. Do not put a column on a pick or drop point, a charger, a parking slot, or a lift queue line or exit.
- `obstacles`: `[{id, kind:"PILLAR"|"CONVEYOR_EQUIP", rect:[x0,z0,x1,z1]}]` — Physical obstacles. The F1 navigation grid blocks the full area.
  - `PILLAR`: A structural column of the building. The 3D scene (WarehouseShell) renders it from this data and no longer generates it procedurally. Do not put a pillar on a conveyor, an aisle, or a pick or drop point.
  - `CONVEYOR_EQUIP` (round-9f): The footprint of the machine at the conveyor end point (the infeed hopper or the receiving machine). It is the end point +-1.5 m. In 3D, the endEquip of Fixtures puts the machine at the conveyor path end point (a visual item). This entry is the related grid block. The single data source for both is the path end points of the conveyors (gen_layout.py derives them automatically and removes duplicate end points). The robot path thus keeps a body clearance from the machine, and contact no longer occurs.
- Conveyor layout (round-9f): The vertical conveyors (CV03/CV04) are against the wall (x=1.4 / 98.6), and the blocked cells of the conveyor body go to the wall surface. Thus the narrow 1-2 cell path along the wall does not exist, and robots always use the inner 4-6 m lane. The horizontal conveyors (CV01/CV02) are shorter, at x 10-46 / 54-90. Each end keeps approximately 5 m of crossing space outside the machine. The traffic that crosses z=35 divides into three places: west (cols 3-7), center (the central aisle, cols 48-51), and east (cols 92-96). Thus all traffic does not go into the central aisle in front of the lift lobby.
- `racks`, `locations`, `zones`, `cameras`, and `spawn.robots` can each have a `floor` value (the default is 1). Each floor has its own navigation grid (see the floor parameter of navgrid).
