/**
 * Footprint area from an object's GroundSurface rings.
 *
 * Lives in core (not next to `computeTotalRoofArea`/`computeVolume`, which
 * stay in the app's `domain/geometry/derived.ts`) because
 * `@cityjson/navara-flatcitybuf`'s `objectRecords.ts` needs it inside the FCB
 * worker, where the app is not importable.
 */
import type { CityObject } from "../citymodel/types";
import { computeArea } from "./metrics";

/**
 * Compute the footprint area from GroundSurface rings.
 * Returns null if no GroundSurface exists.
 */
export function computeFootprintArea(obj: CityObject): number | null {
  const groundSurfaces = obj.surfaces.filter((s) => s.type === "GroundSurface");
  if (groundSurfaces.length === 0) return null;
  return groundSurfaces.reduce(
    (sum, s) => sum + computeArea(s.rings[0] ?? []),
    0,
  );
}
