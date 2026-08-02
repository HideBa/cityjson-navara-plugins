/**
 * The whole of the FlatCityBuf plugin's behaviour, with no engine import.
 *
 * Same split as `@cityjson/navara-cityjson`'s `CityModelRegistry` /
 * `CityJSONPlugin` (Task B7): everything the Navara engine supplies is
 * INJECTED — the descriptor classes (opaque values forwarded to
 * `view.registerMesh`), the per-cell mesh factory (built on
 * `addCityMeshArrays`), and the pick-ray source (built on `getPickRay`) — so
 * this file, and therefore every assertion in `tests/streamRegistry.test.ts`,
 * runs in plain Node. That is the rule in Global Constraints -> Testing
 * conventions: the engine crashes at module scope under Node
 * (`NODE_IMPORT_SAFE = false`), so a test can never import `./plugin`.
 *
 * What lives here:
 *
 * - **The camera-driven driver.** One {@link SettleController} shared by every
 *   layer (a deliberate simplification of `useTileStreaming.ts:600-641`'s
 *   per-layer map — the engine emits a single global camera event stream, so
 *   per-layer controllers would fire in lockstep anyway): `movestart` aborts
 *   every layer's in-flight work, `moveend` + `settleMs` (flushed early by
 *   `idle`) commits every layer once.
 * - **`openStream`**, the old app's `openStreamingLayer.ts` with the store
 *   writes replaced by a handle: worker open -> admission -> CRS gate ->
 *   vertical datum -> grid/cache/frame -> `FcbStreamLayerHandle`.
 * - **`suppressSettle`**, the single "this camera move is mine, not the
 *   user's" entry point, re-published by the plugin and used by every
 *   programmatic camera move (restore, fitAll, alignView, flyTo).
 */
import proj4 from "proj4";
import {
  ensureProjDef,
  geoidHeightAt,
  makeEnuFrame,
  type Rule,
} from "@cityjson/navara-core";
import { CellCache } from "./cellCache";
import type { CellMeshFactory } from "./cellMeshes";
import {
  FLYTO_QUIET_MS,
  RESIDENT_BYTE_BUDGET,
  RESIDENT_TRIANGLE_BUDGET,
  SETTLE_MS,
} from "./constants";
import type { AdmissionError, FcbHeaderModel } from "./fcbSource";
import { cornerRays, type PickRaySource } from "./navaraRays";
import {
  attachSettleController,
  createSettleController,
  type CameraEventSource,
  type IdleEventSource,
  type SettleController,
  type TimerApi,
} from "./settleController";
import { FcbStreamLayerHandle, type CellEntry } from "./streamLayer";
import { makeGrid } from "./tileGrid";
import type { Ray } from "./viewportFootprint";
import type { WorkerClient } from "./workerClient";

/**
 * The subset of Navara's `ThreeView` the registry uses: the descriptor
 * registry, the view-level `idle` event, and the camera the move events live
 * on (Task B1 finding 6 — `movestart`/`move`/`moveend` are on `view.camera`,
 * `idle` is on the view). Structural, so this module needs no engine import
 * and the tests can pass a fake.
 */
export interface StreamViewLike extends IdleEventSource {
  readonly camera: CameraEventSource;
  registerMesh(name: string, desc: unknown): void;
}

/**
 * The part of a streaming layer the driver touches. Structural so the driver
 * tests can register a two-method stub, and so a future layer type (a second
 * source format) can join the same settle loop without inheriting the handle.
 */
export interface StreamLayerLike {
  commit(rays: readonly [Ray, Ray, Ray, Ray]): Promise<void>;
  abortInFlight(): void;
  delete(): void;
}

