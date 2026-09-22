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
  | "non-finite";

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
   *  (`lod`), CityParquet bakes the highest available ≤ lod (an array). */
  bakeLod(
    lod: string | null,
    lodsSeen: ReadonlyArray<string>,
  ): string | readonly string[] | null;
  close(): void;
}
