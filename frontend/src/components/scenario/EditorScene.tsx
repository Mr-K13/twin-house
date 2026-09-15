/**
 * 3D editor of the workspace. The warehouse box (floor with the shared texture, translucent walls, 10 m grid), one InstanceNode per placed
 * asset — the existing procedural model inside <group position rotation-y> — click-to-select, drag-to-move with surface snapping, a yaw ring
 * (drei TransformControls) on the selection, and the HTML5 drop target that turns a palette drag into a new instance while a translucent ghost
 * of the footprint follows the pointer.
 * Placement raycasts only hit meshes tagged `userData.surface`: the floor and the invisible top caps of stackable instances. A cap carries
 * `userData.instanceId`, so the instance being moved never snaps onto itself. Cameras ("free" surface) move on the horizontal plane of their
 * current mount height instead.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MutableRefObject } from "react";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Line, OrbitControls, TransformControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl, TransformControls as TransformControlsImpl } from "three-stdlib";
import type { P3 } from "../../layout/types";
import type { AssetInstance, AssetTypeId, ScenarioSize } from "../../scenario/types";
import { ASSET_DEFS, type AssetDef } from "../../scenario/assetDefs";
import { placeOnSurface, wrapRotation } from "../../scenario/model";
import { useScenarioStore } from "../../scenario/store";
import { useFloorTexture } from "../scene/WarehouseShell";
import { DRAG_MIME } from "./AssetPalette";

interface Hit { point: THREE.Vector3; instanceId: string | null }
/** R3F replaces `event.target` with a pointer-capture proxy that routes later events to the capturing object */
interface CaptureTarget { setPointerCapture(pointerId: number): void; releasePointerCapture(pointerId: number): void }
const captureTarget = (e: ThreeEvent<PointerEvent>) => e.target as unknown as CaptureTarget;
/** three-stdlib types `axis` as private; it is the gizmo handle under the pointer (null when the pointer is not on the ring) */
const gizmoAxis = (tc: TransformControlsImpl | null) => (tc as unknown as { axis: string | null } | null)?.axis ?? null;
/** Imperative raycast bridge from the DOM drop handlers (and the drag-move) into the R3F scene */
interface SceneApi {
  hitSurface(ndc: THREE.Vector2, excludeId?: string): Hit | null;
  hitSurfaceRay(ray: THREE.Ray, excludeId?: string): Hit | null;
  hitPlaneY(ray: THREE.Ray, y: number): THREE.Vector3 | null;
}

function SceneBridge({ apiRef }: { apiRef: MutableRefObject<SceneApi | null> }) {
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const caster = new THREE.Raycaster();
    const surfaces = (excludeId?: string) => {
      const out: THREE.Object3D[] = [];
      scene.traverse((o) => { if (o.userData.surface && (excludeId === undefined || o.userData.instanceId !== excludeId)) out.push(o); });
      return out;
    };
    const nearest = (excludeId?: string): Hit | null => {
      const hits = caster.intersectObjects(surfaces(excludeId), false);
      return hits.length ? { point: hits[0].point.clone(), instanceId: (hits[0].object.userData.instanceId as string | undefined) ?? null } : null;
    };
    apiRef.current = {
      hitSurface(ndc, excludeId) { caster.setFromCamera(ndc, camera); return nearest(excludeId); },
      hitSurfaceRay(ray, excludeId) { caster.ray.copy(ray); return nearest(excludeId); },
      hitPlaneY(ray, y) { const p = new THREE.Vector3(); return ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null; },
    };
    return () => { apiRef.current = null; };
  }, [apiRef, camera, scene]);
  return null;
}

