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
  /** In the stream's METRIC CRS. `undefined` exactly when the source carries
   *  no extent — callers must check the admission first; this model does not
   *  repeat that gate, so it never lies about having an extent it doesn't. */
  readonly extent: BBox3 | undefined;
  readonly referenceSystem: string | undefined;
  /** The metric EPSG code the cells are built in. */
  readonly epsg: number | null;
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
   *  whose objects intersect `bbox`, in the header's metric CRS. `lod` is
   *  the requested rung: the adapter may skip geometry above it. */
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
