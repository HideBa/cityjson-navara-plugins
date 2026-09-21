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
 */
export type LodSelection = string | readonly string[] | null;

/** A non-null selection as the set of LoDs it allows. A string is the
 *  one-element set: its per-object winner is that LoD or nothing. */
export function allowedLodSet(lod: string | readonly string[]): ReadonlySet<string> {
  return new Set(typeof lod === "string" ? [lod] : lod);
}

/** The one LoD a non-null selection draws of `surfaces`: the numerically
 *  highest surface LoD in `allowed`, or `null` when none is. Unlabelled
 *  surfaces never win. */
export function selectedSurfaceLod(
  surfaces: ReadonlyArray<Surface>,
  allowed: ReadonlySet<string>,
): string | null {
  let winner: string | null = null;
  for (const surface of surfaces) {
    if (
      surface.lod !== null &&
      allowed.has(surface.lod) &&
      (winner === null || Number(surface.lod) > Number(winner))
    ) {
      winner = surface.lod;
    }
  }
  return winner;
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
