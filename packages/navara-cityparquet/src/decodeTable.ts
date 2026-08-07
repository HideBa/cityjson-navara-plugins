/**
 * Turns the rows of a CityParquet table into normalised `CityObject`s.
 *
 * Behaviour mirrors `cityparquet-rs/crates/cityparquet/src/decode.rs` (row →
 * object, attribute conversion, the `object_type` reverse lookup) and
 * `export.rs` (`reconstruct_boundaries`/`rebuild_semantics`, which pair a
 * geometry's WKB faces with its flat `face_semantics`) — but it stops one step
 * short of both: this viewer never rebuilds CityJSON `boundaries`, it goes
 * straight to the flat `Surface[]` its mesh builder wants. That is why the
 * `shells` field of `geometry_properties` is read by neither this module nor
 * the WKB decoder: it exists to re-nest a Solid's faces per shell, and a flat
 * surface list has no nesting to restore. `face_semantics` is flat across every
 * shell and every solid member, in the same order the WKB faces are, so a
 * single index pairs them.
 *
 * Where the two formats could diverge, this module follows navara-core's
 * `parseHelpers.parseCityObject` rather than the Rust exporter, because the
 * same dataset must look identical whether it is opened as CityJSON or as
 * CityParquet: the semantic-type allow-list, the `type`/`parent`/`children`
 * exclusion from a surface's attributes, the `"unknown"` fallback, and the
 * highest-numeric-LoD rule for `CityObject.lod` are all lifted from there.
 *
 * The one deliberate difference: `CityObject.bbox` is read from the row's own
 * `bbox` struct instead of being accumulated from the vertices, because
 * CityParquet stores it and recomputing it would be slower and no more true.
 *
 * Engine-free: no `@navaramap/*` imports.
 */

import type {
  BBox3,
  BuildingSurfaceType,
  CityObject,
  Surface,
} from "@cityjson/navara-core";
import type { CityFooter } from "./footer";
import { CityParquetError } from "./footer";
import type { CityParquetTableData, GeometryColumnRef } from "./tableReader";
import type { DecodedWkb } from "./wkb";
import { WkbError, decodeWkb } from "./wkb";

/**
 * The four CityGML 3.0 class names that differ from their CityJSON spelling
 * (`TAXONOMY` in `cityparquet-schema/src/types.rs`; every other core class and
 * every extension class is spelled identically or has no taxonomy entry).
 * `object_type` stores the CityGML name, so a reader must restore the CityJSON
 * one — the app's rules, presets and type filters are all written against
 * CityJSON vocabulary.
 */
const CITYJSON_TYPE_BY_CITYGML_CLASS: ReadonlyMap<string, string> = new Map([
  ["Storey", "BuildingStorey"],
  ["HollowSpace", "TunnelHollowSpace"],
  ["Square", "TransportSquare"],
  ["GenericOccupiedSpace", "GenericCityObject"],
]);

/**
 * The CityJSON object type for a stored `object_type`, or the name itself when
 * it is not one of the four renames — which covers every other core class, and
 * every extension class (those have no taxonomy entry and keep their own name).
 * The lookup is one-way by construction: a file written by a tool that already
 * stores the CityJSON spelling (the duckdb extension does) passes through
 * unchanged, because no CityJSON name is also a divergent CityGML name.
 */
export function cityJsonTypeForObjectType(objectType: string): string {
  return CITYJSON_TYPE_BY_CITYGML_CLASS.get(objectType) ?? objectType;
}

/**
 * The semantic surface types core recognises — the same allow-list
 * `parseHelpers.resolveSemanticType` applies to CityJSON, duplicated here
 * because core exports the union type but no runtime set. Anything else,
 * including an Extension `+Something` surface, renders as `"unknown"` while
 * keeping its attributes.
 */
const KNOWN_BUILDING_SURFACE_TYPES: ReadonlySet<string> = new Set([
  "RoofSurface",
  "WallSurface",
  "GroundSurface",
  "ClosureSurface",
  "OuterCeilingSurface",
  "OuterFloorSurface",
  "Window",
  "Door",
]);