export interface StreamLayerRegistryDeps {
  /** `[descriptorKey, descriptorClass]` pairs, registered on {@link
   *  StreamLayerRegistry.attach}. Empty for a host that registers them itself. */
  readonly descriptors?: ReadonlyArray<readonly [string, unknown]>;
  /** One worker per layer. Injected because `new WorkerClient()` reaches the
   *  DOM `Worker` constructor, which Node does not have. */
  readonly createClient: () => WorkerClient;
  /** Engine seam: builds one mesh per resident cell of the named layer. */
  readonly createMeshFactory: (layerId: string) => CellMeshFactory;
  /** Engine seam: the viewport's pick-ray source, or `null` before the plugin
   *  has a view. Read per use (never captured), so a layer opened before
   *  `init()` still picks correctly afterwards. */
  readonly getPickRays: () => PickRaySource | null;
  /**
   * Geoid undulation sampler. Injected so tests resolve it synchronously
   * instead of hitting the terrain service; defaults to core's
   * `geoidHeightAt`, which is best effort and resolves 0 rather than
   * rejecting (Global Constraints -> Vertical datum).
   */
  readonly sampleGeoidHeight?: (
    lngDeg: number,
    latDeg: number,
  ) => Promise<number>;
  readonly settleMs?: number;
  readonly timers?: TimerApi;
}

export interface OpenStreamOptions {
  readonly id: string;
  readonly source: { readonly url: string } | { readonly blob: Blob };
  readonly rules?: ReadonlyArray<Rule>;
  readonly rulesEnabled?: boolean;
  readonly visible?: boolean;
  /** Vertical-datum correction in metres. Supplied wins outright; omitted
   *  means `await geoidHeightAt(centreLng, centreLat)`. Either way it is known
   *  before the worker's placement is established, so every cell bakes in the
   *  right frame from the very first fetch. */
  readonly heightOffset?: number;
}

/** proj4's two-CRS converter, typed to the two calls used here. */
interface Proj4Converter {
  forward(coords: [number, number]): [number, number];
  inverse(coords: [number, number]): [number, number];
}

export class StreamLayerRegistry {
  /** @internal Public for the driver tests, which register stubs directly. */
  readonly layers = new Map<string, StreamLayerLike>();

  private controller: SettleController | null = null;
  private detachController: (() => void) | null = null;
  private disposed = false;

  /**
   * A `PickRaySource` that forwards to whatever the plugin currently has, so
   * a handle can be built before `init()` and still pick afterwards. Built in
   * the constructor rather than as a field initializer because an object
   * literal's `get` accessors bind `this` to the literal, not to the class.
   */
  private readonly pickRays: PickRaySource;

  constructor(private readonly deps: StreamLayerRegistryDeps) {
    const source = (): PickRaySource | null => deps.getPickRays();
    this.pickRays = {
      get width(): number {
        return source()?.width ?? 0;
      },
      get height(): number {
        return source()?.height ?? 0;
      },
      // `null` (rather than a throw) for "no view yet": `resolvePick` already
      // treats a null ray as "nothing under the cursor".
      getPickRay: (x, y) => source()?.getPickRay(x, y) ?? null,
    };
  }

  /**
   * Register the descriptors and start listening to the camera.
   *
   * Called from the plugin's `init(view, ctx)`, i.e. from *inside*
   * `view.init()`: the engine builds its descriptor registries before it runs
   * plugins, so `registerMesh` works there but not before (Task B1 finding 2).
   *
   * Idempotent in the sense that re-attaching detaches the previous binding
   * first; the controller itself survives, so a suppression window opened
   * across a re-attach is not lost. Ignored after {@link dispose}, so a late
   * `init()` cannot resurrect a torn-down registry with live listeners.
   */
  attach(view: StreamViewLike): void {
    if (this.disposed) return;
    for (const [key, desc] of this.deps.descriptors ?? []) {
      view.registerMesh(key, desc);
    }
    this.detachController?.();
    this.controller ??= createSettleController({
      settleMs: this.deps.settleMs ?? SETTLE_MS,
      // The gesture has begun: whatever is in flight is for a viewport the
      // user has already left, so stop paying for it.
      onFirstChange: () => {
        for (const layer of this.layers.values()) layer.abortInFlight();
      },
      onSettle: () => this.commitAll(),
      timers: this.deps.timers,
    });
    this.detachController = attachSettleController(this.controller, {
      camera: view.camera,
      view,
    });
  }

