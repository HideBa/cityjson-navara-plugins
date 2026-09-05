/**
 * The whole of the CityJSON plugin's behaviour, with no engine import.
 *
 * Everything the Navara engine supplies is injected: the descriptor classes
 * (opaque values forwarded to `view.registerMesh`) and a {@link PickRayProvider}.
 * That makes this file — and therefore every assertion in
 * `tests/cityModelRegistry.test.ts` — runnable in plain Node, which is the rule
 * in Global Constraints -> Testing conventions (the engine crashes at module
 * scope under Node: `NODE_IMPORT_SAFE = false`). `CityJSONPlugin.ts` is the thin
 * binding that supplies the real descriptors and the real `getPickRay`.
 *
 * The deps are constructor-injected rather than imported precisely so a sibling
 * package (`@cityjson/navara-flatcitybuf`) can drive this with its own fakes.
 */
import type { Matrix4 } from "three";
import {
  geoidHeightAt,
  type AppearanceTheme,
  type CityModel,
  type SurfaceStyleEvaluator,
} from "@cityjson/navara-core";
import type { CityModelMesh } from "./cityModelMesh";
import { resolveCityColors, type CityColors } from "./cityColors";
import { CITY_MODEL_MESH_KEY } from "./descriptorKeys";
import { resolveMetricEpsg } from "./enuPlacement";
import { DEFAULT_PICK_STRATEGY, type PickStrategy } from "./pickStrategy";
import type { EcefRay, RaycastHit, SurfaceRef } from "./pickTypes";
import type { PickedFeatureLike, ScreenPoint, Selection } from "./selection";
import type { ThemeStyle } from "./themeStyle";
import type {
  AddCityModelOptions,
  CityModelHandle,
  GeodeticBounds,
} from "./types";

export { CITY_MESH_ARRAYS_KEY, CITY_MODEL_MESH_KEY } from "./descriptorKeys";

/**
 * The engine's screen-point -> ECEF-ray seam.
 *
 * Navara's `getPickRay(windowLike, camera, screenPos)` returns a three `Ray`,
 * which satisfies this return shape structurally — so `CityJSONPlugin` adapts
 * it in two lines and nothing else in the package has to know it exists.
 */
export interface PickRayProvider {
  getPickRay(x: number, y: number): EcefRay | null;
}

/** The subset of Navara's `MeshHandle` the registry uses. */
interface MeshHandleLike {
  ref: unknown;
  visible: boolean;
  /** Patch the descriptor's config. Only `matrixWorld` is ever patched here —
   *  see {@link CityModelRegistry.resolveHeightOffset}. */
  update(patch: { matrixWorld: Matrix4 }): void;
  delete(): void;
}

/** The subset of Navara's `ThreeView` the registry uses. */
export interface CityModelViewLike {
  registerMesh(name: string, desc: unknown): void;
  addMesh(config: unknown): MeshHandleLike;
}

export interface CityModelRegistryDeps {
  /** `[descriptorKey, descriptorClass]` pairs, registered in order. */
  readonly descriptors: ReadonlyArray<readonly [string, unknown]>;
  readonly pickRays: PickRayProvider;
  readonly pickStrategy?: PickStrategy;
  /**
   * Geoid undulation sampler. Injected so tests resolve it synchronously
   * instead of hitting the terrain service; defaults to core's `geoidHeightAt`,
   * which is best-effort and resolves 0 rather than rejecting.
   */
  readonly sampleGeoidHeight?: (
    lngDeg: number,
    latDeg: number,
  ) => Promise<number>;
  /** The plugin-wide default colours; a layer's own
   *  `AddCityModelOptions.colors` is laid over it. */
  readonly colors?: CityColors;
}

function isScreenPoint(
  pick: PickedFeatureLike | ScreenPoint,
): pick is ScreenPoint {
  return (
    typeof (pick as ScreenPoint).x === "number" &&
    typeof (pick as ScreenPoint).y === "number"
  );
}

export class CityModelRegistry {
  private view: CityModelViewLike | null = null;
  private readonly handlesById = new Map<string, CityModelHandle>();
  private readonly pickStrategy: PickStrategy;
  private warnedUnresolvablePick = false;

  constructor(private readonly deps: CityModelRegistryDeps) {
    this.pickStrategy = deps.pickStrategy ?? DEFAULT_PICK_STRATEGY;
  }

