/**
 * ENGINE BINDING MODULE — imports `@navaramap/*`, so no test may import it.
 *
 * Navara `MeshDesc` wrapper around `CityMeshArraysMesh`: one instance per
 * streaming cell (Tasks C8/C10a). All behaviour is in `cityMesh.ts`, which
 * imports nothing from the engine.
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
import { CityMeshArraysMesh, type AddCityMeshArraysOptions } from "./cityMesh";

export type CityMeshArraysDescConfig = MeshConfig & {
  readonly cityMeshArrays: AddCityMeshArraysOptions;
};

export class CityMeshArraysDesc extends MeshDesc<CityMeshArraysDescConfig> {
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
