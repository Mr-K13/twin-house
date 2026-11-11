import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { STATUS_COLOR, useStore } from "../../state/store";
import { FLOOR_ELEV } from "./Mezzanine";
import type { RobotState } from "../../schema/twin_state";
import { PALETTE, KRAFT } from "./palette";
import { placeLabels, type Box, type LabelItem } from "../ui/labelPlacement";

/** Height (m) above the robot origin where its label is anchored */
const LABEL_Y = 1.5;
/** Hands a robot's label element (null on unmount) and its moving group to the label declutter pass */
type LabelRegister = (id: string, el: HTMLDivElement | null, obj: THREE.Object3D) => void;

/** Procedural AMR model: chassis, dark top cover, four wheels, front blue light bar, status light. A box sits on top when loaded. */
export function RobotMesh({ r, selected, onSelect, showLabel, lite, smooth = true, onLabel }: { r: RobotState; selected: boolean; onSelect: () => void; showLabel: boolean; lite?: boolean; smooth?: boolean; onLabel?: LabelRegister }) {
  const color = STATUS_COLOR[r.status];
  const ringRef = useRef<THREE.Mesh>(null!);
  const lampRef = useRef<THREE.MeshBasicMaterial>(null!);
  const groupRef = useRef<THREE.Group>(null!);
  const wheelsRef = useRef<THREE.Group>(null!);
  const labelRef = useCallback((el: HTMLDivElement | null) => onLabel?.(r.id, el, groupRef.current), [onLabel, r.id]);
  // ⚠ round-9 root-cause fix: the transform must only get the initial value at mount time (a stable reference).
  // If we write position={[r.position[0], FLOOR_ELEV[r.floor], ...]} directly, the props content changes every tick.
  // Each React re-render (10 Hz) then overwrites the useFrame-smoothed transform back to "raw coordinates + FLOOR_ELEV(floor)".
  // While the robot rides the lift, floor differs from the real height (floor flips only when the robot exits the lift).
  // The robot then snaps to the wrong height every 100 ms and useFrame pulls it back.
  // This causes the jagged shake during lift travel and at exit. The initial height must also be lift-aware
  // (a remount must not snap from the wrong floor).
  const init = useRef<{ p: [number, number, number]; h: number } | null>(null);
  if (!init.current) {
    const L0 = r.lift_id ? useStore.getState().twin.lifts[r.lift_id] : null;
    init.current = { p: [r.position[0], L0 ? L0.y : FLOOR_ELEV[r.floor] ?? 0, r.position[2]], h: -r.heading };
  }
  // The simulation updates positions at 10 Hz, the display runs at 60 Hz: exponential smoothing tracks the target so motion does not jump cell by cell
  useFrame(({ clock }, dt) => {
    const g = groupRef.current;
    if (g) {
      const k = smooth ? 1 - Math.pow(0.0005, dt) : 1;
      g.position.x += (r.position[0] - g.position.x) * k;
      g.position.z += (r.position[2] - g.position.z) * k;
      // Height: while on the lift, follow the backend-authoritative platform height directly (spec §11.2); otherwise snap to the floor
      const st = useStore.getState();
      const lift = r.lift_id ? st.twin.lifts[r.lift_id] : null;
      const explode = !lite && st.activeFloor === "exploded" && r.floor === 2 && !r.lift_id ? 5 : 0;   // In the lite (CCTV) scene the platform does not rise, so the robot must not rise either

      const ty = (lift ? lift.y : FLOOR_ELEV[r.floor] ?? 0) + explode;
      // The smoothing factor during lift travel must equal the Mezzanine platform k (1 - 0.02^dt) exactly:
      // both track the same lift.y and start from the same height → the per-frame paths match, the robot "sticks" to the platform and does not lead/lag and appear to fall
      const ky = lift ? 1 - Math.pow(0.02, dt) : smooth ? 1 - Math.pow(0.25, dt) : 1;
      g.position.y += (ty - g.position.y) * ky;
      let dh = -r.heading - g.rotation.y; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
      g.rotation.y += dh * k;
      if (wheelsRef.current && r.velocity > 0.05) wheelsRef.current.rotation.z -= (r.velocity / 0.12) * dt;
    }
    if (ringRef.current) { const s = 1 + Math.sin(clock.elapsedTime * 3) * 0.08; ringRef.current.scale.set(s, s, s); }
    if (lampRef.current && (r.status === "ERROR" || r.status === "WARNING")) lampRef.current.opacity = 0.5 + Math.sin(clock.elapsedTime * 8) * 0.5;
  });
  const loaded = r.load.current > 0;
  return (
    <group ref={groupRef} position={init.current.p} rotation-y={init.current.h}>
      <group onClick={(e) => { e.stopPropagation(); onSelect(); }} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")}>
        {/* Chassis */}
        <mesh position={[0, 0.22, 0]} castShadow>
          <boxGeometry args={[0.95, 0.32, 0.68]} />
          <meshStandardMaterial color={PALETTE.white} roughness={0.4} metalness={0.2} />
        </mesh>
        {/* Blue top cover */}
        <mesh position={[0, 0.42, 0]} castShadow>
          <boxGeometry args={[0.8, 0.1, 0.58]} />
          <meshStandardMaterial color={PALETTE.blue} roughness={0.5} metalness={0.2} />
        </mesh>
        {/* Lifting platform */}
        <mesh position={[0, 0.5, 0]}>
          <cylinderGeometry args={[0.3, 0.3, 0.06, 20]} />
          <meshStandardMaterial color={PALETTE.ink} roughness={0.6} metalness={0.4} />
        </mesh>
        {/* Front light bar */}
        <mesh position={[0.485, 0.22, 0]}>
          <boxGeometry args={[0.02, 0.08, 0.5]} />
          <meshBasicMaterial color={PALETTE.blueSoft} />
        </mesh>
        {/* Yellow-black warning strips */}
        {[-0.35, 0.35].map((z) => (
          <mesh key={z} position={[0, 0.1, z]}>
            <boxGeometry args={[0.95, 0.06, 0.02]} />
            <meshBasicMaterial color={PALETTE.yellow} />
          </mesh>
        ))}
        {/* Wheels */}
        <group ref={wheelsRef}>
          {[[-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.32, 0.32]].map(([x, z], i) => (
            <mesh key={i} position={[x, 0.12, z]} rotation-x={Math.PI / 2}>
              <cylinderGeometry args={[0.12, 0.12, 0.1, 14]} />
              <meshStandardMaterial color={PALETTE.ink} roughness={0.9} />
            </mesh>
          ))}
        </group>
        {/* Status light */}
        <mesh position={[-0.33, 0.5, 0]}>
          <sphereGeometry args={[0.07, 10, 10]} />
          <meshBasicMaterial ref={lampRef} color={color} transparent />
        </mesh>
        {/* Cargo box */}
        {loaded && (
          <mesh position={[0, 0.85, 0]} castShadow>
            <boxGeometry args={[0.78, 0.6, 0.62]} />
            <meshStandardMaterial color={KRAFT[1]} roughness={0.9} />
          </mesh>
        )}
      </group>
      {/* Phase 7: virtual LiDAR visualization (when selected, draw a 270° sector + rays to each obstacle; when any robot stops for perception, draw a red front arc) */}
      {!lite && selected && <PerceptionGizmo r={r} />}
      {!lite && !selected && r.perception?.state === "STOPPED" && (
        <mesh position={[0, 0.03, 0]} rotation-x={-Math.PI / 2}><ringGeometry args={[0.95, 1.12, 24, 1, -Math.PI / 6, Math.PI / 3]} /><meshBasicMaterial color="#ef4444" transparent opacity={0.9} side={THREE.DoubleSide} /></mesh>
      )}
      {/* Ground light ring */}
      <mesh ref={ringRef} position={[0, 0.02, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.58, 0.74, 40]} />
        <meshBasicMaterial color={selected ? "#60a5fa" : color} transparent opacity={selected ? 0.9 : 0.45} side={THREE.DoubleSide} />
      </mesh>
      {selected && <mesh position={[0, 0.015, 0]} rotation-x={-Math.PI / 2}><circleGeometry args={[1.1, 40]} /><meshBasicMaterial color="#3b82f6" transparent opacity={0.18} /></mesh>}
      {!lite && (r.status === "ERROR") && <pointLight position={[0, 1, 0]} color="#ef4444" intensity={4} distance={5} />}
      {showLabel && (
        <Html position={[0, LABEL_Y, 0]} zIndexRange={[10, 0]}>
          <div ref={labelRef} className={"lbl" + (selected ? " sel" : r.status === "ERROR" ? " err" : r.status === "CHARGING" ? " chg" : "")} onClick={(e) => { e.stopPropagation(); onSelect(); }}>
            {r.status === "ERROR" ? "⚠ " : ""}{r.id}
          </div>
        </Html>
      )}
    </group>
  );
}

