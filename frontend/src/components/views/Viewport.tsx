import { layout, useStore, type ViewTab, type SceneTool } from "../../state/store";
import { Icon } from "../ui/primitives";
import { Scene3D } from "../scene/Scene3D";
import { MapView2D } from "./MapView2D";

const TABS: Array<[ViewTab, string]> = [["3D", "3D VIEW"], ["MAP", "MAP VIEW"], ["TRAFFIC", "TRAFFIC VIEW"], ["HEATMAP", "HEATMAP"]];

export function Viewport() {
  const tab = useStore((s) => s.viewTab);
  const setTab = useStore((s) => s.setViewTab);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const showPaths = useStore((s) => s.showPaths);
  const showLabels = useStore((s) => s.showLabels);
  const togglePaths = useStore((s) => s.togglePaths);
  const toggleLabels = useStore((s) => s.toggleLabels);
  const focus = useStore((s) => s.focus);
  const activeFloor = useStore((s) => s.activeFloor);
  const setActiveFloor = useStore((s) => s.setActiveFloor);
  // The floor picker only matters with a mezzanine (the Main Warehouse); the home view looks at the centre of the floor
  const hasF2 = layout.floors.some((f) => f.id === 2);
  const home: [number, number, number] = [layout.size.width / 2, 0, layout.size.depth / 2 - 4];
  const toolBtn = (t: SceneTool, icon: JSX.Element, title: string, on = tool === t, onClick = () => setTool(t)) => (
    <button className={on ? "on" : ""} title={title} onClick={onClick}>{icon}</button>
  );
  return (
    <div className="viewport">
      <div className="view-tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="vp-toolbar">
        {hasF2 && <select className="sel" title="Floor" value={String(activeFloor)} onChange={(e) => { const v = e.target.value === "all" || e.target.value === "exploded" ? e.target.value as "all" | "exploded" : Number(e.target.value); setActiveFloor(v); if (v === 2) focus([31, 8, 51]); else focus(home); }}>
          <option value="all">All floors</option>
          <option value="1">Floor 1</option>
          <option value="2">Floor 2</option>
          <option value="exploded">Exploded</option>
        </select>}
        <button className="icon-btn" title="Reset camera" onClick={() => focus(home)}>{Icon.expand}</button>
        <button className="icon-btn" title="Viewport settings">{Icon.gear}</button>
      </div>
      {tab === "3D" ? <Scene3D /> : <MapView2D mode={tab} />}
      {tab === "3D" && (
        <div className="scene-toolbar">
          {toolBtn("select", Icon.cursor, "Select")}
          {toolBtn("pan", Icon.hand, "Pan (left-drag)")}
          {toolBtn("paths", Icon.path, "Toggle paths", showPaths, togglePaths)}
          {toolBtn("labels", Icon.tag, "Toggle labels", showLabels, toggleLabels)}
          {toolBtn("measure", Icon.ruler, "Measure (later phase)", false, () => {})}
        </div>
      )}
    </div>
  );
}
