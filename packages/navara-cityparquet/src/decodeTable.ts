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
  SurfaceTexture,
  UV,
  Vec3,
} from "@cityjson/navara-core";
import type { CityFooter } from "./footer";
import { CityParquetError } from "./footer";
import type { PackageAppearance } from "./sidecars";
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
 * A map with NO prototype, for keys that come out of a third-party file.
 *
 * Every string key in this module — an object id, an attribute name, a diverted
 * `other_attributes` key, a semantic surface's attribute — is written by
 * whoever produced the file, and a plain `{}` gives those keys meanings they
 * must not have. `map["__proto__"] = value` invokes the inherited setter
 * instead of creating an entry, so the object silently vanishes and, worse, the
 * map's own prototype changes; `"constructor" in map` and
 * `"toString" in map` are both true on an empty `{}`, which turns an innocent
 * attribute name into a phantom collision. A null-prototype map has none of
 * those inherited members, so every key is just a key.
 */
function bareMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Own-property test that survives a hostile key. Used instead of `in` even on
 * a {@link bareMap} — the map is safe, but stating the intent at the call site
 * is what stops the next edit from reintroducing the bug — and it is REQUIRED
 * on the hyparquet row objects, which have an ordinary prototype: a
 * footer-declared attribute named `constructor` would otherwise read back
 * `Object` itself from a row that never carried the column.
 */
function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
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
 *
 * AN INT64 PAST 2^53 BECOMES A STRING, NOT A ROUNDED NUMBER. `Number()` is
 * exact only up to `Number.MAX_SAFE_INTEGER`; beyond it the nearest double is
 * a value that was never in the file (`Number(2n ** 63n - 1n)` is
 * 9223372036854775808), and nothing downstream can tell that it drifted.
 * Columns at that magnitude are identifiers, so a wrong NUMBER is traded for a
 * right STRING: it displays, filters, compares and shares as the id that was
 * written, at the cost of a type a rule cannot do arithmetic on — which is not
 * a thing anyone does to a key.
 */
function attributeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
      ? value.toString()
      : Number(value);
  }
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
  const attributes = bareMap<unknown>();
  for (const column of footer.attributes) {
    if (!hasOwn(row, column)) continue;
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
    if (hasOwn(attributes, key)) continue;
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
 * One `face_semantics` entry as an index into `surfaces`, or `null` for a face
 * that carries no semantics.
 *
 * A `bigint` is accepted because the column is `LIST<INT32>` in the reference
 * writer but nothing forces that: an INT64 list arrives from hyparquet as
 * bigints, and rejecting them would leave every face of that file `"unknown"`
 * — colour-by-semantics quietly dead on a file that renders perfectly. This is
 * the same conversion attribute cells already get. A non-integer or negative
 * index is not a usable index either; those are reported, not silently
 * swallowed.
 */
function semanticIndex(entry: unknown): number | null {
  const value = typeof entry === "bigint" ? Number(entry) : entry;
  if (typeof value !== "number") return null;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The `face_semantics` field: one index into `surfaces` per WKB face, flat
 * across every shell and solid member (the writer flattens; only `shells`,
 * which this viewer does not need, could re-nest it).
 *
 * The two ways this can go quiet are both reported, because the symptom of
 * either — every surface `"unknown"` — looks exactly like a file that simply
 * has no semantics: entries of a type that is not an index at all, and a
 * non-empty list that yields no usable index. The second fires on a legitimate
 * all-null list too; the message says only what is true (the faces are
 * unlabelled), and `DecodeWarnings` caps it at two console lines per file.
 */
function readFaceSemantics(
  props: unknown,
  id: string,
  columnName: string,
  warnings: DecodeWarnings,
): ReadonlyArray<number | null> | null {
  if (!isPlainObject(props)) return null;
  const raw = props.face_semantics;
  if (!Array.isArray(raw)) return null;

  let unreadable = 0;
  let usable = 0;
  const indices = raw.map((entry: unknown) => {
    const index = semanticIndex(entry);
    if (index !== null) {
      usable += 1;
      return index;
    }
    if (!isEmptyCell(entry)) unreadable += 1;
    return null;
  });

  if (unreadable > 0) {
    warnings.report(
      "face-semantics-unreadable",
      `the 'face_semantics' of object '${id}' in '${columnName}' has ${unreadable} entr(y/ies) that are not usable surface indices, so those faces are unlabelled.`,
      (more) =>
        `${more} more geometr(y/ies) had unreadable 'face_semantics' entries.`,
    );
  } else if (usable === 0 && indices.length > 0) {
    warnings.report(
      "face-semantics-unlabelled",
      `object '${id}' has a 'face_semantics' list in '${columnName}' with no usable index, so its faces are unlabelled.`,
      (more) =>
        `${more} more geometr(y/ies) had no usable 'face_semantics' index.`,
    );
  }
  return indices;
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
  if (def === undefined) return bareMap<unknown>();
  const attributes = bareMap<unknown>();
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

/**
 * A geometry column's appearance cells, parsed once per row: the
 * `material_*` cell is `{ theme: { values: [id|null per face] } | { value } }`,
 * the `texture_*` cell `{ theme: { values: [ per face: [ per ring:
 * [textureId, [u, v], …] | [null] ] ] } }` with sidecar ids and inline UVs.
 */
interface FaceAppearanceSource {
  readonly material: Record<string, unknown> | null;
  readonly texture: Record<string, unknown> | null;
}

function parseAppearanceCell(cell: unknown): Record<string, unknown> | null {
  if (isEmptyCell(cell)) return null;
  const parsed: unknown = typeof cell === "string" ? tryParseJson(cell) : cell;
  return isPlainObject(parsed) ? parsed : null;
}

/** The surface-level appearance of face `faceIndex`, or nothing. */
function faceAppearance(
  source: FaceAppearanceSource,
  faceIndex: number,
  rings: ReadonlyArray<ReadonlyArray<Vec3>>,
  appearance: PackageAppearance,
): { material?: Record<string, number>; texture?: Record<string, SurfaceTexture> } {
  const out: {
    material?: Record<string, number>;
    texture?: Record<string, SurfaceTexture>;
  } = {};
  for (const [theme, ref] of Object.entries(source.material ?? {})) {
    if (!isPlainObject(ref)) continue;
    const raw =
      ref.value !== undefined
        ? ref.value
        : Array.isArray(ref.values)
          ? ref.values[faceIndex]
          : undefined;
    const sidecarId = semanticIndex(raw);
    if (sidecarId === null) continue;
    const local = appearance.materialLocalById.get(sidecarId);
    const index = local === undefined ? undefined : appearance.ctx.materialRemap[local];
    if (index === undefined || index < 0) continue;
    (out.material ??= {})[theme] = index;
    appearance.ctx.materialThemes.add(theme);
  }
  for (const [theme, ref] of Object.entries(source.texture ?? {})) {
    if (!isPlainObject(ref) || !Array.isArray(ref.values)) continue;
    const face = ref.values[faceIndex];
    if (!Array.isArray(face) || face.length === 0) continue;
    const exterior = face[0];
    if (!Array.isArray(exterior)) continue;
    const sidecarId = semanticIndex(exterior[0]);
    if (sidecarId === null) continue;
    const local = appearance.textureLocalById.get(sidecarId);
    const textureIndex =
      local === undefined ? undefined : appearance.ctx.textureRemap[local];
    if (textureIndex === undefined || textureIndex < 0) continue;
    const uvs: UV[][] = [];
    let ok = true;
    for (let r = 0; r < rings.length; r++) {
      const ringValues = face[r];
      if (!Array.isArray(ringValues)) {
        ok = false;
        break;
      }
      const pairs = ringValues.slice(1);
      // WKB rings come back with the closing vertex stripped; a writer that
      // wrote one UV per WKB point (closing included) is one pair long.
      const n = rings[r]!.length;
      if (pairs.length !== n && pairs.length !== n + 1) {
        ok = false;
        break;
      }
      const ringUvs: UV[] = [];
      for (let k = 0; k < n; k++) {
        const pair = pairs[k];
        if (
          !Array.isArray(pair) ||
          typeof pair[0] !== "number" ||
          typeof pair[1] !== "number"
        ) {
          ok = false;
          break;
        }
        ringUvs.push([pair[0], pair[1]]);
      }
      if (!ok) break;
      uvs.push(ringUvs);
    }
    if (!ok) continue;
    (out.texture ??= {})[theme] = { textureIndex, uvs };
    appearance.ctx.textureThemes.add(theme);
  }
  return out;
}

function readRowGeometry(
  row: Record<string, unknown>,
  geometryColumns: ReadonlyArray<GeometryColumnRef>,
  id: string,
  warnings: DecodeWarnings,
  appearance: PackageAppearance | null,
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
    const faceSemantics = readFaceSemantics(props, id, column.name, warnings);
    const appearanceSource: FaceAppearanceSource | null =
      appearance && (column.materialName || column.textureName)
        ? {
            material: column.materialName
              ? parseAppearanceCell(row[column.materialName])
              : null,
            texture: column.textureName
              ? parseAppearanceCell(row[column.textureName])
              : null,
          }
        : null;

    // `faces` is flat across every shell and every solid member, and so is
    // `face_semantics` — one index pairs them (the `shells` field exists to
    // re-nest them, which a flat surface list never needs).
    for (const [index, face] of decoded.faces.entries()) {
      const semanticIndex = faceSemantics?.[index];
      const definition =
        semanticIndex !== undefined && semanticIndex !== null && definitions
          ? definitions[semanticIndex]
          : undefined;
      const extra =
        appearanceSource && appearance
          ? faceAppearance(appearanceSource, index, face, appearance)
          : {};
      surfaces.push({
        type: resolveSurfaceType(definition),
        // Already unclosed rings of absolute source-CRS coordinates — exactly
        // what `buildCityMeshArrays` triangulates.
        rings: face,
        attributes: resolveSurfaceAttributes(definition),
        lod: column.lod,
        ...extra,
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
  appearance: PackageAppearance | null = null,
): Record<string, CityObject> {
  const objects = bareMap<CityObject>();
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

    const geometry = readRowGeometry(
      row,
      table.geometryColumns,
      id,
      warnings,
      appearance,
    );

    if (hasOwn(objects, id)) {
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
