/**
 * @cityjson/navara-cityjson — Navara plugin for static CityJSON / CityJSONSeq
 * layers.
 *
 * **This barrel is engine-free and Node-importable.** The three modules that
 * import `@navaramap/*` (`CityJSONPlugin`, `CityModelMeshDesc`,
 * `CityMeshArraysDesc`) are published from the separate
 * `@cityjson/navara-cityjson/plugin` entry point instead, because the engine
 * crashes at module scope under Node (`NODE_IMPORT_SAFE = false`). Nothing
 * reachable from here may import the engine — see Global Constraints ->
 * Testing conventions.
 */
import { NAVARA_CORE_VERSION } from "@cityjson/navara-core";

export const CITYJSON_PLUGIN_PLACEHOLDER = `@cityjson/navara-cityjson (core ${NAVARA_CORE_VERSION})`;

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

export type { ThemeEdgeStyle, ThemeStyle } from "./themeStyle";
export {
  DEFAULT_THEME_STYLE,
  ThemeStyleController,
  themeStylesEqual,
} from "./themeStyle";

export { disposeGeometry, geometryFromMeshArrays } from "./cityMeshGeometry";

export type {
  TextureCacheEntry,
  TextureCacheOptions,
  TextureSource,
  TextureStatus,
} from "./texturedMaterials";
export {
  applyTextureSettings,
  buildGroupMaterials,
  defaultTextureSource,
  maskReadyTextures,
  resolveTextureUrl,
  TextureCache,
} from "./texturedMaterials";

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
