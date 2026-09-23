/**
 * The format-agnostic half of a streaming worker: owns the tile grid and a
 * per-cell cache. One traversal per commit: the source adapter's `select()`
 * over the requested region, then bucket locally by bbox centre, and bake
 * each cell's vertices into its own exact local-ENU frame before they are
 * transferred to the main thread.
 *
 * Every import resolves inside this package or in `@cityjson/navara-core`:
 * a worker entry point cannot reach into the host application, and Vite
 * inlines this module's whole graph into one worker chunk (Task C4b).
 */
import proj4 from "proj4";
import {
  buildCityMeshArrays,
  buildRuleColorsFromArrays,
  ensureProjDef,
  geodeticRingsToEnu,
  localMetricFrameFromDescriptor,
  makeEnuFrame,
  projectPositionsToEnu,
  type AppearanceTheme,
  resolveSurfaceColorsLinear,
  SURFACE_COLORS_LINEAR,
  type BBox3,
  type CityAppearance,
  type CityModel,
  type CityObject,
  type LocalMetricFrameDescriptor,
} from "@cityjson/navara-core";
import { bucketFeatures } from "./bucketFeatures";
import { WORKER_RETAINED_BYTE_BUDGET } from "./constants";
import { toObjectRecords } from "./objectRecords";
import type {
  OpenedSource,
  OpenRequest,
  StreamSourceAdapter,
} from "./streamSourceAdapter";
import {
  makeGrid,
  cellCentre,
  unionOfCellBounds,
  type CellKey,
  type Grid,
} from "./tileGrid";
import type {
  CellGeometry,
  CellTexture,
  StreamSource,
  WorkerRequest,
  WorkerResponse,
} from "./workerProtocol";

/**
 * A resident cell as retained by the worker, independent of what has already
 * been transferred to the main thread. `postMessage` DETACHES every
 * transferred `ArrayBuffer` — so once a cell's positions/normals/colors/
 * indices are handed off in `fetch`, the worker no longer owns those
 * specific typed arrays. `recolor` and `surfaces` need to keep working on
 * that cell afterwards (without re-running select()+decode), so the worker
 * keeps its own copies: the full parsed `CityModel` (never transferred — it
 * holds no ArrayBuffers of its own) plus copies of the per-vertex index
 * arrays and base colors that were about to be transferred away.
 */
interface CachedCell {
  readonly model: CityModel;
  readonly objectIndices: Uint32Array;
  readonly surfaceIndices: Uint32Array;
  readonly objectKeys: string[];
  /** Copy of the cell's base (non-rule) vertex colors, so `recolor` can fall
   *  back to them when `buildRuleColorsFromArrays` returns null (no rule
   *  matched) without needing to re-triangulate the cell to get them. */
  readonly colors: Float32Array;
  /** What this entry costs the worker, by {@link estimateRetainedBytes}. */
  readonly retainedBytes: number;
}

/** Per-entry costs of a decoded `CityObject` graph, in bytes. Shape-based
 *  guesses at V8's layout, not measurements of it: an object's own fields and
 *  its `attributes`/`bbox`/`parents`/`children`, a surface's fields and its
 *  `rings` array, a ring's array header, and a `[x, y, z]` coordinate tuple
 *  (a JSArray: header + elements backing store + three doubles). */
const BYTES_PER_OBJECT = 320;
const BYTES_PER_SURFACE = 160;
const BYTES_PER_RING = 40;
const BYTES_PER_VERTEX = 88;

/**
 * What the worker retains for one cell, estimated from its STRUCTURE — the
 * typed arrays it copied, plus a per-object / per-surface / per-ring /
 * per-vertex charge for the decoded `CityModel` it holds by reference.
 *
 * It exists because `CellGeometry`'s transferred arrays are not the cost: the
 * worker keeps a whole decoded model per resident cell, and with every object
 * type hidden a cell bakes NO geometry at all — zero triangles, zero
 * transferred bytes — while still retaining every decoded row behind it. The
 * main thread's byte budget metered only what came over the wire, so such
 * cells were never evicted and the worker grew without bound (Codex milestone
 * review, Critical).
 *
 * Accuracy: an order-of-magnitude figure, deliberately cheap (one pass over
 * rings, never over vertices). It does NOT count attribute VALUES, so a
 * source with long text attributes costs more than this says; V8's real
 * per-object overhead varies with shape, so a source of tiny objects costs
 * less. Treat it as ±50 % — enough to keep a pan bounded, not a heap figure.
 */
