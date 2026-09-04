/**
 * Phase 8 (spec §4/§5): industrial mezzanine and lift.
 *  - Slab 45 cm thick, steel primary/secondary beams, fixed column positions (Layout Config manages them, not random),
 *    yellow-black warning edges, two-rail guardrail + toe board, lift shaft openings.
 *  - Lift: steel shaft frame + metal mesh guard + solid platform + sliding doors + status light/floor indicator.
 *    The platform height reads the backend-authoritative state.lifts[id].y directly.
 *    The frontend only interpolates the render (door motion, platform position). It does not decide when the lift moves.
 */
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { layout, useStore } from "../../state/store";
import type { LiftState } from "../../schema/twin_state";

export const FLOOR_ELEV: Record<number, number> = Object.fromEntries((layout.floors ?? [{ id: 1, elevation: 0 }]).map((f) => [f.id, f.elevation]));

/** Shaft geometry (single source of truth): the engine door-zone constants (SIM.LIFT_SHAFT_HALF_X / LIFT_DOOR_HALF_W) must match these values. Tests prevent drift. */
export const LIFT_SHAFT = { W: 2.8, D: 3.6, LEAF: 1.12 };

/** Fixed support column positions (spec §4.4): the single source of truth is layout.columns. The F1 navigation grid
 *  uses the same data to block obstacles, so visuals and paths always agree (round-9c: fix robots that pass through columns).
 *  This constant is only a fallback when layout lacks the field. */
const COLUMNS: Array<[number, number]> = layout.columns ?? [
  [10, 41.5], [22, 41.5], [34, 41.5], [46, 41.5],
  [10, 60.5], [22, 60.5], [34, 60.5], [46, 60.5],
  [10, 51], [46, 51],
];

const SLAB_T = 0.45;           // Slab thickness (§4.1: 35–45 cm)
const SHAFT_HALF = 1.9;        // Half width of the shaft opening (z direction)

