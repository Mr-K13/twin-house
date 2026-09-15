/**
 * 2D top-down tab of the workspace: the Length × Width floor with a 10 m grid, every instance as its rotated footprint (dashed when it sits
 * above the floor on another asset), an FOV wedge for cameras, and click-to-select. It reads the same store as the 3D view, so selecting
 * here highlights there and in the inspector.
 */
import { ASSET_DEFS } from "../../scenario/assetDefs";
import { footprintCorners } from "../../scenario/model";
import { useScenarioStore } from "../../scenario/store";
import type { AssetInstance } from "../../scenario/types";

const DEG = Math.PI / 180;

/** Sector of fov_deg and range_m × 0.35 (the same fraction the 3D cone uses). 3D looks along +x at rotation 0 and rotation-y by θ turns (1, 0, 0) into (cos θ, 0, −sin θ): an SVG angle of −θ */
function CameraWedge({ inst }: { inst: AssetInstance }) {
  const fov = Number(inst.params.fov_deg ?? 70) * DEG, r = Number(inst.params.range_m ?? 25) * 0.35;
  const [x, , z] = inst.position;
  const a0 = -inst.rotation - fov / 2, a1 = -inst.rotation + fov / 2;
  const d = `M ${x} ${z} L ${x + r * Math.cos(a0)} ${z + r * Math.sin(a0)} A ${r} ${r} 0 ${fov > Math.PI ? 1 : 0} 1 ${x + r * Math.cos(a1)} ${z + r * Math.sin(a1)} Z`;
  return <path d={d} fill="#facc15" fillOpacity={0.12} stroke="#facc15" strokeWidth={0.2} strokeOpacity={0.7} pointerEvents="none" />;
}

export function EditorMap2D() {
  const active = useScenarioStore((s) => s.active);
  const selectedId = useScenarioStore((s) => s.selectedId);
  const select = useScenarioStore((s) => s.select);
  if (!active) return null;
  const { length: L, width: W } = active.size;
  const fs = Math.max(1.8, L / 60);      // labels stay readable on a 500 m warehouse
  const nx = Math.floor(L / 10), nz = Math.floor(W / 10);
  return (
    <svg className="map2d" viewBox={`-3 -5 ${L + 6} ${W + 9}`} preserveAspectRatio="xMidYMid meet" onClick={() => select(null)}>
      <rect x="0" y="0" width={L} height={W} fill="#0a1020" stroke="#334155" strokeWidth="0.4" />
      {Array.from({ length: nx + 1 }, (_, i) => <line key={"v" + i} x1={i * 10} x2={i * 10} y1="0" y2={W} stroke="#16213a" strokeWidth="0.15" />)}
      {Array.from({ length: nz + 1 }, (_, i) => <line key={"h" + i} y1={i * 10} y2={i * 10} x1="0" x2={L} stroke="#16213a" strokeWidth="0.15" />)}
      <text x="0" y={-1.5} fill="#8b98ad" fontSize={fs}>{`x → Length ${L} m`}</text>
      <text x={L} y={W + 3} fill="#8b98ad" fontSize={fs} textAnchor="end">{`z ↓ Width ${W} m · top-down · click a footprint to select`}</text>
      {active.instances.map((inst) => {
        const def = ASSET_DEFS[inst.type];
        const pts = footprintCorners(inst, def);
        const sel = inst.id === selectedId;
        const stacked = def.surface !== "free" && inst.position[1] > 0.01;
        return (
          <g key={inst.id} onClick={(e) => { e.stopPropagation(); select(inst.id); }} style={{ cursor: "pointer" }}>
            {inst.type === "camera" && <CameraWedge inst={inst} />}
            <polygon points={pts.map((p) => p.join(",")).join(" ")} fill={def.color} fillOpacity={sel ? 0.6 : 0.35} stroke={sel ? "#ffffff" : def.color} strokeWidth={sel ? 0.5 : 0.25} strokeDasharray={stacked ? "0.9 0.5" : undefined} />
            <text x={inst.position[0]} y={inst.position[2] - fs * 0.9} fill={sel ? "#fff" : "#e2e8f0"} fontSize={fs} textAnchor="middle" fontFamily="JetBrains Mono, monospace" pointerEvents="none">{inst.id}</text>
          </g>
        );
      })}
    </svg>
  );
}
