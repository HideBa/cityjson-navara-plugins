/**
 * @cityjson/navara-cityjson — Navara plugin for static CityJSON / CityJSONSeq
 * layers.
 *
 * NOTE: this barrel re-exports the three engine-binding modules
 * (`CityJSONPlugin`, `CityModelMeshDesc`, `CityMeshArraysDesc`), so it
 * transitively imports `@navaramap/*` and cannot be loaded under Node
 * (`NODE_IMPORT_SAFE = false`). Unit tests therefore import the specific
 * engine-free module (`../src/cityModelRegistry`, `../src/cityMesh`, ...),
 * never this file — see Global Constraints -> Testing conventions.
 */
import { NAVARA_CORE_VERSION } from "@cityjson/navara-core";

export const CITYJSON_PLUGIN_PLACEHOLDER = `@cityjson/navara-cityjson (core ${NAVARA_CORE_VERSION})`;

export { CityJSONPlugin } from "./CityJSONPlugin";
export type { CityJSONPluginOptions } from "./CityJSONPlugin";
export { CityMeshArraysDesc } from "./CityMeshArraysDesc";
export type { CityMeshArraysDescConfig } from "./CityMeshArraysDesc";
export { CityModelMeshDesc } from "./CityModelMeshDesc";
export type {
  CityModelDescConfig,
  CityModelDescOptions,
} from "./CityModelMeshDesc";

export { CITY_MESH_ARRAYS_KEY, CITY_MODEL_MESH_KEY } from "./descriptorKeys";

export { CityModelRegistry } from "./cityModelRegistry";
export type {
  CityModelRegistryDeps,
  CityModelViewLike,
  PickRayProvider,
} from "./cityModelRegistry";

export { addCityMeshArrays, CityMeshArraysMesh } from "./cityMesh";
export type {
  AddCityMeshArraysOptions,
  CityMeshArraysViewLike,
  CityMeshHandle,
} from "./cityMesh";

export type { AddCityModelOptions, CityModelHandle } from "./types";

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