  /**
   * Run `fn` with the settle controller deaf to camera events, so a
   * programmatic camera move (restore, `fitAll`, `alignView`, `flyTo`) never
   * looks like a user gesture and never triggers a commit.
   *
   * A no-op passthrough before {@link attach}, so the viewport can call it
   * unconditionally without branching on plugin readiness.
   *
   * BOTH forms are used, and both are needed:
   *
   * - `suppress` holds the gate across `fn`'s SYNCHRONOUS part. A `flyTo`
   *   emits its `movestart` from inside the call, so a `suppressUntil` alone
   *   — which can only be handed the promise `fn` has already returned —
   *   arrives one event too late and the burst commits (measured: without
   *   this, the suppressed-move test fails with one commit).
   * - `suppressUntil` then holds it until the returned promise settles, which
   *   is what an *awaited* `flyTo` needs: the animation keeps emitting `move`
   *   for seconds after the call returns, so a quiet window started at return
   *   time would expire mid-flight.
   *
   * Their windows overlap by construction (`suppress` opens its trailing
   * window before releasing its own hold), so the gate never blinks shut
   * between them. A synchronous `setCamera` costs one extra quiet window and
   * nothing else.
   */
  async suppressSettle<T>(fn: () => Promise<T> | T): Promise<T> {
    const controller = this.controller;
    if (!controller) return await fn();
    // The async wrapper (rather than `Promise.resolve(fn())`) is what turns a
    // SYNCHRONOUS throw inside `fn` into a rejected promise — one the gate is
    // released on — instead of an exception escaping `suppress` before
    // `suppressUntil` was ever reached.
    const result = controller.suppress(
      () => (async () => await fn())(),
      FLYTO_QUIET_MS,
    );
    controller.suppressUntil(result, FLYTO_QUIET_MS);
    return await result;
  }

