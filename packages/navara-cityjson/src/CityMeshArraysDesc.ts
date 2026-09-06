/**
 * ENGINE BINDING MODULE — imports `@navaramap/*`, so no test may import it.
 *
 * Navara `MeshDesc` wrapper around `CityMeshArraysMesh`: one instance per
 * streaming cell (Tasks C8/C10a). All behaviour is in `cityMesh.ts`, which
 * imports nothing from the engine.
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
import { CityMeshArraysMesh, type AddCityMeshArraysOptions } from "./cityMesh";

export type CityMeshArraysDescConfig = MeshConfig & {
  readonly cityMeshArrays: AddCityMeshArraysOptions;
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
export class CityMeshArraysDesc extends MeshDescWithSelectiveEffect<CityMeshArraysDescConfig> {
  /** The behaviour object every `CityMeshHandle` method delegates to. */
  cityMesh!: CityMeshArraysMesh;

  private readonly descConfig: CityMeshArraysDescConfig;
  private pickable: PickableMeshWrapper | undefined;

  constructor(
    view: ThreeView,
    ctx: ViewContext,
    config: CityMeshArraysDescConfig,
  ) {
    super(view, ctx, config);
    this.descConfig = config;
  }

  createMesh(): Mesh {
    this.cityMesh = new CityMeshArraysMesh(this.descConfig.cityMeshArrays);
    // Task B1 finding 7: the cell's ENU->ECEF frame is the mesh's top-level
    // `matrixWorld`; `MeshDesc.applyTransform` copies it and disables
    // auto-update.
    this.matrixWorld ??= this.cityMesh.matrixWorld;
    if (this.cityMesh.pickStrategy === "pickable-wrapper") {
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
