import type { Geometry } from "./types.js";

/** Renderer identifier for the built-in triangle. */
export const TRIANGLE_GEOMETRY_ID = 1;
/** Renderer identifier for the indexed unit cube. */
export const BOX_GEOMETRY_ID = 2;

const TRIANGLE = { id: TRIANGLE_GEOMETRY_ID, kind: "triangle" } as const satisfies Geometry;
const BOX = { id: BOX_GEOMETRY_ID, kind: "box" } as const satisfies Geometry;

/** Built-in readonly-TypeScript geometry descriptor; GPU data is owned by the worker. */
/**
 * Returns the built-in triangle geometry descriptor.
 *
 * @example
 * engine.create.mesh({ geometry: "triangle" });
 */
export function triangleGeometry(): Geometry {
  return TRIANGLE;
}

/** Reserved Phase 1 descriptor for the indexed-cube rendering milestone. */
/**
 * Returns the built-in indexed cube geometry descriptor.
 *
 * @example
 * engine.world.add(entity, mesh(boxGeometry(), materialHandle.id));
 */
export function boxGeometry(): Geometry {
  return BOX;
}