export function Mezzanine({ lite = false }: { lite?: boolean }) {
  const f2 = layout.floors.find((f) => f.id === 2);
  if (!f2 || !f2.footprint) return null;
  const xs = f2.footprint.map((p) => p[0]), zs = f2.footprint.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const w = x1 - x0, d = z1 - z0, y = f2.elevation;
  const steel = <meshStandardMaterial color="#39404f" roughness={0.55} metalness={0.6} />;

  // Slab: keep openings for the lift shafts -- the east strip (x1-4 .. x1) splits into segments at each shaft
  const lifts = layout.lifts ?? [];
  const shaftZs = lifts.map((l) => l.cell[1] + 0.5).sort((a, b) => a - b);
  const stripX = x1 - 4;
  const strips: Array<[number, number]> = [];
  let cur = z0;
  for (const sz of shaftZs) { if (sz - SHAFT_HALF > cur) strips.push([cur, sz - SHAFT_HALF]); cur = sz + SHAFT_HALF; }
  if (cur < z1) strips.push([cur, z1]);

  return (
    <group>
      {/* Main slab (west of the shaft strip) */}
      <mesh position={[x0 + (stripX - x0) / 2, y - SLAB_T / 2, z0 + d / 2]} receiveShadow>
        <boxGeometry args={[stripX - x0, SLAB_T, d]} />
        <meshStandardMaterial color="#242d3f" roughness={0.9} metalness={0.1} />
      </mesh>
      {/* East strip (slab segments between the shafts) */}
      {strips.map(([za, zb], i) => (
        <mesh key={i} position={[stripX + (x1 - stripX) / 2, y - SLAB_T / 2, (za + zb) / 2]} receiveShadow>
          <boxGeometry args={[x1 - stripX, SLAB_T, zb - za]} />
          <meshStandardMaterial color="#242d3f" roughness={0.9} metalness={0.1} />
        </mesh>
      ))}
      {/* Steel primary beams (x direction, below the slab) */}
      {[z0 + 2, z0 + d / 2, z1 - 2].map((z, i) => (
        <mesh key={"mb" + i} position={[x0 + w / 2, y - SLAB_T - 0.3, z]}>
          <boxGeometry args={[w, 0.6, 0.35]} />{steel}
        </mesh>
      ))}
      {/* Secondary beams (z direction) */}
      {Array.from({ length: Math.floor(w / 6) }, (_, i) => x0 + 3 + i * 6).map((x, i) => (
        <mesh key={"sb" + i} position={[x, y - SLAB_T - 0.22, z0 + d / 2]}>
          <boxGeometry args={[0.22, 0.45, d - 0.5]} />{steel}
        </mesh>
      ))}
      {/* Fixed column positions */}
      {COLUMNS.map(([x, z], i) => (
        <group key={"col" + i} position={[x, 0, z]}>
          <mesh position={[0, (y - SLAB_T) / 2, 0]} castShadow={!lite}>
            <boxGeometry args={[0.5, y - SLAB_T, 0.5]} />
            <meshStandardMaterial color="#2b3446" roughness={0.6} metalness={0.4} />
          </mesh>
          <mesh position={[0, 0.06, 0]}><boxGeometry args={[0.9, 0.12, 0.9]} />{steel}</mesh>
        </group>
      ))}
      {/* Edges: yellow-black warning strip + two-rail guardrail + toe board (no guardrail at the east lift openings) */}
      {([[x0 + w / 2, z0, w, 0, true], [x0 + w / 2, z1, w, 0, true], [x0, z0 + d / 2, d, 1, true]] as const).map(([cx, cz, len, rot, rail], i) => (
        <Edge key={i} cx={cx} cz={cz} len={len} rot={rot} y={y} rail={rail} />
      ))}
      {strips.map(([za, zb], i) => <Edge key={"e" + i} cx={x1} cz={(za + zb) / 2} len={zb - za} rot={1} y={y} rail />)}
      {/* Floor 2 lighting + lighting below the slab (§4.1) */}
      {!lite && <pointLight position={[x0 + w / 3, y + 5, z0 + d / 2]} intensity={0.7} color="#cfe0ff" distance={30} decay={1.5} />}
      {!lite && <pointLight position={[x0 + w / 2, y - 2.5, z0 + d / 2]} intensity={0.5} color="#93a6c9" distance={24} decay={1.5} />}
      {lifts.map((l) => <Lift key={l.id} l={l} elev={y} lite={lite} />)}
    </group>
  );
}

function Edge({ cx, cz, len, rot, y, rail }: { cx: number; cz: number; len: number; rot: 0 | 1; y: number; rail: boolean }) {
  return (
    <group position={[cx, y, cz]} rotation-y={rot ? Math.PI / 2 : 0}>
      <mesh position={[0, 0.02, 0]}><boxGeometry args={[len, 0.05, 0.3]} /><meshBasicMaterial color="#eab308" /></mesh>
      {rail && (
        <>
          {/* toe board (§4.2) */}
          <mesh position={[0, 0.1, 0]}><boxGeometry args={[len, 0.14, 0.04]} /><meshStandardMaterial color="#b45309" roughness={0.7} /></mesh>
          <mesh position={[0, 0.6, 0]}><boxGeometry args={[len, 0.05, 0.05]} /><meshStandardMaterial color="#64748b" metalness={0.6} roughness={0.4} /></mesh>
          <mesh position={[0, 1.1, 0]}><boxGeometry args={[len, 0.07, 0.07]} /><meshStandardMaterial color="#94a3b8" metalness={0.6} roughness={0.4} /></mesh>
          {Array.from({ length: Math.max(2, Math.floor(len / 3)) }, (_, k) => (
            <mesh key={k} position={[-len / 2 + 0.5 + k * ((len - 1) / Math.max(1, Math.floor(len / 3) - 1)), 0.55, 0]}>
              <boxGeometry args={[0.06, 1.1, 0.06]} /><meshStandardMaterial color="#64748b" metalness={0.6} roughness={0.4} />
            </mesh>
          ))}
        </>
      )}
    </group>
  );
}

