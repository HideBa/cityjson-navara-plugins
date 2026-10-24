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
  Matrix4,
  Mesh,
  Raycaster,
  Vector3,
  type BufferGeometry,
  type Material,
  type MeshLambertMaterial,
} from "three";
import {
  createCityMaterial,
  NO_SHADOW_MATERIALS,
  type ShadowMaterialHooks,
} from "./cityMaterial";
import {
  appearanceThemesEqual,
  buildCityMeshArrays,
  computeOriginOffset,
  createProjectedVertices,
  createVertexPlacer,
  partitionCells,
  raisePositionsInEnu,
  sameLodGeometry,
  type AppearanceTheme,
  type CityMeshArrays,
  type CityModel,
  type MeshCell,
  type SurfaceStyleEvaluator,
  type ProjectedVertices,
  type Vec3,
  type VertexPlacer,
} from "@cityjson/navara-core";
import {
  cellGeometry,
  computeCellBounds,
  drawCellOnly,
  geometryFromMeshArrays,
} from "./cityMeshGeometry";
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
import { computeStyleColors } from "./surfaceColorLayers";
import { CityStyleDepthMaterial, SlotStyle } from "./cityStyle";
import { resolveCityColors, type ResolvedCityColors } from "./cityColors";
import type { Selection, SurfaceSelection } from "./selection";
import { ThemeStyleController, type ThemeStyle } from "./themeStyle";
import { drawnTriangleCount, hiddenObjectMask } from "./slotVisibility";
import {
  buildGroupMaterials,
  defaultTextureSource,
  TextureCache,
  type TextureSource,
} from "./texturedMaterials";