const PERC_COLOR = { CLEAR: "#22d3ee", SLOWING: "#f59e0b", STOPPED: "#ef4444", OFF: "#475569" } as const;
/** Perception layer of the selected robot: 270° / 4 m sector (color = perception state), forward clearance line, rays to each obstacle (red = a dynamic obstacle that blocks the path) */
function PerceptionGizmo({ r }: { r: RobotState }) {
  const P = r.perception; if (!P) return null;
  const col = PERC_COLOR[P.state];
  const range = 4;
  return (
    <group>
      <mesh position={[0, 0.025, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.7, range, 48, 1, -Math.PI * 0.75, Math.PI * 1.5]} />
        <meshBasicMaterial color={col} transparent opacity={P.state === "STOPPED" ? 0.16 : 0.09} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.03, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[range - 0.05, range, 48, 1, -Math.PI * 0.75, Math.PI * 1.5]} />
        <meshBasicMaterial color={col} transparent opacity={0.5} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Line points={[[0.7, 0.08, 0], [Math.max(0.7, P.ahead_m), 0.08, 0]]} color={col} lineWidth={2} transparent opacity={0.9} />
      {P.obstacles.map((o, i) => {
        const b = (-o.bearing_deg * Math.PI) / 180; const x = o.distance_m * Math.cos(b), z = o.distance_m * Math.sin(b);
        const blocking = o.kind !== "RACK" && P.state !== "CLEAR" && o.distance_m <= P.ahead_m + 0.05;
        const c = o.kind === "RACK" ? "#94a3b8" : blocking ? "#ef4444" : o.kind === "HUMAN" ? "#f97316" : "#fbbf24";
        return (
          <group key={i}>
            <Line points={[[0, 0.1, 0], [x, 0.1, z]]} color={c} lineWidth={blocking ? 2 : 1} dashed={o.kind === "RACK"} dashSize={0.3} gapSize={0.2} transparent opacity={0.85} />
            {o.kind !== "RACK" && <mesh position={[x, 0.1, z]}><sphereGeometry args={[0.12, 8, 8]} /><meshBasicMaterial color={c} /></mesh>}
          </group>
        );
      })}
    </group>
  );
}

