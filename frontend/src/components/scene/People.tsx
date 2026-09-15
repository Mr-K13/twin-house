import { Html } from "@react-three/drei";
import { useStore } from "../../state/store";
import { FLOOR_ELEV } from "./Mezzanine";
import type { PersonState } from "../../schema/twin_state";

/** Decorative people on floor 1 (not driven by the simulation). They stand in the maintenance area (RESTRICT-1), which robots cannot enter,
 *  so they never sit next to aisles or charging rows where robots pass close by. The asset catalog lists these as the placed instances. */
export const STATIC_PEOPLE: readonly PersonState[] = [
  { id: "W-01", kind: "WORKER", position: [4.5, 0, 4.5], heading: 0, zone: null, floor: 1, expires_tick: null },
  { id: "W-02", kind: "WORKER", position: [9.5, 0, 2.5], heading: 1.1, zone: null, floor: 1, expires_tick: null },
  { id: "W-03", kind: "WORKER", position: [13.5, 0, 5.5], heading: 2.2, zone: null, floor: 1, expires_tick: null },
  { id: "W-04", kind: "WORKER", position: [16, 0, 2.5], heading: 3.3, zone: null, floor: 1, expires_tick: null },
  { id: "FL-01", kind: "FORKLIFT", position: [8, 0, 4], heading: 0.4, zone: null, floor: 1, expires_tick: null },
];
/** Forklift body envelope (m): the model below is built from these, and the asset catalog reports them */
export const FORKLIFT_BODY = { L: 2.2, W: 1.2, H: 0.9, MAST_H: 2.4 } as const;

/** Worker / forklift NPCs; Phase 1 uses static decoration, Phase 4 drives them with fault injection */
export function People({ lite = false }: { lite?: boolean }) {
  const people = useStore((s) => s.twin.people);
  const af = useStore((s) => s.activeFloor);
  const activeFloor = lite || af === "exploded" ? "all" : af;
  const explodeY = (floor: number) => (!lite && af === "exploded" && floor === 2 ? 5 : 0);   // In the lite (CCTV) scene the platform does not rise, so the workers must not rise either
  const show = (floor: number) => activeFloor === "all" || floor === activeFloor;
  return (
    <group>
      {show(1) && STATIC_PEOPLE.map((p) => p.kind === "WORKER" ? <Worker key={p.id} position={p.position} heading={p.heading} /> : <Forklift key={p.id} position={p.position} heading={p.heading} />)}
      {Object.values(people).filter((p) => show(p.floor ?? 1)).map((p) => {
        const ey = (FLOOR_ELEV[p.floor ?? 1] ?? 0) + explodeY(p.floor ?? 1);
        return (
          <group key={p.id} position-y={ey}>
            {p.kind === "WORKER" ? <Worker position={p.position} heading={p.heading} alert /> : <Forklift position={p.position} heading={p.heading} />}
            {!lite && <Html position={[p.position[0], 2.3, p.position[2]]} center zIndexRange={[12, 0]}><div className="lbl err">⚠ HUMAN</div></Html>}
          </group>
        );
      })}
    </group>
  );
}

/** Worker: hi-vis vest, hard hat; `alert` draws the red ground ring used for an intrusion */
export function Worker({ position, heading = 0, alert = false }: { position: [number, number, number]; heading?: number; alert?: boolean }) {
  return (
    <group position={position} rotation-y={heading}>
      <mesh position={[0, 0.45, 0]}><capsuleGeometry args={[0.16, 0.5, 4, 8]} /><meshStandardMaterial color="#1e3a8a" /></mesh>
      <mesh position={[0, 1.05, 0]}><capsuleGeometry args={[0.2, 0.45, 4, 8]} /><meshStandardMaterial color="#a3e635" emissive="#a3e635" emissiveIntensity={0.5} /></mesh>
      <mesh position={[0, 1.58, 0]}><sphereGeometry args={[0.15, 10, 10]} /><meshStandardMaterial color="#f1c27d" /></mesh>
      <mesh position={[0, 1.7, 0]}><sphereGeometry args={[0.17, 10, 10, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color="#facc15" /></mesh>
      {alert && <mesh position={[0, 0.02, 0]} rotation-x={-Math.PI / 2}><ringGeometry args={[0.7, 0.9, 32]} /><meshBasicMaterial color="#ef4444" /></mesh>}
    </group>
  );
}

/** Forklift: orange body, cab, mast and two forks */
export function Forklift({ position, heading = 0.4 }: { position: [number, number, number]; heading?: number }) {
  return (
    <group position={position} rotation-y={heading}>
      <mesh position={[0, 0.6, 0]} castShadow><boxGeometry args={[FORKLIFT_BODY.L, FORKLIFT_BODY.H, FORKLIFT_BODY.W]} /><meshStandardMaterial color="#f59e0b" roughness={0.5} metalness={0.3} /></mesh>
      <mesh position={[-0.3, 1.6, 0]}><boxGeometry args={[0.9, 1.1, 1.0]} /><meshStandardMaterial color="#111827" /></mesh>
      <mesh position={[1.3, 1.2, 0]}><boxGeometry args={[0.12, FORKLIFT_BODY.MAST_H, 1.0]} /><meshStandardMaterial color="#374151" metalness={0.7} /></mesh>
      {[-0.45, 0.45].map((z) => <mesh key={z} position={[1.7, 0.12, z]}><boxGeometry args={[1.0, 0.06, 0.14]} /><meshStandardMaterial color="#9ca3af" metalness={0.8} /></mesh>)}
      {[[-0.7, -0.6], [0.7, -0.6], [-0.7, 0.6], [0.7, 0.6]].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.28, z]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.28, 0.28, 0.25, 14]} /><meshStandardMaterial color="#0f172a" /></mesh>
      ))}
    </group>
  );
}
