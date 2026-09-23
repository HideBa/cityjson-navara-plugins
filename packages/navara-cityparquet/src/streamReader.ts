/**
 * The engine-free CityParquet stream reader: open a package's tables through
 * range buffers, index their families, and read whole families by row range.
 *
 * Opening reads, per table, the Parquet footer and then the `bbox` and
 * `parents` columns ONE ROW GROUP AT A TIME, packing them straight into typed
 * arrays (six `Float64Array`s and a `Uint8Array`, 49 bytes a row) — never a
 * whole table of JS row objects. It enforces one source EPSG across the
 * tables, picks the stream's INDEX space once, converts the packed boxes into
 * it, and refuses a stream whose converted extent is not finite and
 * non-degenerate.
 *
 * The index space is `"bucket"` (`geographicToProjected`): a projected source
 * indexes in its own metric CRS, unchanged; a GEOGRAPHIC one (EPSG:6697)
 * indexes in navara-core's pinned local metric frame about the source extent's
 * centre (or the caller's), which costs arithmetic instead of a proj4 call per
 * row — about 4 s of Yokohama's 7.2 s open. The header then reports
 * `epsg: null` and the frame's descriptor.
 *
 * `readRows` reads the identity columns, the footer's attribute columns,
 * `other_attributes` and every geometry column (with its semantic-surface
 * sibling) up to a LoD, for row ranges only — with `useOffsetIndex`, so a
 * range inside a row group decodes just the pages covering it. Appearance
 * columns are never read: a stream draws no textures. A batch of a PROJECTED
 * source is projected into the stream's CRS before it is yielded; a batch of a
 * geographic one is NOT — its rings and bboxes stay lon/lat/h doubles, because
 * the worker converts each cell into that cell's own ENU frame, and a vertex
 * that went through a dataset-wide frame first would have been placed twice.
 *
 * A batch holds every row of its range, including the rows of a merge gap
 * (families the query did not hit, and rows without a bbox) — the caller
 * places objects by their own bbox and must tolerate those.
 *
 * Engine-free: no `@navaramap/*` imports.
 */

