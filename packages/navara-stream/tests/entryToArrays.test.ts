/**
 * Task C10a: `CellEntry` (worker wire shape) -> `CityMeshArrays` (mesh
 * primitive shape). Everything passes through by reference: nothing
 * downstream writes into a cell's arrays, because colours, highlight and the
 * image mask live in the mesh's style texture.
 */
import { describe, it, expect } from "vitest";
import { entryToArrays } from "../src/entryToArrays";
import type { CellEntry } from "../src/streamLayer";

function entry(ruleColors: Float32Array | null): CellEntry {
  return {
    geometry: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      slots: new Uint32Array([0, 0, 0]),
      slotObjects: new Uint32Array([0]),
      slotSurfaces: new Uint32Array([3]),
      slotTextures: new Int32Array([-1]),
      baseColors: new Float32Array(3).fill(0.25),
      ruleColors,
      objectKeys: ["B1"],
      triangleCount: 1,
    },
    objects: [],
    surfaceAttrKeys: [],
    lodsSeen: [],
    builtWithRulesEnabled: false,
    builtWithRules: [],
  };
}

describe("entryToArrays", () => {
  it("hands the base colours over as the slots' colours, rules or not", () => {
    // `syncCellMeshes` writes the rule colours over them after creation.
    const e = entry(new Float32Array(3).fill(0.5));
    expect(entryToArrays(e).slotColors).toBe(e.geometry.baseColors);
  });

  it("passes geometry, slot tables, keys and triangleCount through by reference", () => {
    const e = entry(null);
    const arrays = entryToArrays(e);
    expect(arrays.positions).toBe(e.geometry.positions);
    expect(arrays.normals).toBe(e.geometry.normals);
    expect(arrays.slots).toBe(e.geometry.slots);
    expect(arrays.slotObjects).toBe(e.geometry.slotObjects);
    expect(arrays.slotSurfaces).toBe(e.geometry.slotSurfaces);
    expect(arrays.slotTextures).toBe(e.geometry.slotTextures);
    expect(arrays.objectKeys).toBe(e.geometry.objectKeys);
    expect(arrays.triangleCount).toBe(1);
  });
});
