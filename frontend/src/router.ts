/**
 * Dependency-free hash router: `#/` operations console (default), `#/scenarios` setup list, `#/workspace/<id>` scenario editor.
 * Unknown hashes fall back to the console; a reload keeps the page.
 */
import { useSyncExternalStore } from "react";

export type Route = { page: "console" } | { page: "scenarios" } | { page: "workspace"; id: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (path === "scenarios") return { page: "scenarios" };
  const m = /^workspace\/([^/?#]+)$/.exec(path);
  if (m) {
    try { return { page: "workspace", id: decodeURIComponent(m[1]) }; } catch { return { page: "console" }; }
  }
  return { page: "console" };
}

export function routeHash(route: Route): string {
  switch (route.page) {
    case "scenarios": return "#/scenarios";
    case "workspace": return `#/workspace/${encodeURIComponent(route.id)}`;
    default: return "#/";
  }
}

export function navigate(route: Route): void { location.hash = routeHash(route); }

const subscribe = (fn: () => void) => { window.addEventListener("hashchange", fn); return () => window.removeEventListener("hashchange", fn); };
const getHash = () => location.hash;
/** The external-store snapshot is the hash string (stable between changes); the route object is derived per render */
export function useHashRoute(): Route { return parseRoute(useSyncExternalStore(subscribe, getHash, getHash)); }
