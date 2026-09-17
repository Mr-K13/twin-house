/**
 * Right column of the workspace: id, position, rotation and the type-specific parameters (assetDefs paramSchema) of the selected instance.
 * Text and number fields commit on blur / Enter so typing is never fought by re-renders; every edit re-renders the 3D and 2D views immediately.
 */
import { useEffect, useState, type FocusEvent, type KeyboardEvent } from "react";
import type { P3 } from "../../layout/types";
import { ASSET_DEFS, type ParamField } from "../../scenario/assetDefs";
import { wrapRotation } from "../../scenario/model";
import { useScenarioStore } from "../../scenario/store";
import type { ParamValue } from "../../scenario/types";

const DEG = 180 / Math.PI;
const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
const clamp = (v: number, lo = -Infinity, hi = Infinity) => Math.min(hi, Math.max(lo, v));
const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); };

/** Number input that keeps the user's typing until blur / Enter, then commits the clamped value; remounts when the store value changes */
function NumField({ label, unit, value, min, max, step, disabled, onCommit }: { label: string; unit?: string; value: number; min?: number; max?: number; step?: number; disabled?: boolean; onCommit: (v: number) => void }) {
  const shown = round(value);
  const commit = (e: FocusEvent<HTMLInputElement>) => {
    const raw = e.target.value.trim(), n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) { e.target.value = String(shown); return; }
    const v = clamp(n, min, max);
    if (v !== shown) onCommit(v);
    // Show the store's value again: the store may keep it unchanged (a position pushed back to the same place by the walls), and then no remount happens
    e.target.value = String(shown);
  };
  return (
    <label>
      {label}{unit && <span className="unit"> ({unit})</span>}
      <input key={shown} type="number" defaultValue={shown} min={min} max={max} step={step} disabled={disabled} onBlur={commit} onKeyDown={blurOnEnter} />
    </label>
  );
}

export function InstanceInspector() {
  const active = useScenarioStore((s) => s.active);
  const selectedId = useScenarioStore((s) => s.selectedId);
  const updateInstance = useScenarioStore((s) => s.updateInstance);
  const removeInstance = useScenarioStore((s) => s.removeInstance);
  const [idError, setIdError] = useState<string | null>(null);
  useEffect(() => setIdError(null), [selectedId]);
  const inst = active?.instances.find((i) => i.id === selectedId);
  if (!active || !inst) return <p className="hint">Select an instance in the 3D or 2D view, or add one from the asset list, to edit its id, position, rotation and parameters here.</p>;

  const def = ASSET_DEFS[inst.type];
  const size = active.size;
  const { w, d } = def.footprint(inst.params);
  const h = def.height(inst.params);
  // The store keeps the footprint between the walls, so a value too close to a wall comes back as the nearest allowed one
  const setPos = (axis: 0 | 1 | 2, v: number) => { const p = [...inst.position] as P3; p[axis] = v; updateInstance(inst.id, { position: p }); };
  const commitId = (raw: string) => {
    const id = raw.trim();
    if (id === inst.id) { setIdError(null); return; }
    if (!id) { setIdError("Id is required"); return; }
    if (id.length > 40) { setIdError("Id must be 40 characters or fewer"); return; }
    if (active.instances.some((i) => i.id === id)) { setIdError(`${id} is already used in this scenario`); return; }
    setIdError(null);
    updateInstance(inst.id, { id });
  };
  const setParam = (f: ParamField, v: ParamValue) => updateInstance(inst.id, { params: { ...inst.params, [f.key]: v } });
  const paramNumber = (f: ParamField) => { const v = inst.params[f.key] ?? def.defaults[f.key]; return typeof v === "number" ? v : Number(v) || 0; };
  const paramText = (f: ParamField) => String(inst.params[f.key] ?? def.defaults[f.key] ?? "");

  return (
    <div className="inspector">
      <h4 className="drawer-sub" style={{ marginTop: 0 }}>{def.label}</h4>
      <p className="hint">{def.description}</p>
      <div className="insp-grid">
        <label className="wide">Id
          <input key={inst.id} defaultValue={inst.id} maxLength={40} spellCheck={false} onBlur={(e) => commitId(e.target.value)} onKeyDown={blurOnEnter} />
          {idError && <span className="field-error">{idError}</span>}
        </label>
        <NumField label="X" unit="m" value={inst.position[0]} min={0} max={size.length} step={0.1} onCommit={(v) => setPos(0, v)} />
        <NumField label="Z" unit="m" value={inst.position[2]} min={0} max={size.width} step={0.1} onCommit={(v) => setPos(2, v)} />
        <NumField label={def.surface === "free" ? "Mount height Y" : "Y (on surface)"} unit="m" value={inst.position[1]} min={0} max={size.height} step={0.1} disabled={def.surface !== "free"} onCommit={(v) => setPos(1, v)} />
        <NumField label="Rotation" unit="°" value={round(inst.rotation * DEG, 1)} min={-360} max={720} step={5} onCommit={(v) => updateInstance(inst.id, { rotation: wrapRotation(v / DEG) })} />
        {def.paramSchema.map((f) => f.kind === "select" ? (
          <label key={f.key}>{f.label}
            <select value={paramText(f)} onChange={(e) => setParam(f, e.target.value)}>{f.options?.map((o) => <option key={o} value={o}>{o}</option>)}</select>
          </label>
        ) : f.kind === "number" ? (
          <NumField key={f.key} label={f.label} unit={f.unit} value={paramNumber(f)} min={f.min} max={f.max} step={f.step} onCommit={(v) => setParam(f, v)} />
        ) : (
          <label key={f.key}>{f.label}
            <input key={paramText(f)} defaultValue={paramText(f)} maxLength={200} onBlur={(e) => setParam(f, e.target.value)} onKeyDown={blurOnEnter} />
          </label>
        ))}
      </div>
      <div className="insp-meta">Footprint {round(w)} × {round(d)} m · height {round(h)} m · {def.surface === "free" ? "free height" : "snaps to surfaces"}{def.stackable ? " · others can stack on it" : ""}</div>
      <p className="hint">Drag the instance in the 3D view to move it: it cannot leave the walls and snaps flush against a wall within 0.5 m. The yaw ring snaps to 0 / 90 / 180 / 270° when close; Q / E rotate by 15° (Shift: 90°); Delete removes it.</p>
      <button className="btn danger" onClick={() => removeInstance(inst.id)}>Delete instance</button>
    </div>
  );
}
