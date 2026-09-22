/**
 * Which LoD each CityObject draws under a static layer's LoD selection, and
 * whether two selections draw the same geometry.
 *
 * `buildCityMeshArrays` and `sameLodGeometry` share {@link selectedSurfaceLod},
 * so "skip the rebuild" can never drift from what a rebuild would draw.
 */

import type { CityModel, Surface } from "../citymodel/types";

/**
 * A static layer's LoD selection:
 *  - `null` draws every surface, unlabelled ones included;
 *  - a string draws exactly that LoD;
 *  - an array draws, per object, the highest selected LoD that object has
 *    (never two LoDs of one object); an empty array draws nothing.
 *
 * `null` AS AN ELEMENT of the array is the **unlabelled rung**: the surfaces
 * of a source that names no LoD at all (a CityParquet `geometry` column, a
 * CityJSON geometry without `lod`). It ranks BELOW every label, so an object
 * draws its unlabelled surfaces only when none of its labelled ones is
 * selected. Without it such an object is silently invisible under any array
 * selection, which is how a streamed legacy CityParquet table came to report
 * loaded objects and draw nothing (Codex milestone review, Important).
 */
export type LodSelection = string | readonly (string | null)[] | null;

/** A non-null selection as the set of rungs it allows (`null` = unlabelled).
 *  A string is the one-element set: its per-object winner is that LoD or
 *  nothing. */
export function allowedLodSet(
  lod: string | readonly (string | null)[],
): ReadonlySet<string | null> {
  return new Set(typeof lod === "string" ? [lod] : lod);
}

/** The one rung a non-null selection draws of `surfaces`: the numerically
 *  highest surface LoD in `allowed`; `null` when only the unlabelled rung is
 *  allowed and present; `undefined` when the selection draws nothing of these
 *  surfaces at all. The tri-state is what lets `null` mean a real rung rather
 *  than "no match". */
export function selectedSurfaceLod(
  surfaces: ReadonlyArray<Surface>,
  allowed: ReadonlySet<string | null>,
): string | null | undefined {
  let winner: string | undefined;
  let unlabelled = false;
  for (const surface of surfaces) {
    if (surface.lod === null) {
      if (allowed.has(null)) unlabelled = true;
      continue;
    }
    if (
      allowed.has(surface.lod) &&
      (winner === undefined || Number(surface.lod) > Number(winner))
    ) {
      winner = surface.lod;
    }
  }
  if (winner !== undefined) return winner;
  return unlabelled ? null : undefined;
}

/**
 * Whether `a` and `b` draw the same surfaces of every object in `model`, so a
 * mesh built under one is exactly the mesh the other would build.
 *
 * Conservative where that is cheaper: `null` equals only `null` (it also draws
 * unlabelled surfaces), and hidden or filtered objects are compared too. Equal
 * sets answer without visiting objects; otherwise one pass over the surfaces'
 * LoD labels — no triangulation, no geometry copied.
 */
export function sameLodGeometry(
  model: CityModel,
  a: LodSelection,
  b: LodSelection,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const allowedA = allowedLodSet(a);
  const allowedB = allowedLodSet(b);
  if (
    allowedA.size === allowedB.size &&
    [...allowedA].every((lod) => allowedB.has(lod))
  ) {
    return true;
  }
  for (const obj of Object.values(model.objects)) {
    if (!obj) continue;
    if (
      selectedSurfaceLod(obj.surfaces, allowedA) !==
      selectedSurfaceLod(obj.surfaces, allowedB)
    ) {
      return false;
    }
  }
  return true;
}
