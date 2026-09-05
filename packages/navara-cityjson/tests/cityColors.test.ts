import { describe, expect, it } from "vitest";
import {
  SURFACE_COLOR_HEX,
  SURFACE_COLORS_LINEAR,
  srgbHexToLinear,
} from "@cityjson/navara-core";
import {
  DEFAULT_CITY_COLORS,
  resolveCityColors,
} from "../src/cityColors";
import { HIGHLIGHT_COLOR_HEX, HOVER_COLOR_HEX } from "../src/surfaceColorLayers";

describe("resolveCityColors", () => {
  it("with nothing given, is exactly the historical colours", () => {
    const a = resolveCityColors();
    expect(a.highlightColor).toBe(HIGHLIGHT_COLOR_HEX);
    expect(a.hoverColor).toBe(HOVER_COLOR_HEX);
    expect(a.highlight).toEqual(srgbHexToLinear(DEFAULT_CITY_COLORS.highlightColor));
    expect(a.surfaceColors).toEqual(SURFACE_COLOR_HEX);
    // The very same object, not an equal copy: no per-layer allocation for
    // the common case.
    expect(a.surfaceColorsLinear).toBe(SURFACE_COLORS_LINEAR);
    expect(a.surfacePalette).toBeUndefined();
  });

  it("lays later overrides over earlier ones, skipping undefined entries", () => {
    const a = resolveCityColors(
      { highlightColor: "#111111", surfaceColors: { RoofSurface: "#ff0000" } },
      undefined,
      { hoverColor: "#222222", surfaceColors: { WallSurface: "#00ff00" } },
    );
    expect(a.highlightColor).toBe("#111111");
    expect(a.hoverColor).toBe("#222222");
    expect(a.highlight).toEqual(srgbHexToLinear("#111111"));
    expect(a.hover).toEqual(srgbHexToLinear("#222222"));
    // Both palettes merged; every other type keeps the default.
    expect(a.surfacePalette).toEqual({
      RoofSurface: "#ff0000",
      WallSurface: "#00ff00",
    });
    expect(a.surfaceColors.RoofSurface).toBe("#ff0000");
    expect(a.surfaceColors.WallSurface).toBe("#00ff00");
    expect(a.surfaceColors.GroundSurface).toBe(SURFACE_COLOR_HEX.GroundSurface);
    expect(a.surfaceColorsLinear.RoofSurface).toEqual({ r: 1, g: 0, b: 0 });
    expect(a.surfaceColorsLinear.Door).toEqual(SURFACE_COLORS_LINEAR.Door);
  });

  it("a later override of the same key wins", () => {
    const a = resolveCityColors(
      { highlightColor: "#111111" },
      { highlightColor: "#333333" },
    );
    expect(a.highlightColor).toBe("#333333");
  });
});
