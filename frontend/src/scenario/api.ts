/** Typed REST client for /api/scenarios (backend/app/main.py). Same base URL as the console's REST calls (derived from VITE_WS_URL). */
import { API_URL } from "../services/ws";
import type { Scenario, ScenarioSize, ScenarioSummary } from "./types";

export class ApiError extends Error {
  /** HTTP status; 0 when the backend could not be reached at all */
  status: number;
  constructor(status: number, message: string) { super(message); this.name = "ApiError"; this.status = status; }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try { res = await fetch(`${API_URL}${path}`, init); }
  catch { throw new ApiError(0, "backend unreachable"); }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`.trim();
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail).slice(0, 300);
    } catch { /* keep the status text */ }
    throw new ApiError(res.status, detail);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
const json = (method: string, body: unknown, extra?: RequestInit): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...extra });
const path = (id: string) => `/api/scenarios/${encodeURIComponent(id)}`;

export const listScenarios = () => call<ScenarioSummary[]>("/api/scenarios");
export const getScenario = (id: string) => call<Scenario>(path(id));
export const createScenario = (name: string, size: ScenarioSize) => call<Scenario>("/api/scenarios", json("POST", { name, size }));
/** `keepalive` lets the save outlive a page unload (browsers cap keepalive bodies at 64 KB) */
export const putScenario = (s: Scenario, opts: { keepalive?: boolean } = {}) =>
  call<Scenario>(path(s.id), json("PUT", { name: s.name, size: s.size, instances: s.instances }, opts.keepalive ? { keepalive: true } : undefined));
export const deleteScenario = (id: string) => call<void>(path(id), { method: "DELETE" });
