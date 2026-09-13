/**
 * Catalog 3D preview: one small orbiting <Canvas> that draws a single instance of the selected asset type with the same
 * procedural models as the main scene (RackInstances, RobotMesh, Conveyor, StationModel, ChargerModel, Lift, CameraModel,
 * SensorModel, DockModel). The instance is re-centred at the origin and the camera distance comes from the per-type PREVIEWS config.
 */
import { useEffect } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { LayoutRack, LayoutSpawnRobot, LayoutConveyor, LayoutStation, LayoutCharging, LayoutLift, LayoutCamera, LayoutSensor, LayoutDock } from "../../layout/types";
import type { RobotState } from "../../schema/twin_state";
import { SIM, ROBOT_DEFAULTS } from "../../simulation/engine";
import { RackInstances } from "../scene/RackInstances";
import { RobotMesh } from "../scene/Robots";
import { Conveyor, StationModel, ChargerModel, SensorModel } from "../scene/Fixtures";
import { Lift, FLOOR_ELEV } from "../scene/Mezzanine";
import { CameraModel } from "../scene/Cameras";
import { DockModel } from "../scene/WarehouseShell";

/** How to frame one instance: the world point to centre on, the camera distance, the orbit target height, and the model */
interface PreviewDef<T> { center: (o: T) => [number, number, number]; dist: (o: T) => number; lookY?: (o: T) => number; render: (o: T) => JSX.Element }
const def = <T,>(d: PreviewDef<T>): PreviewDef<never> => d;

/** A robot at the origin, idle, using the engine's spawn defaults (RobotMesh needs a full RobotState) */
const robotState = (sp: LayoutSpawnRobot): RobotState => ({
  id: sp.id, model: ROBOT_DEFAULTS.model, floor: 1, lift_id: null, lift_stage: null, position: [0, 0, 0], heading: 0.6, velocity: 0, max_speed: SIM.MAX_SPEED,
  battery: sp.battery, status: "IDLE", fsm: "IDLE", health: 100, current_task_id: null, destination: null, path: [], path_index: 0,
  load: { current: 0, capacity: ROBOT_DEFAULTS.load_capacity }, zone: null, eta_s: null, fsm_since_tick: 0,
  stats: { distance_m: 0, tasks_completed: 0, energy_wh: 0, busy_ticks: 0, wait_ticks: 0 }, perception: { state: "CLEAR", ahead_m: SIM.LIDAR_RANGE, nearest_m: null, obstacles: [] },
});
const bbox = (pts: Array<[number, number]>) => { const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) }; };

export const PREVIEWS: Record<string, PreviewDef<never>> = {
  rack: def<LayoutRack>({ center: (r) => [r.position[0] + r.size[0] / 2, 0, r.position[2] + r.size[2] / 2], dist: (r) => Math.max(r.size[0], r.size[1]) * 2.1, lookY: (r) => r.size[1] / 2, render: (r) => <RackInstances racks={[r]} castShadow={false} /> }),
  robot: def<LayoutSpawnRobot>({ center: () => [0, 0, 0], dist: () => 3.2, lookY: () => 0.3, render: (sp) => <RobotMesh r={robotState(sp)} selected={false} onSelect={() => {}} showLabel={false} lite smooth={false} /> }),
  conveyor: def<LayoutConveyor>({ center: (c) => { const b = bbox(c.path); return [(b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2]; }, dist: (c) => { const b = bbox(c.path); return Math.max(b.x1 - b.x0, b.z1 - b.z0) * 0.9 + 6; }, lookY: () => 0.6, render: (c) => <Conveyor c={c} /> }),
  station: def<LayoutStation>({ center: (s) => [(s.rect[0] + s.rect[2]) / 2, 0, (s.rect[1] + s.rect[3]) / 2], dist: (s) => Math.max(s.rect[2] - s.rect[0], s.rect[3] - s.rect[1]) * 1.4 + 2, lookY: () => 0.6, render: (s) => <StationModel s={s} lite /> }),
  charging: def<LayoutCharging>({ center: (c) => [c.position[0], 0, c.position[2] - 0.9], dist: () => 5, lookY: () => 0.5, render: (c) => <ChargerModel c={c} lite /> }),
  lift: def<LayoutLift>({ center: (l) => [l.cell[0] + 0.5, 0, l.cell[1] + 0.5], dist: () => (FLOOR_ELEV[2] ?? 8) * 1.7 + 4, lookY: () => ((FLOOR_ELEV[2] ?? 8) + 2.4) / 2, render: (l) => <Lift l={l} elev={FLOOR_ELEV[2] ?? 8} lite /> }),
  camera: def<LayoutCamera>({ center: (c) => [c.position[0], c.position[1], c.position[2]], dist: () => 7, lookY: () => -1.6, render: (c) => <CameraModel c={c} active /> }),
  sensor: def<LayoutSensor>({ center: (s) => [s.position[0], s.position[1], s.position[2]], dist: () => 2.2, lookY: () => 0, render: (s) => <SensorModel s={s} /> }),
  dock: def<LayoutDock>({ center: (d) => [d.door[0], 0, -2], dist: () => 16, lookY: () => 2, render: (d) => <DockModel d={d} /> }),
};

/** Re-frames the (single, long-lived) canvas camera when the previewed instance changes, so the WebGL context and compiled shaders are kept */
function Framing({ d, lookY }: { d: number; lookY: number }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    camera.position.set(d * 0.75, d * 0.55 + lookY, d * 0.75); camera.far = d * 12; camera.near = 0.1; camera.lookAt(0, lookY, 0); camera.updateProjectionMatrix();
  }, [camera, d, lookY]);
  return null;
}

/** One instance of `typeId` in a small orbiting canvas; falls back to a hint when the type has no preview */
export function CatalogPreview({ typeId, instance, label }: { typeId: string; instance: object; label: string }) {
  const p = PREVIEWS[typeId];
  if (!p) return <div className="catalog-3d hint">No 3D preview for this type.</div>;
  const o = instance as never;
  const c = p.center(o), d = p.dist(o), lookY = p.lookY?.(o) ?? 0;
  return (
    <div className="catalog-3d">
      <Canvas resize={{ offsetSize: true }} dpr={1} camera={{ position: [d * 0.75, d * 0.55 + lookY, d * 0.75], fov: 34, near: 0.1, far: d * 12 }} gl={{ alpha: true, antialias: true }} style={{ background: "transparent" }}>
        <Framing d={d} lookY={lookY} />
        <ambientLight intensity={0.85} />
        <hemisphereLight args={["#dbe4f0", "#334155", 0.5]} />
        <directionalLight position={[d, d * 1.2, d * 0.6]} intensity={2.2} />
        <pointLight position={[-d, d * 0.4, -d]} color="#60a5fa" intensity={d * 2} />
        <gridHelper args={[d * 2.2, Math.max(8, Math.round(d * 2.2)), "#94a3b8", "#cbd5e1"]} position={[0, -c[1] - 0.005, 0]} />
        <group key={`${typeId}:${label}`} position={[-c[0], -c[1], -c[2]]}>{p.render(o)}</group>
        <OrbitControls target={[0, lookY, 0]} autoRotate autoRotateSpeed={0.9} enablePan={false} minDistance={d * 0.4} maxDistance={d * 3} maxPolarAngle={Math.PI / 2.05} enableDamping dampingFactor={0.1} />
      </Canvas>
      <span className="cap">3D · {label} · drag to orbit</span>
    </div>
  );
}