/** Straight lines every `step` metres over an L × W floor (gridHelper is square, the floor is not) */
function FloorGrid({ L, W, step, color, opacity, y }: { L: number; W: number; step: number; color: string; opacity: number; y: number }) {
  const geo = useMemo(() => {
    const pts: number[] = [];
    for (let x = 0; x <= L + 1e-6; x += step) pts.push(x, 0, 0, x, 0, W);
    for (let z = 0; z <= W + 1e-6; z += step) pts.push(0, 0, z, L, 0, z);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [L, W, step]);
  useEffect(() => () => geo.dispose(), [geo]);
  return <lineSegments geometry={geo} position={[0, y, 0]}><lineBasicMaterial color={color} transparent opacity={opacity} /></lineSegments>;
}

/** Floor (the permanent raycast surface), translucent walls, wall edges, lights, background */
function EditorShell({ size }: { size: ScenarioSize }) {
  const { length: L, width: W, height: H } = size;
  const floorTex = useFloorTexture(L, W);
  const scene = useThree((s) => s.scene);
  useEffect(() => { scene.background = new THREE.Color("#05080f"); return () => { scene.background = null; }; }, [scene]);
  const walls = useMemo<Array<{ p: P3; s: P3 }>>(() => [
    { p: [L / 2, H / 2, 0], s: [L, H, 0.15] }, { p: [L / 2, H / 2, W], s: [L, H, 0.15] },
    { p: [0, H / 2, W / 2], s: [0.15, H, W] }, { p: [L, H / 2, W / 2], s: [0.15, H, W] },
  ], [L, W, H]);
  const floorEdge: P3[] = [[0, 0, 0], [L, 0, 0], [L, 0, W], [0, 0, W], [0, 0, 0]];
  const topEdge: P3[] = [[0, H, 0], [L, H, 0], [L, H, W], [0, H, W], [0, H, 0]];
  return (
    <group>
      <ambientLight intensity={0.45} color="#b9c6e0" />
      <hemisphereLight args={["#9db4e0", "#1a2233", 0.5]} />
      <directionalLight position={[L * 0.3, Math.max(40, H * 3), W * 0.2]} intensity={1.5} color="#e8eefc" />
      <pointLight position={[L / 2, H, W / 2]} intensity={0.5} color="#60a5fa" distance={Math.max(L, W)} decay={1} />
      <mesh rotation-x={-Math.PI / 2} position={[L / 2, 0, W / 2]} userData={{ surface: true }}>
        <planeGeometry args={[L, W]} />
        <meshStandardMaterial map={floorTex} roughness={0.85} metalness={0.15} />
      </mesh>
      {/* The floor texture carries the 1 m grid; every 10 m a stronger line */}
      <FloorGrid L={L} W={W} step={10} color="#3b4a63" opacity={0.7} y={0.012} />
      {walls.map((w, i) => (
        <mesh key={i} position={w.p}>
          <boxGeometry args={w.s} />
          <meshStandardMaterial color="#1e293b" transparent opacity={0.22} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      ))}
      <Line points={floorEdge} color="#3b82f6" lineWidth={1.5} />
      <Line points={topEdge} color="#475569" lineWidth={1} />
    </group>
  );
}

/** Frames the whole warehouse on mount, on a size change, and whenever `resetKey` changes (Reset camera): the floor's bounding circle is fitted to the narrower of the vertical / horizontal field of view, seen from the +z side pitched 50° down */
function FrameCamera({ size, resetKey, controls }: { size: ScenarioSize; resetKey: number; controls: MutableRefObject<OrbitControlsImpl | null> }) {
  const camera = useThree((s) => s.camera);
  const viewport = useThree((s) => s.size);
  useEffect(() => {
    const { length: L, width: W, height: H } = size;
    const radius = Math.hypot(L, W) / 2 + H / 4;
    const vfov = (camera instanceof THREE.PerspectiveCamera ? camera.fov : 36) * (Math.PI / 180);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * Math.max(0.5, viewport.width / Math.max(1, viewport.height)));
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05;
    const pitch = 50 * (Math.PI / 180);
    camera.position.set(L / 2, dist * Math.sin(pitch), W / 2 + dist * Math.cos(pitch));
    if (camera instanceof THREE.PerspectiveCamera) { camera.near = 0.3; camera.far = dist * 6 + 200; camera.updateProjectionMatrix(); }
    const c = controls.current;
    if (c) { c.target.set(L / 2, 0, W / 2); c.update(); } else camera.lookAt(L / 2, 0, W / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reframe only on size / reset, not on every viewport resize
  }, [camera, controls, size.length, size.width, size.height, resetKey]);
  return null;
}

/** Flat footprint highlight on the instance's surface plane plus a thin outline box of footprint × height */
function SelectionMarks({ def, w, d, h }: { def: AssetDef; w: number; d: number; h: number }) {
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), [w, h, d]);
  useEffect(() => () => edges.dispose(), [edges]);
  return (
    <>
      <mesh position={[0, 0.02, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[w, d]} />
        <meshBasicMaterial color={def.color} transparent opacity={0.35} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={edges} position={[0, h / 2, 0]}><lineBasicMaterial color="#ffffff" transparent opacity={0.85} /></lineSegments>
    </>
  );
}