export interface CityModelMeshOptions {
  readonly id: string;
  readonly model: CityModel;
  readonly crs?: string | number;
  readonly lod?: string | readonly string[] | null;
  /** First-level object types whose geometry is left out of the build (so
   *  "Building" also drops its BuildingParts). Arrays, not a Set, because this
   *  travels as a descriptor config; the mesh keeps its own set. */
  readonly hiddenTypes?: ReadonlyArray<string>;
  /**
   * Only these objects contribute geometry; `null`/absent means every one
   * does. An EMPTY set draws nothing — see `setVisibleObjectIds`.
   *
   * NOT on `AddCityModelOptions`, deliberately: the app's filter arrives after
   * the layer exists, so the handle's setter is the only path it needs, and
   * this option is reachable only by constructing a mesh directly (which the
   * tests below do). Promoting it to an ADD-TIME option later means threading
   * it through `AddCityModelOptions`, `cityModelRegistry.addCityModel` and
   * `CityModelMeshDesc.createMesh` as well — the descriptor is what the engine
   * actually calls, and an option the desc drops is silently ignored.
   */
  readonly visibleObjectIds?: ReadonlySet<string> | null;
  /** Metres added to every vertex's geodetic height before the ENU transform
   *  (the geoid undulation at the layer origin). Defaults to 0; Task B7's
   *  registry calls `setHeightOffset()` when its async `geoidHeightAt()`
   *  sample resolves. See Global Constraints -> Vertical datum. */
  readonly heightOffset?: number;
  /** Task B1's PICK_PATH verdict. Defaults to DEFAULT_PICK_STRATEGY. */
  readonly pickStrategy?: PickStrategy;
  /** Appearance theme to draw (see `AddCityModelOptions.appearance`). */
  readonly appearance?: AppearanceTheme | null;
  /** Dataset URL for relative texture paths; `null` = local file. */
  readonly textureBaseUrl?: string | null;
  /** Image-loading seam (tests inject a fake; the default needs a DOM). */
  readonly textureSource?: TextureSource;
  /** Highlight, hover and surface palette, already resolved (the registry
   *  lays the layer's override over the plugin's). Omitted keeps the
   *  historical colours — see `cityColors.ts`. */
  readonly colors?: ResolvedCityColors;
  /** Where every material this mesh draws with is registered for the
   *  engine's cascaded shadow maps (see `cityMaterial.ts`). Filled by
   *  `CityModelMeshDesc`; a mesh built outside the engine leaves it unset. */
  readonly shadowMaterials?: ShadowMaterialHooks;
  /**
   * Asks the engine for a frame. The engine renders on demand, and a write
   * into this mesh's three objects (colours, visibility, placement, theme,
   * textures) is invisible to it; `CityModelMeshDesc` wires this to the
   * descriptor's `requestUpdate`.
   */
  readonly requestRender?: () => void;
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

/** A private copy of a caller's filter set, `null` passed through. The mesh
 *  must not alias a set the app still holds: mutating it in place would leave
 *  `sameVisibleIds` reporting "unchanged" against geometry that no longer
 *  matches it. */
function copyVisibleIds(
  ids: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  return ids === null ? null : new Set(ids);
}

/** Set equality that distinguishes `null` (no filter) from an empty set
 *  (a filter that matched nothing) — the two must never compare equal. */
function sameVisibleIds(
  a: ReadonlySet<string> | null,
  b: ReadonlySet<string> | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** The side of a static layer's grid cell, in metres: small enough that the
 *  frustum culls inside a city, large enough that a district is a handful
 *  of draws. */
export const STATIC_CELL_SIZE = 250;

export class CityModelMesh {
  readonly id: string;
  readonly epsg: number;
  readonly pickStrategy: PickStrategy;
  readonly object3d: Mesh;

  private model: CityModel;
  private readonly originOffset: Vec3;
  private readonly makePlacementMatrix: ((lle: Lle) => Matrix4) | undefined;
  private placement: Placement;
  /** Every vertex any build has projected, kept for the layer's life: a LoD
   *  switch or a new placement reuses them. */
  private projected: ProjectedVertices | null = null;
  /** Places vertices in {@link placerFor}'s frame. */
  private placer: VertexPlacer | null = null;
  private placerFor: Placement | null = null;
  private lod: string | readonly string[] | null;
  private hiddenTypes: ReadonlySet<string>;
  private visibleObjectIds: ReadonlySet<string> | null;
  private arrays: CityMeshArrays;
  /** The build's cells (`partitionCells`). The root mesh draws the first
   *  one itself; {@link cellMeshes} draw the rest, one child each. */
  private cells: readonly MeshCell[] = [];
  private readonly cellMeshes: Mesh[] = [];
  /** The style texture every material of this mesh reads (`cityStyle.ts`):
   *  colours, highlight and the texture mask are writes into it. */
  private readonly style: SlotStyle;
  /** What the mesh renders into the shadow map, when the engine supplies
   *  one: a clone of the material that keeps the style patch. */
  private readonly depthMaterial: CityStyleDepthMaterial;
  /** Triangles not hidden by type or filter: what `triangleCount` reports. */
  private drawnTriangles = 0;
  private styleColors: Float32Array | null = null;
  private evaluator: SurfaceStyleEvaluator | null = null;
  private selections: readonly Selection[] = [];
  private hovered: Selection | null = null;
  private readonly theme: ThemeStyleController;
  private appearance: AppearanceTheme | null;
  private readonly textureBaseUrl: string | null;
  private readonly textureSource: TextureSource;
  /** Images for the active texture theme; null under any other theme. */
  private textures: TextureCache | null = null;
  /** Texture indices whose readiness changed since the last repaint — one
   *  repaint per burst of loads, not one per image (148 on Rotterdam). */
  private pendingTextureChanges = new Set<number>();
  private textureFlushQueued = false;
  private readonly colors: ResolvedCityColors;
  private readonly shadowMaterials: ShadowMaterialHooks;

  /** See `CityModelMeshOptions.requestRender`. */
  private readonly requestRender: () => void;

  constructor(options: CityModelMeshOptions) {
    this.id = options.id;
    this.requestRender = options.requestRender ?? (() => {});
    this.model = options.model;
    // Before `buildArrays` runs (the constructor builds once), because the
    // palette is baked into the slots' base colours.
    this.colors = options.colors ?? resolveCityColors();
    // Both halves of the CRS gate: resolvable by proj4 AND metre-based. A
    // foot-based CRS reprojects fine horizontally but would scale heights and
    // the geoid offset wrong, so it is refused rather than silently placed.
    this.epsg = resolveMetricEpsg(
      options.crs ?? options.model.metadata.referenceSystem,
    );
    this.pickStrategy = options.pickStrategy ?? DEFAULT_PICK_STRATEGY;
    this.lod = options.lod ?? null;
    this.hiddenTypes = new Set(options.hiddenTypes ?? []);
    // COPIED, like `hiddenTypes` above: the caller keeps its own reference,
    // and an in-place mutation of it would silently defeat both "unchanged"
    // guards (the app's set identity, and `sameVisibleIds` below). One
    // allocation beside a full re-triangulation.
    this.visibleObjectIds = copyVisibleIds(options.visibleObjectIds ?? null);
    this.originOffset = computeOriginOffset(options.model);
    this.makePlacementMatrix = options.makePlacementMatrix;
    this.placement = this.computePlacement(options.heightOffset ?? 0);
    this.appearance = options.appearance ?? null;
    this.textureBaseUrl = options.textureBaseUrl ?? null;
    this.textureSource = options.textureSource ?? defaultTextureSource();
    this.shadowMaterials = options.shadowMaterials ?? NO_SHADOW_MATERIALS;

    this.arrays = this.buildArrays();
    this.style = new SlotStyle(this.arrays, this.colors);
    this.applyHidden();

    const material = createCityMaterial(this.style.uniforms);
    this.object3d = new Mesh(
      geometryFromMeshArrays(this.arrays),
      // LIT, styled per surface, double-sided — the ONE city material; the
      // reasoning (and why it is no longer unlit albedo) is on
      // `createCityMaterial`.
      material,
    );
    // The shadow pass draws through a plain depth material that reads the
    // same style texture, so a hidden surface casts no shadow. Not a clone of
    // the lit material: that samples the shadow maps it would be drawing
    // into, which WebGL refuses as a feedback loop, and nothing casts. Every
    // material of this mesh shares the uniforms, so one serves them all.
    this.depthMaterial = new CityStyleDepthMaterial(this.style.uniforms);
    this.object3d.customDepthMaterial = this.depthMaterial;
    this.shadowMaterials.register(material);
    this.object3d.name = `cityModel:${this.id}`;
    this.object3d.userData.layerId = this.id;
    this.object3d.castShadow = true;
    this.object3d.receiveShadow = true;
    this.syncCells();
    this.applyPlacement();
    // After `applyPlacement`: the theme's edge child copies the mesh's
    // matrixWorld when it builds, and every later placement change runs
    // through `rebuildGeometry` -> `theme.geometryReplaced()`.
    this.theme = new ThemeStyleController(this.object3d, (t) =>
      this.isTriangleDrawn(t),
    );
    // A texture theme swaps the single material for one per image group.
    this.applyMaterials();
    this.repaint();
  }

  /** Every object of the LoD selection, hidden or not: hiding is a flag
   *  ({@link applyHidden}), so a toggle never rebuilds. */
  private buildArrays(): CityMeshArrays {
    // Positions come out in local ENU metres, each vertex placed exactly:
    // source (x, y, z) -> lng/lat -> +heightOffset -> ECEF -> inverse ENU
    // frame. Source-CRS deltas are NOT ENU metres: a projected CRS carries
    // scale factor and grid convergence, so a delta 5 km from the origin is
    // off by metres in position and by a fraction of a degree in bearing.
    // The placer belongs to the current placement (its frame and height
    // offset); the projections under it belong to the layer.
    this.projected ??= createProjectedVertices(this.epsg);
    if (this.placer === null || this.placerFor !== this.placement) {
      this.placer = createVertexPlacer(
        {
          epsg: this.epsg,
          frame: this.placement.frame,
          // From the SAME bundle as the frame — the two must agree or the
          // mesh floats/sinks by the offset.
          heightOffset: this.placement.heightOffset,
        },
        this.projected,
      );
      this.placerFor = this.placement;
    }
    const arrays = buildCityMeshArrays(
      this.model,
      this.id,
      this.originOffset,
      this.lod,
      null,
      this.appearance,
      this.colors.surfaceColorsLinear,
      null,
      this.placer,
    );
    // Reordered so each cell is one range of the buffers; nothing else
    // changes, so slots, picking and hiding read the result as before.
    const partitioned = partitionCells(arrays, STATIC_CELL_SIZE);
    this.cells = partitioned.cells;
    return partitioned.arrays;
  }

  /**
   * Draw the build one cell at a time: the root draws the first cell, and
   * every further cell is a child mesh on the root's own attributes, index,
   * materials and placement, bounded by its own vertices. The root keeps the
   * whole layer's bounds, so the engine frames and culls the layer as before
   * and the first cell is simply never culled on its own.
   */
  private syncCells(): void {
    for (const mesh of this.cellMeshes) {
      this.object3d.remove(mesh);
      mesh.geometry.dispose();
    }
    this.cellMeshes.length = 0;
    const [first, ...rest] = this.cells;
    if (first) drawCellOnly(this.geometry, this.arrays, first);
    rest.forEach((cell, i) => {
      const mesh = new Mesh(
        cellGeometry(this.geometry, this.arrays, cell),
        this.object3d.material,
      );
      mesh.name = `${this.object3d.name}:cell${i + 1}`;
      mesh.userData.layerId = this.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = this.depthMaterial;
      // Navara never composes a child's matrix (see the edge child in
      // `themeStyle.ts`), so each cell carries the root's world matrix.
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorld.copy(this.object3d.matrixWorld);
      mesh.matrixWorldNeedsUpdate = false;
      this.object3d.add(mesh);
      this.cellMeshes.push(mesh);
    });
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
    for (const mesh of this.cellMeshes) {
      mesh.matrixWorld.copy(this.placement.matrixWorld);
    }
  }

  private get geometry(): BufferGeometry {
    return this.object3d.geometry;
  }

  /**
   * Under a texture theme, the mesh draws one material per texture group
   * (`buildGroupMaterials`), with a `map` wherever the image is ready; under
   * any other theme, the one plain material. Called after every geometry
   * build, because the groups belong to the build. The image cache outlives
   * the geometry: a LoD change re-requests the same images and gets them
   * back at once.
   */
  private applyMaterials(): void {
    const groups = this.arrays.textureGroups;
    if (!groups || groups.length === 0) {
      this.textures?.dispose();
      this.textures = null;
      if (Array.isArray(this.object3d.material)) {
        this.releaseMaterials(this.object3d.material);
        this.object3d.material = createCityMaterial(this.style.uniforms);
        this.shadowMaterials.register(this.object3d.material);
        this.shareMaterials();
        this.theme.materialsReplaced();
      }
      return;
    }
    this.textures ??= new TextureCache({
      textures: this.model.appearance?.textures ?? [],
      baseUrl: this.textureBaseUrl,
      source: this.textureSource,
      onChange: (textureIndex) => this.textureChanged(textureIndex),
      warn: (message) => console.warn(`[cityModel:${this.id}] ${message}`),
    });
    const previous = this.object3d.material;
    const next = buildGroupMaterials(
      groups,
      this.textures,
      this.style.uniforms,
    );
    this.object3d.material = next;
    for (const m of next) this.shadowMaterials.register(m);
    this.releaseMaterials(previous);
    this.shareMaterials();
    this.theme.materialsReplaced();
  }

  /** Every cell draws with the root's material (array): a group's material
   *  index is its index in the whole build. */
  private shareMaterials(): void {
    for (const mesh of this.cellMeshes) mesh.material = this.object3d.material;
  }

  /** Unregister from the shadow registry FIRST, then dispose, so the
   *  registry rolls its shader patch back on a live material (it would also
   *  drop the entry on the dispose event; see `cityMaterial.ts`). */
  private releaseMaterials(materials: Material | Material[]): void {
    for (const m of Array.isArray(materials) ? materials : [materials]) {
      this.shadowMaterials.unregister(m);
      m.dispose();
    }
  }

  /** An image landed (or failed): give its group the map, then flag the
   *  slots that now show an image. Loads arrive in bursts, so the update is
   *  coalesced onto a microtask. */
  private textureChanged(textureIndex: number): void {
    this.pendingTextureChanges.add(textureIndex);
    if (this.textureFlushQueued) return;
    this.textureFlushQueued = true;
    queueMicrotask(() => this.flushTextureChanges());
  }

  private flushTextureChanges(): void {
    this.textureFlushQueued = false;
    const changed = this.pendingTextureChanges;
    this.pendingTextureChanges = new Set();
    if (changed.size === 0) return;
    const groups = this.arrays.textureGroups;
    const materials = this.object3d.material;
    if (!groups || !Array.isArray(materials)) return;
    groups.forEach((group, i) => {
      if (!changed.has(group.textureIndex)) return;
      const material = materials[i] as MeshLambertMaterial | undefined;
      if (!material) return;
      const entry = this.textures?.get(group.textureIndex);
      material.map = entry?.status === "ready" ? entry.texture : null;
      material.needsUpdate = true;
    });
    this.applyTextured();
    this.requestRender();
  }

  /** Flag every slot whose image is on screen, so the map shows as-is. */
  private applyTextured(): void {
    const textures = this.textures;
    this.style.setTextured((index) => textures?.isReady(index) ?? false);
  }

  /** Test seam: apply any coalesced texture changes now. */
  flushTexturesForTest(): void {
    this.flushTextureChanges();
  }

  /** Write the hidden flag of every slot from the hidden types and the
   *  attribute filter, and recount the drawn triangles. */
  private applyHidden(): void {
    const { objectKeys, objectTypes, indices, slots, slotObjects } =
      this.arrays;
    const hidden = hiddenObjectMask(
      objectKeys,
      objectTypes,
      this.hiddenTypes,
      this.visibleObjectIds,
    );
    this.style.setHidden(hidden);
    this.drawnTriangles = drawnTriangleCount(
      indices,
      slots,
      slotObjects,
      hidden,
    );
  }

  /** Whether triangle `t` is drawn, i.e. its slot is not hidden. */
  private isTriangleDrawn(t: number): boolean {
    return !this.style.isHidden(
      this.arrays.slots[this.arrays.indices[t * 3]!]!,
    );
  }

  /** Every layer of the style texture: colours, the image mask, the
   *  highlight. */
  private repaint(): void {
    this.restyle();
    this.applyTextured();
    this.paint();
  }

  /** Re-run the style evaluator over every slot and write the colours. Not
   *  for highlight changes. */
  private restyle(): void {
    this.styleColors = this.evaluator
      ? computeStyleColors(
          this.evaluator,
          this.arrays.slotObjects,
          this.arrays.slotSurfaces,
          this.arrays.objectKeys,
          (objectId) => this.model.objects[objectId],
          this.arrays.slotColors,
        )
      : null;
    this.style.setColors(this.styleColors ?? this.arrays.slotColors);
    this.requestRender();
  }

  /** Write the highlight flags: four bytes per surface, no colour touched. */
  private paint(): void {
    this.style.setHighlight(this.selections, this.hovered);
    this.requestRender();
  }

  setVisible(visible: boolean): void {
    if (this.object3d.visible === visible) return;
    this.object3d.visible = visible;
    this.requestRender();
  }

  /**
   * Draw another LoD selection. The selection is always recorded — every later
   * rebuild (appearance, placement) reads it — but the
   * geometry is rebuilt only when some object's drawn LoD changes: dropping
   * LoD 0 from [2, 1, 0] on a city where every object also has LoD 1 draws the
   * same triangles, and re-triangulating 1.9 M of them took ~2.7 s
   * (docs/performance/cityparquet-2026-09-21). `sameLodGeometry` walks the
   * surfaces' LoD labels only and shares the builder's per-object choice.
   */
  setLod(lod: string | readonly string[] | null): void {
    if (lod === this.lod) return;
    const unchanged = sameLodGeometry(this.model, this.lod, lod);
    this.lod = lod;
    if (!unchanged) this.rebuildGeometry();
  }

  /** The selection last requested — also after a skipped rebuild. */
  getLod(): string | readonly string[] | null {
    return this.lod;
  }

  /**
   * Which first-level object types are hidden — hiding "Building" hides its
   * BuildingParts too (`toplevelCityObjectType`).
   *
   * A flag write, not a rebuild: the shader drops a hidden slot from the
   * colour, G-buffer and shadow passes alike, so it neither occludes nor
   * casts, the raycast skips it, and the edges outline only what is drawn.
   */
  setHiddenTypes(types: ReadonlyArray<string>): void {
    const next = new Set(types);
    if (sameTypes(next, this.hiddenTypes)) return;
    this.hiddenTypes = next;
    this.hiddenChanged();
  }

  /**
   * Draw only the named objects — the geometry side of the table panel's
   * attribute filter. A flag write, like {@link setHiddenTypes}, and ANDed
   * with it.
   *
   * `null` clears the filter. An EMPTY set is NOT the same thing — it means
   * the filter matched nothing, and nothing is what must be drawn.
   */
  setVisibleObjectIds(ids: ReadonlySet<string> | null): void {
    if (sameVisibleIds(ids, this.visibleObjectIds)) return;
    this.visibleObjectIds = copyVisibleIds(ids);
    this.hiddenChanged();
  }

  private hiddenChanged(): void {
    this.applyHidden();
    // The outline follows what is drawn.
    this.theme.geometryReplaced();
    this.requestRender();
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
   * sample lands — no ordering hazard, and a failed sample simply never calls
   * this. See Global Constraints -> Vertical datum.
   *
   * NOT a rebuild: the vertices are moved in place (`raisePositionsInEnu`),
   * which is what a re-projection at the new offset produces, to Float32
   * storage precision, without proj4 or re-triangulation — a full rebuild on
   * every load cost ~2.7 s on Nishitokyo (docs/performance/cityparquet-2026-09-21).
   * The local move is not zero: the normals at vertex and origin fan out, so
   * a vertex 10 km out shifts ~N·d/R (6 cm for N = 37 m). Normals, colours,
   * picking indices, UVs and texture groups are unchanged; face normals turn
   * by ~N/R (1e-5 rad), which no lighting shows.
   */
  setHeightOffset(metres: number): void {
    if (metres === this.placement.heightOffset) return;
    const oldFrame = this.placement.frame;
    const delta = metres - this.placement.heightOffset;
    this.placement = this.computePlacement(metres);
    this.applyPlacement();
    const geometry = this.geometry;
    const position = geometry.getAttribute("position");
    // The attribute wraps `this.arrays.positions` (`cityMeshGeometry.ts`).
    raisePositionsInEnu(position.array as Float32Array, oldFrame, delta);
    position.needsUpdate = true;
    // Navara frustum-culls on the sphere; a raycast may have cached the box.
    geometry.computeBoundingSphere();
    if (geometry.boundingBox) geometry.computeBoundingBox();
    this.cellMeshes.forEach((mesh, i) =>
      computeCellBounds(mesh.geometry, this.cells[i + 1]!),
    );
    // The edge lines copied the old positions.
    this.theme.geometryReplaced();
    this.requestRender();
  }

  /** The frame/matrix/offset bundle this mesh is currently placed by — what
   *  Task B7's descriptor hands the engine as the mesh's `matrixWorld`. */
  getPlacement(): Placement {
    return this.placement;
  }

  private rebuildGeometry(): void {
    const old = this.geometry;
    this.arrays = this.buildArrays();
    this.style.replace(this.arrays);
    this.object3d.geometry = geometryFromMeshArrays(this.arrays);
    old.dispose();
    this.syncCells();
    this.applyMaterials();
    this.applyHidden();
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
    this.requestRender();
  }

  setStyle(evaluator: SurfaceStyleEvaluator | null): void {
    this.evaluator = evaluator;
    this.repaint();
  }

  /**
   * Swap the model whose ATTRIBUTES rules read, without touching geometry.
   *
   * The app merges computed attributes into a NEW immutable model (new objects
   * for the touched ids only) and pushes it here. The mesh's arrays index
   * objects by id, so only the `this.model.objects[objectId]` lookup inside
   * `repaint`'s `computeStyleColors` changes — a repaint, not a rebuild.
   *
   * Deliberately NOT a `rebuildGeometry` seam, unlike `setLod` /
   * `setHiddenTypes` / `setAppearance`: the geometry-dependent readers
   * (`buildArrays`'s surfaces and vertices, `getBoundsGeodetic`'s bbox, the
   * `TextureCache`'s appearance) must not be re-derived from a model that
   * differs from the built one only in attributes, and a rebuild would drop
   * the texture images and re-triangulate the whole layer on every computed
   * column. A caller that changes GEOMETRY must replace the layer, not call
   * this.
   */
  setModel(model: CityModel): void {
    if (model === this.model) return;
    this.model = model;
    this.repaint();
  }

  /**
   * Draw another appearance theme (or none). A rebuild on the `setLod` seam:
   * a texture theme changes the vertex ORDER (surfaces are grouped by image)
   * and adds UVs, a material theme changes the base colours. Switching
   * between two TEXTURE themes drops the image cache, because the indices
   * of one theme mean nothing in the other; a LoD change keeps it.
   */
  setAppearance(theme: AppearanceTheme | null): void {
    if (appearanceThemesEqual(theme, this.appearance)) return;
    const textureThemeChanged =
      this.appearance?.kind === "texture" &&
      !(theme?.kind === "texture" && theme.name === this.appearance.name);
    if (textureThemeChanged) {
      this.textures?.dispose();
      this.textures = null;
    }
    this.appearance = theme;
    this.rebuildGeometry();
  }

  /** The theme currently drawn. */
  getAppearance(): AppearanceTheme | null {
    return this.appearance;
  }

  /**
   * Highlight this layer's selections.
   *
   * Slots carry no layer id, so `paintSlotFlags` cannot tell one layer's
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
    // The style does not depend on the highlight: hover moves at pointer rate,
    // and re-running every rule over every surface for it is the cost.
    this.paint();
  }

  resolveVertex(vertexIndex: number): SurfaceSelection | null {
    const ref = this.surfaceAt(vertexIndex);
    return ref
      ? this.resolveVertexIndices(ref.objectIndex, ref.surfaceIndex)
      : null;
  }

  /** The surface a vertex belongs to, through its slot. */
  private surfaceAt(vertexIndex: number): SurfaceRef | null {
    const { slots, slotObjects, slotSurfaces } = this.arrays;
    if (vertexIndex < 0 || vertexIndex >= slots.length) return null;
    const slot = slots[vertexIndex]!;
    return {
      objectIndex: slotObjects[slot]!,
      surfaceIndex: slotSurfaces[slot]!,
    };
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
    // The root and its cells, never the edge lines: a line hit must never
    // answer for the surface under the cursor. Each cell's bounds prune the
    // cells the ray misses. Nearest first; a hidden slot is still in the
    // geometry, so it is skipped, not hit.
    const meshes = [this.object3d, ...this.cellMeshes];
    for (const hit of raycaster.intersectObjects(meshes, false)) {
      if (!hit.face || this.style.isHidden(this.arrays.slots[hit.face.a]!)) {
        continue;
      }
      const ref = this.surfaceAt(hit.face.a);
      return ref ? { ...ref, distance: hit.distance } : null;
    }
    return null;
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
      map.push(this.surfaceAt(this.arrays.indices[t * 3]!)!);
    }
    return map;
  }

  /** The colour the shader draws vertex `vertexIndex` in, linear rgb
   *  (`SlotStyle.drawnColor`). A test and readback seam. */
  drawnColorAt(vertexIndex: number): [number, number, number] {
    return this.style.drawnColor(this.arrays.slots[vertexIndex]!);
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

  /** Triangles drawn: hidden types and the attribute filter left out. */
  triangleCount(): number {
    return this.drawnTriangles;
  }

  dispose(): void {
    this.theme.dispose();
    for (const mesh of this.cellMeshes) mesh.geometry.dispose();
    this.geometry.dispose();
    this.textures?.dispose();
    this.textures = null;
    this.releaseMaterials(this.object3d.material);
    this.depthMaterial.dispose();
    this.style.dispose();
  }
}
