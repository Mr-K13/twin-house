/**
 * The built-in twin: the bundled Main Warehouse (warehouse_layout.json). It is listed first on the setup page next to the twins stored in the
 * backend, is read-only (no workspace, no delete), and its console keeps the backend WebSocket simulation. Backend twin ids are "sc-<hex>",
 * so this id cannot collide with one.
 */
import { BUNDLED_LAYOUT } from "../state/store";
import type { ScenarioSummary } from "../scenario/types";

export const BUILTIN_TWIN_ID = "main-warehouse";

const L = BUNDLED_LAYOUT;
export const BUILTIN_TWIN_SUMMARY: ScenarioSummary = {
  id: BUILTIN_TWIN_ID,
  name: L.name,
  size: { length: L.size.width, width: L.size.depth, height: L.size.height },
  instance_count: L.racks.length + L.spawn.robots.length + L.conveyors.length + L.stations.length + L.charging_stations.length
    + L.lifts.length + L.cameras.length + L.sensors.length + L.docks.length,
  created_at: "", updated_at: "",
};
