/**
 * The CityParquet source behind the stream worker core: opens a package's
 * object tables through range buffers (HTTP ranges or local Blobs), answers
 * probes from the family index without reading, and reads whole families by
 * row range for a fetch.
 *
 * Worker memory: the adapter holds the opened stream — its family index and
 * per-table row-group layout — and, during a fetch, only the batch being
 * decoded. Resident cell models belong to the core's cell cache and leave it
 * on `evict`.
 *
 * Engine-free: no `@navaramap/*` imports.
 */
import {
  AdmissionRefusedError,
  asyncBufferFromBlob,
  asyncBufferFromHttp,
  openCityParquetStream,
  RangeNotSupportedError,
  type CityParquetStream,
  type RangeBuffer,
  type ReadBatch,
} from "@cityjson/navara-cityparquet";
import {
  mergeBBox,
  type BBox3,
  type CityModel,
  type CityObject,
} from "@cityjson/navara-core";
import type {
  AdmissionError,
  OpenedSource,
  OpenRequest,
  StreamHeader,
  StreamSourceAdapter,
} from "./streamSourceAdapter";
import type { StreamSource } from "./workerProtocol";

/** A fetch whose query box would read more rows than this (hits plus merge
 *  gaps, `FamilyIndex.readCost`) is refused before anything is read. A fetch
 *  queries the union of its requested cells, which is larger than the
 *  footprint the planner probed, so the planner's own gate does not bound
 *  it. */
export const MAX_FETCH_READ_ROWS = 60_000;

export interface CityParquetSourceAdapterOptions {
  /** Overrides {@link MAX_FETCH_READ_ROWS} (tests). */
  readonly maxFetchReadRows?: number;
}

type Box2 = readonly [number, number, number, number];

const EMPTY_HEADER: StreamHeader = {
  version: "",
  featuresCount: undefined,
  extent: undefined,
  referenceSystem: undefined,
  epsg: null,
};

/** One range buffer per file of the source, in order. */
async function buffersOf(source: StreamSource): Promise<RangeBuffer[]> {
  if ("url" in source) return [await asyncBufferFromHttp(source.url)];
  if ("blob" in source) return [asyncBufferFromBlob(source.blob)];
  if ("urls" in source) {
    const out: RangeBuffer[] = [];
    for (const url of source.urls) out.push(await asyncBufferFromHttp(url));
    return out;
  }
  return source.blobs.map((blob) => asyncBufferFromBlob(blob));
}

/** Why an open failure is a refusal of the source, or `null` to rethrow. */
function admissionOf(error: unknown): AdmissionError | null {
  if (error instanceof RangeNotSupportedError) {
    return { code: "no-range", message: error.message };
  }
  if (error instanceof AdmissionRefusedError) {
    return { code: error.code, message: error.message };
  }
  return null;
}

function intersects2D(b: BBox3, q: Box2): boolean {
  return b[0] <= q[2] && b[3] >= q[0] && b[1] <= q[3] && b[4] >= q[1];
}

function countRingVertices(objects: ReadonlyArray<CityObject>): number {
  let total = 0;
  for (const object of objects) {
    for (const surface of object.surfaces) {
      for (const ring of surface.rings) total += ring.length;
    }
  }
  return total;
}

/**
 * A batch as one `CityModel` per family (`StreamRow.familyRoot`), keeping
 * only the families whose union bbox intersects `bbox`: a batch also holds
 * the rows of its merge gaps, which no viewport asked for. A family with no
 * object bbox cannot be placed and is dropped. `referenceSystem` (the
 * stream header's) is carried as each model's metadata.
 */
