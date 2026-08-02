/**
 * @cityjson/navara-cityjson — Navara plugin for static CityJSON / CityJSONSeq
 * layers. Implemented in milestone M7.3; this entry point is a placeholder so
 * the package builds, type-checks, and can be wired into the host app early.
 */
import { NAVARA_CORE_VERSION } from "@cityjson/navara-core";

export const CITYJSON_PLUGIN_PLACEHOLDER = `@cityjson/navara-cityjson (core ${NAVARA_CORE_VERSION})`;

export { disposeGeometry, geometryFromMeshArrays } from "./cityMeshGeometry";

export type { GeodeticBounds, Lle } from "./enuPlacement";
export {
  CrsUnresolvedError,
  geodeticBoundsFromBBox,
  makePlacementFrame,
  originLleFromOffset,
  placementMatrixFromFrame,
  placementMatrixFromLle,
  resolveEpsg,
} from "./enuPlacement";
