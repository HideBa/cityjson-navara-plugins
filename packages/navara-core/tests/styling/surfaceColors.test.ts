import { describe, it, expect } from "vitest";
import { Color } from "three";
import {
  SURFACE_COLOR_VALUES,
  SURFACE_COLOR_HEX,
  SURFACE_COLORS_LINEAR,
} from "../../src/styling/surfaceColors";

// The renderer previously derived vertex colors from `new Color(hex)`, whose
// r/g/b are Linear-sRGB (ColorManagement is on by default in three). The
// linear table below must reproduce those numbers exactly, or every mesh
// silently shifts color the moment the geometry builder stops using three.
describe("SURFACE_COLORS_LINEAR parity with three.Color", () => {
  for (const [type, hex] of Object.entries(SURFACE_COLOR_VALUES)) {
    it(`matches new Color(0x${hex.toString(16)}) for ${type}`, () => {
      const expected = new Color(hex);
      const actual =
        SURFACE_COLORS_LINEAR[type as keyof typeof SURFACE_COLORS_LINEAR];
      expect(actual.r).toBeCloseTo(expected.r, 6);
      expect(actual.g).toBeCloseTo(expected.g, 6);
      expect(actual.b).toBeCloseTo(expected.b, 6);
    });
  }
});

describe("SURFACE_COLOR_HEX", () => {
  it("renders every value as a 6-digit CSS hex string", () => {
    for (const [type, hex] of Object.entries(SURFACE_COLOR_HEX)) {
      expect(hex, type).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps RoofSurface at #cc4444", () => {
    expect(SURFACE_COLOR_HEX.RoofSurface).toBe("#cc4444");
  });

  it("covers exactly the keys of SURFACE_COLOR_VALUES", () => {
    expect(Object.keys(SURFACE_COLOR_HEX).sort()).toEqual(
      Object.keys(SURFACE_COLOR_VALUES).sort(),
    );
    expect(Object.keys(SURFACE_COLORS_LINEAR).sort()).toEqual(
      Object.keys(SURFACE_COLOR_VALUES).sort(),
    );
  });
});
