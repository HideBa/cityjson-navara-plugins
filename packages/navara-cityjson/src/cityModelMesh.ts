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
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
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
import { ThemeStyleController, type ThemeStyle } from "./themeStyle";

export interface CityModelMeshOptions {
  readonly id: string;
  readonly model: CityModel;
  readonly crs?: string | number;
  readonly lod?: string | null;
  /** First-level object types whose geometry is left out of the build (so
   *  "Building" also drops its BuildingParts). Arrays, not a Set, because this
   *  travels as a descriptor config; the mesh keeps its own set. */
  readonly hiddenTypes?: ReadonlyArray<string>;
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

/** Set equality: the app replaces the hidden-type array wholesale on every
 *  edit, so identity says nothing, and order is not meaningful. */
function sameTypes(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
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
  private hiddenTypes: ReadonlySet<string>;
  private arrays: CityMeshArrays;
  private baseColors: Float32Array;
  private styleColors: Float32Array | null = null;
  private evaluator: SurfaceStyleEvaluator | null = null;
  private selections: readonly Selection[] = [];
  private hovered: Selection | null = null;
  private readonly theme: ThemeStyleController;

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
    this.hiddenTypes = new Set(options.hiddenTypes ?? []);
    this.originOffset = computeOriginOffset(options.model);
    this.makePlacementMatrix = options.makePlacementMatrix;
    this.placement = this.computePlacement(options.heightOffset ?? 0);

    this.arrays = this.buildArrays();
    this.baseColors = Float32Array.from(this.arrays.colors);

    this.object3d = new Mesh(
      geometryFromMeshArrays(this.arrays),
      // UNLIT ALBEDO, not a lit material. The renderer this mesh lives in is
      // calibrated for the PHYSICAL ATMOSPHERE, not for scene lights: the
      // aerial-perspective pass runs in `irradiance` mode and re-shades the
      // g-buffer albedo with the atmosphere's own sun + sky irradiance
      // (`AerialPerspective.irradiance` sets `sunLight = skyLight = true`),
      // and the tone mapper is driven at exposure ~10. A lit
      // `MeshStandardMaterial` would be lit TWICE — once by
      // `SunLightDesc`/`skyLightProbe` at scene-light scale (calibrated for
      // exposure ~1), then again by the AP pass — and every roof clipped to
      // white. See docs/superpowers/research/2026-08-04-overbright-scene-diagnosis.md.
      //
      // The AP pass reads the MRT normal buffer (`useNormalBuffer: true`), and
      // `MeshBasicMaterial` fills it: Navara patches three's `basic` ShaderLib
      // entry on import so the normal varyings are always computed, not only
      // under `USE_ENVMAP`/`USE_SKINNING` (`overrideMaterialsForMRT`). No
      // `flatShading` here — the material has no such option, and that patch
      // `#undef`s `FLAT_SHADED` anyway; our geometry is non-indexed with one
      // normal per face, so the shading reads flat regardless.
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
    this.object3d.name = `cityModel:${this.id}`;
    this.object3d.userData.layerId = this.id;
    this.object3d.castShadow = true;
    this.object3d.receiveShadow = true;
    this.applyPlacement();
    // After `applyPlacement`: the theme's edge child copies the mesh's
    // matrixWorld when it builds, and every later placement change runs
    // through `rebuildGeometry` -> `theme.geometryReplaced()`.
    this.theme = new ThemeStyleController(this.object3d);
  }

  private buildArrays(): CityMeshArrays {
    const arrays = buildCityMeshArrays(
      this.model,
      this.id,
      this.originOffset,
      this.lod,
      this.hiddenTypes.size > 0 ? this.hiddenTypes : null,
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
   * Which first-level object types are left out of the geometry — hiding
   * "Building" hides its BuildingParts too (`toplevelCityObjectType`).
   *
   * A REBUILD, on the same seam `setLod` uses, because a style evaluator
   * cannot hide anything: it writes RGB into an opaque material, so a
   * "hidden" object would still occlude what is behind it and still answer a
   * raycast. Object indices survive the filter (`buildCityMeshArrays`), so the
   * style and highlight `rebuildGeometry` repaints are unaffected.
   */
  setHiddenTypes(types: ReadonlyArray<string>): void {
    const next = new Set(types);
    if (sameTypes(next, this.hiddenTypes)) return;
    this.hiddenTypes = next;
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
    // The theme's edge lines were extracted from the geometry just disposed —
    // an outline of surfaces this LoD (or hidden-type list, or placement) no
    // longer has. A no-op while no theme with edges is active.
    this.theme.geometryReplaced();
  }

  /** Scene theme: a fill multiplier and optional structural edge lines. Pure
   *  presentation — it writes no vertex colours, so rules, highlights and
   *  picking are untouched by it. */
  setThemeStyle(style: ThemeStyle): void {
    this.theme.apply(style);
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

  /**
   * {@link raycast}, resolved to a selection the app can hold.
   *
   * Named apart from the *handle*-level `resolveRaycast(ray): RaycastHit`
   * (shared contract) on purpose: same input, different output, and the two
   * used to differ only by which object you happened to be holding.
   */
  resolveRaycastSelection(ray: EcefRay): SurfaceSelection | null {
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

  /** The table a per-triangle batch id WOULD index: entry `t` is triangle `t`'s
   *  (objectIndex, surfaceIndex). Published because the shared contract
   *  requires it, and rebuilt with the geometry on every LoD change — but the
   *  engine's `PickableMeshWrapper` allocates one batch id per MESH, so
   *  nothing resolves a pick through it today (see `pickStrategy.ts`). Empty
   *  under the own-raycast strategy so nothing pays for it. */
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
    this.theme.dispose();
    this.geometry.dispose();
    const material = this.object3d.material;
    if (Array.isArray(material)) {
      for (const m of material) m.dispose();
    } else {
      material.dispose();
    }
  }
}
