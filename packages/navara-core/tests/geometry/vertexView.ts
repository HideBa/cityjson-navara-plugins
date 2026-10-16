/**
 * Per-vertex views of a build's slot tables, for tests written against what
 * a vertex shows: its object, its surface and its base colour.
 */
import type { CityMeshArrays } from "../../src/geometry/buildCityMeshArrays";

export function vertexObjectIndices(a: CityMeshArrays): Uint32Array {
  return a.slots.map((slot) => a.slotObjects[slot]!);
}

export function vertexSurfaceIndices(a: CityMeshArrays): Uint32Array {
  return a.slots.map((slot) => a.slotSurfaces[slot]!);
}

export function vertexColors(a: CityMeshArrays): Float32Array {
  const out = new Float32Array(a.slots.length * 3);
  a.slots.forEach((slot, v) => {
    out.set(a.slotColors.subarray(slot * 3, slot * 3 + 3), v * 3);
  });
  return out;
}

/** The build's triangles as a soup, 9 floats per triangle, for tests that
 *  measure triangles rather than vertices. */
export function soupPositions(a: CityMeshArrays): Float32Array {
  const out = new Float32Array(a.indices.length * 3);
  a.indices.forEach((v, i) => {
    out.set(a.positions.subarray(v * 3, v * 3 + 3), i * 3);
  });
  return out;
}
