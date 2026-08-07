/**
 * Reads a CityParquet file's footer and rows with the vendored hyparquet.
 *
 * This is the orchestration layer only: it decides WHICH columns to read and
 * hands back the raw row objects. Nothing here decodes a geometry — the WKB
 * blobs stay `Uint8Array` and are turned into boundaries downstream — so the
 * cost of reading a table is the cost of the columns a viewer actually needs.
 *
 * Column discovery mirrors `cityparquet_arrow_schema` in
 * `cityparquet-rs/crates/cityparquet/src/reader.rs`: the LoD set comes from the
 * file's OWN schema, not from the footer's `columns` registry, so a legacy bare
 * `geometry` column (pre-dating the always-suffixed grammar) is still found;
 * and the columns the footer declares in `attributes` are excluded FIRST,
 * because §13.1 makes a declared attribute an attribute even when it is spelled
 * like a geometry column (`lodFromColumnName` is a name-grammar test and
 * cannot tell the difference on its own).
 *
 * Engine-free: no `@navaramap/*` imports.
 */

import { compressors } from "hyparquet-compressors";
import type { CityFooter } from "./footer";
import {
  CityParquetError,
  lodFromColumnName,
  parseCityFooter,
  propsColumnFor,
} from "./footer";
import type { AsyncBuffer, FileMetaData } from "./vendor/hyparquet/index.js";
import {
  parquetMetadataAsync,
  parquetReadObjects,
  parquetSchema,
} from "./vendor/hyparquet/index.js";

/** A geometry column found in the file's schema, paired with its semantics. */
export interface GeometryColumnRef {
  name: string;
  /** Display LoD (`"0"`, `"2.2"`), or `null` for a bare `geometry` column. */
  lod: string | null;
  /** The `geometry_properties*` sibling, when the file actually carries it. */
  propsName: string | null;
}

/** Everything one CityParquet file yields before any geometry is decoded. */
export interface CityParquetTableData {
  footer: CityFooter;
  rows: ReadonlyArray<Record<string, unknown>>;
  geometryColumns: ReadonlyArray<GeometryColumnRef>;
}

/**
 * The reserved non-geometry columns this reader reads, in spec order.
 *
 * The allow-list is the skip-list: `address`, `template`, `other`,
 * `children_roles`, `material_*` and `texture_*` are all real reserved columns
 * that a viewer does not draw, so they are simply never projected — reading
 * them would cost pages of decode per file for data nothing consumes.
 */
const IDENTITY_COLUMNS = [
  "id",
  "feature_id",
  "object_type",
  "parents",
  "children",
  "bbox",
] as const;

/** The catch-all attribute container, when the writer emitted one. */
const OTHER_ATTRIBUTES_COLUMN = "other_attributes";

/**
 * Wraps `bytes` as a hyparquet `AsyncBuffer`.
 *
 * hyparquet slices ABSOLUTE file offsets, so the view must be normalised onto
 * an `ArrayBuffer` of its own: a `readFile` result can be a window into a
 * larger pooled buffer, and a non-zero `byteOffset` would shift every offset in
 * the footer. The copy is spelled out rather than written as
 * `bytes.buffer.slice(...)` because `Uint8Array#buffer` is typed
 * `ArrayBufferLike`, which would widen the result to include
 * `SharedArrayBuffer`.
 */
function asyncBufferOf(bytes: Uint8Array): AsyncBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return {
    byteLength: buf.byteLength,
    slice: (start: number, end?: number) => buf.slice(start, end),
  };
}

/**
 * Runs `fn`, re-throwing anything hyparquet raises as a `CityParquetError`
 * carrying a sentence fit to show a user. Every error leaving this package is
 * a `CityParquetError`, so a caller never has to pattern-match on a vendored
 * library's internal message; the original stays reachable as `cause`.
 */
async function wrapHyparquet<T>(
  what: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    throw new CityParquetError(
      `This file could not be read as Parquet while ${what}. It may be truncated or corrupt, or use a Parquet feature this reader does not support.`,
      { cause },
    );
  }
}