  /**
   * Register the descriptors and remember the view.
   *
   * Called from the plugin's `init(view, ctx)`, i.e. from *inside*
   * `view.init()`: the engine builds its descriptor registries before it runs
   * plugins, so `registerMesh` works there but not before `init()` (Task B1
   * finding 2 — the B2 fake enforces the same ordering).
   */
  attach(view: CityModelViewLike): void {
    for (const [key, desc] of this.deps.descriptors) {
      view.registerMesh(key, desc);
    }
    this.view = view;
  }

  addCityModel(model: CityModel, opts: AddCityModelOptions): CityModelHandle {
    const view = this.view;
    if (!view) {
      throw new Error(
        "CityJSONPlugin.addCityModel called before view.init() — add the plugin with view.addPlugin(plugin) and await view.init() first.",
      );
    }
    if (this.handlesById.has(opts.id)) {
      throw new Error(
        `CityJSONPlugin.addCityModel: a layer with id "${opts.id}" is already registered. Delete it first — otherwise its mesh would be unreachable and never freed.`,
      );
    }
    // The spec 4.3 CRS gate, applied BEFORE anything is added to the view.
    // `CityModelMesh` re-checks it (it is the class that must not be
    // constructible ungeoreferenced), but doing it here means a refused layer
    // leaves no half-created descriptor behind — and it throws the same error
    // whichever descriptor implementation is in play.
    resolveMetricEpsg(opts.crs ?? model.metadata.referenceSystem);

    const meshHandle = view.addMesh({
      [CITY_MODEL_MESH_KEY]: {
        id: opts.id,
        model,
        crs: opts.crs,
        lod: opts.lod ?? null,
        hiddenTypes: opts.hiddenTypes,
        heightOffset: opts.heightOffset,
        pickStrategy: this.pickStrategy,
        appearance: opts.appearance ?? null,
        textureBaseUrl: opts.textureBaseUrl ?? null,
        textureSource: opts.textureSource,
        // Resolved HERE, once per layer: the descriptor and the mesh only ever
        // see the merged, linear-ready form.
        colors: resolveCityColors(this.deps.colors, opts.colors),
      },
    });

    // The descriptor exposes its behaviour object as `.cityMesh`; a test double
    // may hand the behaviour object back directly.
    const ref = meshHandle.ref as { cityMesh?: CityModelMesh };
    const mesh = ref.cityMesh ?? (meshHandle.ref as CityModelMesh);

    const handle: CityModelHandle = {
      id: opts.id,
      setVisible: (v: boolean) => {
        mesh.setVisible(v);
        meshHandle.visible = v;
      },
      setLod: (lod: string | null) => mesh.setLod(lod),
      setHiddenTypes: (types: ReadonlyArray<string>) =>
        mesh.setHiddenTypes(types),
      setStyle: (evaluator: SurfaceStyleEvaluator | null) =>
        mesh.setStyle(evaluator),
      setThemeStyle: (style: ThemeStyle) => mesh.setThemeStyle(style),
      setAppearance: (theme: AppearanceTheme | null) =>
        mesh.setAppearance(theme),
      setHighlight: (sel: readonly Selection[], hovered?: Selection) =>
        mesh.setHighlight(sel, hovered ?? null),
      resolvePick: (pick: PickedFeatureLike | ScreenPoint) => {
        if (isScreenPoint(pick)) {
          // own-raycast path: the ray comes from the INJECTED provider, so this
          // branch is exercised in Node with a fake.
          const ray = this.deps.pickRays.getPickRay(pick.x, pick.y);
          return ray ? mesh.resolveRaycastSelection(ray) : null;
        }
        // A caller that already knows the indices (a replayed pick, a test, a
        // future engine that reports them) is answered directly.
        const objectIndex = pick.properties?.objectIndex;
        const surfaceIndex = pick.properties?.surfaceIndex;
        if (
          typeof objectIndex === "number" &&
          typeof surfaceIndex === "number"
        ) {
          return mesh.resolveVertexIndices(objectIndex, surfaceIndex);
        }
        // There is deliberately NO batchId branch. The spike measured
        // `PickableMeshWrapper` allocating ONE uniform batch id for the whole
        // mesh (both triangles of the probe returned 4666372, with
        // `properties: null`), so a batch id is not a triangle index and
        // `batchIdMap()[batchId]` could only ever be a coincidence.
        this.warnUnresolvablePick();
        return null;
      },
      // `CityModelMesh.raycast` is the RaycastHit half of B6's raycast/resolve
      // split; the handle publishes it under the shared contract's name, while
      // `resolvePick` above is the same path resolved to a Selection.
      resolveRaycast: (ray: EcefRay): RaycastHit | null => mesh.raycast(ray),
      batchIdMap: (): ReadonlyArray<SurfaceRef> => mesh.batchIdMap(),
      getBoundsGeodetic: (): GeodeticBounds => mesh.getBoundsGeodetic(),
      triangleCount: () => mesh.triangleCount(),
      // Read through to the placement on every call rather than captured: the
      // offset starts at 0 and is replaced when the geoid sample below lands.
      heightOffset: () => mesh.getPlacement().heightOffset,
      delete: () => {
        // Only drop the map entry if it is still ours: a delete() called twice
        // must not evict a same-id layer added in between.
        if (this.handlesById.get(opts.id) === handle) {
          this.handlesById.delete(opts.id);
        }
        meshHandle.delete();
      },
    };

    this.handlesById.set(opts.id, handle);
    this.resolveHeightOffset(opts, handle, mesh, meshHandle);
    return handle;
  }