function estimateRetainedBytes(
  model: CityModel,
  objectIndices: Uint32Array,
  surfaceIndices: Uint32Array,
  colors: Float32Array,
  objectKeys: ReadonlyArray<string>,
): number {
  let objects = 0;
  let surfaces = 0;
  let rings = 0;
  let vertices = 0;
  for (const obj of Object.values(model.objects)) {
    if (!obj) continue;
    objects += 1;
    for (const surface of obj.surfaces) {
      surfaces += 1;
      for (const ring of surface.rings) {
        rings += 1;
        vertices += ring.length;
      }
    }
  }
  let keyBytes = 0;
  for (const key of objectKeys) keyBytes += key.length * 2 + 24;
  return (
    objectIndices.byteLength +
    surfaceIndices.byteLength +
    colors.byteLength +
    keyBytes +
    objects * BYTES_PER_OBJECT +
    surfaces * BYTES_PER_SURFACE +
    rings * BYTES_PER_RING +
    vertices * BYTES_PER_VERTEX
  );
}

/**
 * Everything needed to bake a cell's vertices into exact local-ENU metres,
 * captured once per `open`. Two kinds, because a source's coordinates arrive in
 * one of two spaces (`docs/plans/2026-09-23-geographic-to-enu.md`):
 *
 * - `"projected"` — the original. `buildCityMeshArrays` emits source-CRS deltas
 *   from the cell centre, and the renderer treats a cell's vertices as ENU
 *   metres, which for a projected CRS is wrong by the point scale factor and
 *   the grid convergence angle and ignores the vertical datum entirely. The
 *   correction is per-vertex, so it belongs off the main thread: right here
 *   (Task A13b's `projectPositionsToEnu`; `CityModelMesh` does the identical
 *   thing for static layers). EVERY FlatCityBuf source and every projected
 *   CityParquet one takes this path, unchanged.
 * - `"bucket"` — a GEOGRAPHIC source (EPSG:6697). Its rings are already
 *   geodetic, so they are converted into the cell's ENU frame by arithmetic
 *   BEFORE triangulation (`geodeticRingsToEnu`), and no projection runs at all.
 *   Its INDEX — the extent, the tile grid, cell ownership and the bboxes it
 *   reports — is bucket metres about the dataset centre, which is what
 *   `toLngLat` inverts here.
 *
 * Both carry `toLngLat`, because both build a cell's frame from its centre, and
 * both carry the same `heightOffset`.
 */
type CellPlacement = {
  /** Metres added to every vertex's geodetic height AND to the frame origin —
   *  the geoid undulation, resolved by the plugin BEFORE `open` (see the
   *  `open` handler). */
  readonly heightOffset: number;
  /** Index space -> WGS84, built once: proj4's three-argument call re-parses
   *  both CRS definitions on every invocation. */
  toLngLat(coords: [number, number]): [number, number];
} & (
  | { readonly kind: "projected"; readonly epsg: number }
  | {
      readonly kind: "bucket";
      readonly frame: LocalMetricFrameDescriptor;
    }
);

/** Each object's bbox as it arrived, before the ENU conversion re-boxed it:
 *  the boxes a cell REPORTS (`toObjectRecords`), in the index space the main
 *  thread merges and fits them in. */
function bboxesOf(model: CityModel): Map<string, BBox3> {
  const out = new Map<string, BBox3>();
  for (const object of Object.values(model.objects)) {
    if (object?.bbox) out.set(object.id, object.bbox);
  }
  return out;
}

/**
 * A copy of `model` whose rings (and object bboxes) are local ENU metres in
 * `frame`, leaving the caller's geographic model untouched — the cell cache
 * keeps the ENU one, because `recolor` must see exactly the object and surface
 * ordering that built the arrays.
 */
function toCellEnu(
  model: CityModel,
  frame: ReturnType<typeof makeEnuFrame>,
  heightOffset: number,
): CityModel {
  const objects: Record<string, CityObject> = { ...model.objects };
  geodeticRingsToEnu(objects, frame, heightOffset);
  return { ...model, objects };
}