/** Current A* path of the robot (grid cells → world coordinates). The line is thicker when selected. A ring marks the end point. */
function RobotPath({ r, selected }: { r: RobotState; selected: boolean }) {
  const pts = useMemo(() => {
    if (r.path.length === 0 || r.path_index >= r.path.length) return null;
    const y = (FLOOR_ELEV[r.floor] ?? 0) + (useStore.getState().activeFloor === "exploded" && r.floor === 2 ? 5 : 0) + 0.06;
    const out: [number, number, number][] = [[r.position[0], y, r.position[2]]];
    for (let i = r.path_index; i < r.path.length; i++) out.push([r.path[i][0] + 0.5, y, r.path[i][1] + 0.5]);
    return out;
  }, [r.path, r.path_index, r.position, r.floor]);
  if (!pts) return null;
  const end = pts[pts.length - 1];
  const col = r.fsm === "GOING_TO_CHARGE" ? "#60a5fa" : r.load.current > 0 ? "#f59e0b" : "#22d3ee";
  return (
    <group>
      <Line points={pts} color={selected ? PALETTE.blueDeep : col} lineWidth={selected ? 2.4 : 1.4} dashed dashSize={0.7} gapSize={0.4} transparent opacity={selected ? 1 : 0.75} />
      <mesh position={[end[0], end[1] - 0.01, end[2]]} rotation-x={-Math.PI / 2}><ringGeometry args={[0.45, 0.65, 24]} /><meshBasicMaterial color={col} transparent opacity={0.85} /></mesh>
    </group>
  );
}

interface LabelEntry { el: HTMLDivElement; obj: THREE.Object3D; w: number; h: number }
const tmp = new THREE.Vector3();

