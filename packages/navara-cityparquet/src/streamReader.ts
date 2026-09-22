/**
 * The engine-free CityParquet stream reader: open a package's tables through
 * range buffers, index their families, and read whole families by row range.
 *
 * Opening reads, per table, the Parquet footer and then the `bbox` and
 * `parents` columns ONE ROW GROUP AT A TIME, packing them straight into typed
 * arrays (six `Float64Array`s and a `Uint8Array`, 49 bytes a row) — never a
 * whole table of JS row objects. It enforces one source EPSG across the
 * tables, picks the stream's metric CRS once (for EPSG:6697 the UTM zone of
 * the caller's centre, else of the source extent's centre), projects the
 * packed boxes into it, and refuses a stream whose projected extent is not
 * finite and non-degenerate.
 *
 * `readRows` reads the identity columns, the footer's attribute columns,
 * `other_attributes` and every geometry column (with its semantic-surface
 * sibling) up to a LoD, for row ranges only — with `useOffsetIndex`, so a
 * range inside a row group decodes just the pages covering it. Appearance
 * columns are never read: a stream draws no textures. Every batch is
 * projected into the stream's CRS before it is yielded.
 *
 * A batch holds every row of its range, including the rows of a merge gap
 * (families the query did not hit, and rows without a bbox) — the caller
 * places objects by their own bbox and must tolerate those.
 *
 * Engine-free: no `@navaramap/*` imports.
 */

import type { BBox3, CityObject } from "@cityjson/navara-core";
import { NonMetricCrsError } from "@cityjson/navara-core";
import { decodeTableObjects, readBBox } from "./decodeTable";
import type { FamilyColumns, FamilyIndex, FamilyRange } from "./familyIndex";
import { buildFamilyIndex } from "./familyIndex";
import { CityParquetError } from "./footer";
import type { CoordinateTarget } from "./geographicToProjected";
import {
  coordinateTargetFor,
  isIdentityTarget,
  projectBBox,
  projectCityObjects,
} from "./geographicToProjected";
import type { RangeBuffer } from "./rangeSource";
import type { CityParquetSchema, GeometryColumnRef } from "./tableReader";
import {
  buildProjection,
  readCityParquetRows,
  readCityParquetSchema,
} from "./tableReader";

/** Why an open refused a source it could read: the stream cannot be placed. */
export type AdmissionRefusedCode =
  "mixed-crs" | "degenerate-extent" | "non-metric-crs";

/**
 * An open that read the source but will not stream it. A `CityParquetError`
 * (so the package's "every error is a CityParquetError" invariant holds)
 * carrying a machine-readable `code` the worker adapter maps to an admission
 * refusal.
 */
export class AdmissionRefusedError extends CityParquetError {
  constructor(
    readonly code: AdmissionRefusedCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AdmissionRefusedError";
  }
}

export interface StreamRow {
  readonly table: number;
  readonly row: number;
  /** Id of the family's first row: its root, or a leading non-root row at a
   *  table's start. */
  readonly familyRoot: string;
}

export interface ReadBatch {
  readonly objects: Record<string, CityObject>;
  readonly rows: ReadonlyMap<string, StreamRow>;
}

export interface CityParquetStreamHeader {
  version: string;
  /** Rows across every table, valid bbox or not. */
  objectsCount: number;
  /** In the stream's projected CRS. */
  extent: BBox3;
  /** The stream's (projected, metric) EPSG code. */
  epsg: number;
  referenceSystem: string;
  /** Display LoDs of the geometry columns, ascending (`"0"`, `"2.2"`). */
  lods: string[];
  /** Whether any table carries a geometry column with no LoD in its name (a
   *  bare `geometry` column). Its surfaces decode with `lod: null`, so a
   *  selection built only from {@link lods} would draw none of them — the
   *  worker adapter folds this into its bake selection as the lowest rung
   *  (Codex milestone review, Important). */
  unlabelledGeometry: boolean;
  invalidBBoxRows: number;
}

