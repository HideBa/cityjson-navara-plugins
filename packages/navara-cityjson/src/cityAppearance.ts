/**
 * What a city layer LOOKS like, as a host-supplied parameter.
 *
 * Three colours the plugins used to hard-code — the selection highlight, the
 * hover tint and the semantic surface palette — now arrive through
 * `CityJSONPluginOptions.appearance` / `FlatCityBufPluginOptions.appearance`
 * (a per-plugin default) and `AddCityModelOptions.appearance` /
 * `OpenStreamOptions.appearance` (a per-layer override), so a host's brand
 * never has to be edited into this package. Omitting everything keeps the
 * historical values, so no consumer changes by upgrading.
 *
 * Resolved ONCE per layer into linear-sRGB (the vertex colour space) and hex
 * (for a host's UI); the static mesh and the streaming handle both paint from
 * the resolved form, and the worker receives only the hex palette, which is
 * structured-cloneable.
 *
 * Engine-free: no `@navaramap/*`, no three.
 */
import {
  resolveSurfaceColorHex,
  resolveSurfaceColorsLinear,
  srgbHexToLinear,
  type BuildingSurfaceType,
  type LinearRGB,
  type RGB,
  type SurfacePalette,
} from "@cityjson/navara-core";

export interface CityAppearance {
  /** A selected object or surface, CSS hex. */
  readonly highlightColor?: string;
  /** A hovered object or surface, CSS hex. Selection wins where both apply. */
  readonly hoverColor?: string;
  /** Overrides for the semantic surface palette (roof, wall, …). */
  readonly surfaceColors?: SurfacePalette;
}

/** The values the plugins shipped with before appearance became a parameter. */
export const DEFAULT_CITY_APPEARANCE: Required<
  Pick<CityAppearance, "highlightColor" | "hoverColor">
> &
  CityAppearance = {
  highlightColor: "#e8973f",
  hoverColor: "#fbbf24",
};

/** The two paint colours, in the vertex colour space. */
export interface HighlightRGB {
  readonly highlight: RGB;
  readonly hover: RGB;
}

export interface ResolvedCityAppearance extends HighlightRGB {
  readonly highlightColor: string;
  readonly hoverColor: string;
  /** Full palette, CSS hex — what a legend or inspector dot should show. */
  readonly surfaceColors: Record<BuildingSurfaceType, string>;
  /** Full palette, linear — what `buildCityMeshArrays` bakes. */
  readonly surfaceColorsLinear: Record<BuildingSurfaceType, LinearRGB>;
  /** The overrides exactly as given, for forwarding to a worker. */
  readonly surfacePalette: SurfacePalette | undefined;
}

/**
 * Lay each override over the defaults, later arguments winning — the plugin's
 * appearance first, then the layer's. `undefined` entries are skipped, so a
 * caller can pass options straight through without guarding.
 */
export function resolveCityAppearance(
  ...overrides: ReadonlyArray<CityAppearance | undefined>
): ResolvedCityAppearance {
  let highlightColor = DEFAULT_CITY_APPEARANCE.highlightColor;
  let hoverColor = DEFAULT_CITY_APPEARANCE.hoverColor;
  let surfacePalette: SurfacePalette | undefined;
  for (const o of overrides) {
    if (!o) continue;
    if (o.highlightColor !== undefined) highlightColor = o.highlightColor;
    if (o.hoverColor !== undefined) hoverColor = o.hoverColor;
    if (o.surfaceColors !== undefined) {
      surfacePalette = { ...surfacePalette, ...o.surfaceColors };
    }
  }
  return {
    highlightColor,
    hoverColor,
    highlight: srgbHexToLinear(highlightColor),
    hover: srgbHexToLinear(hoverColor),
    surfaceColors: resolveSurfaceColorHex(surfacePalette),
    surfaceColorsLinear: resolveSurfaceColorsLinear(surfacePalette),
    surfacePalette,
  };
}
