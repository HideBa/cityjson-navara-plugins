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
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
} from "three";
import type { CityMeshArrays, EnuFrame } from "@cityjson/navara-core";
import { geometryFromMeshArrays } from "./cityMeshGeometry";
import { CITY_MESH_ARRAYS_KEY } from "./descriptorKeys";
import { DEFAULT_PICK_STRATEGY, type PickStrategy } from "./pickStrategy";
import type { EcefRay, RaycastHit, SurfaceRef } from "./pickTypes";
import { ThemeStyleController, type ThemeStyle } from "./themeStyle";
import {
  buildGroupMaterials,
  maskReadyTextures,
  type TextureCache,
} from "./texturedMaterials";

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
  /**
   * The owning layer's image cache, when `arrays` carries `textureGroups`:
   * one material per group, with a `map` wherever the image is ready. Shared
   * across a layer's cells (keyed by the layer-wide texture index), so an
   * image two cells use loads once. The OWNER subscribes to the cache and
   * calls `textureChanged`; the mesh never listens itself.
   */
  readonly textures?: TextureCache;
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
  /** Swap the vertex-color buffer (rule recolor of a resident cell). Written
   *  RAW — mask first with {@link maskTextured} so an image shows through. */
  setColors(colors: Float32Array): void;
  /** `colors` with white over every vertex whose image is ready (the map
   *  then shows unmodulated); `colors` itself when nothing is textured. Paint
   *  highlights AFTER masking so a selected textured face still tints. */
  maskTextured(colors: Float32Array): Float32Array;
  /** The layer's image cache reported `textureIndex`: attach or drop the
   *  group's map. The caller repaints afterwards. */
  textureChanged(textureIndex: number): void;
  setVisible(visible: boolean): void;
  /** Scene-theme presentation (fill multiplier + structural edge lines).
   *  Independent of `setColors`: a theme never writes vertex colours. */
  setThemeStyle(style: ThemeStyle): void;
  triangleCount(): number;
  /** Entry `t` is triangle `t`'s `SurfaceRef`. See `CityMeshArraysMesh`. */
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
  private readonly theme: ThemeStyleController;
  private readonly textures: TextureCache | null;

  constructor(options: AddCityMeshArraysOptions) {
    this.arrays = options.arrays;
    this.pickStrategy = options.pickStrategy ?? DEFAULT_PICK_STRATEGY;
    this.textures =
      options.textures && (options.arrays.textureGroups?.length ?? 0) > 0
        ? options.textures
        : null;
    // Matrix4.elements and EnuFrame.matrix are both column-major, and
    // `fromArray` copies element-wise, so the Matrix4 does not alias the frame.
    this.matrixWorld = new Matrix4().fromArray(options.frame.matrix);

    this.object3d = new Mesh(
      geometryFromMeshArrays(options.arrays),
      // MRT_VERTEX_COLORS_OK = true (Task B1): a plain built-in material with
      // vertex colors renders correctly through Navara's MRT pass, so no
      // shader patching and no custom pass key.
      //
      // UNLIT ALBEDO, exactly as `CityModelMesh` — the aerial-perspective pass
      // runs in `irradiance` mode and lights the g-buffer albedo from the
      // physical atmosphere, so a lit material would be lit twice and clip to
      // white at the exposure that calibration needs. The full reasoning, and
      // why `MeshBasicMaterial` still fills the MRT normal buffer, is on
      // `CityModelMesh`'s material.
      new MeshBasicMaterial({
        vertexColors: true,
      // DOUBLE-SIDED, and not as a convenience: front-face culling removes
      // real geometry from this data. CityJSON's spec asks for outward-facing
      // exterior shells, but real files vary — and `orientExteriorRing`
      // (navara-core's `buildCityMeshArrays`) makes it worse rather than
      // better on the shapes that matter, because it decides orientation by
      // asking whether a face's normal points away from the object's bbox
      // CENTRE. That is right for a convex block and wrong for every concave
      // one: an L-shaped building's inner walls, a courtyard's inward faces
      // and anything under an overhang legitimately face their own centroid,
      // so the heuristic reverses them and `FrontSide` then culls them.
      // Measured on the Delft sample at a fixed camera with the backdrop off:
      // ~1.1% of the viewport was building pixels that only appear
      // double-sided (3400 px, against 56 the other way).
      //
      // The cost is bounded: these are opaque solids behind a depth test, so
      // the extra fragments are overdraw the z-buffer discards, on a model of
      // ~10^5 triangles. Correct geometry is worth that. Fixing the winding
      // properly needs solid-orientation analysis (ray parity per shell), not
      // a centroid guess — worth doing, but it would still not make a viewer
      // of third-party data safe to cull.
        side: DoubleSide,
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
    // Built after the placement above: the edge child copies the mesh's
    // matrixWorld when it is created, and a cell's frame never changes
    // afterwards.
    this.theme = new ThemeStyleController(this.object3d);
    if (this.textures) {
      // One material per texture group (`buildGroupMaterials`), same
      // calibration as the single one above; images the cache already holds
      // attach at once, the rest as the owner reports them.
      (this.object3d.material as MeshBasicMaterial).dispose();
      this.object3d.material = buildGroupMaterials(
        options.arrays.textureGroups ?? [],
        this.textures,
      );
      this.theme.materialsReplaced();
      this.setColors(this.maskTextured(options.arrays.colors));
    }
  }

  maskTextured(colors: Float32Array): Float32Array {
    const textures = this.textures;
    if (!textures) return colors;
    return maskReadyTextures(colors, this.arrays.textureGroups, (index) =>
      textures.isReady(index),
    );
  }

  textureChanged(textureIndex: number): void {
    const groups = this.arrays.textureGroups;
    const materials = this.object3d.material;
    if (!this.textures || !groups || !Array.isArray(materials)) return;
    const entry = this.textures.get(textureIndex);
    groups.forEach((group, i) => {
      if (group.textureIndex !== textureIndex) return;
      const material = materials[i] as MeshBasicMaterial | undefined;
      if (!material) return;
      material.map = entry?.status === "ready" ? entry.texture : null;
      material.needsUpdate = true;
    });
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

  /** Scene theme, applied through the module both mesh classes share so a
   *  streamed cell and a static layer look identical under one. */
  setThemeStyle(style: ThemeStyle): void {
    this.theme.apply(style);
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
   * Same contract as `CityModelMesh.batchIdMap()`: entry `t` is triangle `t`'s
   * `(objectIndex, surfaceIndex)`. A streamed cell exposes it exactly as a
   * static layer does, and with the same caveat — the engine's batch id is per
   * MESH, not per triangle, so nothing resolves a pick through this table today
   * (see `pickStrategy.ts`). Empty under the own-raycast strategy.
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
    this.theme.dispose();
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
    maskTextured: (colors) => mesh.maskTextured(colors),
    textureChanged: (index) => mesh.textureChanged(index),
    setVisible: (visible) => {
      mesh.setVisible(visible);
      meshHandle.visible = visible;
    },
    setThemeStyle: (style) => mesh.setThemeStyle(style),
    triangleCount: () => mesh.triangleCount(),
    batchIdMap: () => mesh.batchIdMap(),
    resolveRaycast: (ray) => mesh.resolveRaycast(ray),
    delete: () => meshHandle.delete(),
  };
}