/** Lift state → status light color (spec §5.3) */
export const LIFT_LIGHT: Record<string, string> = {
  IDLE: "#22c55e", COOLDOWN: "#22c55e",
  MOVING_UP: "#3b82f6", MOVING_DOWN: "#3b82f6", LEVELING: "#3b82f6",
  DOOR_OPENING: "#22d3ee", DOOR_OPENING_AT_DESTINATION: "#22d3ee", BOARDING: "#22d3ee", ALIGHTING: "#22d3ee",
  DOOR_CLOSING: "#f59e0b", DOOR_CLOSING_AFTER_EXIT: "#f59e0b",
  FAULT: "#ef4444",
};

export function liftLabel(L: LiftState | undefined): string {
  if (!L) return "";
  if (L.fault) return "FAULT";
  if (L.state === "MOVING_UP" || L.state === "MOVING_DOWN") return `F${L.state === "MOVING_UP" ? "1 → F2" : "2 → F1"} · ${L.occupant ?? "empty"}`;
  const q = (L.queue["1"]?.length ?? 0) + (L.queue["2"]?.length ?? 0);
  if (L.state === "IDLE") return `IDLE AT F${L.floor}${q ? ` · QUEUE ${q}` : ""}`;
  return `${L.state.replace(/_/g, " ")}${L.occupant ? ` · ${L.occupant}` : ""}`;
}

/** Lift (supplement spec): VRC style -- steel carriage, two guide rails, top-mounted drive box, full-height metal mesh fence,
 *  interlocked bi-parting safety doors on each floor, door-frame indicator lights, anti-slip steel platform (yellow-black edges,
 *  docking marker, bumper), sill and leveling indicators.
 *  The transparent cyan is only the Digital Twin occupancy overlay. It is not the platform body. */