export function familyModels(
  batch: ReadBatch,
  bbox: Box2,
  referenceSystem?: string,
): CityModel[] {
  const families = new Map<string, CityObject[]>();
  for (const [id, object] of Object.entries(batch.objects)) {
    const root = batch.rows.get(id)?.familyRoot ?? id;
    let members = families.get(root);
    if (!members) {
      members = [];
      families.set(root, members);
    }
    members.push(object);
  }
  const out: CityModel[] = [];
  for (const members of families.values()) {
    let union: BBox3 | null = null;
    for (const object of members) union = mergeBBox(union, object.bbox);
    if (!union || !intersects2D(union, bbox)) continue;
    const objects: Record<string, CityObject> = {};
    for (const object of members) objects[object.id] = object;
    out.push({
      sourceEncoding: "cityparquet",
      metadata: referenceSystem === undefined ? {} : { referenceSystem },
      bbox: union,
      objects,
      vertexCount: countRingVertices(members),
    });
  }
  return out;
}

/** An Error the worker core posts with its `code`. */
function budgetError(cost: number, limit: number): Error {
  return Object.assign(
    new Error(
      `This view would read ${String(cost)} rows of the CityParquet source, over the per-fetch limit of ${String(limit)}; zoom in to load it.`,
    ),
    { code: "budget" },
  );
}

export function createCityParquetSourceAdapter(
  options: CityParquetSourceAdapterOptions = {},
): StreamSourceAdapter {
  const maxFetchReadRows = options.maxFetchReadRows ?? MAX_FETCH_READ_ROWS;
  let stream: CityParquetStream | undefined;
  let buffers: RangeBuffer[] = [];
  /** Cancels the open in flight; `close` aborts it. */
  let openController: AbortController | undefined;

  const openStream = (): CityParquetStream => {
    if (!stream) throw new Error("no file open");
    return stream;
  };

  return {
    ownership: "feature",

    async open(req: OpenRequest): Promise<OpenedSource> {
      openController?.abort();
      const controller = new AbortController();
      openController = controller;
      stream = undefined;
      buffers = [];
      let opened: CityParquetStream;
      let opening: RangeBuffer[];
      try {
        opening = await buffersOf(req.source);
        controller.signal.throwIfAborted();
        for (const buffer of opening) buffer.setSignal(controller.signal);
        // No `lngLatCentre`: the stream's metric CRS follows its own extent.
        opened = await openCityParquetStream(opening);
      } catch (error) {
        const admission = admissionOf(error);
        if (!admission || controller.signal.aborted) throw error;
        return { header: EMPTY_HEADER, admission };
      }
      // Closed (or superseded) while reading: install nothing.
      controller.signal.throwIfAborted();
      stream = opened;
      buffers = opening;
      const h = opened.header;
      return {
        header: {
          version: h.version,
          // Kept populated for readers of the FlatCityBuf field.
          featuresCount: h.objectsCount,
          objectsCount: h.objectsCount,
          extent: h.extent,
          referenceSystem: h.referenceSystem,
          epsg: h.epsg,
          lods: h.lods,
        },
        admission: null,
      };
    },

    // Synchronous over the index: no reads, so nothing to cancel.
    probe: (bbox) => {
      try {
        return Promise.resolve(openStream().index.readCost(bbox));
      } catch (error) {
        return Promise.reject(error as Error);
      }
    },

    async *select(bbox, { lod, signal }): AsyncIterable<CityModel> {
      const s = openStream();
      const cost = s.index.readCost(bbox);
      if (cost > maxFetchReadRows) throw budgetError(cost, maxFetchReadRows);
      const ranges = s.index.query(bbox);
      if (ranges.length === 0) return;
      for (const buffer of buffers) buffer.setSignal(signal);
      for await (const batch of s.readRows(ranges, lod, signal)) {
        yield* familyModels(batch, bbox, s.header.referenceSystem);
      }
    },

    appearance: () => undefined,

    // The highest available LoD ≤ the rung, per object: every known LoD at
    // or below it, highest first (never `null`, which draws every surface).
    bakeLod(lod, lodsSeen) {
      const headerLods = stream?.header.lods ?? [];
      const known = [...new Set([...headerLods, ...lodsSeen])];
      return known
        .filter((l) => lod === null || Number(l) <= Number(lod))
        .sort((a, b) => Number(b) - Number(a));
    },

    close(): void {
      openController?.abort();
      openController = undefined;
      stream = undefined;
      buffers = [];
    },
  };
}
