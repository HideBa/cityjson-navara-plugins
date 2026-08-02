/**
 * Vertex-color layer stack: base -> style (rules) -> highlight, ported from
 * the pre-Navara `src/scene/highlightMesh.ts` and `src/scene/applyRuleColors.ts`.
 *
 * The two layers stay separate arrays on purpose, exactly as the R3F renderer
 * kept them:
 *
 * - `computeStyleColors` produces a *new* array (or null) from the immutable
 *   base colors. It is recomputed only when the layer's rules change.
 * - `paintLayers` writes into the geometry's live `color` attribute array,
 *   restoring the style layer first, so hover/selection changes cost one pass
 *   over the vertices and never accumulate.
 *
 * `computeStyleColors` is the evaluator-driven analogue of core's
 * `buildStyleColorsFromArrays` (which stays as-is for the worker/streaming
 * path): identical caching by `"objIdx:surfIdx"`, identical "return null when
 * nothing matched" contract. It differs only in resolving objects through a
 * caller-supplied `lookup` instead of a whole `CityModel`, because a streaming
 * cell holds a slice of objects rather than a model.
 *
 * Engine-free: no `@navaramap/*` imports, no Three.js types — plain typed
 * arrays in, plain typed arrays out.
 */

import {
  srgbHexToLinear,
  type CityObject,
  type RGB,
  type SurfaceStyleEvaluator,
} from "@cityjson/navara-core";
import type { Selection } from "./selection";

export const HIGHLIGHT_COLOR_HEX = "#e8973f";
export const HOVER_COLOR_HEX = "#fbbf24";

/** Linear-sRGB, matching `new Color(0xe8973f)` under three's ColorManagement. */
const HIGHLIGHT_RGB = srgbHexToLinear(HIGHLIGHT_COLOR_HEX);
const HOVER_RGB = srgbHexToLinear(HOVER_COLOR_HEX);

/**
 * Apply `evaluator` to every unique (object, surface) pair referenced by the
 * per-vertex index arrays and write the resulting Linear-sRGB triples over a
 * copy of `baseColors`.
 *
 * Returns null when the evaluator matched nothing, so the caller can keep
 * rendering `baseColors` without holding a second identical array.
 */
export function computeStyleColors(
  evaluator: SurfaceStyleEvaluator,
  objectIndices: Uint32Array,
  surfaceIndices: Uint32Array,
  objectKeys: readonly string[],
  lookup: (objectId: string) => CityObject | undefined,
  baseColors: Float32Array,
): Float32Array | null {
  const result = Float32Array.from(baseColors);
  // "objIdx:surfIdx" -> resolved color, or null (no style). `undefined` means
  // "not evaluated yet", which is why the map value type includes null.
  const cache = new Map<string, RGB | null>();
  let anyChange = false;

  for (let v = 0; v < objectIndices.length; v++) {
    const objIdx = objectIndices[v]!;
    const surfIdx = surfaceIndices[v]!;
    const key = `${objIdx}:${surfIdx}`;

    let rgb = cache.get(key);
    if (rgb === undefined) {
      rgb = null;
      const objectId = objectKeys[objIdx];
      const object = objectId === undefined ? undefined : lookup(objectId);
      const surface = object?.surfaces[surfIdx];
      if (object && objectId !== undefined && surface) {
        // The evaluator already returns Linear-sRGB; no conversion needed.
        rgb = evaluator(
          { surfaceIndex: surfIdx, surface },
          { objectId, object },
        );
      }
      cache.set(key, rgb);
    }

    if (rgb) {
      const base = v * 3;
      result[base] = rgb[0];
      result[base + 1] = rgb[1];
      result[base + 2] = rgb[2];
      anyChange = true;
    }
  }

  return anyChange ? result : null;
}

/** An object-level selection covers every surface; a surface-level one, exactly one. */
function matchesSurface(
  selection: Selection | null,
  surfaceIdx: number,
): boolean {
  if (!selection) return false;
  if (selection.kind === "object") return true;
  return selection.surfaceIndex === surfaceIdx;
}

/**
 * Restore `source` (the style layer, or the base colors when no style is
 * active) into `target`, then paint hover and selection over it. Selection
 * wins over hover on a vertex both cover.
 *
 * `target` is the geometry's live color array; the caller flips
 * `needsUpdate` afterwards.
 *
 * `Selection.layerId` is NOT checked here — vertices carry no layer id, so
 * the caller must pass only the selections belonging to this mesh's layer
 * (as the pre-Navara `reapplyHighlight` did). Passing an empty selection list
 * and a null hover is the supported "clear" call: it restores `source` and
 * returns without walking the vertices, subsuming the old `clearHighlight`.
 */
export function paintLayers(
  target: Float32Array,
  source: Float32Array,
  objectIndices: Uint32Array,
  surfaceIndices: Uint32Array,
  objectKeys: readonly string[],
  selections: readonly Selection[],
  hovered: Selection | null,
): void {
  target.set(source);

  // Resolve selections to object indices once, rather than per vertex. A
  // second selection on the same object overwrites the first — matching the
  // pre-Navara behaviour, where the store never holds two selections for one
  // object anyway.
  const selectedByIdx = new Map<number, Selection>();
  for (const sel of selections) {
    const idx = objectKeys.indexOf(sel.objectId);
    if (idx >= 0) selectedByIdx.set(idx, sel);
  }
  const hoveredIdx = hovered ? objectKeys.indexOf(hovered.objectId) : -1;

  // Nothing to paint: the restore above is the whole job.
  if (selectedByIdx.size === 0 && hoveredIdx < 0) return;

  for (let v = 0; v < objectIndices.length; v++) {
    const oIdx = objectIndices[v]!;
    const sIdx = surfaceIndices[v]!;
    const base = v * 3;

    // Hover first (lower priority), then selection overrides it.
    if (
      hoveredIdx >= 0 &&
      oIdx === hoveredIdx &&
      matchesSurface(hovered, sIdx)
    ) {
      target[base] = HOVER_RGB[0];
      target[base + 1] = HOVER_RGB[1];
      target[base + 2] = HOVER_RGB[2];
    }

    const sel = selectedByIdx.get(oIdx);
    if (sel && matchesSurface(sel, sIdx)) {
      target[base] = HIGHLIGHT_RGB[0];
      target[base + 1] = HIGHLIGHT_RGB[1];
      target[base + 2] = HIGHLIGHT_RGB[2];
    }
  }
}