export interface CityParquetStream {
  readonly header: CityParquetStreamHeader;
  readonly index: FamilyIndex;
  /** One batch per FamilyRange; `rows` keys are object ids (task 4 of the
   *  roadmap reuses them for attribute lookups). Each range must start at a
   *  family boundary (as `index.query` output does), or `familyRoot` labels
   *  its first row as a root. `maxLod` compares numerically (`"2"` excludes
   *  `"2.2"`), so pass a value from `header.lods`; `null` reads every LoD.
   *
   *  Callers must SERIALISE requests: `signal` is installed on every buffer
   *  of the stream (`RangeBuffer.setSignal`), so a newer request's signal
   *  supersedes the older one's for every slice read after it — the older
   *  request's remaining reads then run under the newer signal. The stream
   *  worker core already aborts the previous request before it starts the
   *  next probe or fetch, which is the serialisation this relies on. */
  readRows(
    ranges: ReadonlyArray<FamilyRange>,
    maxLod: string | null,
    signal: AbortSignal,
  ): AsyncIterable<ReadBatch>;
}

/** Rows decoded between two abort checks. */
const DECODE_CHUNK_ROWS = 256;

/** One opened table: its buffer, schema, row-group layout and root flags. */
interface OpenTable {
  readonly buffer: RangeBuffer;
  readonly schema: CityParquetSchema;
  readonly rowCount: number;
  /** First row of each row group, plus a final entry equal to `rowCount`. */
  readonly rowGroupStarts: ReadonlyArray<number>;
  readonly isRoot: Uint8Array;
}

/**
 * Throws unless a row-range read returned exactly `rowEnd - rowStart` rows:
 * every packed column and every row-number lookup (`isRoot`, `familyRoot`)
 * indexes by `rowStart + i`, so a short or long read would silently shift
 * rows onto the wrong entries.
 */
export function assertRowCount(
  actual: number,
  rowStart: number,
  rowEnd: number,
): void {
  if (actual === rowEnd - rowStart) return;
  throw new CityParquetError(
    `This CityParquet table returned ${String(actual)} rows for rows ${String(rowStart)}..${String(rowEnd)} (expected ${String(rowEnd - rowStart)}); the file is inconsistent with its own row-group metadata.`,
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function rowGroupStartsOf(schema: CityParquetSchema): number[] {
  const starts = [0];
  for (const group of schema.metadata.row_groups) {
    starts.push(starts[starts.length - 1]! + Number(group.num_rows));
  }
  return starts;
}

/** Whether a `parents` cell names at least one parent. */
function hasParents(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((item: unknown) => typeof item === "string")
  );
}

/** The one EPSG code every table declares, or a refusal. */
function consensusSourceEpsg(
  schemas: ReadonlyArray<CityParquetSchema>,
): number {
  const codes = schemas.map((s) => s.footer.epsg);
  const missing = codes.findIndex((c) => c === null);
  if (missing >= 0) {
    throw new AdmissionRefusedError(
      "non-metric-crs",
      `This CityParquet source cannot be placed: table ${missing + 1} declares no EPSG coordinate reference system.`,
    );
  }
  const first = codes[0]!;
  const other = codes.find((c) => c !== first);
  if (other !== undefined) {
    throw new AdmissionRefusedError(
      "mixed-crs",
      `This CityParquet source's tables declare different coordinate reference systems (EPSG:${String(first)} and EPSG:${String(other)}); every table of a stream must share one.`,
    );
  }
  return first!;
}

/**
 * Reads one table's `bbox` + `parents` into packed columns, a row group at a
 * time. A missing or partial bbox packs as NaN (an invalid row).
 */
async function packFamilyColumns(
  buffer: RangeBuffer,
  schema: CityParquetSchema,
  rowGroupStarts: ReadonlyArray<number>,
): Promise<FamilyColumns> {
  const n = rowGroupStarts[rowGroupStarts.length - 1]!;
  const cols = {
    minX: new Float64Array(n).fill(Number.NaN),
    minY: new Float64Array(n).fill(Number.NaN),
    minZ: new Float64Array(n).fill(Number.NaN),
    maxX: new Float64Array(n).fill(Number.NaN),
    maxY: new Float64Array(n).fill(Number.NaN),
    maxZ: new Float64Array(n).fill(Number.NaN),
    isRoot: new Uint8Array(n).fill(1),
  };
  const present = new Set(schema.schemaColumns);
  const columns = ["bbox", "parents"].filter((c) => present.has(c));
  if (columns.length === 0) return cols;

  for (let g = 0; g + 1 < rowGroupStarts.length; g++) {
    const rowStart = rowGroupStarts[g]!;
    const rowEnd = rowGroupStarts[g + 1]!;
    if (rowEnd === rowStart) continue;
    const rows = await readCityParquetRows(buffer, schema.metadata, columns, {
      rowStart,
      rowEnd,
    });
    assertRowCount(rows.length, rowStart, rowEnd);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const r = rowStart + i;
      cols.isRoot[r] = hasParents(row.parents) ? 0 : 1;
      const bbox = readBBox(row.bbox);
      if (bbox === null) continue;
      cols.minX[r] = bbox[0];
      cols.minY[r] = bbox[1];
      cols.minZ[r] = bbox[2];
      cols.maxX[r] = bbox[3];
      cols.maxY[r] = bbox[4];
      cols.maxZ[r] = bbox[5];
    }
  }
  return cols;
}