function Lift({ l, elev, lite }: { l: (typeof layout.lifts)[number]; elev: number; lite: boolean }) {
  const platRef = useRef<THREE.Group>(null!);
  const leafRefs = useRef<Array<THREE.Mesh | null>>([null, null, null, null]);   // [f1L, f1R, f2L, f2R]
  const lightRef = useRef<THREE.MeshBasicMaterial>(null!);
  const levelF1 = useRef<THREE.MeshBasicMaterial>(null!);
  const levelF2 = useRef<THREE.MeshBasicMaterial>(null!);
  const occRef = useRef<THREE.Mesh>(null!);
  const selectLift = useStore((s) => s.selectLift);
  const x = l.cell[0] + 0.5, z = l.cell[1] + 0.5;
  const W = LIFT_SHAFT.W, D = LIFT_SHAFT.D, H = elev + 2.4;   // §5.4
  const LEAF = LIFT_SHAFT.LEAF;                                 // Width of one bi-parting door leaf
  const steel = <meshStandardMaterial color="#2f3542" roughness={0.5} metalness={0.7} />;
  const frame = <meshStandardMaterial color="#171c26" roughness={0.45} metalness={0.75} />;

  useFrame((state, dt) => {
    const L = useStore.getState().twin.lifts[l.id];
    if (!L) return;
    const k = 1 - Math.pow(0.02, dt);
    if (platRef.current) platRef.current.position.y += (L.y - platRef.current.position.y) * k;
    // Bi-parting safety doors: open = the two leaves slide toward ±z
    const setLeaf = (idx: number, open: boolean, sign: number) => {
      const m = leafRefs.current[idx]; if (!m) return;
      const base = sign * LEAF / 2;
      m.position.z += ((open ? base + sign * LEAF : base) - m.position.z) * k;
    };
    setLeaf(0, L.door_f1 === "OPEN", -1); setLeaf(1, L.door_f1 === "OPEN", +1);
    setLeaf(2, L.door_f2 === "OPEN", -1); setLeaf(3, L.door_f2 === "OPEN", +1);
    if (lightRef.current) {
      const c = L.fault ? "#ef4444" : LIFT_LIGHT[L.state] ?? "#22c55e";
      lightRef.current.color.set(c);
      lightRef.current.opacity = L.fault ? 0.5 + Math.sin(state.clock.elapsedTime * 8) * 0.5 : 1;
    }
    // Leveling indicator (supplement §6): shows green when the platform aligns with that floor
    if (levelF1.current) levelF1.current.color.set(Math.abs(L.y - 0) < 0.05 ? "#22c55e" : "#334155");
    if (levelF2.current) levelF2.current.color.set(Math.abs(L.y - elev) < 0.05 ? "#22c55e" : "#334155");
    if (occRef.current) occRef.current.visible = !!L.occupant;
  });

  const L = useStore((s) => s.twin.lifts[l.id]);
  return (
    <group position={[x, 0, z]} onClick={(e) => { e.stopPropagation(); selectLift(l.id); }}
      onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")}>
      {/* ── Shaft steel frame (black) + four corner posts ── */}
      {[[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]].map(([dx, dz], i) => (
        <mesh key={i} position={[dx, H / 2, dz]} castShadow={!lite}><boxGeometry args={[0.24, H, 0.24]} />{frame}</mesh>
      ))}
      {/* Horizontal frame beams (bottom/middle/slab level/top) */}
      {[0.05, elev / 2, elev, H - 0.3].map((hy, i) => (
        <group key={"h" + i}>
          <mesh position={[W / 2, hy, 0]}><boxGeometry args={[0.12, 0.12, D]} />{frame}</mesh>
          <mesh position={[0, hy, -D / 2]}><boxGeometry args={[W, 0.12, 0.12]} />{frame}</mesh>
          <mesh position={[0, hy, D / 2]}><boxGeometry args={[W, 0.12, 0.12]} />{frame}</mesh>
        </group>
      ))}
      {/* ── Full-height metal mesh guard (east/north/south; the west face holds the doors) ── */}
      {([[W / 2 - 0.02, 0, Math.PI / 2, D - 0.2], [0, -D / 2 + 0.02, 0, W - 0.2], [0, D / 2 - 0.02, 0, W - 0.2]] as const).map(([dx, dz, rot, len], i) => (
        <mesh key={"mesh" + i} position={[dx, H / 2 - 0.15, dz]} rotation-y={rot}>
          <planeGeometry args={[len, H - 0.5, Math.round(len * 3), Math.round((H - 0.5) * 2)]} />
          <meshStandardMaterial color="#59a0b8" transparent opacity={0.35} side={THREE.DoubleSide} metalness={0.4} roughness={0.5} wireframe />
        </mesh>
      ))}
      {/* Maintenance door (lower east face, with frame) */}
      <group position={[W / 2 - 0.01, 1.0, D / 2 - 0.9]}>
        <mesh rotation-y={Math.PI / 2}><planeGeometry args={[0.9, 1.9]} /><meshStandardMaterial color="#22303f" transparent opacity={0.85} side={THREE.DoubleSide} /></mesh>
        <mesh position={[0.02, 0, 0]} rotation-y={Math.PI / 2}><ringGeometry args={[0.05, 0.08, 8]} /><meshBasicMaterial color="#eab308" /></mesh>
      </group>
      {/* ── Two guide rails + guide wheels + chain (VRC drive structure) ── */}
      {[-W / 2 + 0.2, W / 2 - 0.2].map((dx, i) => (
        <group key={"rail" + i}>
          <mesh position={[dx, H / 2, D / 2 - 0.22]}><boxGeometry args={[0.1, H, 0.16]} /><meshStandardMaterial color="#454f61" metalness={0.85} roughness={0.25} /></mesh>
        </group>
      ))}
      <mesh position={[0, H / 2, D / 2 - 0.3]}><cylinderGeometry args={[0.03, 0.03, H - 0.6, 6]} /><meshStandardMaterial color="#0d1118" metalness={0.7} roughness={0.4} /></mesh>
      {/* ── Platform (anti-slip steel carriage) ── */}
      <group ref={platRef} position={[0, 0, 0]}>
        {/* Deck */}
        <mesh position={[0, 0.14, 0]} castShadow={!lite}><boxGeometry args={[W - 0.5, 0.1, D - 0.5]} /><meshStandardMaterial color="#3d4657" roughness={0.85} metalness={0.35} /></mesh>
        {/* Structural beams below the deck */}
        <mesh position={[0, 0.05, 0]}><boxGeometry args={[W - 0.7, 0.08, 0.3]} />{steel}</mesh>
        <mesh position={[0, 0.05, -1.0]}><boxGeometry args={[W - 0.7, 0.08, 0.25]} />{steel}</mesh>
        <mesh position={[0, 0.05, 1.0]}><boxGeometry args={[W - 0.7, 0.08, 0.25]} />{steel}</mesh>
        {/* Yellow-black safety edges */}
        {[-1, 1].map((sx, i) => <mesh key={"ex" + i} position={[sx * (W - 0.55) / 2, 0.2, 0]}><boxGeometry args={[0.12, 0.03, D - 0.5]} /><meshBasicMaterial color="#eab308" /></mesh>)}
        {[-1, 1].map((sz, i) => <mesh key={"ez" + i} position={[0, 0.2, sz * (D - 0.55) / 2]}><boxGeometry args={[W - 0.5, 0.03, 0.12]} /><meshBasicMaterial color="#eab308" /></mesh>)}
        {/* Docking marker (cyan corner brackets; when occupied the full overlay lights up = Digital Twin occupancy) */}
        {[[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]].map(([mx, mz], i) => (
          <mesh key={"dm" + i} position={[mx, 0.2, mz]} rotation-x={-Math.PI / 2}><planeGeometry args={[0.3, 0.06]} /><meshBasicMaterial color="#22d3ee" transparent opacity={0.8} /></mesh>
        ))}
        <mesh ref={occRef} position={[0, 0.21, 0]} rotation-x={-Math.PI / 2} visible={false}>
          <planeGeometry args={[1.5, 1.5]} /><meshBasicMaterial color="#22d3ee" transparent opacity={0.12} />
        </mesh>
        {/* Wheel-stop bumper (±x ends) */}
        {[-1, 1].map((sx, i) => <mesh key={"b" + i} position={[sx * (W - 0.8) / 2, 0.26, 0]}><boxGeometry args={[0.06, 0.1, D - 0.9]} /><meshStandardMaterial color="#b45309" roughness={0.6} /></mesh>)}
        {/* carriage brackets → guide rails */}
        {[-W / 2 + 0.2, W / 2 - 0.2].map((dx, i) => (
          <mesh key={"c" + i} position={[dx * 0.82, 0.3, D / 2 - 0.45]}><boxGeometry args={[0.35, 0.5, 0.3]} />{steel}</mesh>
        ))}
      </group>
      {/* ── Bi-parting safety doors on each floor (west face) + door frame, sill, indicator lights ── */}
      {[0, elev].map((fy, fi) => (
        <group key={"door" + fi} position={[-W / 2, fy, 0]}>
          {/* Door frame */}
          <mesh position={[0, 1.15, -LEAF - 0.12]}><boxGeometry args={[0.18, 2.3, 0.14]} />{frame}</mesh>
          <mesh position={[0, 1.15, LEAF + 0.12]}><boxGeometry args={[0.18, 2.3, 0.14]} />{frame}</mesh>
          <mesh position={[0, 2.36, 0]}><boxGeometry args={[0.18, 0.16, 2.6]} />{frame}</mesh>
          {/* Door sill (supplement §6) */}
          <mesh position={[-0.15, 0.015, 0]}><boxGeometry args={[0.5, 0.03, 2.3]} /><meshStandardMaterial color="#556174" metalness={0.7} roughness={0.35} /></mesh>
          {/* Door zone yellow-black floor marking */}
          <mesh position={[-0.85, fy === 0 ? 0.015 : 0.02, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[1.1, 2.4]} /><meshBasicMaterial color="#eab308" transparent opacity={0.18} /></mesh>
          {/* Indicator post: floor light / status light / interlock / e-stop */}
          <group position={[0, 0, -LEAF - 0.35]}>
            <mesh position={[0, 1.2, 0]}><boxGeometry args={[0.12, 0.9, 0.18]} /><meshStandardMaterial color="#1c232f" roughness={0.5} /></mesh>
            <mesh position={[-0.02, 1.5, 0]}><boxGeometry args={[0.1, 0.12, 0.12]} /><meshBasicMaterial ref={fi === 0 ? levelF1 : levelF2} color="#334155" /></mesh>
            <mesh position={[-0.02, 1.3, 0]}><boxGeometry args={[0.1, 0.12, 0.12]} /><meshBasicMaterial ref={fi === 0 ? lightRef : undefined} color="#22c55e" transparent /></mesh>
            <mesh position={[-0.02, 1.05, 0]}><cylinderGeometry args={[0.05, 0.05, 0.05, 10]} /><meshBasicMaterial color="#dc2626" /></mesh>
          </group>
          {/* Bi-parting door leaves */}
          <mesh ref={(m) => { leafRefs.current[fi * 2] = m; }} position={[0, 1.12, -LEAF / 2]}>
            <boxGeometry args={[0.07, 2.2, LEAF]} />
            <meshStandardMaterial color="#4a5364" transparent opacity={0.8} metalness={0.6} roughness={0.35} />
          </mesh>
          <mesh ref={(m) => { leafRefs.current[fi * 2 + 1] = m; }} position={[0, 1.12, LEAF / 2]}>
            <boxGeometry args={[0.07, 2.2, LEAF]} />
            <meshStandardMaterial color="#4a5364" transparent opacity={0.8} metalness={0.6} roughness={0.35} />
          </mesh>
        </group>
      ))}
      {/* ── Top-mounted drive box (compact: Motor–Brake–Gearbox) ── */}
      <group position={[0, H + 0.35, D / 2 - 0.5]}>
        <mesh castShadow={!lite}><boxGeometry args={[1.3, 0.7, 0.9]} /><meshStandardMaterial color="#232a37" roughness={0.5} metalness={0.6} /></mesh>
        {/* Cooling slots */}
        {[-0.3, 0, 0.3].map((dz, i) => <mesh key={i} position={[0.66, 0, dz * 0.9]}><boxGeometry args={[0.02, 0.4, 0.06]} /><meshBasicMaterial color="#0b0f16" /></mesh>)}
        {/* Drive status LED + warning */}
        <mesh position={[-0.55, 0.15, 0.46]}><sphereGeometry args={[0.06, 8, 8]} /><meshBasicMaterial color="#22c55e" /></mesh>
        <mesh position={[0, 0.15, 0.46]} rotation-x={0}><planeGeometry args={[0.3, 0.26]} /><meshBasicMaterial color="#eab308" /></mesh>
      </group>
      {!lite && (
        <Html position={[0, H + 1.3, 0]} zIndexRange={[9, 0]} center>
          <div className="lift-lbl" onClick={(e) => { e.stopPropagation(); selectLift(l.id); }}>
            <b>{l.id}</b><span>{liftLabel(L)}</span>
            <span className="lift-sign">AUTOMATED MATERIAL LIFT · AMR ONLY · CAP 1</span>
          </div>
        </Html>
      )}
    </group>
  );
}
