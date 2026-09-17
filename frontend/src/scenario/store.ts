/**
 * Scenario workspace store. A second zustand store, separate from the console's state/store.ts, so the simulation runner, WebSocket and
 * console UI stay untouched. Instance mutations update `active` synchronously and schedule one PUT after 800 ms of inactivity
 * (createSaveScheduler); a failed save keeps the local state, shows "Save failed — retry" and is retried by the next mutation, `retrySave`,
 * or the next flush (the scheduler keeps the failed document pending, so leaving the page never discards it: `open()` and `close()` flush first).
 * WorkspacePage flushes on `beforeunload` with keepalive (browsers cap keepalive bodies at 64 KB, so a very large document relies on the
 * debounced save already scheduled or on the next visit) and asks for confirmation while a save has failed.
 * Two browsers editing the same scenario overwrite each other (last write wins; documented non-goal).
 */
import { create } from "zustand";
import type { P3 } from "../layout/types";
import type { AssetInstance, AssetTypeId, Scenario, ScenarioSize, ScenarioSummary } from "./types";
import { ApiError, createScenario, deleteScenario, getScenario, listScenarios, putScenario } from "./api";
import { constrainToWalls, createSaveScheduler, roundMm, WALL_SNAP_DISTANCE, type SaveOptions } from "./model";

export type SaveState = "saved" | "saving" | "error";
export type WorkspaceTab = "3D" | "2D";