/** The 2D centre of every finite packed box, or null when there is none. */
function sourceCentre(
  columns: ReadonlyArray<FamilyColumns>,
): [number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const cols of columns) {
    for (let i = 0; i < cols.isRoot.length; i++) {
      const a = cols.minX[i]!;
      const b = cols.minY[i]!;
      const c = cols.maxX[i]!;
      const d = cols.maxY[i]!;
      if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c)) continue;
      if (Number.isNaN(d)) continue;
      x0 = Math.min(x0, a);
      y0 = Math.min(y0, b);
      x1 = Math.max(x1, c);
      y1 = Math.max(y1, d);
    }
  }
  return x0 <= x1 && y0 <= y1 ? [(x0 + x1) / 2, (y0 + y1) / 2] : null;
}

/** Projects every valid packed box into `target`, in place. */
function projectPackedBoxes(
  cols: FamilyColumns,
  target: CoordinateTarget,
): void {
  for (let i = 0; i < cols.isRoot.length; i++) {
    const box: BBox3 = [
      cols.minX[i]!,
      cols.minY[i]!,
      cols.minZ[i]!,
      cols.maxX[i]!,
      cols.maxY[i]!,
      cols.maxZ[i]!,
    ];
    if (!box.every(Number.isFinite)) continue;
    const p = projectBBox(box, target);
    cols.minX[i] = p[0];
    cols.minY[i] = p[1];
    cols.maxX[i] = p[3];
    cols.maxY[i] = p[4];
  }
}

function targetFor(
  sourceEpsg: number,
  centre: readonly [number, number] | null,
): CoordinateTarget {
  try {
    return coordinateTargetFor(sourceEpsg, centre);
  } catch (cause) {
    if (cause instanceof NonMetricCrsError) {
      throw new AdmissionRefusedError("non-metric-crs", cause.message, {
        cause,
      });
    }
    throw cause;
  }
}

function isNonDegenerate(extent: BBox3): boolean {
  return (
    extent.every(Number.isFinite) &&
    extent[3] > extent[0] &&
    extent[4] > extent[1]
  );
}

function lodAllowed(lod: string | null, maxLod: string | null): boolean {
  return maxLod === null || lod === null || Number(lod) <= Number(maxLod);
}

/** Geometry columns up to `maxLod`, stripped of their appearance columns. */
function streamGeometryColumns(
  schema: CityParquetSchema,
  maxLod: string | null,
): GeometryColumnRef[] {
  return schema.geometryColumns
    .filter((g) => lodAllowed(g.lod, maxLod))
    .map((g) => ({ ...g, materialName: null, textureName: null }));
}

/** `range` split at row-group boundaries. */
function piecesOf(
  range: FamilyRange,
  rowGroupStarts: ReadonlyArray<number>,
): { rowStart: number; rowEnd: number }[] {
  const pieces: { rowStart: number; rowEnd: number }[] = [];
  for (let g = 0; g + 1 < rowGroupStarts.length; g++) {
    const rowStart = Math.max(range.start, rowGroupStarts[g]!);
    const rowEnd = Math.min(range.end, rowGroupStarts[g + 1]!);
    if (rowStart < rowEnd) pieces.push({ rowStart, rowEnd });
  }
  return pieces;
}

