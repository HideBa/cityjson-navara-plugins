/**
 * The seam between the format-agnostic stream worker core
 * (`streamWorkerCore.ts`) and one source format. The core owns the tile grid,
 * the cell cache, bucketing, baking and the whole worker protocol; an adapter
 * only opens a source, counts features in a box and decodes the features that
 * intersect it.
 */
import type {
  BBox3,
  CityAppearance,
  CityModel,
  LocalMetricFrameDescriptor,
} from "@cityjson/navara-core";
import type { CellOwnership } from "./bucketFeatures";
import type { WorkerRequest } from "./workerProtocol";

/** What the app reads from an opened stream: its extent, CRS and counts. */
export interface StreamHeader {
  readonly version: string;
  readonly featuresCount: number | undefined;
  /** Individual CityObjects in the dataset, when the format knows it up
   *  front. CityParquet sets it (the sum of its files' row counts);
   *  FlatCityBuf leaves it undefined, because `featuresCount` counts
   *  features (an object plus its parts), not objects. */
  readonly objectsCount?: number;
  /** The source's known LoDs, when the format knows them up front. The core
   *  folds them into every posted cell's `lodsSeen`. */
  readonly lods?: ReadonlyArray<string>;
  /** Per file of the source, its name and its own row count — a breakdown of
   *  `objectsCount`. CityParquet sets it (one object family per file, so the
   *  app can report a family's size before a row is read); a single-file format
   *  leaves it undefined. */
  readonly tables?: ReadonlyArray<{
    readonly name: string;
    readonly rowCount: number;
  }>;
  /** Whether the source carries geometry that names no LoD. CityParquet's
   *  reader computes it and the worker's own bake selection reads it from the
   *  stream; it is declared here because the posted header is the stream
   *  header's projection, and a field the worker posts must not be one this
   *  type denies exists. */
  readonly unlabelledGeometry?: boolean;
  /** Rows of the source that carry no usable bounding box and therefore can
   *  never be placed in a cell — counted by the format that indexes rows
   *  (CityParquet's family index), `undefined` where the format has no such
   *  notion. `objectsCount` counts them, so this is the difference between
   *  "not loaded yet" and "will never load" behind an `N of M loaded`. */
  readonly invalidBBoxRows?: number;
  /** In the stream's INDEX SPACE: its metric CRS when {@link epsg} is set,
   *  else bucket metres about {@link frame}'s origin. `undefined` exactly when
   *  the source carries no extent — callers must check the admission first;
   *  this model does not repeat that gate, so it never lies about having an
   *  extent it doesn't. */
  readonly extent: BBox3 | undefined;
  /** PROVENANCE: the CRS the source's own coordinates are in. For a
   *  frame-carrying source that is also the CRS `select`'s rings arrive in. */
  readonly referenceSystem: string | undefined;
  /** The metric EPSG code the index and the cells are built in, or `null` when
   *  the source indexes in a bucket frame instead — no EPSG code names a local
   *  metric frame, and one that did not describe {@link extent} would be worse
   *  than none. */
  readonly epsg: number | null;
  /**
   * The bucket frame {@link extent}, the tile grid and every record bbox are
   * expressed in, as a `structuredClone`-able descriptor (functions cannot
   * cross `postMessage`; each side rebuilds its transforms from this). Set
   * exactly when {@link epsg} is `null` — that pair is the positive contract
   * for a geographic source, which is admitted on the frame rather than on a
   * metric EPSG.
   *
   * It also says what `select` yields: with a frame, a model's rings are still
   * in the SOURCE CRS (lon/lat/h) and only its bboxes are in index space,
   * because the worker converts each cell's rings into that CELL's own ENU
   * frame — a vertex put through a dataset-wide frame first would have been
   * placed twice, and a frame that spans a city is not level (see
   * `docs/plans/2026-09-23-geographic-to-enu.md`).
   *
   * Absent (as opposed to `null`) for a format that has no such notion.
   */
  readonly frame?: LocalMetricFrameDescriptor | null;
}

export type AdmissionCode =
  | "no-extent"
  | "degenerate-extent"
  | "no-index"
  | "unknown-count"
  | "non-metric-crs"
  | "non-finite"
  | "unsupported"
  | "multi-source"
  | "mixed-crs"
  | "no-range";

/** Why a source cannot be streamed by viewport (`null` = admitted). */
export interface AdmissionError {
  readonly code: AdmissionCode;
  readonly message: string;
}

export interface OpenedSource {
  readonly header: StreamHeader;
  readonly admission: AdmissionError | null;
}

/** The `open` request as the worker receives it. */
export type OpenRequest = Extract<WorkerRequest, { type: "open" }>;

export interface StreamSourceAdapter {
  /** How the core files a decoded model's objects into cells (see
   *  `bucketFeatures`). Omitted means `"object"`. */
  readonly ownership?: CellOwnership;
  open(req: OpenRequest): Promise<OpenedSource>;
  probe(
    bbox: readonly [number, number, number, number],
    signal: AbortSignal,
  ): Promise<number>;
  /** Decoded features (one CityModel per feature: an object plus its parts)
   *  whose objects intersect `bbox`. Every BBOX — the model's and each
   *  object's — is in the header's index space, because that is what the tile
   *  grid and this `bbox` are in; RINGS are in the header's metric CRS too,
   *  unless the header carries a `frame`, in which case they are still the
   *  source's lon/lat/h and the worker places them per cell. `lod` is the
   *  requested rung: the adapter may skip geometry above it. */
  select(
    bbox: readonly [number, number, number, number],
    opts: { lod: string | null; signal: AbortSignal },
  ): AsyncIterable<CityModel>;
  /** Layer-wide appearance built so far (FlatCityBuf merges per feature);
   *  `undefined` when the format carries none. */
  appearance(): CityAppearance | undefined;
  /** How `fetch` bakes `lod`: FlatCityBuf keeps today's exact-LoD filter
   *  (`lod`), CityParquet bakes the highest available ≤ lod (an array). A
   *  `null` ELEMENT of that array is the builder's unlabelled rung — the
   *  surfaces of a geometry column that names no LoD — and ranks below every
   *  label (`lodSelection.ts`). */
  bakeLod(
    lod: string | null,
    lodsSeen: ReadonlyArray<string>,
  ): string | readonly (string | null)[] | null;
  close(): void;
}
