import { useMemo } from "react";
import * as THREE from "three";
import { layout } from "../../state/store";

/** Floor, outer walls, pillars, roof trusses, dock doors, light fixtures */
export function WarehouseShell({ lite = false }: { lite?: boolean }) {
  const { width: W, depth: D, height: H } = layout.size;
  const floorTex = useMemo(() => {
    const c = document.createElement("canvas"); c.width = c.height = 512;
    const g = c.getContext("2d")!;
    g.fillStyle = "#1b2230"; g.fillRect(0, 0, 512, 512);
    // Fine noise dots
    for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.045})`; g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2); }
    // Grid lines (every 1m, one cell = 512/8 px => texture repeat every 8 m)
    g.strokeStyle = "rgba(120,140,170,0.18)"; g.lineWidth = 1.5;
    for (let i = 0; i <= 8; i++) { const p = (i * 512) / 8; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.moveTo(0, p); g.lineTo(512, p); g.stroke(); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(W / 8, D / 8); t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [W, D]);

  // round-9d: pillar positions are no longer procedural (the old version grew pillars on the conveyors and the central aisle, and the navigation grid did not know).
  // Single source of truth = layout.obstacles (kind PILLAR). The F1 grid uses the same data to block cells -- visuals and paths always agree.
  const pillars = useMemo(() =>
    (layout.obstacles ?? []).filter((o) => o.kind === "PILLAR").map((o) => [(o.rect[0] + o.rect[2]) / 2, (o.rect[1] + o.rect[3]) / 2] as [number, number]),
  []);

  const aisleLines = useMemo(() => {
    // Yellow markings for the central aisle and the aisle in front of the docks
    const segs: [number, number, number, number][] = [
      [46.2, 10, 46.2, 62], [53.8, 10, 53.8, 62], [0, 9.8, W, 9.8], [0, 8.2, W, 8.2],
    ];
    return segs;
  }, [W]);

  return (
    <group>
      {/* Floor */}
      <mesh rotation-x={-Math.PI / 2} position={[W / 2, 0, D / 2]} receiveShadow>
        <planeGeometry args={[W, D]} />
        <meshStandardMaterial map={floorTex} roughness={0.85} metalness={0.15} />
      </mesh>
      {/* Aisle markings */}
      {aisleLines.map(([x0, z0, x1, z1], i) => {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const ang = Math.atan2(z1 - z0, x1 - x0);
        return (
          <mesh key={i} position={[(x0 + x1) / 2, 0.01, (z0 + z1) / 2]} rotation={[-Math.PI / 2, 0, -ang]}>
            <planeGeometry args={[len, 0.18]} />
            <meshBasicMaterial color="#c9a227" transparent opacity={0.7} />
          </mesh>
        );
      })}
      {/* Outer walls (thin, visible only from the inside) */}
      {[
        { p: [W / 2, H / 2, 0], s: [W, H, 0.4] }, { p: [W / 2, H / 2, D], s: [W, H, 0.4] },
        { p: [0, H / 2, D / 2], s: [0.4, H, D] }, { p: [W, H / 2, D / 2], s: [0.4, H, D] },
      ].map((w, i) => (
        <mesh key={i} position={w.p as [number, number, number]}>
          <boxGeometry args={w.s as [number, number, number]} />
          <meshStandardMaterial color="#151c29" roughness={0.9} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {/* Blue waistline on the walls */}
      {[[W / 2, 0.25, D], [0, D / 2, Math.PI / 2], [W, D / 2, Math.PI / 2]].map((w, i) => (
        <mesh key={i} position={[w[0], 1.2, w[1] === 0.25 ? w[2] - 0.22 : w[1]]} rotation-y={w[2] === Math.PI / 2 ? w[2] : 0}>
          <planeGeometry args={[w[2] === Math.PI / 2 ? D : W, 0.12]} />
          <meshBasicMaterial color="#3b82f6" side={THREE.DoubleSide} />
        </mesh>
      ))}
      {/* Pillars */}
      {!lite && pillars.map(([x, z], i) => (
        <mesh key={i} position={[x, H / 2, z]} castShadow>
          <boxGeometry args={[0.5, H, 0.5]} />
          <meshStandardMaterial color="#27313f" roughness={0.8} metalness={0.3} />
        </mesh>
      ))}
      {/* Wall-top beams (no full roof, so the top view can show the interior) */}
      {!lite && [[W / 2, 0.2, W, 0.4], [W / 2, D - 0.2, W, 0.4], [0.2, D / 2, 0.4, D], [W - 0.2, D / 2, 0.4, D]].map(([x, z, sx, sz], i) => (
        <mesh key={i} position={[x, H + 0.2, z]}>
          <boxGeometry args={[sx, 0.5, sz]} />
          <meshStandardMaterial color="#1f2937" roughness={0.9} />
        </mesh>
      ))}
      {/* Dock doors */}
      {layout.docks.map((d) => (
        <group key={d.id} position={[d.door[0], 0, 0.25]}>
          <mesh position={[0, 2.4, 0]}>
            <boxGeometry args={[5.5, 4.8, 0.3]} />
            <meshStandardMaterial color="#0e1a2b" roughness={0.6} metalness={0.4} emissive={d.kind === "INBOUND" ? "#14532d" : "#164e63"} emissiveIntensity={0.6} />
          </mesh>
          <mesh position={[0, 5, 0]}>
            <boxGeometry args={[6.2, 0.3, 0.5]} />
            <meshBasicMaterial color={d.kind === "INBOUND" ? "#22c55e" : "#22d3ee"} />
          </mesh>
          {/* Truck trailer (outside the dock) */}
          <mesh position={[0, 1.9, -5]}>
            <boxGeometry args={[2.6, 3.2, 9]} />
            <meshStandardMaterial color="#d9dee7" roughness={0.5} metalness={0.2} />
          </mesh>
        </group>
      ))}
      {/* Ceiling lights */}
      {!lite && Array.from({ length: 4 }, (_, r) => Array.from({ length: 6 }, (_, c) => (
        <mesh key={`${r}-${c}`} position={[10 + c * 16, H - 1, 9 + r * 17]}>
          <boxGeometry args={[3, 0.12, 0.5]} />
          <meshBasicMaterial color="#dbeafe" />
        </mesh>
      )))}
    </group>
  );
}
