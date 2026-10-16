/**
 * Converts normalized CityModel surfaces into plain typed arrays.
 *
 * Triangulates polygon surfaces and computes one normal per surface. Every drawn
 * surface is a SLOT: each vertex names its slot, and per slot the arrays say
 * which object and surface it is, its base colour and its image. Colour,
 * highlight and picking all go through the slot, so restyling never touches
 * a vertex. Contains no GPU/DOM types, so it runs unchanged on the
 * main thread and inside a Web Worker; renderers wrap the arrays in their own
 * buffer objects. Triangulation itself is `triangulate.ts`.
 */

import { triangulateSurface, type SurfaceTriangulation } from "./triangulate";
import type {
  AppearanceTheme,
  CityModel,
  Surface,
  Vec3,
} from "../citymodel/types";
import { toplevelCityObjectType } from "../citymodel/toplevelType";
import {
  allowedLodSet,
  selectedSurfaceLod,
  type LodSelection,
} from "./lodSelection";
import { srgbToLinear } from "../styling/srgb";
import {
  SURFACE_COLORS_LINEAR,
  type LinearRGB,
} from "../styling/surfaceColors";
import type { BuildingSurfaceType } from "../citymodel/types";

/**
 * A contiguous INDEX range of the arrays drawn with one texture image
 * (`textureIndex` into `CityModel.appearance.textures`), or with none
 * (`textureIndex === -1`). Ranges tile the whole array in order; a renderer
 * turns each into a `BufferGeometry` group with its own material.
 */
export interface TextureGroup {
  readonly start: number;
  readonly count: number;
  readonly textureIndex: number;
}

/**
 * The most vertices a build indexes with 16 bits. WebGL 2 always treats the
 * largest index of the type (65,535 for 16 bits) as a primitive restart, so
 * the last usable index is 65,534.
 */
export const MAX_UINT16_VERTICES = 65_535;

export interface CityMeshArrays {
  /** Per vertex, 3 each. Indexed per surface: a vertex belongs to one slot. */
  readonly positions: Float32Array;
  /** Per vertex, 3 each: its surface's normal. */
  readonly normals: Float32Array;
  /** Three per triangle, into the vertex arrays. 16-bit while the vertices
   *  fit ({@link MAX_UINT16_VERTICES}), 32-bit otherwise. */
  readonly indices: Uint16Array | Uint32Array;
  readonly objectKeys: string[];
  /** Per object, paired with `objectKeys`, its FIRST-LEVEL type
   *  (`toplevelCityObjectType`): what a renderer hides by flag, so hiding
   *  "Building" hides its BuildingParts too. */
  readonly objectTypes: string[];
  readonly triangleCount: number;
  /** Per-vertex texture coordinates (2 per vertex). Only under a texture
   *  theme; `null`/absent otherwise. Untextured vertices carry (0, 0). */
  readonly uvs?: Float32Array | null;
  /** Vertex ranges per texture, untextured first. Only under a texture
   *  theme; `null`/absent otherwise. */
  readonly textureGroups?: ReadonlyArray<TextureGroup> | null;
  /** Per vertex, its SLOT: the drawn surface it belongs to, numbered in
   *  write order. A vertex never belongs to two slots. */
  readonly slots: Uint32Array;
  /** Per slot, its object index (into `objectKeys`). */
  readonly slotObjects: Uint32Array;
  /** Per slot, its surface index within the object's own surfaces. */
  readonly slotSurfaces: Uint32Array;
  /** Per slot, the image it is drawn with, or -1 (untextured, or no texture
   *  theme). */
  readonly slotTextures: Int32Array;
  /** Per slot, its base colour (semantic or material), linear rgb, 3 per
   *  slot — what a style texture starts from. */
  readonly slotColors: Float32Array;
}

/** One drawable surface, resolved in pass 1 and written in pass 2. */
interface PendingSurface {
  readonly objectIdx: number;
  readonly surfaceIdx: number;
  readonly surface: Surface;
  readonly triangulation: SurfaceTriangulation;
  readonly textureIndex: number;
  readonly color: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
  };
}

