/**
 * Public API of @cityjson/navara-cityparquet.
 *
 * A reader for the CityParquet format: a STAC Item manifest plus one or more
 * Parquet object tables, assembled into the same normalised `CityModel` the
 * CityJSON and FlatCityBuf paths produce. Engine-free — this package never
 * imports `@navaramap/*`, so it is usable under Node and inside a worker.
 *
 * The entry point for a whole package is `parseCityParquetManifest` (which
 * files to fetch) followed by `assembleCityParquetModel` (what they are). The
 * lower layers are exported too, because a caller that already has one table's
 * bytes — a test, or a single-file `.parquet` drop — needs no manifest.
 */

export { CityParquetError } from "./footer";
export type { CityFooter, CityGeometryColumnMeta } from "./footer";

export type { CityParquetTableData, GeometryColumnRef } from "./tableReader";
export { readCityParquetTable } from "./tableReader";

export { decodeTableObjects } from "./decodeTable";

export type {
  AssembleOptions,
  CityParquetManifest,
  CityParquetPackageFile,
} from "./packageAssembly";
export {
  CITYPARQUET_SIDECAR_NAMES,
  assembleCityParquetModel,
  parseCityParquetManifest,
  sidecarKindOf,
} from "./packageAssembly";

export type { CityParquetSidecars, PackageAppearance } from "./sidecars";
export { readPackageAppearance } from "./sidecars";
