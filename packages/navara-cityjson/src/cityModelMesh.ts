/**
 * The renderer-facing city model mesh: geometry + material + the whole
 * CityModelHandle behaviour set (LoD rebuild, style, highlight, pick
 * resolution, bounds, triangle count).
 *
 * Deliberately free of @navaramap imports — the ENU placement comes from
 * `buildPlacement` (core's `makeEnuFrame`, Task A13b) and its matrix can be
 * overridden through `makePlacementMatrix` in tests. That keeps every
 * behaviour above unit-testable in Node, and keeps static layers and
 * streaming cells (Task C8) on one frame implementation.
 */
import {
  FrontSide,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Vector3,
  type BufferGeometry,
} from "three";
import {
  buildCityMeshArrays,
  computeOriginOffset,
  projectPositionsToEnu,
  type CityMeshArrays,
  type CityModel,
  type SurfaceStyleEvaluator,
  type Vec3,
} from "@cityjson/navara-core";
import { geometryFromMeshArrays } from "./cityMeshGeometry";
import {
  buildPlacement,
  geodeticBoundsFromBBox,
  originLleFromOffset,
  resolveMetricEpsg,
  type GeodeticBounds,
  type Lle,
  type Placement,
} from "./enuPlacement";
import { DEFAULT_PICK_STRATEGY, type PickStrategy } from "./pickStrategy";
import type { EcefRay, RaycastHit, SurfaceRef } from "./pickTypes";
import { computeStyleColors, paintLayers } from "./surfaceColorLayers";
import type { Selection, SurfaceSelection } from "./selection";

export interface CityModelMeshOptions {
  readonly id: string;
  readonly model: CityModel;
  readonly crs?: string | number;
  readonly lod?: string | null;
  /** Metres added to every vertex's geodetic height before the ENU transform
   *  (the geoid undulation at the layer origin). Defaults to 0; Task B7's
   *  registry calls `setHeightOffset()` when its async `geoidHeightAt()`
   *  sample resolves. See Global Constraints -> Vertical datum. */
  readonly heightOffset?: number;
  /** Task B1's PICK_PATH verdict. Defaults to DEFAULT_PICK_STRATEGY. */
  readonly pickStrategy?: PickStrategy;
  /**
   * Test seam: replaces ONLY the ENU->ECEF matrix (so matrix assertions can
   * read `makeTranslation(1, 2, 3)` instead of ECEF megametres). The frame the
   * vertices are projected into always comes from `buildPlacement`, so an
   * override here cannot desync frame from height offset — it can only make
   * world placement fictional, which is exactly what a unit test wants.
   */
  readonly makePlacementMatrix?: (lle: Lle) => Matrix4;
}

export class CityModelMesh {
  readonly id: string;
  readonly epsg: number;
  readonly pickStrategy: PickStrategy;
  readonly object3d: Mesh;

  private readonly model: CityModel;
  private readonly originOffset: Vec3;
  private readonly makePlacementMatrix:
    | ((lle: Lle) => Matrix4)
    | undefined;
  private placement: Placement;
  private lod: string | null;
  private arrays: CityMeshArrays;
  private baseColors: Float32Array;
  private styleColors: Float32Array | null = null;
  private evaluator: SurfaceStyleEvaluator | null = null;
  private selections: readonly Selection[] = [];
  private hovered: Selection | null = null;

