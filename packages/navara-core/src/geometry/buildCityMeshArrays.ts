/**
 * Converts normalized CityModel surfaces into plain typed arrays.
 *
 * Triangulates polygon surfaces, computes flat face normals, assigns vertex
 * colors from the semantic surface type, and emits per-vertex object/surface
 * indices for picking. Contains no GPU/DOM types, so it runs unchanged on the
 * main thread and inside a Web Worker; renderers wrap the arrays in their own
 * buffer objects.
 *
 * `three` is used only for its pure-math polygon helpers (`ShapeUtils`,
 * `Vector2`) — no renderer, no GPU resources.
 */

import { ShapeUtils, Vector2 } from "three";
import type {
  AppearanceTheme,
  BBox3,
  CityModel,
  Surface,
  UV,
  Vec3,
} from "../citymodel/types";
import { toplevelCityObjectType } from "../citymodel/toplevelType";
import { srgbToLinear } from "../styling/srgb";
import {
  SURFACE_COLORS_LINEAR,
  type LinearRGB,
} from "../styling/surfaceColors";
import type { BuildingSurfaceType } from "../citymodel/types";

/**
 * A contiguous VERTEX range of the arrays drawn with one texture image
 * (`textureIndex` into `CityModel.appearance.textures`), or with none
 * (`textureIndex === -1`). Ranges tile the whole array in order; a renderer
 * turns each into a `BufferGeometry` group with its own material.
 */
export interface TextureGroup {
  readonly start: number;
  readonly count: number;
  readonly textureIndex: number;
}

export interface CityMeshArrays {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly objectIndices: Uint32Array;
  readonly surfaceIndices: Uint32Array;
  readonly objectKeys: string[];
  readonly triangleCount: number;
  /** Per-vertex texture coordinates (2 per vertex). Only under a texture
   *  theme; `null`/absent otherwise. Untextured vertices carry (0, 0). */
  readonly uvs?: Float32Array | null;
  /** Vertex ranges per texture, untextured first. Only under a texture
   *  theme; `null`/absent otherwise. */
  readonly textureGroups?: ReadonlyArray<TextureGroup> | null;
}

interface SurfaceTriangulation {
  readonly vertices: ReadonlyArray<Vec3>;
  readonly triangles: ReadonlyArray<readonly [number, number, number]>;
  /** Paired with `vertices`, present when the surface was textured. */
  readonly uvs: ReadonlyArray<UV> | null;
}

/** One drawable surface, resolved in pass 1 and written in pass 2. */
interface PendingSurface {
  readonly objectIdx: number;
  readonly surfaceIdx: number;
  readonly surface: Surface;
  readonly triangulation: SurfaceTriangulation;
  readonly textureIndex: number;
  readonly color: { readonly r: number; readonly g: number; readonly b: number };
}

