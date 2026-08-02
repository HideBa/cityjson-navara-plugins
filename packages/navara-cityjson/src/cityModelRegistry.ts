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
import {
  geoidHeightAt,
  type CityModel,
  type SurfaceStyleEvaluator,
} from "@cityjson/navara-core";
import type { CityModelMesh } from "./cityModelMesh";
import { CITY_MODEL_MESH_KEY } from "./descriptorKeys";
import { resolveMetricEpsg } from "./enuPlacement";
import { DEFAULT_PICK_STRATEGY, type PickStrategy } from "./pickStrategy";
import type { EcefRay, RaycastHit, SurfaceRef } from "./pickTypes";
import type { PickedFeatureLike, ScreenPoint, Selection } from "./selection";
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
        heightOffset: opts.heightOffset,
        pickStrategy: this.pickStrategy,
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
      setStyle: (evaluator: SurfaceStyleEvaluator | null) =>
        mesh.setStyle(evaluator),
      setHighlight: (sel: readonly Selection[], hovered?: Selection) =>
        mesh.setHighlight(sel, hovered ?? null),
      resolvePick: (pick: PickedFeatureLike | ScreenPoint) => {
        if (isScreenPoint(pick)) {
          // own-raycast path: the ray comes from the INJECTED provider, so this
          // branch is exercised in Node with a fake.
          const ray = this.deps.pickRays.getPickRay(pick.x, pick.y);
          return ray ? mesh.resolveRaycast(ray) : null;
        }
        // pickable-wrapper path: prefer an explicit objectIndex/surfaceIndex
        // pair, else map the engine's batchId through the mesh's table.
        const objectIndex = pick.properties?.objectIndex;
        const surfaceIndex = pick.properties?.surfaceIndex;
        if (
          typeof objectIndex === "number" &&
          typeof surfaceIndex === "number"
        ) {
          return mesh.resolveVertexIndices(objectIndex, surfaceIndex);
        }
        if (typeof pick.batchId === "number") {
          const entry = mesh.batchIdMap()[pick.batchId];
          if (!entry) return null;
          return mesh.resolveVertexIndices(
            entry.objectIndex,
            entry.surfaceIndex,
          );
        }
        return null;
      },
      // `CityModelMesh.raycast` is the RaycastHit half of B6's raycast/resolve
      // split; the handle publishes it under the shared contract's name, while
      // `resolvePick` above is the same path resolved to a Selection.
      resolveRaycast: (ray: EcefRay): RaycastHit | null => mesh.raycast(ray),
      batchIdMap: (): ReadonlyArray<SurfaceRef> => mesh.batchIdMap(),
      getBoundsGeodetic: (): GeodeticBounds => mesh.getBoundsGeodetic(),
      triangleCount: () => mesh.triangleCount(),
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
    this.resolveHeightOffset(opts, handle, mesh);
    return handle;
  }

  getHandle(id: string): CityModelHandle | undefined {
    return this.handlesById.get(id);
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