export async function openCityParquetStream(
  buffers: ReadonlyArray<RangeBuffer>,
  opts: { lngLatCentre?: readonly [number, number] } = {},
): Promise<CityParquetStream> {
  if (buffers.length === 0) {
    throw new CityParquetError(
      "This CityParquet source has no object tables, so there is nothing to stream.",
    );
  }

  const schemas: CityParquetSchema[] = [];
  for (const buffer of buffers)
    schemas.push(await readCityParquetSchema(buffer));
  const sourceEpsg = consensusSourceEpsg(schemas);

  const packed: FamilyColumns[] = [];
  const tables: OpenTable[] = [];
  for (const [i, schema] of schemas.entries()) {
    const rowGroupStarts = rowGroupStartsOf(schema);
    const cols = await packFamilyColumns(buffers[i]!, schema, rowGroupStarts);
    packed.push(cols);
    tables.push({
      buffer: buffers[i]!,
      schema,
      rowCount: rowGroupStarts[rowGroupStarts.length - 1]!,
      rowGroupStarts,
      isRoot: cols.isRoot,
    });
  }

  const target = targetFor(
    sourceEpsg,
    opts.lngLatCentre ?? sourceCentre(packed),
  );
  if (!isIdentityTarget(target)) {
    for (const cols of packed) projectPackedBoxes(cols, target);
  }
  const index = buildFamilyIndex(packed);
  if (!isNonDegenerate(index.extent)) {
    throw new AdmissionRefusedError(
      "degenerate-extent",
      index.rowCount === 0
        ? "This CityParquet source cannot be placed: no row has a usable bounding box."
        : "This CityParquet source cannot be placed: its objects' bounding boxes span no area.",
    );
  }

  const lods = [
    ...new Set(
      schemas.flatMap((s) =>
        s.geometryColumns
          .map((g) => g.lod)
          .filter((l): l is string => l !== null),
      ),
    ),
  ].sort((a, b) => Number(a) - Number(b));

  const unlabelledGeometry = schemas.some((s) =>
    s.geometryColumns.some((g) => g.lod === null),
  );

  const header: CityParquetStreamHeader = {
    version: schemas[0]!.footer.version,
    objectsCount: tables.reduce((n, t) => n + t.rowCount, 0),
    extent: index.extent,
    epsg: target.epsg,
    referenceSystem: `https://www.opengis.net/def/crs/EPSG/0/${String(target.epsg)}`,
    lods,
    unlabelledGeometry,
    invalidBBoxRows: index.invalidBBoxRows,
  };

  async function* readRows(
    ranges: ReadonlyArray<FamilyRange>,
    maxLod: string | null,
    signal: AbortSignal,
  ): AsyncGenerator<ReadBatch> {
    for (const buffer of buffers) buffer.setSignal(signal);
    const columnsByTable = new Map<
      number,
      { columns: string[]; geometryColumns: GeometryColumnRef[] }
    >();

    for (const range of ranges) {
      throwIfAborted(signal);
      const table = tables[range.table];
      if (
        table === undefined ||
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end > table.rowCount ||
        range.start >= range.end
      ) {
        throw new CityParquetError(
          `readRows: range ${JSON.stringify(range)} is outside the stream's tables.`,
        );
      }
      let projection = columnsByTable.get(range.table);
      if (projection === undefined) {
        const { schema } = table;
        const geometryColumns = streamGeometryColumns(schema, maxLod);
        projection = {
          geometryColumns,
          columns: buildProjection(
            schema.schemaColumns,
            schema.footer,
            geometryColumns,
          ),
        };
        columnsByTable.set(range.table, projection);
      }

      const objects: Record<string, CityObject> = Object.create(null);
      const rows = new Map<string, StreamRow>();
      let familyRoot = "";
      for (const piece of piecesOf(range, table.rowGroupStarts)) {
        throwIfAborted(signal);
        let raw: Record<string, unknown>[];
        try {
          raw = await readCityParquetRows(
            table.buffer,
            table.schema.metadata,
            projection.columns,
            piece,
          );
        } catch (error) {
          // An abort whose reason is not named "AbortError" would reach here
          // wrapped as a corrupt-file error; the signal is the authority.
          throwIfAborted(signal);
          throw error;
        }
        assertRowCount(raw.length, piece.rowStart, piece.rowEnd);
        for (let off = 0; off < raw.length; off += DECODE_CHUNK_ROWS) {
          throwIfAborted(signal);
          const chunk = raw.slice(off, off + DECODE_CHUNK_ROWS);
          const decoded = decodeTableObjects({
            footer: table.schema.footer,
            rows: chunk,
            geometryColumns: projection.geometryColumns,
          });
          for (let i = 0; i < chunk.length; i++) {
            const row = piece.rowStart + off + i;
            const id = chunk[i]!.id;
            const key = typeof id === "string" ? id : "";
            if (row === range.start || table.isRoot[row] === 1) {
              familyRoot = key;
            }
            const object = key === "" ? undefined : decoded[key];
            if (object === undefined) continue;
            objects[key] = object;
            rows.set(key, { table: range.table, row, familyRoot });
          }
        }
      }
      projectCityObjects(objects, target);
      yield { objects, rows };
    }
  }

  return { header, index, readRows };
}