import type {
  BBox3,
  CityObject,
  LocalMetricFrameDescriptor,
} from "@cityjson/navara-core";
import { NonMetricCrsError } from "@cityjson/navara-core";
import { decodeTableObjects, readBBox } from "./decodeTable";
import type { FamilyColumns, FamilyIndex, FamilyRange } from "./familyIndex";
import { buildFamilyIndex } from "./familyIndex";
import { CityParquetError } from "./footer";
import type { CoordinateTarget } from "./geographicToProjected";
import {
  coordinateTargetFor,
  isBucketTarget,
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

/** One opened table of a stream, as the header reports it. */
export interface CityParquetStreamTable {
  /**
   * The table's identifying name: its buffer's (`RangeBuffer.name` — a URL's
   * last path segment, a File's name), or `table-<i>` with its ZERO-BASED
   * index for a source that carries none, so the name matches the `table`
   * field of `FamilyRange` and `StreamRow`. A label, not an identity: the
   * caller that supplied the buffers is the one that knows which family each
   * one is (`CityParquetManifest.families`).
   */
  name: string;
  /** The table's own `num_rows`, valid bbox or not. */
  rowCount: number;
}

export interface CityParquetStreamHeader {
  version: string;
  /** Rows across every table, valid bbox or not — the sum of
   *  {@link tables}' row counts. */
  objectsCount: number;
  /** Each table of the stream, in the order its buffer was passed. A per-table
   *  breakdown of {@link objectsCount}: one object family per table, so the
   *  sum alone cannot say how many of the rows are buildings. */
  tables: ReadonlyArray<CityParquetStreamTable>;
  /** In the stream's index space: its projected metric CRS when {@link epsg}
   *  is set, else bucket metres about {@link frame}'s origin. */
  extent: BBox3;
  /** The stream's (projected, metric) EPSG code, or `null` when it indexes in
   *  bucket space — no EPSG code names a local metric frame, and a code that
   *  did not describe {@link extent} would be worse than none. */
  epsg: number | null;
  /** The bucket frame {@link extent} and {@link CityParquetStream.index} are
   *  expressed in, as a `structuredClone`-able descriptor for the worker
   *  boundary; `null` exactly when {@link epsg} is set. */
  frame: LocalMetricFrameDescriptor | null;
  /** PROVENANCE, not the index space: the CRS the source's own coordinates
   *  are in — which, for a bucket-space stream, is also the CRS its batches'
   *  rings still arrive in. */
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
  /**
   * What {@link readRows} would PLAN to fetch for `ranges` at `maxLod`, in
   * bytes, from the footer alone — so a caller can refuse a fetch BEFORE a
   * single slice is read.
   *
   * Row limits do not bound bytes: `useOffsetIndex` is requested, never
   * required, and a chunk written without a page index is read WHOLE however
   * few of its rows a range names. A single-row-group table can therefore
   * serve hundreds of megabytes to a one-family fetch that passes every row
   * gate (Codex milestone review, Critical).
   *
   * Per touched row group and per selected column chunk: with an offset
   * index, `total_compressed_size` scaled by the fraction of the group's rows
   * the ranges select; without one, the whole `total_compressed_size`. A chunk
   * that declares no size at all is charged the group's own
   * `total_compressed_size` divided by its column count, and when the GROUP
   * declares no size either, each selected chunk of it is charged the whole
   * file — so such a group costs a multiple of the file, not a fraction of it.
   * Overshooting on purpose: "unknown" must never read as "free".
   *
   * It is an ESTIMATE, not a ceiling, and it is asymmetric — which is the
   * point:
   *
   * - A chunk WITHOUT an offset index is charged whole, which is what
   *   hyparquet really reads. That is the case the gate exists for (one huge
   *   row group, or a file written with no page index), and there the estimate
   *   is tight.
   * - A chunk WITH an offset index is charged its row fraction, and a real
   *   indexed read fetches whole PAGES plus the offset index itself, so it
   *   costs more than that fraction. Measured: the Yokohama 1 km viewport
   *   (6 199 rows of 884 106) plans 2.45 MB and reads 12.83 MB — a factor of
   *   5.2 low. The package's fixtures (256-byte pages, 8-row groups) run about
   *   2x low, which is what `streamReader.test.ts` pins (a factor of 4 either
   *   way, on both fixtures).
   *
   * So a 96 MiB gate over this number is roughly a 500 MB gate over an indexed
   * read, and a 96 MiB gate over an unindexed one. Reads that skip pages are
   * bounded by the row gates anyway; the unbounded case is the one this makes
   * refusable. Tightening it would mean reading each chunk's offset index to
   * count pages — a read of its own, on the path this is meant to protect.
   */
  estimateReadBytes(
    ranges: ReadonlyArray<FamilyRange>,
    maxLod: string | null,
  ): number;
}

/** Rows decoded between two abort checks. */
const DECODE_CHUNK_ROWS = 256;

/** The columns one table is read with at a given LoD ceiling. */
interface TableProjection {
  readonly columns: string[];
  readonly geometryColumns: GeometryColumnRef[];
}

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

/**
 * Converts every valid packed box into `target`'s space, in place — all four
 * horizontal corners each, since neither a projected nor a bucket rectangle is
 * the axis-aligned box of two of them.
 */
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
    // "bucket": the streamed path's index space. It is the projected source's
    // own CRS for anything already metric, so this is a change for EPSG:6697
    // only.
    return coordinateTargetFor(sourceEpsg, centre, "bucket");
  } catch (cause) {
    // `RangeError` too: `makeLocalMetricFrame` refuses a centre past +/-89.9
    // degrees, where cos(phi0) collapses and the frame stops being invertible.
    // Both mean the same thing to a caller — this source has no usable metric
    // index space — and an unwrapped RangeError reached the worker as an
    // unexplained failure instead of a refusal (Task 2 review, Minor).
    if (cause instanceof NonMetricCrsError || cause instanceof RangeError) {
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
    tables: tables.map((t, i) => ({
      name: t.buffer.name ?? `table-${String(i)}`,
      rowCount: t.rowCount,
    })),
    extent: index.extent,
    epsg: target.epsg,
    frame: target.frame,
    // The source CRS when the index is a bucket frame (there is no EPSG for
    // that), the target CRS otherwise — in both cases the CRS the yielded
    // rings are in.
    referenceSystem: `https://www.opengis.net/def/crs/EPSG/0/${String(target.epsg ?? target.sourceEpsg)}`,
    lods,
    unlabelledGeometry,
    invalidBBoxRows: index.invalidBBoxRows,
  };

  /** The columns one table is read with at `maxLod`, memoised per call. */
  function projectionsFor(
    maxLod: string | null,
  ): (index: number) => TableProjection {
    const cache = new Map<number, TableProjection>();
    return (index) => {
      let projection = cache.get(index);
      if (projection === undefined) {
        const { schema } = tables[index]!;
        const geometryColumns = streamGeometryColumns(schema, maxLod);
        projection = {
          geometryColumns,
          columns: buildProjection(
            schema.schemaColumns,
            schema.footer,
            geometryColumns,
          ),
        };
        cache.set(index, projection);
      }
      return projection;
    };
  }

  function estimateReadBytes(
    ranges: ReadonlyArray<FamilyRange>,
    maxLod: string | null,
  ): number {
    const projectionOf = projectionsFor(maxLod);
    // Rows selected per (table, row group), so overlapping or adjacent ranges
    // inside one group are charged for that group once.
    const selected = new Map<string, number>();
    for (const range of ranges) {
      const table = tables[range.table];
      if (table === undefined) continue;
      for (let g = 0; g + 1 < table.rowGroupStarts.length; g++) {
        const rowStart = Math.max(range.start, table.rowGroupStarts[g]!);
        const rowEnd = Math.min(range.end, table.rowGroupStarts[g + 1]!);
        if (rowStart >= rowEnd) continue;
        const key = `${String(range.table)}:${String(g)}`;
        selected.set(key, (selected.get(key) ?? 0) + (rowEnd - rowStart));
      }
    }

    let total = 0;
    for (const [key, rows] of selected) {
      const [t, g] = key.split(":").map(Number) as [number, number];
      const table = tables[t]!;
      const group = table.schema.metadata.row_groups[g]!;
      const groupRows = Number(group.num_rows);
      const fraction = groupRows > 0 ? Math.min(1, rows / groupRows) : 1;
      const wanted = new Set(projectionOf(t).columns);
      // A group that declares no size of its own, and whose chunks declare
      // none either, is charged the whole file: unknown is never free.
      const perChunkFallback =
        group.total_compressed_size === undefined
          ? table.buffer.byteLength
          : Number(group.total_compressed_size) /
            Math.max(1, group.columns.length);
      for (const chunk of group.columns) {
        const meta = chunk.meta_data;
        if (!meta || !wanted.has(meta.path_in_schema[0] ?? "")) continue;
        const size =
          meta.total_compressed_size === undefined
            ? perChunkFallback
            : Number(meta.total_compressed_size);
        // `offset_index_offset` is what hyparquet's `useOffsetIndex` needs to
        // skip pages; without it the chunk is read whole. A bigint 0 is a
        // legal (if odd) offset, so the test is "declared", not "truthy".
        total += chunk.offset_index_offset === undefined ? size : size * fraction;
      }
    }
    return Math.ceil(total);
  }

  async function* readRows(
    ranges: ReadonlyArray<FamilyRange>,
    maxLod: string | null,
    signal: AbortSignal,
  ): AsyncGenerator<ReadBatch> {
    for (const buffer of buffers) buffer.setSignal(signal);
    const projectionOf = projectionsFor(maxLod);

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
      const projection = projectionOf(range.table);

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
      // A bucket target's coordinates are an INDEX: the batch keeps its source
      // lon/lat/h, and the worker converts each cell's families into that
      // cell's own ENU frame.
      if (!isBucketTarget(target)) projectCityObjects(objects, target);
      yield { objects, rows };
    }
  }

  return { header, index, readRows, estimateReadBytes };
}
