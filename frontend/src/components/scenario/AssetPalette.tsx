/**
 * Left column of the workspace: every catalog asset type. Drag a row into the 3D view to place an instance at the drop point (HTML5 drag;
 * the store's `dragType` mirrors the drag because dataTransfer is unreadable during dragover), or click / press Enter to add one at the
 * warehouse centre on the floor (the keyboard-accessible path).
 */
import { ASSET_DEFS, ASSET_TYPE_IDS } from "../../scenario/assetDefs";
import { makeInstance } from "../../scenario/model";
import { useScenarioStore } from "../../scenario/store";
import type { AssetTypeId } from "../../scenario/types";

/** dataTransfer type of a palette drag (Firefox only starts a drag when some data is set) */
export const DRAG_MIME = "application/x-twinhouse-asset";
const firstSentence = (s: string) => { const i = s.indexOf(". "); return i > 0 ? s.slice(0, i + 1) : s; };

export function AssetPalette() {
  const active = useScenarioStore((s) => s.active);
  const addInstance = useScenarioStore((s) => s.addInstance);
  const select = useScenarioStore((s) => s.select);
  const setDragType = useScenarioStore((s) => s.setDragType);
  if (!active) return null;
  const add = (type: AssetTypeId) => {
    const inst = makeInstance(type, [active.size.length / 2, 0, active.size.width / 2], active.instances);
    addInstance(inst);
    select(inst.id);
  };
  return (
    <div className="wi-list palette" aria-label="Asset types">
      {ASSET_TYPE_IDS.map((type) => {
        const def = ASSET_DEFS[type];
        return (
          <div key={type} className="wi-item palette-item" role="button" tabIndex={0} draggable
            title="Drag into the 3D view to place it there, or click to add it at the warehouse centre"
            onClick={() => add(type)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); add(type); } }}
            onDragStart={(e) => { e.dataTransfer.setData(DRAG_MIME, type); e.dataTransfer.setData("text/plain", type); e.dataTransfer.effectAllowed = "copy"; setDragType(type); }}
            onDragEnd={() => setDragType(null)}>
            <span className="swatch" style={{ background: def.color }} />
            <span className="pl-text"><b>{def.label}</b><small>{firstSentence(def.description)}</small></span>
          </div>
        );
      })}
    </div>
  );
}
