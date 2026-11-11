import { Html, RoundedBox } from "@react-three/drei";
import { layout, useStore } from "../../state/store";
import { FLOOR_ELEV } from "./Mezzanine";
import type { PersonState } from "../../schema/twin_state";
import { PALETTE } from "./palette";

/** Decorative people on floor 1 of the Main Warehouse (not driven by the simulation; a twin's own placements come from layout.static_people). They stand in the maintenance area (RESTRICT-1), which robots cannot enter,
 *  so they never sit next to aisles or charging rows where robots pass close by. The asset catalog lists these as the placed instances. */
export const STATIC_PEOPLE: readonly PersonState[] = [
  { id: "W-01", kind: "WORKER", position: [4.5, 0, 4.5], heading: 0, zone: null, floor: 1, expires_tick: null },
  { id: "W-02", kind: "WORKER", position: [9.5, 0, 2.5], heading: 1.1, zone: null, floor: 1, expires_tick: null },
  { id: "W-03", kind: "WORKER", position: [13.5, 0, 5.5], heading: 2.2, zone: null, floor: 1, expires_tick: null },
  { id: "W-04", kind: "WORKER", position: [16, 0, 2.5], heading: 3.3, zone: null, floor: 1, expires_tick: null },
  { id: "FL-01", kind: "FORKLIFT", position: [8, 0, 4], heading: 0.4, zone: null, floor: 1, expires_tick: null },
];
/** Forklift envelope (m): L runs from the counterweight to the fork tips, W is across the wheels, H is the top of the yellow body.
 *  The model below is built inside it and the asset catalog / workspace editor report it. */
export const FORKLIFT_BODY = { L: 2.8, W: 1.2, H: 1.2, MAST_H: 2.4 } as const;