/** The slice of a worker's global scope the core talks through. */
export interface StreamWorkerContext {
  postMessage(m: WorkerResponse, t?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
}

/** The themes seen so far, texture themes first, for the learned list. */
function appearanceThemesSeen(
  built: CityAppearance | undefined,
): AppearanceTheme[] {
  if (!built) return [];
  return [
    ...built.textureThemes.map(
      (name): AppearanceTheme => ({ kind: "texture", name }),
    ),
    ...built.materialThemes.map(
      (name): AppearanceTheme => ({ kind: "material", name }),
    ),
  ];
}

/** The definitions behind a cell's texture groups, by layer-wide index. */
function cellTextures(
  groups: ReadonlyArray<{ textureIndex: number }> | null | undefined,
  built: CityAppearance | undefined,
): CellTexture[] {
  if (!groups || !built) return [];
  const out: CellTexture[] = [];
  for (const group of groups) {
    const texture = built.textures[group.textureIndex];
    if (group.textureIndex >= 0 && texture) {
      out.push({ index: group.textureIndex, texture });
    }
  }
  return out;
}

/** Distinct, non-null `Surface.lod` labels present in `model` — computed
 *  from the pre-triangulation `CityModel`, NOT from `buildCityMeshArrays`'s
 *  output, whose surfaces have already been filtered down to one requested
 *  `msg.lod` (or all, if `null`) and so can never reveal a label this cell
 *  ALSO has but the current commit didn't ask for. Mirrors
 *  `layerStore.ts`'s `computeAvailableLods`, but that function additionally
 *  sorts descending for a UI dropdown — order doesn't matter here, since
 *  `useTileStreaming.ts` only ever feeds this into `buildLadder`, which does
 *  its own dedup+sort. */
function distinctLods(model: CityModel): string[] {
  const set = new Set<string>();
  for (const obj of Object.values(model.objects)) {
    for (const surface of obj?.surfaces ?? []) {
      if (surface.lod) set.add(surface.lod);
    }
  }
  return [...set];
}

/** Whether two opens name the same source. Both keyed: by key. Otherwise the
 *  sources themselves: urls by value (a list element by element, in order),
 *  Blobs by identity — which a structured-cloned request never repeats, so an
 *  unkeyed Blob is always a new source. */
function sameOpen(
  a: { source: StreamSource; sourceKey?: string },
  b: { source: StreamSource; sourceKey?: string },
): boolean {
  if (a.sourceKey !== undefined && b.sourceKey !== undefined) {
    return a.sourceKey === b.sourceKey;
  }
  return sameSource(a.source, b.source);
}

function sameSource(a: StreamSource, b: StreamSource): boolean {
  if ("url" in a) return "url" in b && a.url === b.url;
  if ("blob" in a) return "blob" in b && a.blob === b.blob;
  const listA: ReadonlyArray<unknown> = "urls" in a ? a.urls : a.blobs;
  const listB: ReadonlyArray<unknown> | null =
    "urls" in a
      ? "urls" in b
        ? b.urls
        : null
      : "blobs" in b
        ? b.blobs
        : null;
  return (
    listB !== null &&
    listA.length === listB.length &&
    listA.every((item, i) => item === listB[i])
  );
}

/** A cell's own LoDs plus the source's up-front ones, each label once. */
function unionLods(
  own: string[],
  known: ReadonlyArray<string> | undefined,
): string[] {
  if (!known || known.length === 0) return own;
  return [...new Set([...own, ...known])];
}

/**
 * Installs the streaming worker protocol on `ctx`, reading features through
 * `adapter`. All state lives in this call's closure: one install is one
 * worker.
 */
export interface StreamWorkerOptions {
  /** Overrides {@link WORKER_RETAINED_BYTE_BUDGET} (tests). */
  readonly retainedByteBudget?: number;
}

export function installStreamWorker(
  ctx: StreamWorkerContext,
  adapter: StreamSourceAdapter,
  options: StreamWorkerOptions = {},
): void {
  const retainedByteBudget =
    options.retainedByteBudget ?? WORKER_RETAINED_BYTE_BUDGET;
  /** Set together with `placement` — both exist exactly when a source is open
   *  and admitted (see the `open` handler). */
  let grid: Grid | undefined;
  let placement: CellPlacement | undefined;
  /** The host's surface palette, resolved once from `open` — every cell built
   *  after that bakes it. Defaults to core's palette. */
  let surfaceColors = SURFACE_COLORS_LINEAR;
  let controller: AbortController | null = null;
  /** The admitted source and what its `open` answered, kept so a second
   *  `open` of the SAME source (the registry opens twice: once to learn the
   *  extent, once with the resolved geoid offset) re-establishes placement
   *  and palette without re-reading the source. Unset after a refused or
   *  failed open, so a retry asks the adapter again. */
  let opened:
    | { source: StreamSource; sourceKey?: string; result: OpenedSource }
    | undefined;
  /** Opens run one at a time, in arrival order: an open still reading its
   *  source when the next arrives would otherwise land its result (and the
   *  adapter's state) over the newer one. */
  let openQueue: Promise<void> = Promise.resolve();
  /** Bumped by every `close`. An open captures it on arrival and re-checks it
   *  at both of its suspension points, so a `close` that lands while an open
   *  is queued or still reading its source invalidates it: the late open
   *  installs no grid, no placement and no `opened` source, and posts no
   *  `opened` response for a layer the main thread has already dropped.
   *  `controller` cannot do this job — it is the PROBE/FETCH controller, and
   *  an adapter's `open` never sees it (Codex milestone review, Minor). */
  let closeGeneration = 0;
  /** Whether the adapter holds state from an `open` not yet closed. */
  let adapterOpen = false;
  /** The worker's own cell cache. Counts against the same memory budget as
   *  the main thread's cache; the main thread's `evict` message is what
   *  releases entries here (see the `evict`/`close` handlers below). Without
   *  it, this map would grow without bound as the viewport pans. */
  const cells = new Map<CellKey, CachedCell>();
  /** Running sum of `cells`' `retainedBytes`, kept by the helpers below —
   *  every mutation of `cells` goes through one of them, or the total (and
   *  therefore the cap) silently drifts. Map insertion order is the LRU
   *  order: `cacheSet` and `cacheTouch` re-insert, so the oldest entry is
   *  always first. */
  let retainedBytes = 0;

  function cacheSet(key: CellKey, cell: CachedCell): void {
    const previous = cells.get(key);
    if (previous) retainedBytes -= previous.retainedBytes;
    cells.delete(key);
    cells.set(key, cell);
    retainedBytes += cell.retainedBytes;
  }

  function cacheDelete(key: CellKey): void {
    const previous = cells.get(key);
    if (!previous) return;
    retainedBytes -= previous.retainedBytes;
    cells.delete(key);
  }

  function cacheClear(): void {
    cells.clear();
    retainedBytes = 0;
  }

  /** Moves `key` to the most-recently-used end. */
  function cacheTouch(key: CellKey): void {
    const cell = cells.get(key);
    if (!cell) return;
    cells.delete(key);
    cells.set(key, cell);
  }

  /** Drops least-recently-used entries until the worker is back inside its
   *  own cap, never touching a key of the commit in flight (`keep`) — those
   *  are about to be posted, and the main thread would then hold cells this
   *  side had already forgotten. */
  function cacheTrim(keep: ReadonlySet<CellKey>): void {
    if (retainedBytes <= retainedByteBudget) return;
    for (const key of [...cells.keys()]) {
      if (retainedBytes <= retainedByteBudget) return;
      if (keep.has(key)) continue;
      cacheDelete(key);
    }
  }

  function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
    ctx.postMessage(msg, transfer);
  }