  /**
   * Open a `.fcb` source for viewport streaming.
   *
   * The old app's `openStreamingLayer.ts`, minus the two store writes and plus
   * two gates it never had:
   *
   *  1. **CRS admission (spec §4.3).** The worker's own `checkAdmission`
   *     already refuses a non-metric CRS, but a layer that reaches this point
   *     still has to be *projectable* on the main thread — `viewportFootprint`
   *     converts camera rays into source XY on every commit. Refusing here,
   *     before anything is registered, is the same discipline
   *     `CityModelRegistry.addCityModel` applies via `resolveMetricEpsg`.
   *  2. **Vertical datum**, resolved BEFORE the worker's placement exists, so
   *     the very first cell bakes into `makeEnuFrame(cellLng, cellLat,
   *     heightOffset)` and the worker never performs a network request of its
   *     own. This is AWAITED rather than applied afterwards as the static path
   *     does (Task B7 re-places one mesh matrix): re-placing a streaming layer
   *     would mean re-decoding every resident cell, because the offset is
   *     baked into each cell's vertices in the worker. One request, once per
   *     layer, before any tile — and `geoidHeightAt` resolves 0 on failure, so
   *     it can neither reject nor hang the open beyond its own fetch timeout.
   *
   * Throws (never resolves a broken handle) on a worker error, an admission
   * refusal, a missing extent or an unusable CRS, terminating the worker on
   * the way out — nothing else would ever terminate it, so it would otherwise
   * leak for the lifetime of the tab.
   */
  async openStream(opts: OpenStreamOptions): Promise<FcbStreamLayerHandle> {
    if (this.disposed) {
      // Not merely tidy: a layer opened here would spin up a worker that
      // `dispose` has already stopped being able to reach.
      throw new Error(
        `FlatCityBufPlugin.openStream("${opts.id}") after dispose().`,
      );
    }
    if (this.layers.has(opts.id)) {
      throw new Error(
        `FlatCityBufPlugin.openStream: a layer with id "${opts.id}" is already registered. Remove it first — otherwise its worker would be unreachable and never terminated.`,
      );
    }
    const client = this.deps.createClient();
    try {
      const header = await this.openWorker(client, opts, opts.heightOffset);
      if (!header.extent) {
        // Unreachable given checkAdmission's contract (its only extent-less
        // branch, "no-extent", is what `openWorker` already threw on) —
        // defensive, not a real path today.
        throw new Error(`"${opts.id}" has no usable geographical extent.`);
      }

      // --- CRS gate (spec §4.3) -------------------------------------------
      const epsg = header.epsg;
      if (epsg === null || !ensureProjDef(epsg)) {
        throw new Error(
          `Cannot georeference "${opts.id}": unsupported CRS (EPSG:${epsg ?? "unknown"})`,
        );
      }
      // Built once: proj4's three-argument call re-parses both CRS definitions
      // on every invocation, and this pair runs per footprint corner per
      // commit.
      const converter = proj4(`EPSG:${epsg}`, "WGS84") as Proj4Converter;
      const toLngLat = (x: number, y: number): readonly [number, number] =>
        converter.forward([x, y]);
      const toSourceXY = (
        lng: number,
        lat: number,
      ): readonly [number, number] | null => {
        try {
          const [x, y] = converter.inverse([lng, lat]);
          // A ray that missed the globe, or a point outside the projection's
          // domain, comes back non-finite rather than throwing. Either way
          // `viewportFootprint` reads it as "no usable footprint".
          return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
        } catch {
          return null;
        }
      };

      // --- Vertical datum, before any cell exists --------------------------
      const [minX, minY, , maxX, maxY] = header.extent;
      const [centreLng, centreLat] = toLngLat(
        (minX + maxX) / 2,
        (minY + maxY) / 2,
      );
      const heightOffsetM =
        opts.heightOffset ??
        (await (this.deps.sampleGeoidHeight ?? geoidHeightAt)(
          centreLng,
          centreLat,
        ));
      if (opts.heightOffset === undefined) {
        // Establishes the worker's placement with the resolved offset. Only
        // now can a `fetch` be dispatched — see `openWorker`.
        await this.openWorker(client, opts, heightOffsetM);
      }

      const handle: FcbStreamLayerHandle = new FcbStreamLayerHandle({
        id: opts.id,
        client,
        grid: makeGrid(header.extent),
        header,
        cache: new CellCache<CellEntry>({
          maxTriangles: RESIDENT_TRIANGLE_BUDGET,
          maxBytes: RESIDENT_BYTE_BUDGET,
        }),
        // The layer's own ENU frame, at the extent centre and at the SAME
        // vertical offset the cells bake with — its z = 0 plane is the ground
        // plane `viewportFootprint` intersects camera rays with.
        frame: makeEnuFrame(centreLng, centreLat, heightOffsetM),
        toSourceXY,
        toLngLat,
        heightOffsetM,
        meshFactory: this.deps.createMeshFactory(opts.id),
        // Delegating rather than captured: `getPickRays()` is null until the
        // plugin has a view, and a layer opened in between must still pick.
        pickRays: this.pickRays,
        // A LoD change must refetch even for a viewport that has not moved —
        // hysteresis would otherwise skip the commit and leave the old LoD
        // resident indefinitely (B1). The handle does not own the camera, so
        // the driver supplies the forced commit.
        onLodChanged: () => this.commitLayer(handle),
      });

      // Seeded BEFORE the first commit, deliberately: the handle defaults to
      // `rulesEnabled: false` while the app's layer default is true, so an
      // unseeded first fetch would bake no rule colours and every resident
      // cell would need a recolor round trip to catch up (C10a/C10b ledger).
      handle.setVisible(opts.visible ?? true);
      handle.setRules(opts.rules ?? [], opts.rulesEnabled ?? true);

      this.register(opts.id, handle);
      this.commitLayer(handle);
      return handle;
    } catch (err) {
      // Whether admission refused, the open response errored, or anything
      // above threw: this worker never got registered, so nothing else will
      // ever terminate it — do so here or it leaks for the lifetime of the tab.
      client.terminate();
      throw err;
    }
  }

