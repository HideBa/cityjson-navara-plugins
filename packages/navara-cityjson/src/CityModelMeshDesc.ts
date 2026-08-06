/**
 * ENGINE BINDING MODULE — one of only three files in this package that import
 * `@navaramap/*`. No test may import it (the engine crashes at module scope
 * under Node: `NODE_IMPORT_SAFE = false`).
 *
 * Navara `MeshDesc` wrapper around `CityModelMesh`. Everything behavioural
 * lives in `CityModelMesh` (Node-testable); this class only owns the engine
 * contract: create the instance, publish its ENU->ECEF frame as the mesh's
 * `matrixWorld`, opt into picking when the strategy asks for it, and tear down
 * on destroy.
 *
 * Placement is NOT an engine concern here — `CityModelMesh` builds its frame
 * from `@cityjson/navara-core`'s `makeEnuFrame` (Task A13b), never from
 * Navara's `eastNorthUpToFixedFrame`, so static layers and streaming cells
 * share one frame implementation.
 */
import {
  MeshDesc,
  PickableMeshWrapper,
  type MeshConfig,
  type ViewContext,
} from "@navaramap/three";
// `ThreeView` is @navaramap/three's DEFAULT export, not a named one.
import type ThreeView from "@navaramap/three";
import type { Mesh } from "three";
import type { CityModel } from "@cityjson/navara-core";
import { CityModelMesh } from "./cityModelMesh";
import type { PickStrategy } from "./pickStrategy";

/** The nested config the registry passes under `CITY_MODEL_MESH_KEY`. */
export interface CityModelDescOptions {
  readonly id: string;
  readonly model: CityModel;
  readonly crs?: string | number;
  readonly lod?: string | null;
  /** First-level object types built without geometry (see
   *  `CityModelMesh.setHiddenTypes`); changed afterwards through the handle. */
  readonly hiddenTypes?: ReadonlyArray<string>;
  /** Initial vertical-datum offset. Usually undefined here — the registry
   *  applies the sampled geoid undulation through `setHeightOffset()` once it
   *  resolves (Global Constraints -> Vertical datum). */
  readonly heightOffset?: number;
  readonly pickStrategy?: PickStrategy;
}

export type CityModelDescConfig = MeshConfig & {
  readonly cityModel: CityModelDescOptions;
};

export class CityModelMeshDesc extends MeshDesc<CityModelDescConfig> {
  /** The behaviour object every `CityModelHandle` method delegates to. */
  cityMesh!: CityModelMesh;

  private readonly descConfig: CityModelDescConfig;
  private pickable: PickableMeshWrapper | undefined;

  constructor(view: ThreeView, ctx: ViewContext, config: CityModelDescConfig) {
    super(view, ctx, config);
    // `BaseDesc` keeps no reference to the config, so hold our own.
    this.descConfig = config;
  }

  createMesh(): Mesh {
    const options = this.descConfig.cityModel;
    this.cityMesh = new CityModelMesh({
      id: options.id,
      model: options.model,
      crs: options.crs,
      lod: options.lod ?? null,
      hiddenTypes: options.hiddenTypes,
      heightOffset: options.heightOffset,
      pickStrategy: options.pickStrategy,
      // No `makePlacementMatrix` override: the default is core's
      // `makeEnuFrame` via `buildPlacement`.
    });

    // Task B1 finding 7: the ENU->ECEF frame travels as the mesh's top-level
    // `matrixWorld`, which `MeshDesc.applyTransform` (called straight after
    // this method) copies onto the Object3D with auto-update disabled. Taking
    // it from the mesh's own placement means the engine and the mesh can never
    // disagree about where the layer is. An explicit config `matrixWorld` still
    // wins, for callers that want to override placement outright.
    this.matrixWorld ??= this.cityMesh.getPlacement().matrixWorld;

    if (this.cityMesh.pickStrategy === "pickable-wrapper") {
      // The wrapper carries ONE uniform batch id for the whole mesh (Task B1
      // §3), so this branch resolves picks per LAYER, not per surface. It is
      // not the default; `DEFAULT_PICK_STRATEGY` is "own-raycast".
      this.pickable = new PickableMeshWrapper(this.cityMesh.object3d, this.ctx);
      this.ctx.registerPickableMesh(this.id, this.pickable);
    }
    return this.cityMesh.object3d;
  }

  onDestroy(): void {
    if (this.pickable) {
      this.ctx.unregisterPickableMesh(this.id);
      this.pickable = undefined;
    }
    this.cityMesh?.dispose();
    super.onDestroy();
  }
}
