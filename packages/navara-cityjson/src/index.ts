/**
 * @cityjson/navara-cityjson — Navara plugin for static CityJSON / CityJSONSeq
 * layers. Implemented in milestone M7.3; this entry point is a placeholder so
 * the package builds, type-checks, and can be wired into the host app early.
 */
import { NAVARA_CORE_VERSION } from "@cityjson/navara-core";

export const CITYJSON_PLUGIN_PLACEHOLDER = `@cityjson/navara-cityjson (core ${NAVARA_CORE_VERSION})`;

export { disposeGeometry, geometryFromMeshArrays } from "./cityMeshGeometry";

export type { CityModelMeshOptions } from "./cityModelMesh";
export { CityModelMesh } from "./cityModelMesh";

export type { PickStrategy } from "./pickStrategy";
export { DEFAULT_PICK_STRATEGY } from "./pickStrategy";

export type { EcefRay, RaycastHit, SurfaceRef } from "./pickTypes";

export type {
  ObjectSelection,
  PickedFeatureLike,
  PickMode,
  ScreenPoint,
  Selection,
  SurfaceSelection,
} from "./selection";

export {
  computeStyleColors,
  HIGHLIGHT_COLOR_HEX,
  HOVER_COLOR_HEX,
  paintLayers,
} from "./surfaceColorLayers";

export type { GeodeticBounds, Lle, Placement } from "./enuPlacement";
export {
  assertMetricCrs,
  buildPlacement,
  CrsUnresolvedError,
  geodeticBoundsFromBBox,
  makePlacementFrame,
  NonMetricCrsError,
  originLleFromOffset,
  placementMatrixFromFrame,
  placementMatrixFromLle,
  resolveEpsg,
  resolveMetricEpsg,
} from "./enuPlacement";
