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
  MeshDescWithSelectiveEffect,
  PickableMeshWrapper,
  type MeshConfig,
  type ViewContext,
} from "@navaramap/three";
// `ThreeView` is @navaramap/three's DEFAULT export, not a named one.
import type ThreeView from "@navaramap/three";
import type { Mesh } from "three";
import type { AppearanceTheme, CityModel } from "@cityjson/navara-core";
import { CityModelMesh } from "./cityModelMesh";
import type { ResolvedCityColors } from "./cityColors";
import type { PickStrategy } from "./pickStrategy";
import type { TextureSource } from "./texturedMaterials";

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
  /** See `AddCityModelOptions` for all three. */
  readonly appearance?: AppearanceTheme | null;
  readonly textureBaseUrl?: string | null;
  readonly textureSource?: TextureSource;
  /** Already resolved by the registry (plugin default + layer override). */
  readonly colors?: ResolvedCityColors;
}

export type CityModelDescConfig = MeshConfig & {
  readonly cityModel: CityModelDescOptions;
};

/**
 * `MeshDescWithSelectiveEffect`, not the plain `MeshDesc`, and not for the
 * selective effects: its `getPassKey()` puts the mesh in the engine's MRT
 * scene whenever any optional G-buffer is allocated. The plain base class
 * answers "opaque", a forward scene the engine draws AFTER it has copied the
 * G-buffer out, so a city mesh there never wrote its normals (or its CSM
 * shadow term) anywhere a lighting pass could read them — every wall came out
 * as flat albedo whatever the sun did. The MRT scene is also where the
 * engine's own shadow-receiving mesh descriptors live, so depth ordering
 * against terrain and draped layers is the engine's, not ours.
 */
export class CityModelMeshDesc extends MeshDescWithSelectiveEffect<CityModelDescConfig> {
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
      appearance: options.appearance,
      textureBaseUrl: options.textureBaseUrl,
      textureSource: options.textureSource,
      colors: options.colors,
      // The engine's cascaded-shadow registry (`SunLightDesc` listens): a
      // material it has never seen receives no shadow. See `cityMaterial.ts`.
      shadowMaterials: {
        register: (m) => this.ctx.applyShadowMaterial(m),
        unregister: (m) => this.ctx.removeShadowMaterial(m),
      },
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