/**
 * Convert normalized CityModel surfaces into plain typed arrays: positions,
 * per-surface normals, indices and the slot tables.
 *
 * Uses a two-pass approach for large-model performance:
 * Pass 1: count total triangles to pre-allocate typed arrays.
 * Pass 2: write directly into typed arrays (no intermediate number[]).
 *
 * The geometry is indexed per surface: a surface's vertices are written once
 * and its triangles index them, and no vertex is shared between surfaces, so
 * a vertex's slot is exact and every vertex of a surface carries the
 * surface's normal.
 *
 * Contains no Three.js DOM/GPU types (no BufferGeometry/BufferAttribute),
 * so it can run inside a Web Worker.
 *
 * `_layerId` is accepted (and underscore-prefixed) purely to keep the call
 * signature symmetric with the renderer wrappers, which pair `objectKeys`
 * with the layer ID to form a `PickingIndex`; the array builder itself has
 * no use for it.
 *
 * `hiddenTypes` holds FIRST-LEVEL group names (`toplevelCityObjectType`), so
 * hiding "Building" hides its BuildingParts too. A hidden object contributes
 * no triangles but still takes its `objectKeys` slot and its object index —
 * object indices must be identical to an unfiltered build, or every consumer
 * that maps an index back through `objectKeys` (`computeStyleColors`,
 * `paintSlotFlags`, `resolveVertexIndices`) shifts by the number of hidden
 * objects before it.
 *
 * `appearance` selects one of the model's appearance themes:
 *  - a MATERIAL theme replaces the semantic colour of every surface that has
 *    a material in that theme with the material's diffuse colour (sRGB →
 *    linear); nothing else changes, so rule colours still override exactly
 *    as they do over semantic colours;
 *  - a TEXTURE theme writes surfaces SORTED by texture index (untextured
 *    first, file order within a bucket) so each image is one contiguous
 *    index range (`textureGroups`), and emits per-vertex `uvs`. Colours stay
 *    semantic: a renderer draws a slot white only once its image
 *    (`slotTextures`) has loaded, so a missing image degrades to the plain
 *    look. A texture theme
 *    that covers no visible surface emits neither (`uvs`/`textureGroups`
 *    null), so a model without images costs nothing extra.
 * With no theme (the default) `uvs`/`textureGroups` are null and the
 * vertex order is the file's.
 *
 * `visibleObjectIds` is the ATTRIBUTE filter's geometry side: only the named
 * objects contribute triangles, `null` means no filter, and an EMPTY set means
 * nothing matched and nothing is drawn. Like `hiddenTypes`, a filtered object
 * still takes its `objectKeys` slot and its object index — object indices must
 * be identical to an unfiltered build, or every consumer that maps an index
 * back through `objectKeys` shifts by the number of filtered objects before it.
 */
