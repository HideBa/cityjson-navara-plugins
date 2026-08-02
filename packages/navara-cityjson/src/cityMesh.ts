/**
 * Low-level "arrays + frame -> mesh on the globe" primitive.
 *
 * `CityModelMesh` (Task B6) is the rich, model-backed version of the same idea;
 * this one exists because the streaming plugin has neither a `CityModel` nor an
 * LoD to rebuild from — it has one decoded cell and one ENU frame per cell
 * (Tasks C8/C10a), and the colors arrive pre-baked from the worker.
 *
 * Engine-free by design: no `@navaramap/*` import anywhere in this file, so
 * Task C10a's tests can drive it under plain Node. The Navara descriptor that
 * wraps it lives in `CityMeshArraysDesc.ts`.
 */
import {
  FrontSide,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Vector3,
} from "three";
import type { CityMeshArrays, EnuFrame } from "@cityjson/navara-core";
import { geometryFromMeshArrays } from "./cityMeshGeometry";
import { CITY_MESH_ARRAYS_KEY } from "./descriptorKeys";
import { DEFAULT_PICK_STRATEGY, type PickStrategy } from "./pickStrategy";
import type { EcefRay, RaycastHit, SurfaceRef } from "./pickTypes";

export interface AddCityMeshArraysOptions {
  readonly id: string;
  readonly arrays: CityMeshArrays;
  readonly frame: EnuFrame;
  /** Stamped into the descriptor's pick properties so a `PickedFeature` routes
   *  back to the owning handle (Task B15). Defaults to `id`. */
  readonly layerId?: string;
  /** Streaming only: which resident cell this mesh is. Task C10b reads it off
   *  `properties.cellKey` to find the cell that owns a batchId. */
  readonly cellKey?: string;
  /** Task B1's PICK_PATH verdict; defaults to {@link DEFAULT_PICK_STRATEGY}. */
  readonly pickStrategy?: PickStrategy;
}

/**
 * The public per-cell handle (shared contract). Every member is flat — there is
 * no `handle.mesh.` indirection — because Task C10b picks, recolors and hides
 * cells through exactly these members. `ref` is the escape hatch for the rare
 * caller that genuinely needs the descriptor/Object3D.
 */
export interface CityMeshHandle {
  /** The descriptor instance the engine created for this mesh. */
  readonly ref: unknown;
  /** Swap the vertex-color buffer (rule recolor of a resident cell). */
  setColors(colors: Float32Array): void;
  setVisible(visible: boolean): void;
  triangleCount(): number;
  /** index = engine batch id, entry = that triangle's `SurfaceRef`. */
  batchIdMap(): ReadonlyArray<SurfaceRef>;
  /** ECEF ray in, hit surface + ray distance out. The distance is what lets a
   *  caller holding many of these keep the nearest hit (Task C10b). */
  resolveRaycast(ray: EcefRay): RaycastHit | null;
  delete(): void;
}

/** The `view.addMesh` seam, structurally typed so this module needs no engine
 *  import. Navara's `ThreeView` satisfies it. */
export interface CityMeshArraysViewLike {
  addMesh(config: unknown): {
    ref: unknown;
    visible: boolean;
    delete(): void;
  };
}

/** The behaviour object, free of `@navaramap` imports so it is Node-testable. */
export class CityMeshArraysMesh {
  readonly object3d: Mesh;
  readonly pickStrategy: PickStrategy;
  /** The cell's ENU->ECEF frame as a matrix. `CityMeshArraysDesc` hands this to
   *  the engine as the mesh's top-level `matrixWorld` (Task B1 finding 7). */
  readonly matrixWorld: Matrix4;

  private readonly arrays: CityMeshArrays;