/**
 * Convert normalized CityModel surfaces into plain typed arrays: positions,
 * per-triangle face normals, vertex colors, and picking indices.
 *
 * Uses a two-pass approach for large-model performance:
 * Pass 1: count total triangles to pre-allocate typed arrays.
 * Pass 2: write directly into typed arrays (no intermediate number[]).
 *
 * Normals are computed per-triangle (flat face normal) and written
 * identically to all three of that triangle's vertices. Because the
 * geometry is non-indexed (no vertex sharing across triangles), this is
 * exactly what `BufferGeometry.computeVertexNormals()` produces: each
 * vertex belongs to only one triangle, so the "accumulated" normal is
 * just that triangle's own face normal, normalized.
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
 * `paintLayers`, `resolveVertexIndices`) shifts by the number of hidden
 * objects before it.
 *
 * `appearance` selects one of the model's appearance themes:
 *  - a MATERIAL theme replaces the semantic colour of every surface that has
 *    a material in that theme with the material's diffuse colour (sRGB →
 *    linear); nothing else changes, so rule colours still override exactly
 *    as they do over semantic colours;
 *  - a TEXTURE theme writes surfaces SORTED by texture index (untextured
 *    first, file order within a bucket) so each image is one contiguous
 *    vertex range (`textureGroups`), and emits per-vertex `uvs`. Colours stay
 *    semantic: a renderer whites them out only where an image has actually
 *    loaded, so a missing image degrades to the plain look. A texture theme
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
  selectedLod: string | null = null,
  hiddenTypes: ReadonlySet<string> | null = null,
  appearance: AppearanceTheme | null = null,
  /** Vertex colour per semantic surface type. Defaults to core's palette; a
   *  host passes `resolveSurfaceColorsLinear(itsPalette)` to bake its own. */
  surfaceColors: Record<BuildingSurfaceType, LinearRGB> = SURFACE_COLORS_LINEAR,
  visibleObjectIds: ReadonlySet<string> | null = null,
): CityMeshArrays {
  const objectKeys: string[] = [];
  const textureTheme =
    appearance?.kind === "texture" ? appearance.name : null;
  const materialTheme =
    appearance?.kind === "material" ? appearance.name : null;
  const materials = model.appearance?.materials;

  // Pass 1: triangulate, resolve colour/texture, build the object key list.
  let totalTriangles = 0;
  const pending: PendingSurface[] = [];
  let objectIdx = 0;
  for (const [id, obj] of Object.entries(model.objects)) {
    if (!obj) continue;
    // Pushed BEFORE the hidden check: the key list is never filtered, and a
    // hidden object still consumes its index — see `hiddenTypes` above.
    objectKeys.push(id);
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
    for (let surfaceIdx = 0; surfaceIdx < obj.surfaces.length; surfaceIdx++) {
      const surface = obj.surfaces[surfaceIdx]!;
      if (selectedLod !== null && surface.lod !== selectedLod) continue;
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
    }
  }

  // Under a texture theme, one contiguous range per image. A stable sort
  // keeps file order inside each bucket; per-vertex object/surface indices
  // carry identity, so the write order is free to change.
  if (textureTheme !== null) {
    pending.sort((a, b) => a.textureIndex - b.textureIndex);
  }

  const vertexCount = totalTriangles * 3;
  // A texture theme no drawn surface uses is the plain build.
  const anyTextured =
    textureTheme !== null && pending.some((p) => p.textureIndex >= 0);

  // Pre-allocate typed arrays (avoids dynamic array growth and copy)
  const posArray = new Float32Array(vertexCount * 3);
  const normalArray = new Float32Array(vertexCount * 3);
  const colorArray = new Float32Array(vertexCount * 3);
  const objIdxArray = new Uint32Array(vertexCount);
  const surfIdxArray = new Uint32Array(vertexCount);
  const uvArray = anyTextured ? new Float32Array(vertexCount * 2) : null;
  const textureGroups: TextureGroup[] | null = anyTextured ? [] : null;

  // Pass 2: write directly into typed arrays
  let writeIdx = 0;
  for (const entry of pending) {
    const { objectIdx, surfaceIdx, triangulation, color, textureIndex } = entry;

    if (textureGroups) {
      const last = textureGroups[textureGroups.length - 1];
      if (last && last.textureIndex === textureIndex) {
        textureGroups[textureGroups.length - 1] = {
          ...last,
          count: last.count + triangulation.triangles.length * 3,
        };
      } else {
        textureGroups.push({
          start: writeIdx,
          count: triangulation.triangles.length * 3,
          textureIndex,
        });
      }
    }

    {
      for (const triangle of triangulation.triangles) {
        const v0 = triangulation.vertices[triangle[0]]!;
        const v1 = triangulation.vertices[triangle[1]]!;
        const v2 = triangulation.vertices[triangle[2]]!;
        const base = writeIdx * 3;

        if (uvArray && triangulation.uvs) {
          const uv0 = triangulation.uvs[triangle[0]]!;
          const uv1 = triangulation.uvs[triangle[1]]!;
          const uv2 = triangulation.uvs[triangle[2]]!;
          const uvBase = writeIdx * 2;
          uvArray[uvBase] = uv0[0];
          uvArray[uvBase + 1] = uv0[1];
          uvArray[uvBase + 2] = uv1[0];
          uvArray[uvBase + 3] = uv1[1];
          uvArray[uvBase + 4] = uv2[0];
          uvArray[uvBase + 5] = uv2[1];
        }

        posArray[base] = v0[0] - originOffset[0];
        posArray[base + 1] = v0[1] - originOffset[1];
        posArray[base + 2] = v0[2] - originOffset[2];
        posArray[base + 3] = v1[0] - originOffset[0];
        posArray[base + 4] = v1[1] - originOffset[1];
        posArray[base + 5] = v1[2] - originOffset[2];
        posArray[base + 6] = v2[0] - originOffset[0];
        posArray[base + 7] = v2[1] - originOffset[1];
        posArray[base + 8] = v2[2] - originOffset[2];

        // Flat face normal, written to all three vertices. The geometry is
        // non-indexed (no vertex sharing across triangles), so this exactly
        // reproduces what BufferGeometry.computeVertexNormals() computes:
        // normal = normalize(cross(v2 - v1, v0 - v1)).
        //
        // Critically, this must be derived from the values just written
        // into posArray (already rounded to Float32), NOT from the
        // double-precision v0/v1/v2. computeVertexNormals() reads from the
        // Float32Array position attribute, so for a triangle whose
        // double-precision area is tiny relative to its coordinate
        // magnitude, Float32 rounding can collapse two vertices onto the
        // same representable value and zero out the cross product — a
        // real behavioral case that reading from v0/v1/v2 directly would
        // miss (it would "see" the double-precision area and produce a
        // non-zero normal where the old computeVertexNormals()-based
        // implementation produced zero).
        const [nx, ny, nz] = computeFaceNormal(
          posArray[base]!,
          posArray[base + 1]!,
          posArray[base + 2]!,
          posArray[base + 3]!,
          posArray[base + 4]!,
          posArray[base + 5]!,
          posArray[base + 6]!,
          posArray[base + 7]!,
          posArray[base + 8]!,
        );
        normalArray[base] = nx;
        normalArray[base + 1] = ny;
        normalArray[base + 2] = nz;
        normalArray[base + 3] = nx;
        normalArray[base + 4] = ny;
        normalArray[base + 5] = nz;
        normalArray[base + 6] = nx;
        normalArray[base + 7] = ny;
        normalArray[base + 8] = nz;

        colorArray[base] = color.r;
        colorArray[base + 1] = color.g;
        colorArray[base + 2] = color.b;
        colorArray[base + 3] = color.r;
        colorArray[base + 4] = color.g;
        colorArray[base + 5] = color.b;
        colorArray[base + 6] = color.r;
        colorArray[base + 7] = color.g;
        colorArray[base + 8] = color.b;

        objIdxArray[writeIdx] = objectIdx;
        objIdxArray[writeIdx + 1] = objectIdx;
        objIdxArray[writeIdx + 2] = objectIdx;
        surfIdxArray[writeIdx] = surfaceIdx;
        surfIdxArray[writeIdx + 1] = surfaceIdx;
        surfIdxArray[writeIdx + 2] = surfaceIdx;

        writeIdx += 3;
      }
    }
  }

  return {
    positions: posArray,
    normals: normalArray,
    colors: colorArray,
    objectIndices: objIdxArray,
    surfaceIndices: surfIdxArray,
    objectKeys,
    triangleCount: totalTriangles,
    uvs: uvArray,
    textureGroups,
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
 * Flat face normal for a triangle, normalized to unit length (or the zero
 * vector for a degenerate/zero-area triangle — matching
 * `Vector3.normalize()`'s `divideScalar(length() || 1)`, which leaves a
 * zero-length vector as `(0,0,0)` rather than producing `NaN`).
 *
 * Takes the three vertices as plain numbers already read back from the
 * Float32Array position buffer (see call site) — NOT double-precision
 * coordinates — because `BufferGeometry.computeVertexNormals()` operates on
 * the Float32-rounded position attribute. Uses the same vertex pairing and
 * cross-product order as that function (`cross(pC - pB, pA - pB)`) so
 * results match bit-for-bit (within float rounding) with what the old
 * `computeVertexNormals()`-based implementation produced for non-indexed
 * geometry, including the case where Float32 rounding collapses a
 * double-precision-nondegenerate triangle to zero area.
 */
function computeFaceNormal(
  p0x: number,
  p0y: number,
  p0z: number,
  p1x: number,
  p1y: number,
  p1z: number,
  p2x: number,
  p2y: number,
  p2z: number,
): Vec3 {
  const cbx = p2x - p1x;
  const cby = p2y - p1y;
  const cbz = p2z - p1z;
  const abx = p0x - p1x;
  const aby = p0y - p1y;
  const abz = p0z - p1z;
  const nx = cby * abz - cbz * aby;
  const ny = cbz * abx - cbx * abz;
  const nz = cbx * aby - cby * abx;
  const length = Math.hypot(nx, ny, nz);
  if (length === 0) return [0, 0, 0];
  return [nx / length, ny / length, nz / length];
}

/**
 * `uvRings`, when given, pairs with `rings` one UV per vertex; the returned
 * `uvs` pair with `vertices` the same way. Every ring reversal below —
 * the exterior's orientation flip and a hole's winding fix — is applied to
 * the UV ring by the SAME decision, so a texture never mirrors on a face
 * whose vertices were reordered. A UV ring that does not match its vertex
 * ring in length is dropped (the surface renders untextured).
 */
function triangulateSurface(
  rings: ReadonlyArray<ReadonlyArray<Vec3>>,
  objectBBox: BBox3 | null,
  uvRings: ReadonlyArray<ReadonlyArray<UV>> | null = null,
): SurfaceTriangulation | null {
  if (rings.length === 0) return null;

  let uvs: ReadonlyArray<ReadonlyArray<UV>> | null =
    uvRings !== null &&
    uvRings.length === rings.length &&
    uvRings.every((uvRing, i) => uvRing.length === rings[i]!.length)
      ? uvRings
      : null;

  const exteriorRaw = rings[0];
  const exteriorRing = orientExteriorRing(exteriorRaw, objectBBox);
  if (!exteriorRing || exteriorRing.length < 3) return null;
  const exteriorReversed = exteriorRing !== exteriorRaw;
  const exteriorUvs = uvs
    ? exteriorReversed
      ? [...uvs[0]!].reverse()
      : uvs[0]!
    : null;

  const normal = computeNewellNormal(exteriorRing);
  const normalLength = Math.hypot(normal[0], normal[1], normal[2]);
  if (normalLength === 0) return null;

  const basis = buildProjectionBasis(exteriorRing, [
    normal[0] / normalLength,
    normal[1] / normalLength,
    normal[2] / normalLength,
  ]);
  if (!basis) return null;

  const projectedContour = projectRingTo2D(exteriorRing, basis);
  const contourClockwise = ShapeUtils.isClockWise([...projectedContour]);

  const holeIndices: number[] = [];
  for (let i = 1; i < rings.length; i++) {
    if (rings[i]!.length >= 3) holeIndices.push(i);
  }
  const holeRings = holeIndices.map((i) => [...rings[i]!]);
  const holeUvs: UV[][] | null = uvs
    ? holeIndices.map((i) => [...uvs![i]!])
    : null;
  const projectedHoles = holeRings.map((ring, h) => {
    const projectedHole = projectRingTo2D(ring, basis);
    const holeClockwise = ShapeUtils.isClockWise([...projectedHole]);
    if (holeClockwise !== contourClockwise) return projectedHole;
    // The hole is rewound for the triangulator, and `triangulateShape`
    // returns indices into the concatenated contour + holes it was GIVEN —
    // so the 3D ring and its UVs are reversed alongside the 2D projection,
    // or every triangle touching the hole would read vertex n-1-k for k.
    // (Before 2026-09-03 only the projection was reversed; courtyard
    // buildings rendered with triangles spanning the hole.)
    if (holeUvs) holeUvs[h] = [...holeUvs[h]!].reverse();
    holeRings[h] = [...ring].reverse();
    return [...projectedHole].reverse();
  });

  const vertices = [exteriorRing, ...holeRings].flat();
  if (exteriorUvs && holeUvs) {
    uvs = [exteriorUvs, ...holeUvs];
  } else {
    uvs = null;
  }
  const triangles = ShapeUtils.triangulateShape(
    [...projectedContour],
    projectedHoles.map((hole) => [...hole]),
  ).map(
    (triangle) =>
      [triangle[0]!, triangle[1]!, triangle[2]!] as const satisfies readonly [
        number,
        number,
        number,
      ],
  );

  return { vertices, triangles, uvs: uvs ? uvs.flat() : null };
}

function orientExteriorRing(
  ring: ReadonlyArray<Vec3> | undefined,
  objectBBox: BBox3 | null,
): ReadonlyArray<Vec3> | undefined {
  if (!ring || ring.length < 3 || !objectBBox) return ring;

  const normal = computeNewellNormal(ring);
  const normalLengthSq =
    normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2];
  if (normalLengthSq === 0) return ring;

  const faceCenter = computeRingCenter(ring);
  const objectCenter = [
    (objectBBox[0] + objectBBox[3]) / 2,
    (objectBBox[1] + objectBBox[4]) / 2,
    (objectBBox[2] + objectBBox[5]) / 2,
  ] as const;
  const toFace = [
    faceCenter[0] - objectCenter[0],
    faceCenter[1] - objectCenter[1],
    faceCenter[2] - objectCenter[2],
  ] as const;
  const dot =
    normal[0] * toFace[0] + normal[1] * toFace[1] + normal[2] * toFace[2];

  return dot < 0 ? [...ring].reverse() : ring;
}

function computeRingCenter(ring: ReadonlyArray<Vec3>): Vec3 {
  let sx = 0;
  let sy = 0;
  let sz = 0;

  for (const v of ring) {
    sx += v[0];
    sy += v[1];
    sz += v[2];
  }

  return [sx / ring.length, sy / ring.length, sz / ring.length];
}

// Newell's method is stable for arbitrary planar polygon winding.
function computeNewellNormal(ring: ReadonlyArray<Vec3>): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;

  for (let i = 0; i < ring.length; i++) {
    const current = ring[i]!;
    const next = ring[(i + 1) % ring.length]!;
    nx += (current[1] - next[1]) * (current[2] + next[2]);
    ny += (current[2] - next[2]) * (current[0] + next[0]);
    nz += (current[0] - next[0]) * (current[1] + next[1]);
  }

  return [nx, ny, nz];
}

