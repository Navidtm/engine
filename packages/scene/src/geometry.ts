import type { Geometry } from "./types.js";

export const TRIANGLE_GEOMETRY_ID = 1;
export const BOX_GEOMETRY_ID = 2;

const TRIANGLE: Geometry = Object.freeze({ id: TRIANGLE_GEOMETRY_ID, kind: "triangle" });
const BOX: Geometry = Object.freeze({ id: BOX_GEOMETRY_ID, kind: "box" });

/** Immutable built-in geometry descriptor; GPU data is owned by the worker. */
export function triangleGeometry(): Geometry {
  return TRIANGLE;
}

/** Reserved Phase 1 descriptor for the indexed-cube rendering milestone. */
export function boxGeometry(): Geometry {
  return BOX;
}
