/**
 * Public API of @cityjson/navara-core.
 *
 * Format-agnostic CityJSON domain code shared by every Navara CityJSON
 * plugin and by host applications: wire types, parsers, geometry building,
 * picking indices, and per-surface styling hooks. This package never imports
 * `@navaramap/*` — it is usable without the engine.
 */

/** Version of this package, asserted against package.json by tests/version.test.ts. */
export const NAVARA_CORE_VERSION = "0.0.0";

export type {
  Vec3,
  BBox3,
  UV,
  ColorRGB,
  BuildingSurfaceType,
  Surface,
  SurfaceTexture,
  CityMaterial,
  CityTexture,
  TextureWrapMode,
  CityAppearance,
  AppearanceTheme,
  CityObject,
  CityModelMetadata,
  CityModel,
} from "./citymodel/types";
export {
  TOPLEVEL_BY_SECOND_LEVEL,
  toplevelCityObjectType,
} from "./citymodel/toplevelType";
export type { CityModelEncoding } from "./citymodel/supportedEncodings";
export {
  CITYMODEL_ENCODING_PRIORITY,
  isSupportedCityModelEncoding,
  getPreferredCityModelEncoding,
} from "./citymodel/supportedEncodings";

export type {
  CityJSONRoot,
  CityJSONTransform,
  CityJSONVertex,
  CityJSONObjectType,
  CityJSONObject,
  CityJSONGeometryType,
  CityJSONGeometryBase,
  CityJSONSurfaceGeometry,
  CityJSONGeometryInstance,
  CityJSONGeometry,
  CityJSONSemanticSurfaceType,
  CityJSONSemanticSurface,
  CityJSONSemantics,
  CityJSONMetadata,
  CityJSONPointOfContact,
  CityJSONGeometryTemplates,
} from "./citymodel/cityjson/types";
export {
  IDENTITY_TRANSFORM,
  dequantizeAll,
  mergeBBox,
  parseCityObject,
  mapMetadata,
} from "./citymodel/cityjson/parseHelpers";
export { parseCityJSON } from "./citymodel/cityjson/parseCityJSON";
export type {
  AppearanceContext,
  LocalAppearance,
  SurfacePath,
} from "./citymodel/cityjson/appearance";
export {
  AppearanceMerger,
  EMPTY_APPEARANCE_CONTEXT,
  readLocalAppearance,
  resolveSurfaceMaterial,
  resolveSurfaceTexture,
} from "./citymodel/cityjson/appearance";

export type { CityJSONFeature } from "./citymodel/cityjsonseq/types";
export { parseCityJSONSeq } from "./citymodel/cityjsonseq/parseCityJSONSeq";

export {
  NonMetricCrsError,
  assertMetricCrs,
  ensureProjDef,
  ensureProjDefAsync,
  isMetricCrs,
  parseEpsgCode,
} from "./citymodel/crsProjDefs";

export type { EnuFrame } from "./geo/enuFrame";
export {
  ecefToEnu,
  ecefToGeodetic,
  enuToEcef,
  geodeticToEcef,
  makeEnuFrame,
} from "./geo/enuFrame";
export type {
  SourceToEnuOptions,
  ProjectPositionsOptions,
} from "./geo/sourceToEnu";
export { sourceToEnuPoint, projectPositionsToEnu } from "./geo/sourceToEnu";
export type { RasterPixels, GeoidSampleDeps } from "./geo/geoidHeight";
export {
  GEOID_TILEJSON_URL,
  GEOID_ATTRIBUTION,
  geoidHeightAt,
  resetGeoidCacheForTest,
} from "./geo/geoidHeight";

export type { LinearRGB } from "./styling/surfaceColors";
export {
  SURFACE_COLOR_VALUES,
  SURFACE_COLOR_HEX,
  SURFACE_COLORS_LINEAR,
} from "./styling/surfaceColors";

export type {
  CityMeshArrays,
  TextureGroup,
} from "./geometry/buildCityMeshArrays";
export {
  buildCityMeshArrays,
  computeOriginOffset,
} from "./geometry/buildCityMeshArrays";
export {
  buildCityEdgeSegments,
  DEFAULT_EDGE_ANGLE_DEG,
} from "./geometry/buildCityEdgeSegments";
export type { PickingIndex, PickResult } from "./picking/types";

export type { RoofMetrics } from "./roofMetrics/types";
export {
  computeArea,
  computeAzimuth,
  computeElevation,
  computeInclination,
  computeRoofMetrics,
  computeSurfaceNormal,
} from "./roofMetrics/metrics";
export { computeFootprintArea } from "./roofMetrics/footprint";
export type {
  Condition,
  ConditionOperator,
  LogicMode,
  Rule,
} from "./rules/types";
export { evaluateCondition, evaluateRule, matchRule } from "./rules/evaluate";

export type { RGB } from "./styling/srgb";
export { srgbHexToLinear, srgbToLinear } from "./styling/srgb";
export type {
  CityObjectInfo,
  SurfaceInfo,
  SurfaceStyleEvaluator,
} from "./styling/buildStyleColors";
export { buildStyleColorsFromArrays } from "./styling/buildStyleColors";
export {
  buildRuleColorsFromArrays,
  compileRuleEvaluator,
} from "./styling/ruleColors";
