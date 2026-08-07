/**
 * The Parquet footer's `city` key-value metadata, as this reader needs it.
 *
 * Behaviour mirrors `cityparquet-rs/crates/cityparquet-schema/src/metadata.rs`
 * (`CityMetadata::from_key_values`) and `types.rs` (`Lod::from_column_suffix`,
 * `geometry_column_name`), narrowed to the fields a viewer actually reads: the
 * version, the EPSG code, the geometry-column registry, the attribute list and
 * the provenance token. Everything else in the object (`extensions`,
 * `appearance_defaults`, `other`, the full PROJJSON body) is carried by the
 * file but not needed to draw it, so it is deliberately not modelled — a
 * reader must never *need* those to decode (spec §metadata).
 *
 * Validation is narrow rather than schema-complete: the `city` key must exist,
 * parse as a JSON object, and declare a version; a `columns` entry must name a
 * column and its encoding. Anything beyond that is normalised to a default,
 * because rejecting a file over a field we do not read would be a worse
 * outcome than ignoring it. Every rejection is a `CityParquetError` carrying a
 * sentence fit to show a user.
 *
 * Engine-free: no `@navaramap/*` imports.
 */

/** One `city.columns` entry, as this reader models it. */
export interface CityGeometryColumnMeta {
  name: string;
  /** `"WKB"` for the normative encoding; other tokens exist and are carried
   * verbatim so a caller can refuse them by name rather than by guesswork. */
  encoding: string;
  geometryTypes: string[];
  /** `"right-handed"` / `"left-handed"`, or `null` when the file omits it. */
  orientation3d: string | null;
}

/** The `city` footer object, narrowed to the fields this reader uses. */
export interface CityFooter {
  version: string;
  /** From `city.crs`'s PROJJSON `id` when its authority is EPSG; `null` for a
   * non-EPSG authority, an absent id, or an absent CRS. */
  epsg: number | null;
  primaryColumn: string | null;
  geometryColumns: CityGeometryColumnMeta[];
  /** `city.attributes`, or `[]` when the file declares none. */
  attributes: string[];
  sourceFormat: string | null;
}

/** Every failure this package raises while reading a CityParquet file. */
export class CityParquetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CityParquetError";
  }
}

