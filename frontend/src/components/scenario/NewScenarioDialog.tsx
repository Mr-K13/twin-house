/** New Scenario dialog: name and warehouse Length / Width / Height (metres) with the backend's bounds validated client-side; Create posts, then opens the workspace */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SIZE_LIMITS, validateSize } from "../../scenario/model";
import { useScenarioStore } from "../../scenario/store";
import { navigate } from "../../router";
import { useFocusTrap } from "../ui/useFocusTrap";

const DIMS = ["length", "width", "height"] as const;
const HINT = { length: "along x", width: "along z", height: "wall height" } as const;

export function NewScenarioDialog({ defaultName, onClose }: { defaultName: string; onClose: () => void }) {
  const create = useScenarioStore((s) => s.create);
  const [name, setName] = useState(defaultName);
  const [size, setSize] = useState({ length: "60", width: "40", height: "10" });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const trap = useFocusTrap<HTMLDivElement>(true);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); nameRef.current?.select(); }, []);   // after the focus trap's own initial focus
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose]);

  const parsed = { length: Number(size.length), width: Number(size.width), height: Number(size.height) };
  const trimmed = name.trim();
  const errors = [...(trimmed ? [] : ["Name is required"]), ...(trimmed.length > 80 ? ["Name must be 80 characters or fewer"] : []), ...validateSize(parsed)];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (errors.length) return;
    setBusy(true); setApiError(null);
    try {
      const s = await create(trimmed, parsed);
      onClose();
      navigate({ page: "workspace", id: s.id });
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal small" role="dialog" aria-modal="true" aria-label="New scenario" tabIndex={-1} ref={trap} onClick={(e) => e.stopPropagation()}>
        <header className="modal-h"><span>New Scenario</span><span className="spacer" /><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></header>
        <form className="modal-b dialog-form" onSubmit={(e) => void submit(e)} noValidate>
          <label>Name<input ref={nameRef} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
          <div className="size-grid">
            {DIMS.map((k) => (
              <label key={k}>{k[0].toUpperCase() + k.slice(1)} (m) <span className="unit">· {HINT[k]}</span>
                <input type="number" inputMode="decimal" min={SIZE_LIMITS[k][0]} max={SIZE_LIMITS[k][1]} step="0.5" value={size[k]} onChange={(e) => setSize({ ...size, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <p className="hint" style={{ margin: 0 }}>The warehouse is an empty box: Length runs along x, Width along z, Height is the wall height. Length and Width 5–500 m, Height 3–40 m. Assets are placed in the workspace afterwards.</p>
          {touched && errors.map((er) => <div key={er} className="field-error">{er}</div>)}
          {apiError && <div className="field-error">Could not create the scenario: {apiError}</div>}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
