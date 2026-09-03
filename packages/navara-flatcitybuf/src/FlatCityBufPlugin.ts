/**
 * ENGINE BINDING MODULE — imports `@navaramap/*`, so no test may import it (nor
 * the package barrel, which does NOT re-export it: this file is reachable only
 * through the `./plugin` subpath).
 *
 * Navara plugin streaming FlatCityBuf city models by camera footprint. All
 * behaviour lives in `StreamLayerRegistry`, which is engine-free and therefore
 * unit-testable in Node; this class only supplies the three things that
 * genuinely come from the engine — the descriptor class, `getPickRay` (via
 * `navaraViewRaySource`), and `addCityMeshArrays(view, …)` — and forwards
 * every call.
 *
 * Registration happens inside `init()`, which the engine runs from within
 * `ThreeView.init()` *after* its descriptor registries exist (Task B1 finding
 * 2). `view.addPlugin(plugin)` must therefore still be called before
 * `view.init()`.
 */
import { Plugin, type ViewContext } from "@navaramap/three";
// `ThreeView` is @navaramap/three's DEFAULT export, not a named one.
import type ThreeView from "@navaramap/three";
import {
  CITY_MESH_ARRAYS_KEY,
  type PickStrategy,
} from "@cityjson/navara-cityjson";
import { CityMeshArraysDesc } from "@cityjson/navara-cityjson/plugin";
import { createCellMeshFactory } from "./cellMeshFactory";
import { navaraViewRaySource } from "./engineRays";
import type { ViewportSize, PickRaySource } from "./navaraRays";
import type { FcbStreamLayerHandle } from "./streamLayer";
import {
  StreamLayerRegistry,
  type OpenStreamOptions,
  type StreamLayerLike,
} from "./streamRegistry";
import { WorkerClient } from "./workerClient";

export interface FlatCityBufPluginOptions {
  /** Task B1's PICK_PATH verdict, forwarded to every cell mesh. */
  readonly pickStrategy?: PickStrategy;
  /**
   * Viewport dimensions in CSS pixels. Supplied by the component that owns the
   * container element and its `ResizeObserver`, because `ThreeView` documents
   * `canvas` as a CONSTRUCTOR option, not a readable property (Task C4).
   */
  readonly getViewportSize: () => ViewportSize;
  /** Geoid sampler override; defaults to core's `geoidHeightAt`. Mainly a test
   *  and offline-development seam (Global Constraints -> Vertical datum). */
  readonly sampleGeoidHeight?: (
    lngDeg: number,
    latDeg: number,
  ) => Promise<number>;
}

export class FlatCityBufPlugin extends Plugin<ThreeView, ViewContext> {
  private view: ThreeView | null = null;
  private raySource: PickRaySource | null = null;
  private readonly registry: StreamLayerRegistry;

  constructor(private readonly options: FlatCityBufPluginOptions) {
    super();
    this.registry = new StreamLayerRegistry({
      // A streamed cell is exactly a static layer's arrays-backed mesh, so it
      // uses the same descriptor. Registering it here as well as in
      // `CityJSONPlugin` is idempotent (the engine's registry is a Map keyed by
      // name, and both plugins register the same class from the same module
      // instance) and is what makes this plugin usable on its own.
      descriptors: [[CITY_MESH_ARRAYS_KEY, CityMeshArraysDesc]],
      createClient: () => new WorkerClient(),
      // The stamping (layerId / cellKey / pickStrategy) lives in an
      // engine-free module so it is provable in Node — see `cellMeshFactory`.
      createMeshFactory: (layerId, textures) =>
        createCellMeshFactory({
          layerId,
          getView: () => this.view,
          pickStrategy: this.options.pickStrategy,
          textures,
        }),
      getPickRays: () => this.raySource,
      sampleGeoidHeight: this.options.sampleGeoidHeight,
    });
  }

  async init(view: ThreeView, _ctx: ViewContext): Promise<void> {
    this.view = view;
    this.raySource = navaraViewRaySource(view, this.options.getViewportSize);
    // Registers the cell descriptor and binds the settle machine to
    // `view.camera` (move events) plus `view` (`idle`) — Task B1 finding 6.
    // `idle` only ever flushes a debounce a `moveend` already armed: a bare
    // `setCamera` emits `idle` and nothing else, and must not commit.
    this.registry.attach(view);
  }

  /**
   * Run `fn` with the settle controller deaf to camera events, so a
   * programmatic camera move (restore, `fitAll`, `alignView`, `flyTo`) never
   * looks like a user gesture and never triggers a commit. A no-op passthrough
   * before `init()` has run, so the viewport can call it unconditionally.
   */
  suppressSettle<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.registry.suppressSettle(fn);
  }

  /**
   * {@link suppressSettle}, plus one commit once the move has landed — for a
   * programmatic move whose DESTINATION the user is about to look at (a fit, a
   * camera restore, an alignment). Without it a suppressed move leaves the
   * viewport framed and empty until the user nudges the camera.
   */
  suppressSettleThenCommit<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.registry.suppressSettleThenCommit(fn);
  }

  openStream(opts: OpenStreamOptions): Promise<FcbStreamLayerHandle> {
    return this.registry.openStream(opts);
  }

  getHandle(id: string): StreamLayerLike | undefined {
    return this.registry.getHandle(id);
  }

  handles(): readonly StreamLayerLike[] {
    return this.registry.handles();
  }

  remove(id: string): void {
    this.registry.remove(id);
  }

  dispose(): void {
    this.registry.dispose();
  }
}
