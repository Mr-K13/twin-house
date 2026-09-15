/**
 * Scenario workspace contract. Mirror of the Pydantic models in backend/app/schema.py (ScenarioSize, AssetInstance, ScenarioBody, Scenario);
 * the backend validates every document, this file only types it. Coordinates in metres: Length → x, Width → z, Height → y (the same mapping as
 * warehouse_layout.json); `rotation` is the yaw in radians around y, rendered with three.js `rotation-y`.
 */
import type { P3 } from "../layout/types";

/** Equal to the ids in catalog/assetTypes.ts and ASSET_TYPE_IDS in the backend; tests/scenario.test.ts enforces the frontend side */
export type AssetTypeId = "rack" | "robot" | "conveyor" | "station" | "charging" | "lift" | "camera" | "sensor" | "dock" | "worker" | "forklift";

export interface ScenarioSize { length: number; width: number; height: number }
export type ParamValue = number | string | boolean;

/** One placed asset: the parent group in the 3D scene carries `position` / `rotation`; `params` are the type-specific editor fields */
export interface AssetInstance { id: string; type: AssetTypeId; position: P3; rotation: number; params: Record<string, ParamValue> }

export interface Scenario { id: string; name: string; size: ScenarioSize; instances: AssetInstance[]; created_at: string; updated_at: string }
/** What GET /api/scenarios returns: no instances, only their count */
export interface ScenarioSummary { id: string; name: string; size: ScenarioSize; instance_count: number; created_at: string; updated_at: string }