  constructor(options: CityModelMeshOptions) {
    this.id = options.id;
    this.model = options.model;
    // Both halves of the CRS gate: resolvable by proj4 AND metre-based. A
    // foot-based CRS reprojects fine horizontally but would scale heights and
    // the geoid offset wrong, so it is refused rather than silently placed.
    this.epsg = resolveMetricEpsg(
      options.crs ?? options.model.metadata.referenceSystem,
    );
    this.pickStrategy = options.pickStrategy ?? DEFAULT_PICK_STRATEGY;
    this.lod = options.lod ?? null;
    this.originOffset = computeOriginOffset(options.model);
    this.makePlacementMatrix = options.makePlacementMatrix;
    this.placement = this.computePlacement(options.heightOffset ?? 0);

    this.arrays = this.buildArrays();
    this.baseColors = Float32Array.from(this.arrays.colors);

    this.object3d = new Mesh(
      geometryFromMeshArrays(this.arrays),
      new MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        side: FrontSide,
      }),
    );
    this.object3d.name = `cityModel:${this.id}`;
    this.object3d.userData.layerId = this.id;
    this.object3d.castShadow = true;
    this.object3d.receiveShadow = true;
    this.applyPlacement();
  }

  private buildArrays(): CityMeshArrays {
    const arrays = buildCityMeshArrays(
      this.model,
      this.id,
      this.originOffset,
      this.lod,
    );
    // buildCityMeshArrays emits *source-CRS deltas* from originOffset. Those
    // are NOT ENU metres: a projected CRS carries scale factor and grid
    // convergence, so a delta 5 km from the origin is off by metres in
    // position and by a fraction of a degree in bearing. Re-place every vertex
    // exactly: source (x, y, z) -> lng/lat -> +heightOffset -> ECEF ->
    // inverse ENU frame. Runs once per LoD rebuild, not per frame.
    projectPositionsToEnu(arrays.positions, {
      originOffset: this.originOffset,
      epsg: this.epsg,
      frame: this.placement.frame,
      // From the SAME bundle as the frame — the two must agree or the mesh
      // floats/sinks by the offset.
      heightOffset: this.placement.heightOffset,
    });
    return arrays;
  }

  /** The ENU frame, its ECEF matrix and the offset baked into both, for
   *  `heightOffset` metres of geoid undulation. */
  private computePlacement(heightOffset: number): Placement {
    const originLle = originLleFromOffset(this.originOffset, this.epsg);
    const placement = buildPlacement(originLle, heightOffset);
    if (!this.makePlacementMatrix) return placement;
    return {
      ...placement,
      matrixWorld: this.makePlacementMatrix({
        ...originLle,
        height: originLle.height + heightOffset,
      }),
    };
  }

  private applyPlacement(): void {
    // Navara copies a mesh's top-level matrixWorld and disables auto-update
    // (Task B1 finding 7); mirror that here so the object behaves identically
    // in a bare three scene and in a unit test's raycast.
    this.object3d.matrixAutoUpdate = false;
    this.object3d.matrix.copy(this.placement.matrixWorld);
    this.object3d.matrixWorld.copy(this.placement.matrixWorld);
    this.object3d.matrixWorldNeedsUpdate = false;
  }

  private get geometry(): BufferGeometry {
    return this.object3d.geometry;
  }

  /** Recompute style colors, then repaint the live color attribute. */
  private repaint(): void {
    this.styleColors = this.evaluator
      ? computeStyleColors(
          this.evaluator,
          this.arrays.objectIndices,
          this.arrays.surfaceIndices,
          this.arrays.objectKeys,
          (objectId) => this.model.objects[objectId],
          this.baseColors,
        )
      : null;

    const attr = this.geometry.getAttribute("color");
    paintLayers(
      attr.array as Float32Array,
      this.styleColors ?? this.baseColors,
      this.arrays.objectIndices,
      this.arrays.surfaceIndices,
      this.arrays.objectKeys,
      this.selections,
      this.hovered,
    );
    attr.needsUpdate = true;
  }

  setVisible(visible: boolean): void {
    this.object3d.visible = visible;
  }

  setLod(lod: string | null): void {
    if (lod === this.lod) return;
    this.lod = lod;
    this.rebuildGeometry();
  }

  /**
   * Re-place the mesh at a new vertical-datum offset.
   *
   * `ellipsoidal = orthometric + N`, and the offset is added to BOTH the
   * frame origin's height and every vertex's height — so in ECEF the whole
   * mesh slides outward along the ellipsoid normal by N (a Delft model RISES
   * ~43 m, from sunk to correct), while its LOCAL coordinates are unchanged
   * to within float32 noise. The re-projection below is therefore not what
   * moves the model; the new frame is. It runs because the vertices were
   * projected into the OLD frame and must be expressed in the new one.
   *
   * The geoid sample is asynchronous (a network fetch), and blocking first
   * render on it would mean a blank viewport whenever the terrain service is
   * slow. So the mesh is built at offset 0 and re-placed the moment the
   * sample lands — one extra geometry pass per layer, no ordering hazard, and
   * a failed sample simply never calls this. See Global Constraints ->
   * Vertical datum.
   */
  setHeightOffset(metres: number): void {
    if (metres === this.placement.heightOffset) return;
    this.placement = this.computePlacement(metres);
    this.applyPlacement();
    // Vertices were expressed in the OLD frame, so re-project them into the
    // new one. Their local values barely change (both the vertex and the
    // origin rose by the same N); the visible movement comes from the frame.
    this.rebuildGeometry();
  }

  /** The frame/matrix/offset bundle this mesh is currently placed by — what
   *  Task B7's descriptor hands the engine as the mesh's `matrixWorld`. */
  getPlacement(): Placement {
    return this.placement;
  }

  private rebuildGeometry(): void {
    const old = this.geometry;
    this.arrays = this.buildArrays();
    this.baseColors = Float32Array.from(this.arrays.colors);
    this.object3d.geometry = geometryFromMeshArrays(this.arrays);
    old.dispose();
    this.repaint();
  }

  setStyle(evaluator: SurfaceStyleEvaluator | null): void {
    this.evaluator = evaluator;
    this.repaint();
  }

  /**
   * Highlight this layer's selections.
   *
   * Vertices carry no layer id, so `paintLayers` cannot tell one layer's
   * selection from another's (Task B5 carry-forward) — the filtering is done
   * here, exactly as the pre-Navara `reapplyHighlight` did. Without it, two
   * layers holding the same object id would cross-highlight.
   */
  setHighlight(
    selections: readonly Selection[],
    hovered: Selection | null = null,
  ): void {
    this.selections = selections.filter((s) => s.layerId === this.id);
    this.hovered = hovered?.layerId === this.id ? hovered : null;
    this.repaint();
  }

  resolveVertex(vertexIndex: number): SurfaceSelection | null {
    const objIdxAttr = this.geometry.getAttribute("objectIndex");
    const surfIdxAttr = this.geometry.getAttribute("surfaceIndex");
    if (!objIdxAttr || !surfIdxAttr) return null;
    if (vertexIndex < 0 || vertexIndex >= objIdxAttr.count) return null;
    return this.resolveVertexIndices(
      objIdxAttr.getX(vertexIndex),
      surfIdxAttr.getX(vertexIndex),
    );
  }

  /**
   * Own-raycast pick path (spike PICK_PATH = "own-raycast"): ECEF ray in, the
   * hit surface plus its ray distance out, so a caller raycasting several
   * meshes can keep the nearest hit (shared contract's `RaycastHit`).
   */
  raycast(ray: EcefRay): RaycastHit | null {
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
    // helper object answer for it.
    const hit = raycaster.intersectObject(this.object3d, false)[0];
    if (!hit?.face) return null;
    const objIdxAttr = this.geometry.getAttribute("objectIndex");
    const surfIdxAttr = this.geometry.getAttribute("surfaceIndex");
    if (!objIdxAttr || !surfIdxAttr) return null;
    return {
      objectIndex: objIdxAttr.getX(hit.face.a),
      surfaceIndex: surfIdxAttr.getX(hit.face.a),
      distance: hit.distance,
    };
  }

  /** {@link raycast}, resolved to a selection the app can hold. */
  resolveRaycast(ray: EcefRay): SurfaceSelection | null {
    const hit = this.raycast(ray);
    if (!hit) return null;
    return this.resolveVertexIndices(hit.objectIndex, hit.surfaceIndex);
  }

  /** PickedFeature path: object/surface indices straight from the payload. */
  resolveVertexIndices(
    objectIndex: number,
    surfaceIndex: number,
  ): SurfaceSelection | null {
    const objectId = this.arrays.objectKeys[objectIndex];
    if (objectId === undefined) return null;
    return { kind: "surface", layerId: this.id, objectId, surfaceIndex };
  }

  /** pickable-wrapper pick path (spike PICK_PATH = "pickable-wrapper"): the
   *  per-triangle batch id Navara reports back maps 1:1 onto this table, whose
   *  index is the batch id and whose entry is the triangle's
   *  (objectIndex, surfaceIndex). Rebuilt with the geometry on every LoD
   *  change; empty under the own-raycast strategy so nothing pays for it. */
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

  getBoundsGeodetic(): GeodeticBounds {
    const bbox = this.model.bbox ?? [0, 0, 0, 0, 0, 0];
    const b = geodeticBoundsFromBBox(bbox, this.epsg);
    // Report the same heights the mesh is actually placed at, so fitAll /
    // fitLayer frame the model where it renders (Global Constraints ->
    // Vertical datum).
    const { heightOffset } = this.placement;
    return {
      ...b,
      minHeight: b.minHeight + heightOffset,
      maxHeight: b.maxHeight + heightOffset,
    };
  }

  triangleCount(): number {
    return this.arrays.triangleCount;
  }

  dispose(): void {
    this.geometry.dispose();
    const material = this.object3d.material;
    if (Array.isArray(material)) {
      for (const m of material) m.dispose();
    } else {
      material.dispose();
    }
  }
}