export function buildCityMeshArrays(
  model: CityModel,
  _layerId: string,
  originOffset: Vec3 = [0, 0, 0],
  selectedLod: LodSelection = null,
  hiddenTypes: ReadonlySet<string> | null = null,
  appearance: AppearanceTheme | null = null,
  /** Vertex colour per semantic surface type. Defaults to core's palette; a
   *  host passes `resolveSurfaceColorsLinear(itsPalette)` to bake its own. */
  surfaceColors: Record<BuildingSurfaceType, LinearRGB> = SURFACE_COLORS_LINEAR,
  visibleObjectIds: ReadonlySet<string> | null = null,
): CityMeshArrays {
  const objectKeys: string[] = [];
  const objectTypes: string[] = [];
  const textureTheme = appearance?.kind === "texture" ? appearance.name : null;
  const materialTheme =
    appearance?.kind === "material" ? appearance.name : null;
  const materials = model.appearance?.materials;

  // One representation per object, never overlapping LoDs; a string is the
  // one-element selection (`lodSelection.ts`). `null` draws every surface.
  const allowedLods = selectedLod === null ? null : allowedLodSet(selectedLod);

  // Pass 1: triangulate, resolve colour/texture, build the object key list.
  let totalTriangles = 0;
  let totalVertices = 0;
  const pending: PendingSurface[] = [];
  let objectIdx = 0;
  for (const [id, obj] of Object.entries(model.objects)) {
    if (!obj) continue;
    // Pushed BEFORE the hidden check: the key list is never filtered, and a
    // hidden object still consumes its index — see `hiddenTypes` above.
    objectKeys.push(id);
    objectTypes.push(toplevelCityObjectType(obj.objectType));
    const thisObjectIdx = objectIdx++;
    if (isHidden(obj.objectType, hiddenTypes)) continue;
    // An ATTRIBUTE filter, ANDed with the type filter above: an object draws
    // only if its type is not hidden AND (no id filter is set OR it is named).
    // `null` and an EMPTY set are deliberately different — null is "no
    // filter", an empty set is "nothing matched", and a filter that matched
    // nothing must show nothing rather than everything.
    //
    // A RAW id test, with no ancestor walk — unlike `isHidden`, which folds an
    // object up to its first-level type. The CALLER owns feature expansion
    // (the app's feature-scoped SQL already expands a match to the whole
    // feature, parts included), so walking parents here would double-expand,
    // once per object, inside the hot pass-1 loop.
    if (visibleObjectIds !== null && !visibleObjectIds.has(id)) continue;
    // `undefined` is "this selection draws nothing of this object"; `null` is
    // a real answer — the object's UNLABELLED surfaces won, because the
    // selection names the unlabelled rung and no labelled surface of this
    // object is in it (`lodSelection.ts`).
    const objectLod = allowedLods
      ? selectedSurfaceLod(obj.surfaces, allowedLods)
      : undefined;
    if (allowedLods && objectLod === undefined) continue;
    for (let surfaceIdx = 0; surfaceIdx < obj.surfaces.length; surfaceIdx++) {
      const surface = obj.surfaces[surfaceIdx]!;
      if (allowedLods && surface.lod !== objectLod) continue;
      const surfaceTexture =
        textureTheme !== null ? surface.texture?.[textureTheme] : undefined;
      const triangulation = triangulateSurface(
        surface.rings,
        obj.bbox,
        surfaceTexture?.uvs ?? null,
      );
      if (!triangulation) continue;
      // Textured only when the UVs made it through triangulation intact.
      const textureIndex =
        surfaceTexture && triangulation.uvs ? surfaceTexture.textureIndex : -1;
      let color: PendingSurface["color"] = surfaceColors[surface.type];
      if (materialTheme !== null) {
        const materialIdx = surface.material?.[materialTheme];
        const diffuse =
          materialIdx === undefined
            ? undefined
            : materials?.[materialIdx]?.diffuseColor;
        if (diffuse) {
          const [r, g, b] = srgbToLinear(diffuse);
          color = { r, g, b };
        }
      }
      pending.push({
        objectIdx: thisObjectIdx,
        surfaceIdx,
        surface,
        triangulation,
        textureIndex,
        color,
      });
      totalTriangles += triangulation.triangles.length;
      totalVertices += triangulation.vertices.length;
    }
  }

  // Under a texture theme, one contiguous range per image. A stable sort
  // keeps file order inside each bucket; the slot tables carry identity, so
  // the write order is free to change.
  if (textureTheme !== null) {
    pending.sort((a, b) => a.textureIndex - b.textureIndex);
  }

  // Indexed per surface: a surface's ring vertices are written once and its
  // triangles index them, so a vertex never belongs to two slots.
  const vertexCount = totalVertices;
  // A texture theme no drawn surface uses is the plain build.
  const anyTextured =
    textureTheme !== null && pending.some((p) => p.textureIndex >= 0);

  // Pre-allocate typed arrays (avoids dynamic array growth and copy)
  const posArray = new Float32Array(vertexCount * 3);
  const normalArray = new Float32Array(vertexCount * 3);
  const uvArray = anyTextured ? new Float32Array(vertexCount * 2) : null;
  const indices =
    vertexCount <= MAX_UINT16_VERTICES
      ? new Uint16Array(totalTriangles * 3)
      : new Uint32Array(totalTriangles * 3);
  const textureGroups: TextureGroup[] | null = anyTextured ? [] : null;
  const slotCount = pending.length;
  const slots = new Uint32Array(vertexCount);
  const slotObjects = new Uint32Array(slotCount);
  const slotSurfaces = new Uint32Array(slotCount);
  const slotTextures = new Int32Array(slotCount);
  const slotColors = new Float32Array(slotCount * 3);

  // Pass 2: write directly into typed arrays
  let vertexWrite = 0;
  let indexWrite = 0;
  for (let slot = 0; slot < slotCount; slot++) {
    const entry = pending[slot]!;
    const { objectIdx, surfaceIdx, triangulation, color, textureIndex } = entry;
    const { vertices, triangles } = triangulation;
    slotObjects[slot] = objectIdx;
    slotSurfaces[slot] = surfaceIdx;
    slotTextures[slot] = textureIndex;
    slotColors[slot * 3] = color.r;
    slotColors[slot * 3 + 1] = color.g;
    slotColors[slot * 3 + 2] = color.b;
    const first = vertexWrite;
    slots.fill(slot, first, first + vertices.length);

    if (textureGroups) {
      const last = textureGroups[textureGroups.length - 1];
      if (last && last.textureIndex === textureIndex) {
        textureGroups[textureGroups.length - 1] = {
          ...last,
          count: last.count + triangles.length * 3,
        };
      } else {
        textureGroups.push({
          start: indexWrite,
          count: triangles.length * 3,
          textureIndex,
        });
      }
    }

    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i]!;
      const base = (first + i) * 3;
      posArray[base] = v[0] - originOffset[0];
      posArray[base + 1] = v[1] - originOffset[1];
      posArray[base + 2] = v[2] - originOffset[2];
      if (uvArray && triangulation.uvs) {
        const uv = triangulation.uvs[i]!;
        uvArray[(first + i) * 2] = uv[0];
        uvArray[(first + i) * 2 + 1] = uv[1];
      }
    }

    // One normal per surface: the sum of its triangles' cross products,
    // normalised. For a planar surface that is every triangle's own face
    // normal; a bent one gets the area-weighted mean. The crosses are taken
    // from the values just written to `posArray` (already rounded to
    // Float32), NOT from the double-precision vertices: a triangle whose
    // Float32 corners collapse onto one value has zero area on the GPU, and a
    // surface made only of such triangles gets the zero normal, as three's
    // `computeVertexNormals` would give it.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (const triangle of triangles) {
      const a = (first + triangle[0]) * 3;
      const b = (first + triangle[1]) * 3;
      const c = (first + triangle[2]) * 3;
      indices[indexWrite++] = first + triangle[0];
      indices[indexWrite++] = first + triangle[1];
      indices[indexWrite++] = first + triangle[2];
      const cbx = posArray[c]! - posArray[b]!;
      const cby = posArray[c + 1]! - posArray[b + 1]!;
      const cbz = posArray[c + 2]! - posArray[b + 2]!;
      const abx = posArray[a]! - posArray[b]!;
      const aby = posArray[a + 1]! - posArray[b + 1]!;
      const abz = posArray[a + 2]! - posArray[b + 2]!;
      nx += cby * abz - cbz * aby;
      ny += cbz * abx - cbx * abz;
      nz += cbx * aby - cby * abx;
    }
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) {
      nx /= length;
      ny /= length;
      nz /= length;
    }
    for (let i = 0; i < vertices.length; i++) {
      const base = (first + i) * 3;
      normalArray[base] = nx;
      normalArray[base + 1] = ny;
      normalArray[base + 2] = nz;
    }
    vertexWrite += vertices.length;
  }

  return {
    positions: posArray,
    normals: normalArray,
    indices,
    objectKeys,
    objectTypes,
    triangleCount: totalTriangles,
    uvs: uvArray,
    textureGroups,
    slots,
    slotObjects,
    slotSurfaces,
    slotTextures,
    slotColors,
  };
}

function isHidden(
  objectType: string,
  hiddenTypes: ReadonlySet<string> | null,
): boolean {
  return (
    hiddenTypes !== null && hiddenTypes.has(toplevelCityObjectType(objectType))
  );
}

/**
 * Compute a good origin offset from a CityModel's bounding box.
 * Uses the center of the bbox to minimize coordinate magnitudes.
 */
export function computeOriginOffset(model: CityModel): Vec3 {
  if (!model.bbox) return [0, 0, 0];
  return [
    (model.bbox[0] + model.bbox[3]) / 2,
    (model.bbox[1] + model.bbox[4]) / 2,
    (model.bbox[2] + model.bbox[5]) / 2,
  ];
}
