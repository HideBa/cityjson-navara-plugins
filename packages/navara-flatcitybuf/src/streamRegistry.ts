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
  type AppearanceTheme,
  type SurfacePalette,
  type Rule,
} from "@cityjson/navara-core";
import { CellCache } from "./cellCache";
import type { CellMeshFactory } from "./cellMeshes";
import {
  FLYTO_QUIET_MS,
  GEOID_TIMEOUT_MS,
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
import { createLayerTextures } from "./layerTextures";
import type { TextureCache, TextureSource } from "@cityjson/navara-cityjson";
import { resolveCityColors, type CityColors } from "@cityjson/navara-cityjson";
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
  /** `textures` is the layer's shared image cache, for cells built under a
   *  texture theme. */
  readonly createMeshFactory: (
    layerId: string,
    textures: TextureCache,
  ) => CellMeshFactory;
  /** Image-loading seam for texture themes; defaults to three's loader. */
  readonly createTextureSource?: () => TextureSource;
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
  /** The plugin-wide default colours; a stream's own
   *  `OpenStreamOptions.colors` is laid over it. */
  readonly colors?: CityColors;
}

export interface OpenStreamOptions {
  readonly id: string;
  readonly source: { readonly url: string } | { readonly blob: Blob };
  readonly rules?: ReadonlyArray<Rule>;
  readonly rulesEnabled?: boolean;
  readonly visible?: boolean;
  /** First-level object types to stream WITHOUT geometry — hiding "Building"
   *  also hides its BuildingParts. Seeded before the first commit, so a
   *  restored layer's very first fetch is already filtered. */
  readonly hiddenTypes?: ReadonlyArray<string>;
  /** Appearance theme to bake from the first commit; `null`/omitted draws
   *  the plain colours. Changed afterwards through `setAppearance`. */
  readonly appearance?: AppearanceTheme | null;
  /** Vertical-datum correction in metres. Supplied wins outright; omitted
   *  means `await geoidHeightAt(centreLng, centreLat)`. Either way it is known
   *  before the worker's placement is established, so every cell bakes in the
   *  right frame from the very first fetch. */
  readonly heightOffset?: number;
  /** This stream's own colours (highlight, hover, surface palette), laid
   *  over the plugin's `colors` option; the palette travels to the worker in
   *  `open`. Unrelated to `appearance`, which names a theme the DATA carries. */
  readonly colors?: CityColors;
}

/** The ambient timers, resolved at call time so a test's fake clock (installed
 *  after the registry was constructed) is still honoured — the same shape
 *  `settleController.ts` uses for exactly the same reason. */
const defaultTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

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
  /** Pending destination commit — see {@link suppressSettleThenCommit}. */
  private destinationCommitTimer: ReturnType<TimerApi["setTimeout"]> | null =
    null;

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
   *
   * Ends by committing every layer already open. A layer opened BEFORE the
   * plugin had a view got no initial commit — `currentRays()` had nothing to
   * ask — and nothing else would revisit it, so it would sit empty until the
   * user happened to move the camera. This is the same "a commit is owed and
   * no camera event will arrive" case `onCommitNeeded` exists for.
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
    this.commitAll();
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
   * {@link suppressSettle}, plus ONE commit at the move's destination.
   *
   * Suppression alone leaves a commit **owed**. Camera events are swallowed
   * for the whole flight, so a fit that lands squarely on a city fetches
   * nothing at all: the viewport sits framed and empty until the user happens
   * to nudge the camera. That was reported from the M7.5 browser smoke, and it
   * is the same shape as the two cases that already commit out of band —
   * {@link attach}'s trailing `commitAll()` and `onCommitNeeded` — "a commit is
   * owed and no camera event is going to arrive".
   *
   * SCHEDULED, not immediate: the commit is queued for `FLYTO_QUIET_MS` after
   * `fn`'s promise settles, which is exactly when the suppression window
   * closes — the same constant that decides when real camera events start
   * counting again, so the two can never disagree. What that promise means
   * depends on the caller: Navara 0.1.x's `flyTo` resolves at the END of its
   * flight (or when a newer move supersedes it), so a caller that returns it
   * holds the gate for the whole animation and the commit lands `FLYTO_QUIET_MS`
   * after touchdown; a synchronous `setCamera` — or 0.0.5's `flyTo`, which
   * returned nothing — settles at once, and the window has to absorb the
   * whole animation on its own. Committing at settle time itself would, in
   * the second case, fetch the viewport the camera is leaving.
   *
   * No double-commit with a user gesture: while the gate is held, camera
   * events produce nothing at all, so nothing else can commit inside the
   * window. A gesture that begins the instant the gate reopens races this
   * commit, and `WorkerClient`'s epoch makes the LATER one win — the same
   * ordering that already governs two settles in quick succession.
   *
   * A rejected move has no destination worth fetching, so it commits nothing.
   */
  async suppressSettleThenCommit<T>(fn: () => Promise<T> | T): Promise<T> {
    const flight = this.suppressSettle(fn);
    flight.then(
      () => this.commitAfterSuppression(),
      () => undefined,
    );
    return await flight;
  }

  /** The queued destination commit of {@link suppressSettleThenCommit}. At
   *  most one is pending: a second programmatic move before the first landed
   *  supersedes it, and its own window is the one that matters. */
  private commitAfterSuppression(): void {
    if (this.disposed || this.controller === null) return;
    const timers = this.deps.timers ?? defaultTimers;
    if (this.destinationCommitTimer !== null) {
      timers.clearTimeout(this.destinationCommitTimer);
    }
    this.destinationCommitTimer = timers.setTimeout(() => {
      this.destinationCommitTimer = null;
      if (this.disposed) return;
      this.commitAll();
    }, FLYTO_QUIET_MS);
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
    // Once per stream, before the worker opens: the worker needs the palette
    // in its `open`, the handle needs the highlight pair.
    const colors = resolveCityColors(this.deps.colors, opts.colors);
    try {
      const header = await this.openWorker(
        client,
        opts,
        opts.heightOffset,
        colors.surfacePalette,
      );
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
        (await this.sampleHeightOffset(opts.id, centreLng, centreLat));
      if (opts.heightOffset === undefined) {
        // Establishes the worker's placement with the resolved offset. Only
        // now can a `fetch` be dispatched — see `openWorker`.
        await this.openWorker(
          client,
          opts,
          heightOffsetM,
          colors.surfacePalette,
        );
      }

      // Relative texture paths resolve against the `.fcb`'s own URL; a Blob
      // has none, so its relative images cannot load (the cache warns once).
      const textures = createLayerTextures({
        baseUrl: "url" in opts.source ? opts.source.url : null,
        source: this.deps.createTextureSource?.(),
        warn: (message) => console.warn(`[stream:${opts.id}] ${message}`),
      });
      const handle: FcbStreamLayerHandle = new FcbStreamLayerHandle({
        id: opts.id,
        client,
        textures,
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
        colors,
        meshFactory: this.deps.createMeshFactory(opts.id, textures.cache),
        // Delegating rather than captured: `getPickRays()` is null until the
        // plugin has a view, and a layer opened in between must still pick.
        pickRays: this.pickRays,
        // A LoD change must refetch even for a viewport that has not moved —
        // hysteresis would otherwise skip the commit and leave the old LoD
        // resident indefinitely (B1) — and so must resuming camera sync, which
        // left the layer resident on an older viewport. The handle does not own
        // the camera, so the driver supplies the forced commit.
        onCommitNeeded: () => this.commitLayer(handle),
      });

      // Seeded BEFORE the first commit, deliberately: the handle defaults to
      // `rulesEnabled: false` while the app's layer default is true, so an
      // unseeded first fetch would bake no rule colours and every resident
      // cell would need a recolor round trip to catch up (C10a/C10b ledger).
      handle.setVisible(opts.visible ?? true);
      handle.setRules(opts.rules ?? [], opts.rulesEnabled ?? true);
      // Same reason, one step stronger: an unseeded first fetch would bake the
      // hidden types' geometry and only drop it on the refetch a later toggle
      // forces — a visible flash of everything the user had hidden.
      handle.setHiddenTypes(opts.hiddenTypes ?? []);
      handle.setAppearance(opts.appearance ?? null);

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
   * The vertical-datum offset, or 0 — but never a hang.
   *
   * This is the ONE await in the whole plugin that a network stall can block
   * indefinitely, and it blocks the layer's entire existence: no worker
   * placement, no cells, no error. Core's sampler already swallows failures
   * (it resolves 0 and logs) but it issues a bare `fetch` with no
   * `AbortSignal`, and browser `fetch` has no default timeout — so a
   * terrain.reearth.land response that never arrives would leave `openStream`
   * pending forever.
   *
   * Bounded HERE rather than in core's fetch, deliberately:
   *
   * - it is the awaiting caller that needs the bound. The static path (Task
   *   B7) samples the same service without blocking anything — it renders at
   *   offset 0 and re-places when the sample lands — so core has no such
   *   requirement and gains nothing from a timeout.
   * - the sampler is an INJECTED seam. Racing here bounds whatever the host
   *   supplied, not just core's `fetch`; an `AbortSignal.timeout` inside core
   *   would bound neither an injected sampler nor core's own `decode` step
   *   (`createImageBitmap`), which is equally capable of never settling.
   *
   * What it does NOT do: cancel the in-flight request. The connection is left
   * to the browser; we simply stop waiting on it. Adding `AbortSignal.timeout`
   * to core's fetch is still worth doing for connection hygiene, and is
   * complementary to this — recorded as a follow-up rather than folded in,
   * because it changes a module three packages share.
   *
   * A rejecting sampler is treated the same way as a stalled one: the vertical
   * datum is documented as best effort with a 0 fallback (Global Constraints
   * -> Vertical datum), so it must not be able to fail a layer open.
   */
  private async sampleHeightOffset(
    id: string,
    lngDeg: number,
    latDeg: number,
  ): Promise<number> {
    const sample = this.deps.sampleGeoidHeight ?? geoidHeightAt;
    const timers = this.deps.timers ?? defaultTimers;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const timedOut = Symbol("geoid-timeout");
    const deadline = new Promise<typeof timedOut>((resolve) => {
      handle = timers.setTimeout(() => resolve(timedOut), GEOID_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        (async () => await sample(lngDeg, latDeg))(),
        deadline,
      ]);
      if (result !== timedOut && Number.isFinite(result)) return result;
      this.warnGeoidFallback(id, lngDeg, latDeg, result === timedOut);
      return 0;
    } catch (error) {
      this.warnGeoidFallback(id, lngDeg, latDeg, false, error);
      return 0;
    } finally {
      // Both for the browser (a 10 s handle held per layer) and for a test's
      // fake clock, which would otherwise still have work pending.
      if (handle !== null) timers.clearTimeout(handle);
    }
  }

  private warnGeoidFallback(
    id: string,
    lngDeg: number,
    latDeg: number,
    timedOut: boolean,
    error?: unknown,
  ): void {
    console.warn(
      `[navara-flatcitybuf] layer "${id}": the geoid sample at ${lngDeg.toFixed(4)}, ${latDeg.toFixed(4)} ` +
        (timedOut
          ? `did not resolve within ${GEOID_TIMEOUT_MS} ms`
          : `failed`) +
        `; falling back to heightOffset 0 m — the model will sit at its geoid separation (~43 m for NAP) below the terrain. ` +
        `Pass \`heightOffset\` to openStream to skip the sample entirely.`,
      ...(error === undefined ? [] : [error]),
    );
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
    surfaceColors: SurfacePalette | undefined,
  ): Promise<FcbHeaderModel> {
    const resp = await client.send(
      "url" in opts.source
        ? { type: "open", url: opts.source.url, heightOffset, surfaceColors }
        : { type: "open", blob: opts.source.blob, heightOffset, surfaceColors },
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
    if (this.destinationCommitTimer !== null) {
      (this.deps.timers ?? defaultTimers).clearTimeout(
        this.destinationCommitTimer,
      );
      this.destinationCommitTimer = null;
    }
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