/** One entry of a Parquet footer's key-value metadata. */
interface FooterKeyValue {
  key?: string | null;
  value?: string | null;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the footer's `city` key. The `geo` key (pure GeoParquet) is ignored:
 * it describes a strict subset of the same columns, and `city` is the only
 * object that can describe a solid-family column at all.
 */
export function parseCityFooter(
  kv: ReadonlyArray<FooterKeyValue>,
): CityFooter {
  let raw: string | null = null;
  for (const entry of kv) {
    if (entry.key === "city" && typeof entry.value === "string") {
      raw = entry.value;
    }
  }
  if (raw === null) {
    throw new CityParquetError(
      "This file is not a CityParquet file — its Parquet footer carries no 'city' metadata.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CityParquetError(
      "This file is not a CityParquet file — the 'city' metadata in its Parquet footer is not valid JSON.",
    );
  }
  if (!isJsonObject(parsed)) {
    throw new CityParquetError(
      "This file is not a CityParquet file — the 'city' metadata in its Parquet footer is not a JSON object.",
    );
  }

  const version = parsed.version;
  if (typeof version !== "string") {
    throw new CityParquetError(
      "This file is not a CityParquet file — its 'city' metadata declares no CityParquet version.",
    );
  }

  return {
    version,
    epsg: readEpsg(parsed.crs),
    primaryColumn: readOptionalString(parsed.primary_column),
    geometryColumns: readColumns(parsed.columns),
    attributes: readAttributes(parsed.attributes),
    sourceFormat: readOptionalString(parsed.source_format),
  };
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The EPSG code of a PROJJSON CRS object: its top-level `id`, which a
 * CompoundCRS carries alongside the components that have ids of their own (the
 * fixture's EPSG:7415 is exactly that shape). A non-EPSG authority yields
 * `null` rather than an error — the layer is then rejected upstream by the
 * app's CRS gate, with its own message.
 */
function readEpsg(crs: unknown): number | null {
  if (!isJsonObject(crs)) return null;
  const id = crs.id;
  if (!isJsonObject(id)) return null;
  if (id.authority !== "EPSG") return null;
  const code = id.code;
  if (typeof code === "number" && Number.isInteger(code)) return code;
  // PROJJSON allows a string code; accept a plain integer spelling of one.
  if (typeof code === "string" && /^\d+$/.test(code)) return Number(code);
  return null;
}

function readColumns(value: unknown): CityGeometryColumnMeta[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new CityParquetError(
      "This CityParquet file's 'city' metadata is malformed: 'columns' is not a list of geometry columns.",
    );
  }
  return value.map((entry) => {
    if (!isJsonObject(entry)) {
      throw new CityParquetError(
        "This CityParquet file's 'city' metadata is malformed: a 'columns' entry is not an object.",
      );
    }
    const name = entry.name;
    if (typeof name !== "string") {
      throw new CityParquetError(
        "This CityParquet file's 'city' metadata is malformed: a 'columns' entry has no column name.",
      );
    }
    const encoding = entry.encoding;
    if (typeof encoding !== "string") {
      throw new CityParquetError(
        `This CityParquet file's 'city' metadata is malformed: the geometry column '${name}' declares no encoding.`,
      );
    }
    const geometryTypes = Array.isArray(entry.geometry_types)
      ? entry.geometry_types.filter(
          (t: unknown): t is string => typeof t === "string",
        )
      : [];
    return {
      name,
      encoding,
      geometryTypes,
      orientation3d: readOptionalString(entry.orientation_3d),
    };
  });
}

function readAttributes(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new CityParquetError(
      "This CityParquet file's 'city' metadata is malformed: 'attributes' is not a list of column names.",
    );
  }
  return value.filter((a: unknown): a is string => typeof a === "string");
}

/** The reserved prefix every geometry column name starts with. */
const GEOMETRY_PREFIX = "geometry";
/** The reserved prefix of the sibling column holding a geometry's semantics. */
const GEOMETRY_PROPERTIES_PREFIX = "geometry_properties";

/** `lod<major>_<minor>`, with both components in `Lod`'s `u8` range. */
const LOD_SUFFIX = /^lod(\d{1,3})_(\d{1,3})$/;

/**
 * The LoD a geometry column carries, or `null` when `name` does not fit the
 * reserved geometry-column grammar (a `geometry_properties_*` sibling, a
 * `geometry_vertices_*` column of an Arrow-native encoding, an ordinary
 * attribute name like `b3_volume_lod2`).
 *
 * This is a NAME test and nothing more: a source attribute that happens to be
 * spelled `geometry_lod2_2` matches it. Callers must exclude the columns the
 * footer declares in `attributes` first — the footer, not the spelling, is
 * what makes a column an attribute.
 *
 * The returned string is the DISPLAY spelling, matching what
 * `parseCityJSON` reports for the same source data: a `.0` minor is stripped
 * (`lod0_0` → `"0"`, `lod1_0` → `"1"`), because a CityJSON file writes
 * `"lod": "0"` while the column grammar always carries a minor
 * (`Lod::column_suffix`). Without that, one dataset would offer LoD `"0"` as
 * CityJSON and `"0.0"` as CityParquet.
 *
 * A legacy bare `geometry` column — pre-dating the always-suffixed grammar —
 * is a geometry column of unknown LoD, hence `{lod: null}` rather than `null`.
 */
export function lodFromColumnName(name: string): { lod: string | null } | null {
  if (name === GEOMETRY_PREFIX) return { lod: null };
  const suffix = name.startsWith(`${GEOMETRY_PREFIX}_`)
    ? name.slice(GEOMETRY_PREFIX.length + 1)
    : null;
  if (suffix === null) return null;
  const match = LOD_SUFFIX.exec(suffix);
  const major = match?.[1];
  const minor = match?.[2];
  if (major === undefined || minor === undefined) return null;
  const majorN = Number(major);
  const minorN = Number(minor);
  if (majorN > 255 || minorN > 255) return null;
  return { lod: minorN === 0 ? `${majorN}` : `${majorN}.${minorN}` };
}

/**
 * The `geometry_properties*` column holding the semantic surfaces of a given
 * geometry column — the same name with the reserved prefix swapped, so the LoD
 * suffix is carried across unchanged (`geometry_column_name` in `types.rs`).
 */
export function propsColumnFor(geometryColumn: string): string {
  if (lodFromColumnName(geometryColumn) === null) {
    throw new CityParquetError(
      `This CityParquet file's '${geometryColumn}' column is not a geometry column, so it has no semantic-surface column.`,
    );
  }
  return (
    GEOMETRY_PROPERTIES_PREFIX + geometryColumn.slice(GEOMETRY_PREFIX.length)
  );
}
