import { describe, expect, it } from "vitest";
import { drawnTriangleCount, hiddenObjectMask } from "../src/slotVisibility";

describe("hiddenObjectMask", () => {
  const keys = ["B1", "B1-0", "T1"];
  const types = ["Building", "Building", "SolitaryVegetationObject"];

  it("hides every object of a hidden first-level type", () => {
    expect([
      ...hiddenObjectMask(keys, types, new Set(["Building"]), null),
    ]).toEqual([1, 1, 0]);
  });

  it("hides what the attribute filter does not name", () => {
    expect([
      ...hiddenObjectMask(keys, types, new Set(), new Set(["T1"])),
    ]).toEqual([1, 1, 0]);
  });

  it("hides everything for an empty filter, and nothing for none", () => {
    expect([...hiddenObjectMask(keys, types, new Set(), new Set())]).toEqual([
      1, 1, 1,
    ]);
    expect([...hiddenObjectMask(keys, types, new Set(), null)]).toEqual([
      0, 0, 0,
    ]);
  });

  it("ANDs the two: a named object of a hidden type stays hidden", () => {
    expect([
      ...hiddenObjectMask(
        keys,
        types,
        new Set(["Building"]),
        new Set(["B1", "T1"]),
      ),
    ]).toEqual([1, 1, 0]);
  });

  it("counts the triangles of the objects it does not hide", () => {
    // Two slots over four vertices: slot 0 (object 0) has two triangles,
    // slot 1 (object 1) one.
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6]);
    const slots = new Uint32Array([0, 0, 0, 0, 1, 1, 1]);
    const slotObjects = new Uint32Array([0, 1]);
    expect(
      drawnTriangleCount(indices, slots, slotObjects, new Uint8Array([0, 0])),
    ).toBe(3);
    expect(
      drawnTriangleCount(indices, slots, slotObjects, new Uint8Array([1, 0])),
    ).toBe(1);
  });
});