interface ProjectionBasis {
  readonly origin: Vec3;
  readonly tangent: Vec3;
  readonly bitangent: Vec3;
}

function buildProjectionBasis(
  ring: ReadonlyArray<Vec3>,
  normal: Vec3,
): ProjectionBasis | null {
  const origin = ring[0]!;
  let tangent: Vec3 | null = null;

  for (let i = 1; i < ring.length; i++) {
    const edge = subtractVec3(ring[i]!, origin);
    const length = Math.hypot(edge[0], edge[1], edge[2]);
    if (length > 0) {
      tangent = [edge[0] / length, edge[1] / length, edge[2] / length];
      break;
    }
  }

  if (!tangent) return null;

  const bitangentRaw = crossVec3(normal, tangent);
  const bitangentLength = Math.hypot(
    bitangentRaw[0],
    bitangentRaw[1],
    bitangentRaw[2],
  );
  if (bitangentLength === 0) return null;

  const bitangent: Vec3 = [
    bitangentRaw[0] / bitangentLength,
    bitangentRaw[1] / bitangentLength,
    bitangentRaw[2] / bitangentLength,
  ];
  const tangentOrthoRaw = crossVec3(bitangent, normal);
  const tangentOrthoLength = Math.hypot(
    tangentOrthoRaw[0],
    tangentOrthoRaw[1],
    tangentOrthoRaw[2],
  );
  if (tangentOrthoLength === 0) return null;

  return {
    origin,
    tangent: [
      tangentOrthoRaw[0] / tangentOrthoLength,
      tangentOrthoRaw[1] / tangentOrthoLength,
      tangentOrthoRaw[2] / tangentOrthoLength,
    ],
    bitangent,
  };
}

function projectRingTo2D(
  ring: ReadonlyArray<Vec3>,
  basis: ProjectionBasis,
): Vector2[] {
  return ring.map((vertex) => {
    const offset = subtractVec3(vertex, basis.origin);
    return new Vector2(
      dotVec3(offset, basis.tangent),
      dotVec3(offset, basis.bitangent),
    );
  });
}

function subtractVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dotVec3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
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
