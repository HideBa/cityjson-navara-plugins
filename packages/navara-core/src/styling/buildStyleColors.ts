/**
 * Per-surface recoloring driven by a host-supplied styling hook.
 *
 * The host (an app's rule engine, a thematic map, a legend) supplies a
 * `SurfaceStyleEvaluator`; this module walks the slot tables emitted by
 * `buildCityMeshArrays`, resolves each slot to its `CityObject` + `Surface`,
 * and writes the evaluator's Linear-sRGB color over a copy of the slots' base
 * colors. The evaluator is called once per slot, that is once per surface.
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

import { inheritedAttributes } from "../citymodel/inheritedAttributes";
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
  /**
   * The object's attributes with its ancestors' underneath
   * (`inheritedAttributes`): what a rule reads, because a BuildingPart's
   * roofs need its Building's attributes.
   */
  readonly attributes: Readonly<Record<string, unknown>>;
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
  /** The slot's unstyled colour, Linear-sRGB, when the caller has one. */
  base?: RGB,
) => RGB | null;

/**
 * Per SLOT (`CityMeshArrays.slotObjects` / `slotSurfaces`), the evaluator's
 * colour over a copy of `slotColors`, 3 floats per slot. A slot is one drawn
 * surface, so the evaluator runs once per surface and the result is what a
 * style texture holds, never a per-vertex buffer.
 *
 * Returns null when the evaluator matched nothing, so the caller keeps the
 * base colours without holding a second identical array.
 */
export function buildSlotStyleColors(
  model: CityModel,
  slotObjects: Uint32Array,
  slotSurfaces: Uint32Array,
  objectKeys: ReadonlyArray<string>,
  evaluate: SurfaceStyleEvaluator,
  slotColors: Float32Array,
): Float32Array | null {
  const result = Float32Array.from(slotColors);
  let anyChange = false;
  const attributeCache = new Map<number, Readonly<Record<string, unknown>>>();

  for (let slot = 0; slot < slotObjects.length; slot++) {
    const styleColor = resolveStyleColor(
      slotObjects[slot]!,
      slotSurfaces[slot]!,
      model,
      objectKeys,
      evaluate,
      attributeCache,
      [
        slotColors[slot * 3]!,
        slotColors[slot * 3 + 1]!,
        slotColors[slot * 3 + 2]!,
      ],
    );
    if (styleColor) {
      const base = slot * 3;
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
  attributeCache: Map<number, Readonly<Record<string, unknown>>>,
  base: RGB,
): RGB | null {
  const objectId = objectKeys[objIdx];
  if (!objectId) return null;

  const object = model.objects[objectId];
  if (!object) return null;

  const surface = object.surfaces[surfIdx];
  if (!surface) return null;

  let attributes = attributeCache.get(objIdx);
  if (!attributes) {
    attributes = inheritedAttributes(object, (id) => model.objects[id]);
    attributeCache.set(objIdx, attributes);
  }
  return evaluate(
    { surfaceIndex: surfIdx, surface },
    { objectId, object, attributes },
    base,
  );
}
