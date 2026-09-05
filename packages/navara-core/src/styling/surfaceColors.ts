/**
 * Single source of truth for surface type → color mapping.
 *
 * Raw hex values live here. CSS hex strings (UI layer) and Linear-sRGB
 * triples (vertex colors) are both derived from this map, so the renderer
 * never needs a `three.Color` just to look up a semantic color.
 */

import type { BuildingSurfaceType } from "../citymodel/types";
import { srgbHexToLinear } from "./srgb";

export const SURFACE_COLOR_VALUES: Record<BuildingSurfaceType, number> = {
  RoofSurface: 0xcc4444,
  WallSurface: 0xcccccc,
  GroundSurface: 0x886644,
  ClosureSurface: 0x999999,
  OuterCeilingSurface: 0xaaaaaa,
  OuterFloorSurface: 0x998877,
  Window: 0x6699cc,
  Door: 0x996633,
  unknown: 0x888888,
};

/** CSS hex string for use in UI (inspector dots, legends). */
export const SURFACE_COLOR_HEX: Record<BuildingSurfaceType, string> =
  Object.fromEntries(
    Object.entries(SURFACE_COLOR_VALUES).map(([k, v]) => [
      k,
      "#" + v.toString(16).padStart(6, "0"),
    ]),
  ) as Record<BuildingSurfaceType, string>;

/** A color in the Linear-sRGB working space, channels in [0, 1]. */
export interface LinearRGB {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Linear-sRGB vertex colors, byte-for-byte equivalent to what
 * `new three.Color(hex).r/g/b` produced before the geometry builder dropped
 * its `three.Color` dependency (parity locked by surfaceColors.test.ts).
 */
export const SURFACE_COLORS_LINEAR: Record<BuildingSurfaceType, LinearRGB> =
  Object.fromEntries(
    Object.entries(SURFACE_COLOR_HEX).map(([k, hex]) => {
      const [r, g, b] = srgbHexToLinear(hex);
      return [k, { r, g, b }];
    }),
  ) as Record<BuildingSurfaceType, LinearRGB>;

/**
 * A host's overrides for the semantic palette above, as CSS hex — the shape a
 * brand hands over and the shape that survives `postMessage` to the worker.
 * Missing types keep the defaults, so a host that only wants its own roof
 * colour names one key.
 */
export type SurfacePalette = Readonly<
  Partial<Record<BuildingSurfaceType, string>>
>;

/** Defaults with `palette` laid over them, as CSS hex (UI dots, legends). */
export function resolveSurfaceColorHex(
  palette?: SurfacePalette,
): Record<BuildingSurfaceType, string> {
  const out = { ...SURFACE_COLOR_HEX };
  if (palette) {
    for (const [type, hex] of Object.entries(palette)) {
      if (typeof hex === "string") out[type as BuildingSurfaceType] = hex;
    }
  }
  return out;
}

/**
 * The same, as the Linear-sRGB triples `buildCityMeshArrays` bakes into vertex
 * colours. Resolved ONCE per layer (or per worker open), never per vertex.
 */
export function resolveSurfaceColorsLinear(
  palette?: SurfacePalette,
): Record<BuildingSurfaceType, LinearRGB> {
  if (!palette) return SURFACE_COLORS_LINEAR;
  return Object.fromEntries(
    Object.entries(resolveSurfaceColorHex(palette)).map(([k, hex]) => {
      const [r, g, b] = srgbHexToLinear(hex);
      return [k, { r, g, b }];
    }),
  ) as Record<BuildingSurfaceType, LinearRGB>;
}