/** The top-level column names of a file's schema, in file order. */
function topLevelColumnNames(metadata: FileMetaData): string[] {
  const tree = parquetSchema(metadata);
  return tree.children.map((child) => child.element.name);
}

/**
 * Finds the geometry columns of a file, given its schema's top-level names and
 * the footer that says which of those names are attributes.
 */
function discoverGeometryColumns(
  schemaColumns: ReadonlyArray<string>,
  footer: CityFooter,
): GeometryColumnRef[] {
  const attributeNames = new Set(footer.attributes);
  const present = new Set(schemaColumns);
  const found: GeometryColumnRef[] = [];
  for (const name of schemaColumns) {
    if (attributeNames.has(name)) continue;
    const parsed = lodFromColumnName(name);
    if (parsed === null) continue;
    const propsName = propsColumnFor(name);
    found.push({
      name,
      lod: parsed.lod,
      propsName: present.has(propsName) ? propsName : null,
    });
  }
  return found;
}

/**
 * Rejects a file whose geometry is not WKB.
 *
 * The Arrow-native encodings are experimental and describe their coordinates in
 * sibling `geometry_vertices_*` columns this reader does not read; refusing by
 * name is better than decoding a blob that is not there.
 */
function requireWkb(footer: CityFooter): void {
  for (const column of footer.geometryColumns) {
    if (column.encoding !== "WKB") {
      throw new CityParquetError(
        `This file uses the experimental "${column.encoding}" geometry encoding, which is not supported.`,
      );
    }
  }
}

/**
 * The projection for `parquetReadObjects`, intersected with the file's schema.
 *
 * A name that is absent from the schema is dropped rather than passed through:
 * `feature_id`, `other_attributes` and even a footer-declared attribute are all
 * optional in practice (the mirrors are independently generated), and hyparquet
 * gives no guarantee about how it treats a column it cannot find.
 */
function buildProjection(
  schemaColumns: ReadonlyArray<string>,
  footer: CityFooter,
  geometryColumns: ReadonlyArray<GeometryColumnRef>,
): string[] {
  const present = new Set(schemaColumns);
  const wanted = [
    ...IDENTITY_COLUMNS,
    ...geometryColumns.map((g) => g.name),
    ...geometryColumns
      .map((g) => g.propsName)
      .filter((n): n is string => n !== null),
    ...footer.attributes,
    OTHER_ATTRIBUTES_COLUMN,
  ];
  const projection: string[] = [];
  const seen = new Set<string>();
  for (const name of wanted) {
    if (!present.has(name) || seen.has(name)) continue;
    seen.add(name);
    projection.push(name);
  }
  return projection;
}

/**
 * Reads a whole CityParquet file: its `city` footer, its geometry columns and
 * every row of the columns a viewer needs.
 *
 * Rows come back with `utf8: false`, which is what the WKB decoder downstream
 * depends on: STRING-annotated columns are still JS strings, while the
 * un-annotated `BYTE_ARRAY` geometry blobs stay raw `Uint8Array`.
 */
export async function readCityParquetTable(
  bytes: Uint8Array,
): Promise<CityParquetTableData> {
  const file = asyncBufferOf(bytes);

  const metadata = await wrapHyparquet("reading its footer", () =>
    parquetMetadataAsync(file),
  );
  const footer = parseCityFooter(metadata.key_value_metadata ?? []);
  requireWkb(footer);

  const schemaColumns = await wrapHyparquet("reading its schema", () =>
    topLevelColumnNames(metadata),
  );
  const geometryColumns = discoverGeometryColumns(schemaColumns, footer);
  const columns = buildProjection(schemaColumns, footer, geometryColumns);

  const rows = await wrapHyparquet("reading its rows", () =>
    parquetReadObjects({
      file,
      metadata,
      columns,
      utf8: false,
      compressors,
    }),
  );

  return { footer, rows, geometryColumns };
}
