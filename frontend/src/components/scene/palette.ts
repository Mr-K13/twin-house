/**
 * Object palette for the 3D warehouse, taken from the clean isometric illustration style the scene follows: royal-blue structure
 * (rack uprights, frames, pillars, truck cabs), sunny-yellow vehicles and safety edges, white / light-grey equipment bodies, near-black
 * trim (overhead guards, masts, tyres) and kraft cartons. Status colours (STATUS_COLOR, lift and dock lights, error red, FOV cones)
 * stay semantic and are deliberately not part of this palette.
 */
export const PALETTE = {
  blue: "#2f5be3",
  blueDeep: "#1f3fa8",
  blueSoft: "#8fb0ff",
  yellow: "#f6b928",
  orange: "#f08a24",
  teal: "#2fb7ae",
  ink: "#23262d",
  slate: "#6b7688",
  steel: "#a7b1c0",
  silver: "#d5dbe4",
  white: "#f3f5f9",
  skin: "#f1c27d",
  denim: "#2b3f73",
  wood: "#c58d55",
} as const;

/** Light environment: polished pale-grey floor with a faint grid, light-grey walls, a pale sky that the fog fades into, and the
 *  lighting that keeps those surfaces bright without washing out the objects. Shared by the console scene and the workspace editor. */
export const ENV = {
  sky: "#e1e7ef",
  floor: "#dbe2eb",
  floorSpeck: "rgba(70,85,110,",
  floorGrid: "rgba(100,116,139,0.22)",
  wall: "#cdd5e0",
  slab: "#c4ccd8",
  grid: "#94a3b8",
  ambient: "#ffffff",
  hemiSky: "#f2f6fc",
  hemiGround: "#b8c2d0",
  sun: "#ffffff",
  /** 2D maps: floor outline, 10 m grid, captions and on-map labels */
  mapEdge: "#a7b1c0",
  mapGrid: "#c3ccd8",
  mapCaption: "#64748b",
  mapLabel: "#334155",
} as const;

/** Carton shades: rack boxes, conveyor parcels, robot cargo, bench parcels */
export const KRAFT = ["#e6bf8f", "#dcae79", "#d09d66", "#e9c9a0", "#c98f57"] as const;