  /** One `open`, run through `openQueue` so opens never overlap. `generation`
   *  is `closeGeneration` as this request ARRIVED: a `close` since then makes
   *  the whole open a no-op. */
  async function handleOpen(
    msg: OpenRequest,
    generation: number,
  ): Promise<void> {
    if (generation !== closeGeneration) return; // closed while queued
    let result: OpenedSource;
    const same = opened !== undefined && sameOpen(opened, msg);
    if (opened && same) {
      // Invariant: the registry never fetches between its two opens, so the
      // cell cache is empty here and keeping it (and the grid) is safe.
      result = opened.result;
    } else {
      // Another source: drop everything of the previous one FIRST, so an
      // open that is refused or throws can never leave a stale grid serving
      // fetches, or stale cells answering `surfaces`.
      controller?.abort();
      grid = undefined;
      placement = undefined;
      cacheClear();
      opened = undefined;
      if (adapterOpen) {
        adapterOpen = false;
        adapter.close();
      }
      adapterOpen = true;
      result = await adapter.open(msg);
      if (generation !== closeGeneration) {
        // Closed while this open was reading. Whatever the adapter installed
        // for it must go with it, or the next open sees a source nobody
        // asked for.
        adapterOpen = false;
        adapter.close();
        return;
      }
    }
    if (generation !== closeGeneration) return;
    const { header, admission } = result;
    // An admitted source guarantees header.extent is set and header.epsg is a
    // metre-based code (the adapter's admission refuses anything else), but
    // the two are independent as far as the type checker knows.
    // An admitted source guarantees an index space: a metric EPSG, or — for a
    // geographic one — a bucket frame descriptor. `epsg: null` WITH a frame is
    // the positive contract for the second kind; `epsg: null` with no frame is
    // no contract at all and is not placed.
    if (!admission && header.extent && (header.epsg !== null || header.frame)) {
      opened = {
        source: msg.source,
        ...(msg.sourceKey !== undefined ? { sourceKey: msg.sourceKey } : {}),
        result,
      };
      // A new source always gets its own grid; the same source keeps its.
      grid = same && grid ? grid : makeGrid(header.extent);
      // The plugin resolved the geoid undulation (or the caller's override)
      // BEFORE sending `open`, precisely so the worker can bake every cell
      // in the right frame from the first fetch — the worker never samples
      // it itself and never needs network access. See Global Constraints
      // -> Vertical datum.
      const heightOffset = msg.heightOffset ?? 0;
      if (header.epsg !== null) {
        const epsg = header.epsg;
        // Registers RD New and friends; built-in codes are a no-op. Without it
        // proj4 cannot construct the converter below at all.
        ensureProjDef(epsg);
        const converter = proj4(`EPSG:${epsg}`, "WGS84") as {
          forward(coords: [number, number]): [number, number];
        };
        placement = {
          kind: "projected",
          epsg,
          heightOffset,
          toLngLat: (coords) => converter.forward(coords),
        };
      } else {
        // Arithmetic, and the SAME arithmetic every other user of this frame
        // performs — the family index, the tile grid, the camera footprint and
        // the main thread's own `cellFrame`.
        const bucket = localMetricFrameFromDescriptor(header.frame!);
        placement = {
          kind: "bucket",
          frame: header.frame!,
          heightOffset,
          toLngLat: ([x, y]) => bucket.toLngLat(x, y),
        };
      }
    }
    surfaceColors = resolveSurfaceColorsLinear(msg.surfaceColors);
    post({ type: "opened", id: msg.id, header, admission });
  }

  ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
    const msg = ev.data;
    /** THIS request's controller (probe/fetch only). The outer catch judges
     *  `aborted` by it: `controller` may already belong to a newer request,
     *  whose signal says nothing about why this one failed. */
    let own: AbortController | null = null;
    try {
      if (msg.type === "open") {
        const generation = closeGeneration;
        const run = openQueue.then(() => handleOpen(msg, generation));
        openQueue = run.catch(() => undefined);
        await run;
        return;
      }

      if (msg.type === "probe") {
        controller?.abort();
        own = new AbortController();
        controller = own;
        const count = await adapter.probe(msg.bbox, own.signal);
        post({ type: "probed", id: msg.id, count });
        return;
      }

      if (msg.type === "fetch") {
        if (!grid || !placement) throw new Error("no file open");
        const theGrid = grid;
        const place = placement;
        const knownLods = opened?.result.header.lods;
        controller?.abort();
        const my = new AbortController();
        own = my;
        controller = my;

        // Every key this call touches in the worker's OWN cache, paired with
        // whatever was cached at that key BEFORE this call touched it (or
        // `undefined` for a genuinely new key) — so it can be rolled back if
        // the request doesn't finish cleanly (aborted mid-loop, or an
        // exception partway through). Without this, a cell already
        // `cells.set()`'d and posted before the failure stays cached in the
        // worker forever — the main thread never adopts it (a failed/aborted
        // fetch never reaches `commitNormal`/`commitSwap`), so it can never
        // be reached by a main-thread `evict` either (B3, 2026-07-28 final
        // review).
        //
        // Recording the PRIOR value (not just the key) matters when this call
        // is a same-key REFETCH of a cell that was already resident from an
        // earlier, successfully-adopted fetch: a plain `cells.delete(key)`
        // rollback would destroy that still-good prior value along with the
        // failed attempt, leaving the worker's cache diverged from what the
        // main thread still believes is resident (a second, later regression
        // on top of the original B3 fix, 2026-07-28 final review).
        const touchedKeys: {
          key: CellKey;
          previous: CachedCell | undefined;
        }[] = [];
        const rollbackTouchedKeys = (): void => {
          for (const { key, previous } of touchedKeys) {
            if (previous) cacheSet(key, previous);
            else cacheDelete(key);
          }
        };

        // Query the requested cells WHOLE, not the view: a cell's objects
        // are owned by bbox centre, so a view that reaches only part of a
        // boundary cell would otherwise bake that cell with the objects in
        // its other part missing — and the cell, once resident, is never
        // refetched to fill them in. `msg.bbox` stays a diagnostic.
        const queryBBox = unionOfCellBounds(theGrid, msg.cells);
        if (!queryBBox) {
          post({ type: "done", id: msg.id }); // nothing requested
          return;
        }

        try {
          // Decode in chunks, yielding so a superseded fetch can be
          // cancelled.
          const models: CityModel[] = [];
          let sinceYield = 0;
          for await (const model of adapter.select(queryBBox, {
            lod: msg.lod,
            signal: my.signal,
          })) {
            if (my.signal.aborted) {
              post({
                type: "error",
                id: msg.id,
                message: "aborted",
                aborted: true,
              });
              return;
            }
            models.push(model);
            if (++sinceYield >= 64) {
              sinceYield = 0;
              await new Promise((r) => setTimeout(r, 0));
            }
          }

          const resident = new Set(msg.cells);
          // Geometry only: `cellModel` and the `objects` records below stay
          // unfiltered, because the inspector, the table and type discovery
          // all read them and must still see a hidden object.
          const hiddenTypes =
            msg.hiddenTypes.length > 0 ? new Set(msg.hiddenTypes) : null;
          const buckets = bucketFeatures(
            models,
            theGrid,
            msg.level,
            new Set(),
            adapter.ownership ?? "object",
          );
          // Built once per fetch, AFTER the traversal so this fetch's own
          // features are in it: the tables a material theme reads its diffuse
          // colours from, and the theme list the main thread learns from.
          const builtAppearance = adapter.appearance();
          const appearanceThemes = appearanceThemesSeen(builtAppearance);
          for (const [key, cellModelBare] of buckets) {
            if (my.signal.aborted) {
              // A newer fetch/probe/cancel superseded this one mid-loop: any
              // cells already touched THIS call are for an incomplete result
              // the main thread will never commit, so they must not linger
              // here either. Also posts a terminal response — this loop used
              // to `return` silently on abort, which left the `sendStreaming`
              // call awaiting THIS request's id pending forever on the main
              // thread (workerClient.ts's `streaming` map never got a 'done'
              // or 'error' to resolve on).
              rollbackTouchedKeys();
              post({
                type: "error",
                id: msg.id,
                message: "aborted",
                aborted: true,
              });
              return;
            }
            if (!resident.has(key)) continue; // outside the requested cover
            const bareModel: CityModel = builtAppearance
              ? { ...cellModelBare, appearance: builtAppearance }
              : cellModelBare;
            const cellLods = distinctLods(bareModel);
            const origin = cellCentre(theGrid, key, 0);
            // The cell's own ENU frame: its centre's geodetic position, raised
            // by the vertical datum offset. Built the same way on both sides —
            // same function, same arguments as `cellMeshes.cellFrame()` on the
            // main thread (Task C8) — so cell placement and cell vertices
            // cannot disagree.
            const [cellLng, cellLat] = place.toLngLat([origin[0], origin[1]]);
            const frame = makeEnuFrame(cellLng, cellLat, place.heightOffset);
            // A GEOGRAPHIC source is placed BEFORE triangulation: its rings are
            // already geodetic, so `lon/lat/h -> ECEF -> this frame` is
            // arithmetic, and doing it first means normals and edge creases are
            // computed where they are drawn. The boxes the cell REPORTS are
            // kept aside first: they travel in bucket space, the one frame the
            // main thread can merge and fit across cells, while the geometry
            // (and the metrics computed from it) belong in the cell's frame.
            const reportBBoxes =
              place.kind === "bucket" ? bboxesOf(bareModel) : undefined;
            const cellModel =
              place.kind === "bucket"
                ? toCellEnu(bareModel, frame, place.heightOffset)
                : bareModel;
            const a = buildCityMeshArrays(
              cellModel,
              key,
              // Already ENU metres about the frame origin for a bucket source,
              // so there is nothing to subtract; source-CRS deltas from the
              // cell centre otherwise.
              place.kind === "bucket" ? [0, 0, 0] : origin,
              adapter.bakeLod(msg.lod, cellLods),
              hiddenTypes,
              msg.appearance ?? null,
              surfaceColors,
            );
            if (place.kind === "projected") {
              // `a.positions` are source-CRS deltas from `origin`; the renderer
              // wants local ENU metres in the cell's OWN frame, so re-place
              // every vertex exactly. Without this the deltas are off by the
              // projection's scale factor and grid convergence, which is metres
              // and a fraction of a degree of bearing at cell scale.
              projectPositionsToEnu(a.positions, {
                originOffset: origin,
                epsg: place.epsg,
                frame,
                heightOffset: place.heightOffset,
              });
            }
            const ruleColors = msg.rulesEnabled
              ? buildRuleColorsFromArrays(
                  cellModel,
                  a.objectIndices,
                  a.surfaceIndices,
                  a.objectKeys,
                  msg.rules,
                  a.colors,
                )
              : null;
            // Build the payload explicitly. Do NOT spread `a`: CityMeshArrays
            // has `colors`, CellGeometry has `baseColors`, and a spread would
            // emit both.
            const geometry: CellGeometry = {
              positions: a.positions,
              normals: a.normals,
              baseColors: a.colors,
              ruleColors,
              objectIndices: a.objectIndices,
              surfaceIndices: a.surfaceIndices,
              objectKeys: a.objectKeys,
              triangleCount: a.triangleCount,
              uvs: a.uvs ?? null,
              textureGroups: a.textureGroups ?? null,
              textures: cellTextures(a.textureGroups, builtAppearance),
            };
            const { records, surfaceAttrKeys } = toObjectRecords(
              cellModel,
              reportBBoxes,
            );

            // Record this cell in the worker cache BEFORE transferring: the
            // arrays below are detached the instant `post()`'s postMessage
            // call returns, so `.slice()` copies must be taken first.
            // `cellModel` itself is never transferred (it holds no
            // ArrayBuffers), so it can be cached by reference. Capture
            // whatever was at this key BEFORE overwriting it — a same-key
            // refetch of an already-resident cell must roll back to THIS, not
            // to nothing, if the call fails later.
            const previous = cells.get(key);
            const objectIndices = a.objectIndices.slice();
            const surfaceIndices = a.surfaceIndices.slice();
            const colors = a.colors.slice();
            const retained = estimateRetainedBytes(
              cellModel,
              objectIndices,
              surfaceIndices,
              colors,
              a.objectKeys,
            );
            cacheSet(key, {
              model: cellModel,
              objectIndices,
              surfaceIndices,
              objectKeys: a.objectKeys,
              colors,
              retainedBytes: retained,
            });
            touchedKeys.push({ key, previous });
            // Backstop only, and never at the expense of THIS commit: the
            // main thread's evict is what normally frees entries here.
            cacheTrim(resident);

            post(
              {
                type: "cell",
                id: msg.id,
                key,
                geometry,
                objects: records,
                surfaceAttrKeys,
                // Every distinct LoD label observed in this cell's RAW model,
                // independent of `msg.lod`'s filter — what
                // `useTileStreaming.ts` folds into the layer's auto-LoD
                // ladder (`levelPolicy.ts`'s `buildLadder`). Previously
                // always `[]`, which left the ladder permanently empty and
                // auto mode permanently selecting "all LoDs" (B1, 2026-07-28
                // final review).
                // ...plus the source's up-front LoDs, when its format knows
                // them, so the ladder is complete before every cell is seen.
                lodsSeen: unionLods(cellLods, knownLods),
                // What the record bboxes are in, and what the main thread
                // rebuilds this cell's ENU placement from.
                frame: place.kind === "bucket" ? place.frame : null,
                appearanceThemes,
                // What this cell costs the WORKER, which is not what its
                // transferred arrays cost: the main thread adds it to the
                // geometry bytes it meters, so a cell that bakes nothing
                // (every type hidden) still consumes residency budget.
                retainedBytes: retained,
              },
              [
                a.positions.buffer,
                a.normals.buffer,
                a.colors.buffer,
                a.objectIndices.buffer,
                a.surfaceIndices.buffer,
                ...(a.uvs ? [a.uvs.buffer] : []),
              ],
            );
          }
          post({ type: "done", id: msg.id });
        } catch (e) {
          rollbackTouchedKeys();
          throw e; // the outer catch below posts the 'error' response.
        }
        return;
      }

      if (msg.type === "recolor") {
        for (const key of msg.cells) {
          const cached = cells.get(key);
          // A recolor request can race a viewport move (or this worker's own
          // retained-byte trim): the main thread may ask to recolor a key
          // this worker no longer holds. Skip rather than error.
          if (!cached) continue;
          cacheTouch(key);
          // buildRuleColorsFromArrays returns null when no rule matched
          // anything (or rulesEnabled is false); ruleColors on the wire is
          // non-nullable, so fall back to a fresh copy of the cached base
          // colors — same "ruleColors ?? baseColors" convention the
          // non-streaming path uses (see highlightMesh.ts). Always a *copy*:
          // transferring the cache's own buffer would detach it out from
          // under this cache entry.
          const ruleColors = msg.rulesEnabled
            ? (buildRuleColorsFromArrays(
                cached.model,
                cached.objectIndices,
                cached.surfaceIndices,
                cached.objectKeys,
                msg.rules,
                cached.colors,
              ) ?? cached.colors.slice())
            : cached.colors.slice();
          post({ type: "recolored", id: msg.id, key, ruleColors }, [
            ruleColors.buffer,
          ]);
        }
        post({ type: "done", id: msg.id });
        return;
      }

      if (msg.type === "surfaces") {
        for (const [key, cached] of cells) {
          const obj = cached.model.objects[msg.objectId];
          if (obj) {
            // `cacheTouch` re-inserts (delete + set) DURING this iteration,
            // which is only safe because the loop returns immediately below.
            cacheTouch(key);
            post({
              type: "surfaceData",
              id: msg.id,
              objectId: msg.objectId,
              surfaces: obj.surfaces as unknown[],
            });
            return;
          }
        }
        post({
          type: "error",
          id: msg.id,
          message: `object not resident in any cached cell: ${msg.objectId}`,
          code: "not-found",
          aborted: false,
        });
        return;
      }

      if (msg.type === "evict") {
        for (const key of msg.cells) cacheDelete(key);
        return;
      }

      if (msg.type === "cancel") {
        controller?.abort();
        return;
      }
      if (msg.type === "close") {
        controller?.abort();
        closeGeneration++;
        adapterOpen = false;
        opened = undefined;
        adapter.close();
        grid = undefined;
        placement = undefined;
        cacheClear();
        return;
      }
    } catch (e) {
      // An adapter's machine-readable refusal (CityParquet's read budget:
      // `code: "budget"`) reaches the main thread with the message.
      const tagged: unknown =
        e instanceof Error ? (e as Error & { code?: unknown }).code : undefined;
      const code = typeof tagged === "string" ? tagged : undefined;
      post({
        type: "error",
        id: msg.id,
        message: e instanceof Error ? e.message : String(e),
        ...(code !== undefined ? { code } : {}),
        aborted: own?.signal.aborted ?? false,
      });
    }
  };
}
