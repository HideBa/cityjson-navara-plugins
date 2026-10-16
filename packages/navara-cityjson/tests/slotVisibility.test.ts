import { describe, expect, it } from "vitest";
import { hiddenObjectMask } from "../src/slotVisibility";

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
});
