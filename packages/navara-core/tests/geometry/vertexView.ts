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