  /**
   * One `open` round trip, returning the admitted header.
   *
   * Called **twice** when the caller supplied no `heightOffset`, which is the
   * one shape the wire protocol leaves available: the worker takes the offset
   * on `open` (it bakes it into every cell's ENU frame from the first fetch,
   * and never samples the geoid itself), while the extent centre the geoid is
   * sampled AT only exists once the header has been read. So the first open
   * reads the header, and the second — after the sample lands — establishes
   * the placement. It costs one extra header read (a few KB of range request,
   * or a `Blob.slice` for a local file) per layer, once, and no cell can ever
   * be fetched in between: `openStream` dispatches nothing until it returns.
   * A caller that already knows its offset pays a single open.
   */
  private async openWorker(
    client: WorkerClient,
    opts: OpenStreamOptions,
    heightOffset: number | undefined,
  ): Promise<FcbHeaderModel> {
    const resp = await client.send(
      "url" in opts.source
        ? { type: "open", url: opts.source.url, heightOffset }
        : { type: "open", blob: opts.source.blob, heightOffset },
    );
    if (resp.type === "error") throw new Error(resp.message);
    if (resp.type !== "opened") {
      throw new Error(`Unexpected response opening "${opts.id}": ${resp.type}`);
    }
    // Cast at the true boundary: the worker builds `header`/`admission` via
    // `headerModel`/`checkAdmission` (fcbSource.ts) before posting them, so
    // this is the wire's `unknown` catching up with what the worker actually
    // sent — not an unchecked assumption about foreign data.
    const admission = resp.admission as AdmissionError | null;
    if (admission) throw new Error(admission.message);
    return resp.header as FcbHeaderModel;
  }

  /** Put a layer under the settle loop. Public so a host can drive a layer it
   *  built itself, and so the driver tests need no worker. */
  register(id: string, layer: StreamLayerLike): void {
    this.layers.set(id, layer);
  }

  getHandle(id: string): StreamLayerLike | undefined {
    return this.layers.get(id);
  }

  handles(): readonly StreamLayerLike[] {
    return [...this.layers.values()];
  }

  /** Tear one layer down: its worker, its cell meshes, its place in the loop.
   *  Unknown ids are ignored, so a caller need not track what it removed. */
  remove(id: string): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    this.layers.delete(id);
    layer.delete();
  }

  /** Stop listening, drop every layer. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachController?.();
    this.detachController = null;
    this.controller?.dispose();
    for (const layer of this.layers.values()) layer.delete();
    this.layers.clear();
  }

  /**
   * The four viewport-corner rays every commit is computed from, or `null`
   * when there is no view yet (nothing to commit against, and `cornerRays`
   * would have nothing to ask).
   *
   * Deliberately NOT wrapped in a try/catch: `toRay` throws with the offending
   * payload when the engine's ray shape changes, and swallowing that here
   * would turn a broken pick-ray binding into a layer that silently never
   * streams.
   */
  private currentRays(): readonly [Ray, Ray, Ray, Ray] | null {
    const source = this.deps.getPickRays();
    return source ? cornerRays(source) : null;
  }

  /** One settle: every registered layer commits once, against ONE set of rays
   *  (re-deriving them per layer would let a mid-loop camera write split the
   *  commit across two viewports). */
  private commitAll(): void {
    if (this.layers.size === 0) return;
    const rays = this.currentRays();
    if (!rays) return;
    for (const layer of this.layers.values()) void layer.commit(rays);
  }

  private commitLayer(layer: StreamLayerLike): void {
    const rays = this.currentRays();
    if (!rays) return;
    void layer.commit(rays);
  }
}
