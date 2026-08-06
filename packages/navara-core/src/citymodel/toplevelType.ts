/**
 * The CityJSON second-level -> first-level object-type fold.
 *
 * CityJSON splits a construction across two levels: the first-level object
 * (`Building`) carries the semantics, its second-level children
 * (`BuildingPart`, `BuildingInstallation`, ...) carry the geometry. Any
 * per-type filter that reads `objectType` verbatim therefore hides nothing on
 * real data — measured on the Delft sample, all 66 Buildings are geometry-free
 * and all 66 BuildingParts are attribute-free.
 *
 * A static NAME MAP, not a parent walk: the second-level vocabulary is closed
 * by the spec (Building x7, Bridge x5, Tunnel x5), and a walk would need the
 * parent object to be present — which it is not, cell by cell, on the
 * streaming path. Keep this table in step with `CityJSONObjectType`
 * (./cityjson/types.ts).
 */

/** Second-level type name -> its first-level parent. */
export const TOPLEVEL_BY_SECOND_LEVEL: Readonly<Record<string, string>> = {
  BuildingPart: "Building",
  BuildingInstallation: "Building",
  BuildingConstructiveElement: "Building",
  BuildingFurniture: "Building",
  BuildingStorey: "Building",
  BuildingRoom: "Building",
  BuildingUnit: "Building",
  BridgePart: "Bridge",
  BridgeInstallation: "Bridge",
  BridgeConstructiveElement: "Bridge",
  BridgeRoom: "Bridge",
  BridgeFurniture: "Bridge",
  TunnelPart: "Tunnel",
  TunnelInstallation: "Tunnel",
  TunnelConstructiveElement: "Tunnel",
  TunnelHollowSpace: "Tunnel",
  TunnelFurniture: "Tunnel",
};

/**
 * The first-level group `objectType` belongs to.
 *
 * Identity for a first-level type, for a `+Extension` type (an extension may
 * declare a parentage the schema cannot know, so folding one would be a guess)
 * and for anything unrecognised — an unknown type is its own group rather than
 * silently merged into another.
 */
export function toplevelCityObjectType(objectType: string): string {
  return TOPLEVEL_BY_SECOND_LEVEL[objectType] ?? objectType;
}
