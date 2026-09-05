/**
 * ENGINE BINDING MODULE — imports `@navaramap/*`, so no test may import it (nor
 * the package barrel, which re-exports it).
 *
 * Navara plugin exposing CityJSON / CityJSONSeq city models as globe-placed
 * meshes. All behaviour lives in `CityModelRegistry`, which is engine-free and
 * therefore unit-testable in Node; this class only supplies the two things that
 * genuinely come from the engine — the descriptor classes and `getPickRay` —
 * and forwards every call.
 *
 * Registration happens inside `init()`, which the engine runs from within
 * `ThreeView.init()` *after* its descriptor registries exist (Task B1 finding
 * 2). `view.addPlugin(plugin)` must therefore still be called before
 * `view.init()`, which Task B8's ordered plugin list guarantees.
 */
import { getPickRay, Plugin, type ViewContext } from "@navaramap/three";
// `ThreeView` is @navaramap/three's DEFAULT export, not a named one.
import type ThreeView from "@navaramap/three";
import { Vector2 } from "three";
import type { CityModel } from "@cityjson/navara-core";
import { CityMeshArraysDesc } from "./CityMeshArraysDesc";
import { CityModelMeshDesc } from "./CityModelMeshDesc";
import {
  CityModelRegistry,
  type CityModelViewLike,
} from "./cityModelRegistry";
import { CITY_MESH_ARRAYS_KEY, CITY_MODEL_MESH_KEY } from "./descriptorKeys";
import type { CityAppearance } from "./cityAppearance";
import type { PickStrategy } from "./pickStrategy";
import type { EcefRay } from "./pickTypes";
import type { AddCityModelOptions, CityModelHandle } from "./types";

export { CITY_MESH_ARRAYS_KEY, CITY_MODEL_MESH_KEY };

export interface CityJSONPluginOptions {
  /** Task B1's PICK_PATH verdict; defaults to `DEFAULT_PICK_STRATEGY`. */
  readonly pickStrategy?: PickStrategy;
  /** Default colours for every layer this plugin adds (highlight, hover, the
   *  surface palette); `AddCityModelOptions.appearance` overrides per layer. */
  readonly appearance?: CityAppearance;
}

export class CityJSONPlugin extends Plugin<ThreeView, ViewContext> {
  private view: ThreeView | null = null;
  private readonly registry: CityModelRegistry;

  constructor(options: CityJSONPluginOptions = {}) {
    super();
    this.registry = new CityModelRegistry({
      descriptors: [
        [CITY_MODEL_MESH_KEY, CityModelMeshDesc],
        [CITY_MESH_ARRAYS_KEY, CityMeshArraysDesc],
      ],
      // The engine seam, supplied here and nowhere else.
      pickRays: { getPickRay: (x, y) => this.pickRay(x, y) },
      pickStrategy: options.pickStrategy,
      appearance: options.appearance,
    });
  }

  async init(view: ThreeView): Promise<void> {
    this.view = view;
    // Structural: ThreeView already satisfies CityModelViewLike, which is how
    // the registry stays engine-free.
    const viewLike: CityModelViewLike = view;
    this.registry.attach(viewLike);
  }

  addCityModel(model: CityModel, opts: AddCityModelOptions): CityModelHandle {
    return this.registry.addCityModel(model, opts);
  }

  getHandle(id: string): CityModelHandle | undefined {
    return this.registry.getHandle(id);
  }

  handles(): readonly CityModelHandle[] {
    return this.registry.handles();
  }

  /**
   * `getPickRay(windowLike, camera, screenPos)` (Task B1 finding 5): a free
   * function, not a view method; `windowLike` is `{width, height, pixelRatio}`
   * and `screenPos` is in CSS pixels relative to the canvas. The returned three
   * `Ray` is already in ECEF and satisfies {@link EcefRay} structurally, so no
   * conversion is needed.
   */
  private pickRay(x: number, y: number): EcefRay | null {
    const view = this.view;
    if (!view) return null;
    const windowLike = {
      width: view.screenSize.x,
      height: view.screenSize.y,
      pixelRatio: view.pixelRatio,
    };
    return getPickRay(windowLike, view.camera.raw, new Vector2(x, y));
  }
}