interface ScenarioStore {
  summaries: ScenarioSummary[];
  listState: "idle" | "loading" | "ready" | "error";
  listError: string | null;
  active: Scenario | null;
  activeState: "idle" | "loading" | "ready" | "missing" | "error";
  activeError: string | null;
  saveState: SaveState;
  saveError: string | null;
  selectedId: string | null;
  viewTab: WorkspaceTab;
  /** Asset type currently dragged from the palette (HTML5 drag data is unreadable during dragover) */
  dragType: AssetTypeId | null;
  loadList(): Promise<void>;
  create(name: string, size: ScenarioSize): Promise<Scenario>;
  remove(id: string): Promise<void>;
  open(id: string): Promise<void>;
  /** Flush a pending save, then clear the active scenario */
  close(): Promise<void>;
  /** Save a pending document now (page unload passes keepalive) */
  flushSave(opts?: SaveOptions): Promise<void>;
  retrySave(): void;
  /** Adds with the footprint kept between the walls */
  addInstance(inst: AssetInstance): void;
  /** Merges the patch; whatever changed (position, rotation, footprint parameters), the footprint is kept between the walls */
  updateInstance(id: string, patch: Partial<AssetInstance>): void;
  /** Pointer move: updateInstance with the position plus magnetic walls (WALL_SNAP_DISTANCE) */
  moveInstance(id: string, position: P3): void;
  removeInstance(id: string): void;
  renameScenario(name: string): void;
  select(id: string | null): void;
  setViewTab(t: WorkspaceTab): void;
  setDragType(t: AssetTypeId | null): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useScenarioStore = create<ScenarioStore>((set, get) => {
  /** open() / close() sequence number: a late GET or a late close must not clobber a newer open */
  let seq = 0;
  const scheduler = createSaveScheduler<Scenario>(async (doc, opts) => {
    try {
      const saved = await putScenario(doc, opts);
      set((s) => {
        const summaries = s.summaries.map((x) => (x.id === saved.id ? { ...x, name: saved.name, size: saved.size, instance_count: saved.instances.length, updated_at: saved.updated_at } : x));
        if (s.active?.id !== saved.id) return { summaries };
        const active = { ...s.active, updated_at: saved.updated_at };
        // Only report "saved" when nothing newer is waiting for the delay
        return scheduler.pending() ? { summaries, active } : { summaries, active, saveState: "saved", saveError: null };
      });
    } catch (e) {
      set((s) => (s.active?.id === doc.id ? { saveState: "error", saveError: message(e) } : {}));
      throw e;   // the scheduler keeps the document pending for the next retry
    }
  });
  /** Flush without surfacing the rejection: the error is already recorded in saveState */
  const flushQuietly = (opts?: SaveOptions) => scheduler.flush(opts).catch(() => undefined);
  const mutate = (fn: (a: Scenario) => Scenario) => {
    const a = get().active; if (!a) return;
    const next = fn(a);
    set({ active: next, saveState: "saving" });
    scheduler.schedule(next);
  };
  /** Every instance write ends here: footprint between the walls (magnetic when `snap` > 0) and a mm-rounded position */
  const settle = (inst: AssetInstance, size: ScenarioSize, snap = 0): AssetInstance => {
    const c = constrainToWalls(inst, size, snap);
    return { ...c, position: roundMm(c.position) };
  };

  return {
    summaries: [], listState: "idle", listError: null,
    active: null, activeState: "idle", activeError: null,
    saveState: "saved", saveError: null,
    selectedId: null, viewTab: "3D", dragType: null,

    async loadList() {
      set({ listState: "loading", listError: null });
      try { set({ summaries: await listScenarios(), listState: "ready" }); }
      catch (e) { set({ listState: "error", listError: message(e) }); }
    },
    async create(name, size) {
      const s = await createScenario(name, size);
      set((st) => ({ summaries: [{ id: s.id, name: s.name, size: s.size, instance_count: 0, created_at: s.created_at, updated_at: s.updated_at }, ...st.summaries.filter((x) => x.id !== s.id)] }));
      return s;
    },
    async remove(id) {
      await deleteScenario(id);
      set((st) => ({ summaries: st.summaries.filter((s) => s.id !== id) }));
    },
    async open(id) {
      const token = ++seq;
      set({ active: null, activeState: "loading", activeError: null, selectedId: null, dragType: null, saveState: "saved", saveError: null });
      await flushQuietly();     // a pending (or previously failed) save goes out first, so the GET below returns it
      if (token !== seq) return;
      try {
        const s = await getScenario(id);
        if (token !== seq) return;
        set({ active: s, activeState: "ready" });
      } catch (e) {
        if (token !== seq) return;
        set({ activeState: e instanceof ApiError && e.status === 404 ? "missing" : "error", activeError: message(e) });
      }
    },
    async close() {
      const token = ++seq;
      await flushQuietly();
      if (token !== seq) return;
      set({ active: null, activeState: "idle", activeError: null, selectedId: null, dragType: null });
    },
    flushSave(opts) { return flushQuietly(opts); },
    retrySave() {
      const a = get().active; if (!a) return;
      set({ saveState: "saving", saveError: null });
      scheduler.schedule(a);
      void flushQuietly();
    },
    addInstance(inst) { mutate((a) => ({ ...a, instances: [...a.instances, settle(inst, a.size)] })); },
    updateInstance(id, patch) {
      mutate((a) => ({ ...a, instances: a.instances.map((i) => (i.id === id ? settle({ ...i, ...patch }, a.size) : i)) }));
      if (patch.id && patch.id !== id && get().selectedId === id) set({ selectedId: patch.id });
    },
    moveInstance(id, position) {
      mutate((a) => ({ ...a, instances: a.instances.map((i) => (i.id === id ? settle({ ...i, position }, a.size, WALL_SNAP_DISTANCE) : i)) }));
    },
    removeInstance(id) {
      mutate((a) => ({ ...a, instances: a.instances.filter((i) => i.id !== id) }));
      if (get().selectedId === id) set({ selectedId: null });
    },
    renameScenario(name) { const n = name.trim(); if (n) mutate((a) => ({ ...a, name: n })); },
    select(selectedId) { set({ selectedId }); },
    setViewTab(viewTab) { set({ viewTab }); },
    setDragType(dragType) { set({ dragType }); },
  };
});