  constructor(options: AddCityMeshArraysOptions) {
    this.arrays = options.arrays;
    this.pickStrategy = options.pickStrategy ?? DEFAULT_PICK_STRATEGY;
    // Matrix4.elements and EnuFrame.matrix are both column-major, and
    // `fromArray` copies element-wise, so the Matrix4 does not alias the frame.
    this.matrixWorld = new Matrix4().fromArray(options.frame.matrix);

    this.object3d = new Mesh(
      geometryFromMeshArrays(options.arrays),
      // MRT_VERTEX_COLORS_OK = true (Task B1): a plain standard material with
      // vertex colors renders correctly through Navara's MRT pass, so no
      // shader patching and no custom pass key.
      new MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        side: FrontSide,
      }),
    );
    this.object3d.name = `cityMesh:${options.id}`;
    // Routing metadata rides on `userData`, not on the engine's pick payload:
    // `PickableMeshWrapper` takes only `(object, ctx)` and the spike measured
    // its `PickedFeature` coming back with `properties: null` / `layerId:
    // undefined` (Task B1 §3). `layerId` is what Task B15's router uses to find
    // the owning handle; `cellKey` is what Task C10b uses to find the resident
    // cell inside a streaming layer — and under the own-raycast default the
    // caller reaches both straight off the Object3D it raycast.
    this.object3d.userData.layerId = options.layerId ?? options.id;
    if (options.cellKey !== undefined) {
      this.object3d.userData.cellKey = options.cellKey;
    }
    // Navara copies a mesh's top-level matrixWorld and disables auto-update;
    // mirror that here so the object behaves identically in a bare three scene
    // and in a unit test's raycast.
    this.object3d.matrixAutoUpdate = false;
    this.object3d.matrix.copy(this.matrixWorld);
    this.object3d.matrixWorld.copy(this.matrixWorld);
    this.object3d.matrixWorldNeedsUpdate = false;
    this.object3d.castShadow = true;
    this.object3d.receiveShadow = true;
  }

  /**
   * Replace the vertex colors in place.
   *
   * `geometryFromMeshArrays` deliberately *wraps* the caller's typed arrays, so
   * writing into the live attribute is what reaches the GPU — allocating a new
   * attribute here would silently detach recoloring from the draw call.
   */
  setColors(colors: Float32Array): void {
    const attr = this.object3d.geometry.getAttribute("color");
    (attr.array as Float32Array).set(colors);
    attr.needsUpdate = true;
  }

  setVisible(visible: boolean): void {
    this.object3d.visible = visible;
  }

  triangleCount(): number {
    return this.arrays.triangleCount;
  }

  /**
   * Own-raycast pick path for a streamed cell (spike `PICK_PATH`): ECEF ray in,
   * the hit face's `(objectIndex, surfaceIndex)` plus its ray distance out. The
   * caller (Task C10b's stream layer) knows its own layerId and objectKeys and
   * builds the `Selection`.
   */
  resolveRaycast(ray: EcefRay): RaycastHit | null {
    if (!this.object3d.visible) return null;
    const raycaster = new Raycaster(
      new Vector3(ray.origin.x, ray.origin.y, ray.origin.z),
      new Vector3(
        ray.direction.x,
        ray.direction.y,
        ray.direction.z,
      ).normalize(),
      0,
      Infinity,
    );
    // `false`: this mesh has no children, and descending would let some future
    // helper object answer for it. Hits come back sorted near-to-far, so [0] is
    // this mesh's nearest face; `distance` lets the caller compare across cells.
    const hit = raycaster.intersectObject(this.object3d, false)[0];
    if (!hit?.face) return null;
    return {
      objectIndex: this.arrays.objectIndices[hit.face.a]!,
      surfaceIndex: this.arrays.surfaceIndices[hit.face.a]!,
      distance: hit.distance,
    };
  }

  /**
   * Same contract as `CityModelMesh.batchIdMap()`: index = engine batch id,
   * entry = that triangle's `(objectIndex, surfaceIndex)`. Lets a streamed cell
   * resolve a pick exactly the way a static layer does (Task C10b); empty under
   * the own-raycast strategy so nothing pays for it.
   */
  batchIdMap(): ReadonlyArray<SurfaceRef> {
    if (this.pickStrategy !== "pickable-wrapper") return [];
    const map: SurfaceRef[] = [];
    for (let t = 0; t < this.arrays.triangleCount; t++) {
      const v = t * 3;
      map.push({
        objectIndex: this.arrays.objectIndices[v]!,
        surfaceIndex: this.arrays.surfaceIndices[v]!,
      });
    }
    return map;
  }

  dispose(): void {
    this.object3d.geometry.dispose();
    const material = this.object3d.material;
    if (Array.isArray(material)) {
      for (const m of material) m.dispose();
    } else {
      material.dispose();
    }
  }
}

/**
 * Add one arrays-backed mesh to the view and return the flat handle Task C8
 * holds per resident cell.
 *
 * `view` is structurally typed, so this is callable with Navara's real
 * `ThreeView` **and** with the B2 fake — which is how C10a tests it without
 * importing the engine.
 */
export function addCityMeshArrays(
  view: CityMeshArraysViewLike,
  opts: AddCityMeshArraysOptions,
): CityMeshHandle {
  const meshHandle = view.addMesh({ [CITY_MESH_ARRAYS_KEY]: opts });
  // The descriptor exposes its behaviour object as `.cityMesh`; a test double
  // may hand the behaviour object back directly.
  const ref = meshHandle.ref as { cityMesh?: CityMeshArraysMesh };
  const mesh = ref.cityMesh ?? (meshHandle.ref as CityMeshArraysMesh);
  return {
    ref: meshHandle.ref,
    setColors: (colors) => mesh.setColors(colors),
    setVisible: (visible) => {
      mesh.setVisible(visible);
      meshHandle.visible = visible;
    },
    triangleCount: () => mesh.triangleCount(),
    batchIdMap: () => mesh.batchIdMap(),
    resolveRaycast: (ray) => mesh.resolveRaycast(ray),
    delete: () => meshHandle.delete(),
  };
}