/**
 * The prefix a CityJSON Extension attribute (`+height`) is stored under
 * (`normalise_attribute_name` in `cityparquet-schema/src/model.rs`), since `+`
 * is not a portable column-name character. The footer's `attributes` list
 * carries the normalised spelling, so the `+` has to be restored here or the
 * same dataset would expose `ex_height` as CityParquet and `+height` as
 * CityJSON.
 *
 * The normalisation is lossy in the writer and the name is the only signal a
 * reader has (the "extension" role lives in Arrow field metadata, which the
 * `city` footer does not carry), so a source attribute genuinely named
 * `ex_height` is indistinguishable from `+height` and comes back as the latter.
 * That is a residual of the format, not a decision taken here.
 */
const EXTENSION_ATTRIBUTE_PREFIX = "ex_";

/** The catch-all attribute container, when the writer emitted one. */
const OTHER_ATTRIBUTES_COLUMN = "other_attributes";

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date)
  );
}

/** A cell that carries no value: a null column, or a column not read at all. */
function isEmptyCell(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * Console warnings, deduplicated by kind.
 *
 * Every condition this decoder warns about is systematic: a writer that emits
 * one unreadable `other_attributes` cell emits a million of them, and a package
 * has a row per city object. So the FIRST of each kind is reported in full,
 * naming the object it happened on, and the rest are counted and summarised
 * once — a bug stays discoverable without the console (and the main thread)
 * paying per row for it.
 */
class DecodeWarnings {
  private readonly counts = new Map<string, number>();
  private readonly summaries = new Map<string, (more: number) => string>();

  /**
   * Reports one occurrence. `summary(more)` is only called if a second
   * occurrence of the same `kind` ever happens, and receives the number of
   * occurrences BEYOND the one already printed.
   */
  report(
    kind: string,
    message: string,
    summary: (more: number) => string,
  ): void {
    const seen = this.counts.get(kind) ?? 0;
    this.counts.set(kind, seen + 1);
    this.summaries.set(kind, summary);
    if (seen === 0) console.warn(`CityParquet: ${message}`);
  }

  /** Prints one summary line per kind that occurred more than once. */
  flush(): void {
    for (const [kind, count] of this.counts) {
      if (count < 2) continue;
      const summary = this.summaries.get(kind);
      if (summary === undefined) continue;
      console.warn(`CityParquet: ${summary(count - 1)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Identity columns
// ---------------------------------------------------------------------------

/**
 * A `LIST<STRING>` cell as a plain string array. A null list and an absent
 * column are both "no ids" — hyparquet yields `null` for the first and
 * `undefined` for the second, so the test is nullish, not `=== null`.
 * Non-string items (only reachable in a hand-rolled file) are dropped rather
 * than stringified, so a broken row cannot inject a parent id like `"[object
 * Object]"` that would then fail to resolve.
 */
function readIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item: unknown): item is string => typeof item === "string",
  );
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The reserved `bbox` struct as a `BBox3`. Every one of the six fields must be
 * a finite number; a partially-populated struct yields `null` (no bbox) rather
 * than a box with `undefined` corners, which would poison every bbox merge
 * downstream.
 */
function readBBox(value: unknown): BBox3 | null {
  if (!isPlainObject(value)) return null;
  const xmin = finiteNumber(value.xmin);
  const ymin = finiteNumber(value.ymin);
  const zmin = finiteNumber(value.zmin);
  const xmax = finiteNumber(value.xmax);
  const ymax = finiteNumber(value.ymax);
  const zmax = finiteNumber(value.zmax);
  if (
    xmin === null ||
    ymin === null ||
    zmin === null ||
    xmax === null ||
    ymax === null ||
    zmax === null
  ) {
    return null;
  }
  return [xmin, ymin, zmin, xmax, ymax, zmax];
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

const TEXT_DECODER = new TextDecoder();

/**
 * One attribute cell in the shape the rest of the app expects.
 *
 * hyparquet reconstructs Parquet's logical types into JS values, and three of
 * them are not JSON-representable: an INT64 arrives as `bigint` (which
 * `JSON.stringify` throws on — the attribute panel, the rule engine and the
 * share link all stringify), a DATE/TIMESTAMP as `Date`, and a BYTE_ARRAY that
 * carries no STRING annotation as `Uint8Array`. Arrays are mapped element-wise
 * for the same reason (a `LIST<INT64>` is a list of bigints); a struct cell is
 * passed through as-is, because a viewer displays it rather than computing on
 * it.
 *
 * The Rust decoder renders a Date32 as `YYYY-MM-DD` and a timestamp as RFC3339;
 * both arrive here as an indistinguishable `Date`, so both become the RFC3339
 * spelling.
 */
function attributeValue(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return TEXT_DECODER.decode(value);
  if (Array.isArray(value)) return value.map(attributeValue);
  return value;
}

/** The CityJSON attribute name a column name stands for. */
function attributeKeyForColumn(column: string): string {
  return column.startsWith(EXTENSION_ATTRIBUTE_PREFIX)
    ? `+${column.slice(EXTENSION_ATTRIBUTE_PREFIX.length)}`
    : column;
}

/**
 * A row's attributes: one entry per non-null footer-declared column, plus
 * whatever the `other_attributes` container diverted.
 *
 * A column attribute wins a name collision. The two sets are non-colliding by
 * construction (the writer diverts an attribute precisely because it could not
 * have a column of its own, and the Rust decoder treats a collision as a
 * corrupt file), so this only decides what a broken file does — and keeping the
 * typed column value is the better of two bad outcomes.
 */
function readAttributes(
  row: Record<string, unknown>,
  footer: CityFooter,
  id: string,
  warnings: DecodeWarnings,
): JsonObject {
  const attributes: JsonObject = {};
  for (const column of footer.attributes) {
    const cell = row[column];
    if (isEmptyCell(cell)) continue;
    attributes[attributeKeyForColumn(column)] = attributeValue(cell);
  }

  const diverted = readOtherAttributes(
    row[OTHER_ATTRIBUTES_COLUMN],
    id,
    warnings,
  );
  for (const [key, value] of Object.entries(diverted)) {
    if (key in attributes) continue;
    attributes[key] = attributeValue(value);
  }
  return attributes;
}

/**
 * The `other_attributes` container, keyed by each attribute's SOURCE name (the
 * writer diverts here exactly so the name survives un-normalised). It is a JSON
 * string column, but a writer that annotated it `JSON` would have hyparquet
 * hand back the parsed object already, so both are accepted. A malformed or
 * non-object cell costs the diverted attributes and nothing else — a viewer
 * that refused the whole file over it would be trading a complete model for a
 * few labels.
 */
function readOtherAttributes(
  cell: unknown,
  id: string,
  warnings: DecodeWarnings,
): JsonObject {
  if (isEmptyCell(cell)) return {};
  if (isPlainObject(cell)) return cell;
  if (typeof cell !== "string" || cell === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(cell);
  } catch {
    warnings.report(
      "other_attributes",
      `object '${id}' has an 'other_attributes' cell that is not valid JSON; its diverted attributes were skipped.`,
      (more) => `${more} more object(s) had an unreadable 'other_attributes'.`,
    );
    return {};
  }
  if (!isPlainObject(parsed)) {
    warnings.report(
      "other_attributes",
      `object '${id}' has an 'other_attributes' cell that is not a JSON object; its diverted attributes were skipped.`,
      (more) => `${more} more object(s) had an unreadable 'other_attributes'.`,
    );
    return {};
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Geometry + semantics
// ---------------------------------------------------------------------------

/** One entry of a geometry's `surfaces` list: a `type` plus free attributes. */
type SurfaceDefinition = JsonObject;

/**
 * The `surfaces` field of a `geometry_properties` struct — the CityJSON
 * `semantics.surfaces` array, stored as JSON text. Absent (no semantics at all)
 * and malformed both yield `null`, which makes every face of that geometry
 * `"unknown"`.
 */
function readSurfaceDefinitions(
  props: unknown,
  id: string,
  columnName: string,
  warnings: DecodeWarnings,
): SurfaceDefinition[] | null {
  if (!isPlainObject(props)) return null;
  const raw = props.surfaces;
  if (isEmptyCell(raw)) return null;
  const parsed: unknown = typeof raw === "string" ? tryParseJson(raw) : raw;
  if (!Array.isArray(parsed)) {
    warnings.report(
      "surfaces",
      `object '${id}' has an unreadable 'surfaces' list in '${columnName}'; its faces are unlabelled.`,
      (more) =>
        `${more} more geometr(y/ies) had an unreadable 'surfaces' list.`,
    );
    return null;
  }
  return parsed.map((entry: unknown) => (isPlainObject(entry) ? entry : {}));
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The `face_semantics` field: one index into `surfaces` per WKB face, flat
 * across every shell and solid member (the writer flattens; only `shells`,
 * which this viewer does not need, could re-nest it). A `null` entry means the
 * face carries no semantics.
 */
function readFaceSemantics(
  props: unknown,
): ReadonlyArray<number | null> | null {
  if (!isPlainObject(props)) return null;
  const raw = props.face_semantics;
  if (!Array.isArray(raw)) return null;
  return raw.map((entry: unknown) =>
    typeof entry === "number" ? entry : null,
  );
}

/** The semantic type of a surface definition, per core's allow-list. */
function resolveSurfaceType(
  def: SurfaceDefinition | undefined,
): BuildingSurfaceType {
  const type = def?.type;
  if (typeof type === "string" && KNOWN_BUILDING_SURFACE_TYPES.has(type)) {
    return type as BuildingSurfaceType;
  }
  return "unknown";
}

/**
 * A surface definition's extra attributes: everything but `type` and the
 * structural `parent`/`children` links, exactly as `parseHelpers`
 * does for CityJSON semantics.
 */
function resolveSurfaceAttributes(
  def: SurfaceDefinition | undefined,
): JsonObject {
  if (def === undefined) return {};
  const attributes: JsonObject = {};
  for (const [key, value] of Object.entries(def)) {
    if (key === "type" || key === "parent" || key === "children") continue;
    attributes[key] = value;
  }
  return attributes;
}

/**
 * Decodes one geometry cell, translating any WKB failure into the
 * `CityParquetError` this package promises at its boundary. The object id and
 * the column name go into the message because a single bad blob in a
 * million-row package is otherwise unfindable.
 */
function decodeGeometryCell(
  cell: unknown,
  id: string,
  columnName: string,
): DecodedWkb {
  if (!(cell instanceof Uint8Array)) {
    throw new CityParquetError(
      `The geometry of object '${id}' in column '${columnName}' is not WKB bytes, so it could not be read.`,
    );
  }
  try {
    // hyparquet hands back an exact-length view of its decoded page, which is
    // what `decodeWkb` needs — re-wrapping it would only risk widening it.
    return decodeWkb(cell);
  } catch (cause) {
    const detail =
      cause instanceof WkbError
        ? cause.message
        : "the blob could not be decoded";
    throw new CityParquetError(
      `The geometry of object '${id}' in column '${columnName}' could not be read: ${detail}.`,
      { cause },
    );
  }
}

/** What one row's geometry columns contributed. */
interface RowGeometry {
  surfaces: Surface[];
  /** Highest numeric LoD across the row's non-null geometry cells. */
  lod: string | null;
}

/**
 * Mirrors `parseCityObject`'s LoD tracking: the highest LoD by numeric value,
 * keeping the SOURCE spelling of the winner. A geometry column with no LoD (the
 * legacy bare `geometry`) contributes nothing, exactly as a CityJSON geometry
 * with no `"lod"` member does.
 */
function higherLod(
  current: string | null,
  candidate: string | null,
): string | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return parseFloat(candidate) > parseFloat(current) ? candidate : current;
}

function readRowGeometry(
  row: Record<string, unknown>,
  geometryColumns: ReadonlyArray<GeometryColumnRef>,
  id: string,
  warnings: DecodeWarnings,
): RowGeometry {
  const surfaces: Surface[] = [];
  let lod: string | null = null;

  for (const column of geometryColumns) {
    const cell = row[column.name];
    if (isEmptyCell(cell)) continue;
    // The LoD is tracked for every geometry the row carries, including the ones
    // that yield no surfaces — a MultiPoint at LoD1 still makes the object an
    // LoD1 object, which is what the CityJSON path reports too.
    lod = higherLod(lod, column.lod);

    const decoded = decodeGeometryCell(cell, id, column.name);
    if (decoded.kind !== "faces") {
      // Points and lines are legal CityJSON geometries with nothing to shade.
      warnings.report(
        "non-surface",
        `the geometry of object '${id}' in '${column.name}' is points or lines, so it was not turned into surfaces.`,
        (more) => `${more} more geometr(y/ies) were points or lines.`,
      );
      continue;
    }

    const props = column.propsName === null ? null : row[column.propsName];
    const definitions = readSurfaceDefinitions(
      props,
      id,
      column.name,
      warnings,
    );
    const faceSemantics = readFaceSemantics(props);

    // `faces` is flat across every shell and every solid member, and so is
    // `face_semantics` — one index pairs them (the `shells` field exists to
    // re-nest them, which a flat surface list never needs).
    for (const [index, face] of decoded.faces.entries()) {
      const semanticIndex = faceSemantics?.[index];
      const definition =
        semanticIndex !== undefined && semanticIndex !== null && definitions
          ? definitions[semanticIndex]
          : undefined;
      surfaces.push({
        type: resolveSurfaceType(definition),
        // Already unclosed rings of absolute source-CRS coordinates — exactly
        // what `buildCityMeshArrays` triangulates.
        rings: face,
        attributes: resolveSurfaceAttributes(definition),
        lod: column.lod,
      });
    }
  }

  return { surfaces, lod };
}

// ---------------------------------------------------------------------------
// Rows → objects
// ---------------------------------------------------------------------------

/**
 * Every row of a CityParquet table as a normalised `CityObject`, keyed by id.
 *
 * A row with no geometry at all — the typical root `Building`, whose geometry
 * lives on its `BuildingPart` children — still becomes an object with
 * `surfaces: []`, because the attribute-inheritance display walks from a picked
 * part to its parent and needs that parent to exist.
 *
 * Throws a `CityParquetError` if a geometry blob cannot be decoded: a file that
 * fails there is corrupt, and a viewer that silently dropped the bad geometry
 * would show a plausible but incomplete city. Rows that are unusable for
 * structural reasons (no id, no type) are skipped with a warning instead —
 * the spec makes both non-null, so this is defence against a hand-rolled file
 * rather than a path a valid one takes.
 */
export function decodeTableObjects(
  table: CityParquetTableData,
): Record<string, CityObject> {
  const objects: Record<string, CityObject> = {};
  const warnings = new DecodeWarnings();

  for (const row of table.rows) {
    const id = row.id;
    if (typeof id !== "string" || id === "") {
      warnings.report(
        "no-id",
        "skipped a row whose 'id' column is missing or not a string.",
        (more) => `${more} more row(s) were skipped for the same reason.`,
      );
      continue;
    }
    const storedType = row.object_type;
    if (typeof storedType !== "string" || storedType === "") {
      warnings.report(
        "no-object-type",
        `skipped object '${id}' — its 'object_type' column is missing or not a string.`,
        (more) => `${more} more row(s) were skipped for the same reason.`,
      );
      continue;
    }

    const geometry = readRowGeometry(row, table.geometryColumns, id, warnings);

    if (id in objects) {
      warnings.report(
        "duplicate-id",
        `object '${id}' appears more than once in this table; the later row wins.`,
        (more) => `${more} more object id(s) were duplicated.`,
      );
    }

    objects[id] = {
      id,
      objectType: cityJsonTypeForObjectType(storedType),
      attributes: readAttributes(row, table.footer, id, warnings),
      surfaces: geometry.surfaces,
      bbox: readBBox(row.bbox),
      children: readIdList(row.children),
      parents: readIdList(row.parents),
      lod: geometry.lod,
    };
  }

  warnings.flush();

  return objects;
}