/**
 * Screen-space label declutter for the 3D view: every frame projects each robot's label anchor, places the labels with placeLabels (in
 * pixels, avoiding each other and the robot bodies) and offsets each label element from its default spot centred above the anchor.
 * A label pushed to a far tier gets a CSS leader line (data-lead) back to its anchor. Label sizes and the lift / zone / sign label boxes (kept clear
 * as obstacles) are re-read every 10 frames.
 */
function LabelDeclutter({ reg, selected }: { reg: MutableRefObject<Map<string, LabelEntry>>; selected: string | null }) {
  const prev = useRef(new Map<string, number>());
  const frame = useRef(0);
  const signs = useRef<Box[]>([]);
  useFrame(({ camera, size, gl }) => {
    const remeasure = frame.current++ % 10 === 0;
    if (remeasure) {
      const c = gl.domElement.getBoundingClientRect();
      signs.current = [...(gl.domElement.parentElement?.parentElement?.querySelectorAll(".lift-lbl, .zone-lbl, .sign-lbl") ?? [])].map((el) => {
        const b = el.getBoundingClientRect();
        return { x0: b.left - c.left, y0: b.top - c.top, x1: b.right - c.left, y1: b.bottom - c.top };
      });
    }
    const items: LabelItem[] = [], bodies: Box[] = [...signs.current];
    const toScreen = () => [((tmp.x + 1) / 2) * size.width, ((1 - tmp.y) / 2) * size.height] as const;
    for (const [id, e] of reg.current) {
      if (remeasure || !e.w) { e.w = e.el.offsetWidth; e.h = e.el.offsetHeight; }
      e.obj.getWorldPosition(tmp); tmp.y += 0.4; tmp.project(camera);
      if (tmp.z > 1 || !e.w) continue;
      const [bx, by] = toScreen();
      bodies.push({ x0: bx - 10, y0: by - 10, x1: bx + 10, y1: by + 10 });
      e.obj.getWorldPosition(tmp); tmp.y += LABEL_Y; tmp.project(camera);
      const [x, y] = toScreen();
      items.push({ id, x, y, w: e.w, h: e.h, priority: id === selected });
    }
    const out = placeLabels(items, { markR: 2, gap: 2, bounds: { x0: 0, y0: 0, x1: size.width, y1: size.height }, obstacles: bodies, previous: prev.current });
    prev.current = new Map([...out].map(([id, l]) => [id, l.slot]));
    for (const it of items) {
      const l = out.get(it.id)!, el = reg.current.get(it.id)!.el;
      // .lbl is translate(-50%, -100%): bottom-centre on the anchor; shift that to the placed box
      el.style.transform = `translate(calc(-50% + ${(l.cx - it.x).toFixed(1)}px), calc(-100% + ${(l.box.y1 - it.y).toFixed(1)}px))`;
      const above = l.cy < it.y;
      el.dataset.lead = l.leader ? (above ? "down" : "up") : "";
      if (l.leader) el.style.setProperty("--lead", `${(above ? it.y - l.box.y1 : l.box.y0 - it.y).toFixed(1)}px`);
    }
  });
  return null;
}

export function Robots({ lite = false }: { lite?: boolean }) {
  const robots = useStore((s) => s.twin.robots);
  const selected = useStore((s) => s.selectedRobot);
  const select = useStore((s) => s.select);
  const showLabels = useStore((s) => s.showLabels);
  const showPaths = useStore((s) => s.showPaths);
  const af = useStore((s) => s.activeFloor);
  const activeFloor = lite || af === "exploded" ? "all" : af;
  const visible = (r: RobotState) => activeFloor === "all" || r.floor === activeFloor || !!r.lift_id;
  const labels = showLabels && !lite;
  const reg = useRef(new Map<string, LabelEntry>());
  const onLabel = useCallback<LabelRegister>((id, el, obj) => { if (el && obj) reg.current.set(id, { el, obj, w: 0, h: 0 }); else reg.current.delete(id); }, []);
  return (
    <group>
      {labels && <LabelDeclutter reg={reg} selected={selected} />}
      {Object.values(robots).filter(visible).map((r) => (
        <group key={r.id}>
          <RobotMesh r={r} selected={r.id === selected} onSelect={() => select(r.id)} showLabel={labels} lite={lite} onLabel={onLabel} />
          {showPaths && !lite && <RobotPath r={r} selected={r.id === selected} />}
        </group>
      ))}
    </group>
  );
}