interface NodeProps {
  inst: AssetInstance; selected: boolean;
  onSelect: (id: string) => void;
  /** Selects and starts a move drag unless the pointer is on the rotate ring */
  onPointerDown: (e: ThreeEvent<PointerEvent>, inst: AssetInstance) => void;
  onPointerMove: (e: ThreeEvent<PointerEvent>) => void;
  onPointerUp: (e: ThreeEvent<PointerEvent>) => void;
  onSelectedObject: (g: THREE.Group | null) => void;
}
/** One placed asset: the type's model centred at the origin inside a group that carries position / rotation; stackable types add an invisible top cap */
const InstanceNode = memo(function InstanceNode({ inst, selected, onSelect, onPointerDown, onPointerMove, onPointerUp, onSelectedObject }: NodeProps) {
  const def = ASSET_DEFS[inst.type];
  const row = useMemo(() => def.toLayoutRow(inst), [def, inst]);
  const groupRef = useRef<THREE.Group>(null);
  useEffect(() => { if (!selected) return; onSelectedObject(groupRef.current); return () => onSelectedObject(null); }, [selected, onSelectedObject]);
  const select = useCallback(() => onSelect(inst.id), [onSelect, inst.id]);
  const opts = useMemo(() => ({ onSelect: select }), [select]);
  const { w, d } = def.footprint(inst.params);
  const h = def.height(inst.params);
  return (
    <group ref={groupRef} position={inst.position} rotation-y={inst.rotation} userData={{ instanceId: inst.id }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); onPointerDown(e, inst); }}
      onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerOver={() => { document.body.style.cursor = "grab"; }} onPointerOut={() => { document.body.style.cursor = ""; }}>
      {def.render(row, inst, opts)}
      {def.stackable && (
        <mesh position={[0, h, 0]} rotation-x={-Math.PI / 2} userData={{ surface: true, instanceId: inst.id }}>
          <planeGeometry args={[w, d]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      {selected && <SelectionMarks def={def} w={w} d={d} h={h} />}
    </group>
  );
});

/** Translucent footprint × height box that follows the surface under a palette drag */
function Ghost({ type, point }: { type: AssetTypeId; point: P3 }) {
  const def = ASSET_DEFS[type];
  const { w, d } = def.footprint(def.defaults);
  const h = def.height(def.defaults);
  const mount = def.defaults.mount_h;
  const y = def.surface === "free" && typeof mount === "number" ? mount : point[1];
  return (
    <mesh position={[point[0], y + h / 2, point[2]]} raycast={() => null}>
      <boxGeometry args={[w, h, d]} />
      <meshBasicMaterial color={def.color} transparent opacity={0.35} depthWrite={false} />
    </mesh>
  );
}

export function EditorScene({ resetKey }: { resetKey: number }) {
  const scenario = useScenarioStore((s) => s.active);
  const selectedId = useScenarioStore((s) => s.selectedId);
  const select = useScenarioStore((s) => s.select);
  const apiRef = useRef<SceneApi | null>(null);
  const orbitRef = useRef<OrbitControlsImpl | null>(null);
  const gizmoRef = useRef<TransformControlsImpl | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const dragRef = useRef<{ id: string; moved: boolean; release: () => void } | null>(null);
  const [ghost, setGhost] = useState<{ type: AssetTypeId; point: P3 } | null>(null);
  const [selectedObject, setSelectedObject] = useState<THREE.Group | null>(null);
  useEffect(() => () => { cancelAnimationFrame(rafRef.current); document.body.style.cursor = ""; }, []);

  // ── Move drag (R3F pointer events; the canvas captures the pointer so moves keep arriving when it leaves the object) ──
  /** The single way a drag ends: pointer up, pointer cancel, the dragged instance disappearing, or unmount */
  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try { drag.release(); } catch { /* capture already gone */ }
    if (orbitRef.current) orbitRef.current.enabled = true;
    document.body.style.cursor = "";
  }, []);
  const onNodePointerDown = useCallback((e: ThreeEvent<PointerEvent>, inst: AssetInstance) => {
    if (gizmoAxis(gizmoRef.current)) return;                // the pointer is on the rotate ring: TransformControls owns this drag, the selection must not change
    useScenarioStore.getState().select(inst.id);
    const target = captureTarget(e), pointerId = e.pointerId;
    dragRef.current = { id: inst.id, moved: false, release: () => target.releasePointerCapture(pointerId) };
    target.setPointerCapture(pointerId);
    if (orbitRef.current) orbitRef.current.enabled = false;
    document.body.style.cursor = "grabbing";
  }, []);
  const onNodePointerMove = useCallback((e: ThreeEvent<PointerEvent>) => {
    const drag = dragRef.current, api = apiRef.current;
    if (!drag || !api) return;
    const st = useScenarioStore.getState();
    const inst = st.active?.instances.find((i) => i.id === drag.id);
    if (!inst) return;
    const def = ASSET_DEFS[inst.type];
    const p = def.surface === "free" ? api.hitPlaneY(e.ray, inst.position[1]) : api.hitSurfaceRay(e.ray, drag.id)?.point ?? null;
    if (!p) return;                                          // pointer outside every surface: keep the last position
    drag.moved = true;
    st.moveInstance(drag.id, [p.x, p.y, p.z]);
  }, []);
  const onNodePointerUp = useCallback(() => endDrag(), [endDrag]);
  useEffect(() => {
    // A pointer released or cancelled anywhere (context menu, tab switch, touch gesture) must not leave the camera locked
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => { window.removeEventListener("pointerup", endDrag); window.removeEventListener("pointercancel", endDrag); };
  }, [endDrag]);
  const instances = scenario?.instances;
  useEffect(() => {
    const drag = dragRef.current;
    if (drag && !instances?.some((i) => i.id === drag.id)) endDrag();   // the dragged instance was deleted (Delete key) mid-drag
  }, [instances, endDrag]);
  const onSelect = useCallback((id: string) => select(id), [select]);
  /** Commits to the instance the gizmo actually rotated (its group carries the id), never to whatever is selected at mouse-up */
  const onRotateCommit = useCallback((obj: THREE.Object3D) => {
    const id = obj.userData.instanceId as string | undefined;
    if (id) useScenarioStore.getState().updateInstance(id, { rotation: wrapRotation(obj.rotation.y) });
  }, []);

  // ── HTML5 drop target for palette drags ──
  const ndcOf = (clientX: number, clientY: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  };
  const clearGhost = () => { cancelAnimationFrame(rafRef.current); setGhost(null); };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    const type = useScenarioStore.getState().dragType;
    if (!type) return;                                      // a foreign drag (file, text) is ignored
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const { clientX, clientY } = e;
    cancelAnimationFrame(rafRef.current);                   // at most one raycast per animation frame
    rafRef.current = requestAnimationFrame(() => {
      const hit = apiRef.current?.hitSurface(ndcOf(clientX, clientY));
      setGhost(hit ? { type, point: [hit.point.x, hit.point.y, hit.point.z] } : null);
    });
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.relatedTarget instanceof Node && wrapRef.current?.contains(e.relatedTarget)) return;
    clearGhost();
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    clearGhost();
    const st = useScenarioStore.getState();
    const type = (e.dataTransfer.getData(DRAG_MIME) || st.dragType || "") as AssetTypeId | "";
    st.setDragType(null);
    if (!type || !(type in ASSET_DEFS) || !st.active) return;
    const hit = apiRef.current?.hitSurface(ndcOf(e.clientX, e.clientY));
    if (!hit) return;                                        // dropped outside the floor: nothing is created
    const inst = placeOnSurface(type, [hit.point.x, hit.point.y, hit.point.z], st.active.size, st.active.instances);
    st.addInstance(inst);
    st.select(inst.id);
  };

  if (!scenario || !instances) return null;
  const { size } = scenario;
  return (
    <div ref={wrapRef} className={"ws-canvas" + (ghost ? " drop-target" : "")} onDragEnter={onDragOver} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <Canvas resize={{ offsetSize: true }} dpr={[1, 1.5]}
        camera={{ position: [size.length / 2, Math.max(size.length, size.width) * 0.9, size.width * 1.6], fov: 36, near: 0.3, far: 2000 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.1 }}
        onPointerMissed={(e) => { if (e.button === 0 && !dragRef.current) select(null); }}>
        <SceneBridge apiRef={apiRef} />
        <EditorShell size={size} />
        {instances.map((inst) => (
          <InstanceNode key={inst.id} inst={inst} selected={inst.id === selectedId} onSelect={onSelect}
            onPointerDown={onNodePointerDown} onPointerMove={onNodePointerMove} onPointerUp={onNodePointerUp} onSelectedObject={setSelectedObject} />
        ))}
        {ghost && <Ghost type={ghost.type} point={ghost.point} />}
        {selectedObject && selectedId && (
          <TransformControls ref={gizmoRef} object={selectedObject} mode="rotate" showX={false} showZ={false} size={0.9} onMouseUp={() => onRotateCommit(selectedObject)} />
        )}
        <OrbitControls ref={orbitRef} makeDefault target={[size.length / 2, 0, size.width / 2]} maxPolarAngle={Math.PI / 2.05} minDistance={3} maxDistance={Math.max(size.length, size.width) * 4} enableDamping dampingFactor={0.1} />
        <FrameCamera size={size} resetKey={resetKey} controls={orbitRef} />
      </Canvas>
    </div>
  );
}
