import { describe, it, expect } from "vitest";
import { computeFootprintArea } from "../../src/roofMetrics/footprint";
import type { CityObject, Surface } from "../../src/citymodel/types";

function surface(type: Surface["type"], size: number): Surface {
  return {
    type,
    rings: [
      [
        [0, 0, 0],
        [size, 0, 0],
        [size, size, 0],
        [0, size, 0],
      ],
    ],
    attributes: {},
    lod: "2",
  };
}

function object(surfaces: Surface[]): CityObject {
  return {
    id: "b1",
    objectType: "Building",
    attributes: {},
    surfaces,
    bbox: null,
    children: [],
    parents: [],
    lod: "2",
  };
}

describe("computeFootprintArea", () => {
  it("returns null when the object has no GroundSurface", () => {
    expect(
      computeFootprintArea(object([surface("RoofSurface", 4)])),
    ).toBeNull();
  });

  it("sums the exterior-ring areas of every GroundSurface", () => {
    const area = computeFootprintArea(
      object([
        surface("GroundSurface", 4),
        surface("RoofSurface", 10),
        surface("GroundSurface", 2),
      ]),
    );
    expect(area).toBeCloseTo(16 + 4, 9);
  });

  it("ignores a degenerate GroundSurface ring instead of throwing", () => {
    const degenerate: Surface = {
      type: "GroundSurface",
      rings: [],
      attributes: {},
      lod: "2",
    };
    expect(computeFootprintArea(object([degenerate]))).toBe(0);
  });
});