/** Worker / forklift NPCs; Phase 1 uses static decoration, Phase 4 drives them with fault injection */
export function People({ lite = false }: { lite?: boolean }) {
  const people = useStore((s) => s.twin.people);
  const af = useStore((s) => s.activeFloor);
  const activeFloor = lite || af === "exploded" ? "all" : af;
  const explodeY = (floor: number) => (!lite && af === "exploded" && floor === 2 ? 5 : 0);   // In the lite (CCTV) scene the platform does not rise, so the workers must not rise either
  const show = (floor: number) => activeFloor === "all" || floor === activeFloor;
  return (
    <group>
      {show(1) && (layout.static_people ?? STATIC_PEOPLE).map((p) => p.kind === "WORKER" ? <Worker key={p.id} position={p.position} heading={p.heading} /> : <Forklift key={p.id} position={p.position} heading={p.heading} />)}
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

/** Worker: orange hi-vis vest, hard hat; `alert` draws the red ground ring used for an intrusion */
export function Worker({ position, heading = 0, alert = false }: { position: [number, number, number]; heading?: number; alert?: boolean }) {
  return (
    <group position={position} rotation-y={heading}>
      <mesh position={[0, 0.45, 0]}><capsuleGeometry args={[0.16, 0.5, 4, 8]} /><meshStandardMaterial color={PALETTE.denim} /></mesh>
      <mesh position={[0, 1.05, 0]}><capsuleGeometry args={[0.2, 0.45, 4, 8]} /><meshStandardMaterial color={PALETTE.orange} emissive={PALETTE.orange} emissiveIntensity={0.25} /></mesh>
      <mesh position={[0, 1.58, 0]}><sphereGeometry args={[0.15, 10, 10]} /><meshStandardMaterial color={PALETTE.skin} /></mesh>
      <mesh position={[0, 1.7, 0]}><sphereGeometry args={[0.17, 10, 10, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color={PALETTE.yellow} /></mesh>
      {alert && <mesh position={[0, 0.02, 0]} rotation-x={-Math.PI / 2}><ringGeometry args={[0.7, 0.9, 32]} /><meshBasicMaterial color="#ef4444" /></mesh>}
    </group>
  );
}

/** Toy-like plastic finish shared by the forklift parts */
const Paint = ({ color, metal = 0.05 }: { color: string; metal?: number }) => <meshStandardMaterial color={color} roughness={0.55} metalness={metal} />;

/** Counterbalance forklift, +x is forward: blue chassis under a rounded yellow body and counterweight, black overhead guard with an amber
 *  beacon, seated driver in an orange vest, black mast with carriage and two L-shaped forks, dark tyres with light hubs (front pair larger).
 *  Spans x ∈ [−L/2, L/2] and z ∈ [−W/2, W/2] of FORKLIFT_BODY. */
export function Forklift({ position, heading = 0.4 }: { position: [number, number, number]; heading?: number }) {
  const { MAST_H } = FORKLIFT_BODY;
  const guardTop = 2.08;
  return (
    <group position={position} rotation-y={heading}>
      {/* Chassis, body, counterweight, dashboard */}
      <RoundedBox args={[1.6, 0.36, 1.04]} radius={0.06} smoothness={3} position={[-0.5, 0.38, 0]} castShadow><Paint color={PALETTE.blue} /></RoundedBox>
      <RoundedBox args={[1.62, 0.42, 1.12]} radius={0.1} smoothness={3} position={[-0.58, 0.74, 0]} castShadow><Paint color={PALETTE.yellow} /></RoundedBox>
      <RoundedBox args={[0.48, 0.66, 1.14]} radius={0.14} smoothness={3} position={[-1.15, 0.86, 0]} castShadow><Paint color={PALETTE.yellow} /></RoundedBox>
      <RoundedBox args={[0.3, 0.36, 0.92]} radius={0.08} smoothness={3} position={[0.08, 1.08, 0]} castShadow><Paint color={PALETTE.yellow} /></RoundedBox>
      <mesh position={[-0.08, 1.32, 0]} rotation={[-Math.PI / 2, 0, 0.6, "ZYX"]}><torusGeometry args={[0.13, 0.022, 8, 20]} /><Paint color={PALETTE.ink} /></mesh>
      {/* Seat */}
      <mesh position={[-0.55, 1.0, 0]}><boxGeometry args={[0.42, 0.1, 0.52]} /><Paint color={PALETTE.ink} /></mesh>
      <mesh position={[-0.78, 1.24, 0]} rotation-z={0.12}><boxGeometry args={[0.1, 0.46, 0.52]} /><Paint color={PALETTE.ink} /></mesh>
      {/* Driver */}
      <group position={[-0.52, 0, 0]}>
        <mesh position={[0, 1.36, 0]}><capsuleGeometry args={[0.17, 0.26, 4, 10]} /><Paint color={PALETTE.orange} /></mesh>
        {[-0.12, 0.12].map((z) => <mesh key={z} position={[0.2, 1.1, z]}><boxGeometry args={[0.42, 0.13, 0.13]} /><Paint color={PALETTE.denim} /></mesh>)}
        {[-0.2, 0.2].map((z) => <mesh key={z} position={[0.2, 1.4, z]} rotation-z={1.17}><capsuleGeometry args={[0.05, 0.28, 4, 6]} /><Paint color={PALETTE.orange} /></mesh>)}
        <mesh position={[0, 1.72, 0]}><sphereGeometry args={[0.12, 12, 12]} /><Paint color={PALETTE.skin} /></mesh>
        <mesh position={[0, 1.76, 0]}><sphereGeometry args={[0.135, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} /><Paint color={PALETTE.orange} /></mesh>
      </group>
      {/* Overhead guard: four posts, end rails and lengthwise slats */}
      {[0.22, -1.08].flatMap((x) => [-0.5, 0.5].map((z) => (
        <mesh key={`${x}:${z}`} position={[x, (0.95 + guardTop) / 2, z]} castShadow><boxGeometry args={[0.06, guardTop - 0.95, 0.06]} /><Paint color={PALETTE.ink} /></mesh>
      )))}
      {[0.22, -1.08].map((x) => <mesh key={x} position={[x, guardTop, 0]}><boxGeometry args={[0.08, 0.07, 1.08]} /><Paint color={PALETTE.ink} /></mesh>)}
      {[-0.5, -0.25, 0, 0.25, 0.5].map((z) => <mesh key={z} position={[-0.43, guardTop + 0.02, z]} castShadow><boxGeometry args={[1.38, 0.04, 0.07]} /><Paint color={PALETTE.ink} /></mesh>)}
      <mesh position={[-0.95, guardTop + 0.1, 0]}><cylinderGeometry args={[0.06, 0.07, 0.12, 12]} /><meshStandardMaterial color={PALETTE.orange} emissive={PALETTE.orange} emissiveIntensity={0.8} /></mesh>
      {/* Mast: two uprights with cross members */}
      {[-0.36, 0.36].map((z) => <mesh key={z} position={[0.38, MAST_H / 2, z]} castShadow><boxGeometry args={[0.09, MAST_H, 0.1]} /><Paint color={PALETTE.ink} metal={0.3} /></mesh>)}
      {[0.3, MAST_H / 2 + 0.3, MAST_H - 0.05].map((y) => <mesh key={y} position={[0.38, y, 0]}><boxGeometry args={[0.08, 0.08, 0.82]} /><Paint color={PALETTE.ink} metal={0.3} /></mesh>)}
      {/* Carriage and load backrest */}
      <mesh position={[0.46, 0.42, 0]}><boxGeometry args={[0.05, 0.12, 0.9]} /><Paint color={PALETTE.ink} metal={0.3} /></mesh>
      <mesh position={[0.46, 0.75, 0]}><boxGeometry args={[0.05, 0.08, 0.9]} /><Paint color={PALETTE.ink} metal={0.3} /></mesh>
      {[-0.3, 0, 0.3].map((z) => <mesh key={z} position={[0.46, 0.6, z]}><boxGeometry args={[0.04, 0.36, 0.04]} /><Paint color={PALETTE.ink} metal={0.3} /></mesh>)}
      {/* Forks: vertical shank + tine reaching the front of the envelope */}
      {[-0.28, 0.28].map((z) => (
        <group key={z}>
          <mesh position={[0.5, 0.28, z]}><boxGeometry args={[0.05, 0.5, 0.11]} /><Paint color={PALETTE.ink} metal={0.4} /></mesh>
          <mesh position={[0.96, 0.05, z]} castShadow><boxGeometry args={[0.88, 0.05, 0.11]} /><Paint color={PALETTE.ink} metal={0.4} /></mesh>
        </group>
      ))}
      {/* Wheels: tyre + hub; front pair larger */}
      {([[0.05, 0.3], [-0.98, 0.25]] as const).flatMap(([x, r]) => [-0.49, 0.49].map((z) => (
        <group key={`${x}:${z}`} position={[x, r, z]} rotation-x={Math.PI / 2}>
          <mesh castShadow><cylinderGeometry args={[r, r, 0.22, 20]} /><Paint color={PALETTE.ink} /></mesh>
          <mesh><cylinderGeometry args={[r * 0.5, r * 0.5, 0.235, 16]} /><Paint color={PALETTE.silver} metal={0.3} /></mesh>
        </group>
      )))}
    </group>
  );
}
