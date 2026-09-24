/**
 * Dependency-free hash router: `#/` twin setup list (default), `#/workspace/<id>` twin editor, `#/console/<id>` operations console of one twin.
 * `#/scenarios` (the old setup link) and unknown hashes fall back to the setup list; a reload keeps the page.
 */
import { useSyncExternalStore } from "react";

export type Route = { page: "scenarios" } | { page: "workspace"; id: string } | { page: "console"; id: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  const m = /^(workspace|console)\/([^/?#]+)$/.exec(path);
  if (m) {
    try { return { page: m[1] as "workspace" | "console", id: decodeURIComponent(m[2]) }; } catch { return { page: "scenarios" }; }
  }
  return { page: "scenarios" };
}

export function routeHash(route: Route): string {
  switch (route.page) {
    case "workspace": return `#/workspace/${encodeURIComponent(route.id)}`;
    case "console": return `#/console/${encodeURIComponent(route.id)}`;
    default: return "#/";
  }
}

export function navigate(route: Route): void { location.hash = routeHash(route); }

const subscribe = (fn: () => void) => { window.addEventListener("hashchange", fn); return () => window.removeEventListener("hashchange", fn); };
const getHash = () => location.hash;
/** The external-store snapshot is the hash string (stable between changes); the route object is derived per render */
export function useHashRoute(): Route { return parseRoute(useSyncExternalStore(subscribe, getHash, getHash)); }
