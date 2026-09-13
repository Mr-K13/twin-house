import * as THREE from "three";
import { useMemo } from "react";
import { layout, useStore } from "../../state/store";
import type { LayoutCamera } from "../../layout/types";

/** One CCTV camera: pole mount, body aimed at look_at, record LED, and a translucent FOV cone scaled by fov_deg / range_m */
export function CameraModel({ c, status = "ONLINE", active = false, onClick }: { c: LayoutCamera; status?: string; active?: boolean; onClick?: () => void }) {
  const coneGeo = useMemo(() => new THREE.ConeGeometry(1, 1, 4, 1, true), []);
  const dir = new THREE.Vector3(...c.look_at).sub(new THREE.Vector3(...c.position));
  const len = Math.min(c.range_m * 0.35, 9);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
  const col = status === "OFFLINE" ? "#6b7280" : active ? "#60a5fa" : "#22d3ee";
  return (
    <group position={c.position} onClick={onClick && ((e) => { e.stopPropagation(); onClick(); })}>
      {/* Mount and body */}
      <mesh position={[0, 0.4, 0]}><cylinderGeometry args={[0.05, 0.05, 0.8, 8]} /><meshStandardMaterial color="#374151" /></mesh>
      <mesh quaternion={q} position={[0, 0, 0]}>
        <boxGeometry args={[0.35, 0.6, 0.3]} />
        <meshStandardMaterial color="#111827" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.1, 0]}><sphereGeometry args={[0.07, 8, 8]} /><meshBasicMaterial color={status === "OFFLINE" ? "#6b7280" : "#ef4444"} /></mesh>
      {/* FOV cone */}
      <mesh quaternion={q} position={dir.clone().normalize().multiplyScalar(len / 2)} scale={[len * Math.tan((c.fov_deg * Math.PI) / 360), len, len * Math.tan((c.fov_deg * Math.PI) / 360) * 0.6]} geometry={coneGeo}>
        <meshBasicMaterial color={col} transparent opacity={active ? 0.16 : 0.05} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Small camera model + FOV cone for every layout camera (the cone of the selected camera is brighter) */
export function CameraGizmos() {
  const cams = useStore((s) => s.twin.cameras);
  const active = useStore((s) => s.activeCamera);
  const setActive = useStore((s) => s.setActiveCamera);
  return (
    <group>
      {layout.cameras.map((c) => <CameraModel key={c.id} c={c} status={cams[c.id]?.status ?? "ONLINE"} active={c.id === active} onClick={() => setActive(c.id)} />)}
    </group>
  );
}
