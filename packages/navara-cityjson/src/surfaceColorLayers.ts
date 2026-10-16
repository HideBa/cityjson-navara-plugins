/**
 * The two layers a city mesh's surfaces are coloured by: the STYLE (rules) as
 * per-slot colours, and the HIGHLIGHT (hover, selection) as per-slot flags.
 *
 * - `computeStyleColors` produces a *new* per-slot array (or null) from the
 *   immutable base colours. It is recomputed only when the layer's rules
 *   change, and becomes the style texture's RGB.
 * - `paintSlotFlags` sets the selected and hovered bits in the style
 *   texture's alpha, so a hover costs one pass over the slots and an upload
 *   of four bytes per surface, and never touches a colour.
 *
 * `computeStyleColors` is the evaluator-driven analogue of core's
 * `buildSlotStyleColors` (which the worker uses): one evaluation per slot,
 * the same "return null when nothing matched" contract. It differs only in
 * resolving objects through a caller-supplied `lookup` instead of a whole
 * `CityModel`, because a streaming cell holds a slice of objects rather than
 * a model.
 *
 * Engine-free: no `@navaramap/*` imports; the flags go through the
 * `SlotFlagWriter` seam that `CityStyleTexture` satisfies.
 */

import {
  inheritedAttributes,
  srgbHexToLinear,
  type CityObject,
  type SurfaceStyleEvaluator,
} from "@cityjson/navara-core";
import type { Selection } from "./selection";
import { DEFAULT_CITY_COLORS, type HighlightRGB } from "./cityColors";
import { SLOT_HOVERED, SLOT_SELECTED } from "./slotFlags";

/** The historical defaults, kept as named exports for hosts and tests that
 *  read them; a host that wants its own passes `CityColors` instead. */
export const HIGHLIGHT_COLOR_HEX = DEFAULT_CITY_COLORS.highlightColor;
export const HOVER_COLOR_HEX = DEFAULT_CITY_COLORS.hoverColor;

/** Linear-sRGB, matching `new Color(hex)` under three's ColorManagement. */
export const DEFAULT_HIGHLIGHT_RGB: HighlightRGB = {
  highlight: srgbHexToLinear(HIGHLIGHT_COLOR_HEX),
  hover: srgbHexToLinear(HOVER_COLOR_HEX),
};

/**
 * Apply `evaluator` to every slot (one drawn surface each) and write the
 * resulting Linear-sRGB triples over a copy of `slotColors`.
 *
 * Returns null when the evaluator matched nothing, so the caller can keep
 * the base colours without holding a second identical array.
 */
export function computeStyleColors(
  evaluator: SurfaceStyleEvaluator,
  slotObjects: Uint32Array,
  slotSurfaces: Uint32Array,
  objectKeys: readonly string[],
  lookup: (objectId: string) => CityObject | undefined,
  slotColors: Float32Array,
): Float32Array | null {
  const result = Float32Array.from(slotColors);
  const attributeCache = new Map<number, Readonly<Record<string, unknown>>>();
  let anyChange = false;

  for (let slot = 0; slot < slotObjects.length; slot++) {
    const objIdx = slotObjects[slot]!;
    const surfIdx = slotSurfaces[slot]!;
    const objectId = objectKeys[objIdx];
    const object = objectId === undefined ? undefined : lookup(objectId);
    const surface = object?.surfaces[surfIdx];
    if (!object || objectId === undefined || !surface) continue;
    let attributes = attributeCache.get(objIdx);
    if (!attributes) {
      attributes = inheritedAttributes(object, lookup);
      attributeCache.set(objIdx, attributes);
    }
    // The evaluator already returns Linear-sRGB; no conversion needed.
    const rgb = evaluator(
      { surfaceIndex: surfIdx, surface },
      { objectId, object, attributes },
    );
    if (!rgb) continue;
    const base = slot * 3;
    result[base] = rgb[0];
    result[base + 1] = rgb[1];
    result[base + 2] = rgb[2];
    anyChange = true;
  }

  return anyChange ? result : null;
}

/** Where `paintSlotFlags` writes: `CityStyleTexture` in a mesh, a recorder
 *  in a test. */
export interface SlotFlagWriter {
  flags(slot: number): number;
  setFlags(slot: number, flags: number): void;
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
 * Set `SLOT_SELECTED` on every slot a selection covers and `SLOT_HOVERED` on
 * every slot the hover covers, and clear both everywhere else. The shader
 * draws selection over hover where both apply.
 *
 * `Selection.layerId` is NOT checked here — slots carry no layer id, so the
 * caller must pass only the selections belonging to this mesh's layer.
 * Passing an empty selection list and a null hover is the "clear" call.
 */
export function paintSlotFlags(
  target: SlotFlagWriter,
  slotObjects: Uint32Array,
  slotSurfaces: Uint32Array,
  objectKeys: readonly string[],
  selections: readonly Selection[],
  hovered: Selection | null,
): void {
  // Resolve selections to object indices once, rather than per slot.
  // Surface selections are keyed by (object, surface), NOT by object alone:
  // the store can and does hold two surfaces of one building (shift-click a
  // roof then a wall), and an object-keyed map made the second evict the
  // first, so only the last-painted face highlighted.
  const wholeObjects = new Set<number>();
  const selectedSurfaces = new Map<number, Set<number>>();
  for (const sel of selections) {
    const idx = objectKeys.indexOf(sel.objectId);
    if (idx < 0) continue;
    if (sel.kind === "object") {
      wholeObjects.add(idx);
      continue;
    }
    const surfaces = selectedSurfaces.get(idx);
    if (surfaces) surfaces.add(sel.surfaceIndex);
    else selectedSurfaces.set(idx, new Set([sel.surfaceIndex]));
  }
  const hoveredIdx = hovered ? objectKeys.indexOf(hovered.objectId) : -1;
  const both = SLOT_SELECTED | SLOT_HOVERED;

  for (let slot = 0; slot < slotObjects.length; slot++) {
    const oIdx = slotObjects[slot]!;
    const sIdx = slotSurfaces[slot]!;
    let flags = target.flags(slot) & ~both;
    if (oIdx === hoveredIdx && matchesSurface(hovered, sIdx)) {
      flags |= SLOT_HOVERED;
    }
    if (wholeObjects.has(oIdx) || selectedSurfaces.get(oIdx)?.has(sIdx)) {
      flags |= SLOT_SELECTED;
    }
    target.setFlags(slot, flags);
  }
}