  getHandle(id: string): CityModelHandle | undefined {
    return this.handlesById.get(id);
  }

  /**
   * Warn once that an engine pick event cannot be resolved to a surface.
   *
   * Only reachable under `pickStrategy: "pickable-wrapper"`, which the spike
   * proved cannot carry per-surface identity; the shipped default is
   * `"own-raycast"`, whose picks arrive as a `ScreenPoint` and never reach
   * here. Once per registry, because a pick event fires on every click.
   */
  private warnUnresolvablePick(): void {
    if (this.warnedUnresolvablePick) return;
    this.warnedUnresolvablePick = true;
    console.warn(
      `[navara-cityjson] pickStrategy "${this.pickStrategy}" cannot resolve a surface from an engine pick event: PickableMeshWrapper carries one uniform batch id per mesh, not per triangle. Use the "own-raycast" strategy (the default) and route picks as screen points.`,
    );
  }

  handles(): readonly CityModelHandle[] {
    return [...this.handlesById.values()];
  }

  /**
   * Vertical datum. A caller-supplied `heightOffset` wins outright; otherwise
   * sample the geoid at the layer origin and re-place the mesh when it lands.
   *
   * The mesh renders immediately at offset 0 rather than waiting on a network
   * round trip, and core's sampler resolves 0 on failure (logging its own
   * warning), so this never blocks first paint. See Global Constraints ->
   * Vertical datum.
   */
  private resolveHeightOffset(
    opts: AddCityModelOptions,
    handle: CityModelHandle,
    mesh: CityModelMesh,
    meshHandle: MeshHandleLike,
  ): void {
    if (opts.heightOffset !== undefined) return;
    const sample = this.deps.sampleGeoidHeight ?? geoidHeightAt;
    // The origin's geodetic position is read off the placement the mesh was
    // built with, rather than recomputed here: one proj4 conversion, and the
    // sample is guaranteed to be taken where the layer actually sits.
    const { lngDeg, latDeg } = mesh.getPlacement().frame;
    void sample(lngDeg, latDeg)
      .then((metres) => {
        // The layer may have been deleted (or replaced) while the fetch was in
        // flight — its mesh is disposed and must not be touched.
        if (this.handlesById.get(opts.id) !== handle) return;
        mesh.setHeightOffset(metres);
        // The descriptor captured the OLD placement matrix when it created the
        // mesh; `setHeightOffset` only rewrote the Object3D. Push the new one
        // through the engine's own update path so the two cannot disagree —
        // otherwise a later `handle.update({ position })` would recompose from
        // the stale frame and snap the layer back to its pre-geoid height.
        meshHandle.update({
          matrixWorld: mesh.getPlacement().matrixWorld,
        });
      })
      .catch((error: unknown) => {
        // Only reachable with an injected sampler that rejects; core's own
        // never does. The layer stays at 0 m, i.e. geoid-separation low, which
        // is the documented best-effort fallback.
        console.warn(
          `[navara-cityjson] geoid sampling failed for layer "${opts.id}"; leaving heightOffset at 0 m.`,
          error,
        );
      });
  }
}
