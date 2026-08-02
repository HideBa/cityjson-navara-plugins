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
  BuildingSurfaceType,
  Surface,
  CityObject,
  CityModelMetadata,
  CityModel,
} from "./citymodel/types";
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
  dequantizeAll,
  mergeBBox,
  parseCityObject,
  mapMetadata,
} from "./citymodel/cityjson/parseHelpers";
export { parseCityJSON } from "./citymodel/cityjson/parseCityJSON";
