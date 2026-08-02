/**
 * Per-surface vertex recoloring driven by a host-supplied styling hook.
 *
 * The host (an app's rule engine, a thematic map, a legend) supplies a
 * `SurfaceStyleEvaluator`; this module walks the per-vertex object/surface
 * index arrays emitted by `buildCityMeshArrays`, resolves each vertex to its
 * `CityObject` + `Surface`, and writes the evaluator's Linear-sRGB color over
 * a copy of the base colors. The evaluator is called once per unique
 * (object, surface) pair, not once per vertex.
 *
 * Worker-safe: consumes plain typed arrays, no GPU/DOM types.
 *
 * Generalized from multiroof-viewer's `buildRuleColorsFromArrays`
 * (src/scene/applyRuleColors.ts), which hardcoded the rule engine; the
 * rule-specific parts (roof metrics, `matchRule`, RoofSurface gating) are
 * supplied by the caller through the evaluator — for static layers the app
 * compiles them (`compileRuleEvaluator`), for streaming layers the FCB
 * worker does.
 */

import type { CityModel, CityObject, Surface } from "../citymodel/types";
import type { RGB } from "./srgb";

export interface SurfaceInfo {
  /** Index of the surface within `object.surfaces`. */
  readonly surfaceIndex: number;
  readonly surface: Surface;
}

export interface CityObjectInfo {
  /** ID of the city object the surface belongs to. */
  readonly objectId: string;
  readonly object: CityObject;
}

/**
 * Returns the Linear-sRGB color for a surface, or null to leave the surface
 * at its base (semantic) color.
 *
 * Both arguments carry their own identity (`surfaceIndex`, `objectId`), so no
 * third context argument is needed — this is the shape every consumer in this
 * plan uses (plugin `computeStyleColors`, app `compileRuleEvaluator`).
 */
export type SurfaceStyleEvaluator = (
  surface: SurfaceInfo,
  object: CityObjectInfo,
) => RGB | null;

export function buildStyleColorsFromArrays(
  model: CityModel,
  objectIndices: Uint32Array,
  surfaceIndices: Uint32Array,
  objectKeys: ReadonlyArray<string>,
  evaluate: SurfaceStyleEvaluator,
  baseColors: Float32Array,
): Float32Array | null {
  const result = Float32Array.from(baseColors);
  let anyChange = false;

  // Cache: "objIdx:surfIdx" → resolved color, or null (no style)
  const colorCache = new Map<string, RGB | null>();

  for (let v = 0; v < objectIndices.length; v++) {
    const objIdx = objectIndices[v]!;
    const surfIdx = surfaceIndices[v]!;
    const cacheKey = `${objIdx}:${surfIdx}`;

    let styleColor = colorCache.get(cacheKey);
    if (styleColor === undefined) {
      styleColor = resolveStyleColor(
        objIdx,
        surfIdx,
        model,
        objectKeys,
        evaluate,
      );
      colorCache.set(cacheKey, styleColor);
    }

    if (styleColor) {
      const base = v * 3;
      result[base] = styleColor[0];
      result[base + 1] = styleColor[1];
      result[base + 2] = styleColor[2];
      anyChange = true;
    }
  }

  return anyChange ? result : null;
}

function resolveStyleColor(
  objIdx: number,
  surfIdx: number,
  model: CityModel,
  objectKeys: ReadonlyArray<string>,
  evaluate: SurfaceStyleEvaluator,
): RGB | null {
  const objectId = objectKeys[objIdx];
  if (!objectId) return null;

  const object = model.objects[objectId];
  if (!object) return null;

  const surface = object.surfaces[surfIdx];
  if (!surface) return null;

  return evaluate({ surfaceIndex: surfIdx, surface }, { objectId, object });
}
