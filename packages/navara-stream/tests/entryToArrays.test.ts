/**
 * Task C10a: `CellEntry` (worker wire shape) -> `CityMeshArrays` (mesh
 * primitive shape).
 *
 * The load-bearing case here is the LAST one: the returned `colors` must not
 * alias EITHER of the cache entry's colour buffers. See `entryToArrays`'s own
 * doc comment for why (the geometry wraps what it is given, and both
 * `syncCellMeshes`'s post-create `setColors` and Task C10b's highlight paint
 * write into that live buffer in place).
 */
import { describe, it, expect } from "vitest";
import { entryToArrays } from "../src/entryToArrays";
import type { CellEntry } from "../src/streamLayer";

function entry(ruleColors: Float32Array | null): CellEntry {
  return {
    geometry: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      baseColors: new Float32Array(9).fill(0.25),
      ruleColors,
      objectIndices: new Uint32Array([0, 0, 0]),
      surfaceIndices: new Uint32Array([3, 3, 3]),
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
  it("uses baseColors as `colors` when the cell has no rule colors", () => {
    const arrays = entryToArrays(entry(null));
    expect([...arrays.colors]).toEqual(new Array(9).fill(0.25));
  });

  it("prefers ruleColors over baseColors when the worker baked them", () => {
    const rule = new Float32Array(9).fill(0.5);
    const arrays = entryToArrays(entry(rule));
    expect([...arrays.colors]).toEqual(new Array(9).fill(0.5));
  });

  it("passes positions, normals, indices, keys and triangleCount through by reference", () => {
    const e = entry(null);
    const arrays = entryToArrays(e);
    expect(arrays.positions).toBe(e.geometry.positions);
    expect(arrays.normals).toBe(e.geometry.normals);
    expect(arrays.objectIndices).toBe(e.geometry.objectIndices);
    expect(arrays.surfaceIndices).toBe(e.geometry.surfaceIndices);
    expect(arrays.objectKeys).toBe(e.geometry.objectKeys);
    expect(arrays.triangleCount).toBe(1);
  });

  it("never aliases the cache entry's colour buffers, on EITHER branch: painting the returned buffer leaves the restore baselines untouched (C8 ledger)", () => {
    const noRules = entry(null);
    const plain = entryToArrays(noRules);
    expect(plain.colors).not.toBe(noRules.geometry.baseColors);
    plain.colors.fill(1);
    expect([...noRules.geometry.baseColors]).toEqual(new Array(9).fill(0.25));

    const rule = new Float32Array(9).fill(0.5);
    const withRules = entry(rule);
    const styled = entryToArrays(withRules);
    expect(styled.colors).not.toBe(rule);
    expect(styled.colors).not.toBe(withRules.geometry.baseColors);
    styled.colors.fill(1);
    expect([...rule]).toEqual(new Array(9).fill(0.5));
    expect([...withRules.geometry.baseColors]).toEqual(new Array(9).fill(0.25));
  });

  it("keeps the vertex count consistent: 3 floats per vertex, 3 vertices per triangle", () => {
    const arrays = entryToArrays(entry(null));
    expect(arrays.positions.length).toBe(arrays.triangleCount * 9);
    expect(arrays.colors.length).toBe(arrays.positions.length);
    expect(arrays.objectIndices.length).toBe(arrays.triangleCount * 3);
    expect(arrays.surfaceIndices.length).toBe(arrays.objectIndices.length);
  });
});
