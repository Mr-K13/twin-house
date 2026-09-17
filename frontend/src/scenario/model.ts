/**
 * Pure helpers for the scenario workspace (no React, no DOM): size validation, instance ids, placement (surface snapping, footprints kept
 * between the walls with magnetic walls), rotation wrapping, 2D footprints and the debounced auto-save scheduler. Everything here is covered by tests/scenario.test.ts.
 */
import type { P2, P3 } from "../layout/types";
import type { AssetInstance, AssetTypeId, ScenarioSize } from "./types";
import { ASSET_DEFS, type AssetDef, type Params } from "./assetDefs";

/** Same bounds as ScenarioSize in backend/app/schema.py (metres) */
export const SIZE_LIMITS: Record<keyof ScenarioSize, readonly [number, number]> = { length: [5, 500], width: [5, 500], height: [3, 40] };
const SIZE_KEYS = ["length", "width", "height"] as const;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Human-readable errors; empty when the size is acceptable to the backend */
export function validateSize(size: ScenarioSize): string[] {
  const errors: string[] = [];
  for (const k of SIZE_KEYS) {
    const v = size[k], [lo, hi] = SIZE_LIMITS[k];
    if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${cap(k)} must be a number`);
    else if (v < lo || v > hi) errors.push(`${cap(k)} must be between ${lo} and ${hi} m`);
  }
  return errors;
}

/** Catalog-style id prefixes: RACK-01, R01, CV01, ST-01, CHG-01, LIFT-01, CAM-01, SEN-01, DOCK-01, W-01, FL-01 */
export const ID_PREFIX: Record<AssetTypeId, string> = { rack: "RACK-", robot: "R", conveyor: "CV", station: "ST-", charging: "CHG-", lift: "LIFT-", camera: "CAM-", sensor: "SEN-", dock: "DOCK-", worker: "W-", forklift: "FL-" };

/** First unused zero-padded number for the type's prefix */
export function nextInstanceId(type: AssetTypeId, existing: readonly AssetInstance[]): string {
  const used = new Set(existing.map((i) => i.id));
  for (let n = 1; ; n++) { const id = ID_PREFIX[type] + String(n).padStart(2, "0"); if (!used.has(id)) return id; }
}

/** Distance (m) within which a footprint edge moved towards a wall is pulled flush against it (pointer moves and drops only) */
export const WALL_SNAP_DISTANCE = 0.5;

/** Half of the axis-aligned x / z extent of the footprint turned by `rotation`: the box that footprintCorners spans */
export function footprintHalfExtents(def: AssetDef, params: Params, rotation: number): { hx: number; hz: number } {
  const { w, d } = def.footprint(params);
  const c = Math.abs(Math.cos(rotation)), s = Math.abs(Math.sin(rotation));
  return { hx: (w * c + d * s) / 2, hz: (w * s + d * c) / 2 };
}

/** One axis: keep [v − half, v + half] inside [0, hi], centred when it does not fit; an edge within `snap` of a wall is pulled flush against it */
function betweenWalls(v: number, half: number, hi: number, snap: number): number {
  const lo = half, up = hi - half;
  if (up < lo) return hi / 2;
  const c = Math.min(up, Math.max(lo, v));
  if (c - lo <= snap) return lo;
  if (up - c <= snap) return up;
  return c;
}

/**
 * The whole footprint stays between the walls, not just the instance centre: x ∈ [hx, L − hx] and z ∈ [hz, W − hz] for the rotated footprint's
 * half extents (an instance wider than the warehouse is centred), y ∈ [0, H]. `snap` > 0 makes the walls magnetic (WALL_SNAP_DISTANCE for
 * drags and drops; typed inspector values and rotations only get the clamp). Returns `inst` itself when nothing had to move.
 */
export function constrainToWalls(inst: AssetInstance, size: ScenarioSize, snap = 0): AssetInstance {
  const { hx, hz } = footprintHalfExtents(ASSET_DEFS[inst.type], inst.params, inst.rotation);
  const [x, y, z] = inst.position;
  const position: P3 = [betweenWalls(x, hx, size.length, snap), Math.min(size.height, Math.max(0, y)), betweenWalls(z, hz, size.width, snap)];
  return position[0] === x && position[1] === y && position[2] === z ? inst : { ...inst, position };
}

/** Millimetre precision: raycast hits carry ~15 digits that only bloat the saved document */
export function roundMm(p: P3): P3 { return [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000, Math.round(p[2] * 1000) / 1000]; }

const TAU = 2 * Math.PI;
/** Wrap a yaw into [0, 2π) */
export function wrapRotation(r: number): number { const w = ((r % TAU) + TAU) % TAU; return w >= TAU ? 0 : w; }
export function rotateBy(rotation: number, delta: number): number { return wrapRotation(rotation + delta); }

/** The yaw ring is magnetic: within this many radians of 0°, 90°, 180° or 270° it snaps to that direction (half a Q / E step) */
export const CARDINAL_SNAP_TOLERANCE = (7.5 * Math.PI) / 180;
/** Nearest multiple of 90° when `rotation` is within `tolerance` of one, otherwise `rotation` unchanged; the result is wrapped into [0, 2π) */
export function snapToCardinal(rotation: number, tolerance = CARDINAL_SNAP_TOLERANCE): number {
  const quarter = Math.PI / 2;
  const nearest = Math.round(rotation / quarter) * quarter;
  return wrapRotation(Math.abs(rotation - nearest) <= tolerance ? nearest : rotation);
}

/**
 * Yaw around y of a rotation given as a quaternion. `Object3D.rotation.y` is not usable for this: three.js decomposes a pure 120° yaw
 * into the Euler triple (π, 60°, π), so reading `.y` after a TransformControls drag would store 60°. atan2(m13, m11) of the rotation
 * matrix is the yaw itself, in (−π, π].
 */
export function yawFromQuaternion(x: number, y: number, z: number, w: number): number {
  return Math.atan2(2 * (x * z + w * y), 1 - 2 * (y * y + z * z));
}

/** A new instance of `type` at `position` with the editor defaults cloned and a fresh id; a free-height type (camera) starts at its mount height */
export function makeInstance(type: AssetTypeId, position: P3, existing: readonly AssetInstance[]): AssetInstance {
  const def = ASSET_DEFS[type];
  const params = { ...def.defaults };
  const mount = params.mount_h;
  const y = def.surface === "free" && typeof mount === "number" ? mount : position[1];
  return { id: nextInstanceId(type, existing), type, position: [position[0], y, position[2]], rotation: 0, params };
}

/** Drop / place: snap types take the surface hit point (the floor or a stackable top), free types keep their mount height; the footprint stays between the walls and snaps flush to a wall within WALL_SNAP_DISTANCE */
export function placeOnSurface(type: AssetTypeId, hit: P3, size: ScenarioSize, existing: readonly AssetInstance[]): AssetInstance {
  const inst = constrainToWalls(makeInstance(type, hit, existing), size, WALL_SNAP_DISTANCE);
  return { ...inst, position: roundMm(inst.position) };
}

/**
 * The four footprint corners in the x/z plane, rotated with the three.js `rotation-y` convention — (x, z) → (x cos θ + z sin θ, −x sin θ + z cos θ),
 * which is an SVG rotate(−θ°) — and translated to the instance position. Used by the 2D view.
 */
export function footprintCorners(inst: AssetInstance, def: AssetDef): P2[] {
  const { w, d } = def.footprint(inst.params);
  const c = Math.cos(inst.rotation), s = Math.sin(inst.rotation);
  const [x, , z] = inst.position;
  const local: P2[] = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  return local.map(([lx, lz]) => [x + lx * c + lz * s, z - lx * s + lz * c]);
}

// ── Debounced auto-save ─────────────────────────────────────
export interface SaveOptions { keepalive?: boolean }
export interface SaveScheduler<T> {
  /** Remember the latest document and (re)start the delay */
  schedule(doc: T): void;
  /** Save a pending document now; resolves when that save (or the one already in flight) has finished and rejects when it failed */
  flush(opts?: SaveOptions): Promise<void>;
  /** A document is waiting for the delay to elapse */
  pending(): boolean;
  /** Drop the pending document without saving */
  cancel(): void;
}
/** Injectable timer so the scheduler is unit-tested without fake DOM timers */
export interface SchedulerTimer { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
const realTimer: SchedulerTimer = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/**
 * Many `schedule` calls within `delayMs` collapse into one `save` of the latest document (a drag-move never issues more than one request).
 * Saves never overlap: the next one waits for the one in flight, so the backend always receives them in order. A failed save puts its
 * document back as pending (unless a newer one arrived meanwhile), so the next `flush` or `schedule` retries it and no edit is lost.
 */
export function createSaveScheduler<T>(save: (doc: T, opts: SaveOptions) => Promise<void>, delayMs = 800, timer: SchedulerTimer = realTimer): SaveScheduler<T> {
  let latest: T | null = null;
  let handle: unknown = null;
  let inflight: Promise<void> = Promise.resolve();
  let lastResult: Promise<void> = inflight;
  const clearTimer = () => { if (handle !== null) { timer.clear(handle); handle = null; } };
  const run = (opts: SaveOptions = {}): Promise<void> => {
    clearTimer();
    if (latest === null) return lastResult;
    const doc = latest; latest = null;
    const attempt = async () => {
      try { await save(doc, opts); }
      catch (e) { if (latest === null) latest = doc; throw e; }
    };
    lastResult = inflight.then(attempt, attempt);
    inflight = lastResult.catch(() => undefined);   // the internal chain never stays rejected
    return lastResult;
  };
  return {
    schedule(doc) { latest = doc; clearTimer(); handle = timer.set(() => { run().catch(() => undefined); }, delayMs); },
    flush(opts) { return run(opts); },
    pending() { return latest !== null; },
    cancel() { clearTimer(); latest = null; },
  };
}
