/**
 * Shared parsing helpers for CityJSON-family formats.
 *
 * Both CityJSON and CityJSONSeq (CityJSON Text Sequences) use the same
 * object and geometry schema. This module provides the low-level
 * primitives — dequantization, surface extraction, bbox computation,
 * and per-object parsing — so each format parser can compose them.
 */

import type {
  BBox3,
  BuildingSurfaceType,
  CityModelMetadata,
  CityObject,
  Surface,
  SurfaceTexture,
  Vec3,
} from "../types";
import {
  EMPTY_APPEARANCE_CONTEXT,
  resolveSurfaceMaterial,
  resolveSurfaceTexture,
  type AppearanceContext,
  type SurfacePath,
} from "./appearance";
import type {
  CityJSONObject,
  CityJSONRoot,
  CityJSONSemanticSurface,
  CityJSONSurfaceGeometry,
  CityJSONTransform,
  CityJSONVertex,
} from "./types";

// ---------------------------------------------------------------------------
// Vertex dequantization
// ---------------------------------------------------------------------------

function dequantizeVertex(
  v: CityJSONVertex,
  transform: CityJSONTransform,
): Vec3 {
  return [
    v[0] * transform.scale[0] + transform.translate[0],
    v[1] * transform.scale[1] + transform.translate[1],
    v[2] * transform.scale[2] + transform.translate[2],
  ];
}

/**
 * The transform to use when a file declares none.
 *
 * CityJSON made `transform` mandatory only in v1.1: a v1.0 file may omit it
 * entirely, in which case its vertices are already real (floating point)
 * coordinates. Scaling by 1 and translating by 0 is exactly that case, so the
 * quantized and unquantized paths share one code path instead of branching.
 */
export const IDENTITY_TRANSFORM: CityJSONTransform = {
  scale: [1, 1, 1],
  translate: [0, 0, 0],
};

export function dequantizeAll(
  vertices: ReadonlyArray<CityJSONVertex>,
  transform: CityJSONTransform,
): Vec3[] {
  return vertices.map((v) => dequantizeVertex(v, transform));
}

// ---------------------------------------------------------------------------
// Bounding box helpers
// ---------------------------------------------------------------------------

function expandBBox(bbox: MutableBBox, v: Vec3): void {
  if (v[0] < bbox[0]) bbox[0] = v[0];
  if (v[1] < bbox[1]) bbox[1] = v[1];
  if (v[2] < bbox[2]) bbox[2] = v[2];
  if (v[0] > bbox[3]) bbox[3] = v[0];
  if (v[1] > bbox[4]) bbox[4] = v[1];
  if (v[2] > bbox[5]) bbox[5] = v[2];
}

export function mergeBBox(a: BBox3 | null, b: BBox3 | null): BBox3 | null {
  if (a === null) return b;
  if (b === null) return a;
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.max(a[3], b[3]),
    Math.max(a[4], b[4]),
    Math.max(a[5], b[5]),
  ];
}

// ---------------------------------------------------------------------------
// Semantic type resolution
// ---------------------------------------------------------------------------

const KNOWN_BUILDING_SURFACE_TYPES = new Set<string>([
  "RoofSurface",
  "WallSurface",
  "GroundSurface",
  "ClosureSurface",
  "OuterCeilingSurface",
  "OuterFloorSurface",
  "Window",
  "Door",
]);

function resolveSemanticType(
  sem: CityJSONSemanticSurface | undefined,
): BuildingSurfaceType {
  if (!sem) return "unknown";
  if (KNOWN_BUILDING_SURFACE_TYPES.has(sem.type)) {
    return sem.type as BuildingSurfaceType;
  }
  return "unknown";
}

function extractSemanticAttributes(
  sem: CityJSONSemanticSurface | undefined,
): Record<string, unknown> {
  if (!sem) return {};
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sem)) {
    if (key !== "type" && key !== "parent" && key !== "children") {
      attrs[key] = value;
    }
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Surface extraction
// ---------------------------------------------------------------------------

type MutableBBox = [number, number, number, number, number, number];

/** A surface's boundary: rings of vertex indices. */
type RawSurface = ReadonlyArray<ReadonlyArray<number>>;

/**
 * Resolve one surface: its rings to real coordinates, its semantic, and —
 * when the geometry carries appearance members — its per-theme material and
 * texture. Shared by every boundary depth (MultiSurface, Solid, MultiSolid);
 * `path` is where this surface sits in the geometry's nesting, which is also
 * where its material/texture entries sit.
 *
 * A vertex index the file never declared is skipped (the ring is shorter,
 * the polygon still triangulates); the texture resolver skips the same
 * vertex so UVs stay paired.
 */
function buildSurface(
  geom: CityJSONSurfaceGeometry,
  rawSurface: RawSurface,
  sem: CityJSONSemanticSurface | undefined,
  path: SurfacePath,
  realVertices: Vec3[],
  objectBBox: MutableBBox,
  lod: string | null,
  ctx: AppearanceContext,
): Surface {
  const rings: Vec3[][] = [];
  for (const ring of rawSurface) {
    const realRing: Vec3[] = [];
    for (const idx of ring) {
      const v = realVertices[idx];
      if (v) {
        realRing.push(v);
        expandBBox(objectBBox, v);
      }
    }
    rings.push(realRing);
  }

  const surface: {
    type: BuildingSurfaceType;
    rings: Vec3[][];
    attributes: Record<string, unknown>;
    lod: string | null;
    material?: Readonly<Record<string, number>>;
    texture?: Readonly<Record<string, SurfaceTexture>>;
  } = {
    type: resolveSemanticType(sem),
    rings,
    attributes: extractSemanticAttributes(sem),
    lod,
  };

  if (geom.material !== undefined) {
    const material = resolveSurfaceMaterial(geom.material, path, ctx);
    if (material) surface.material = material;
  }
  if (geom.texture !== undefined) {
    const texture = resolveSurfaceTexture(
      geom.texture,
      path,
      rawSurface,
      rings,
      realVertices,
      ctx,
    );
    if (texture) surface.texture = texture;
  }
  return surface;
}

function semanticAt(
  geom: CityJSONSurfaceGeometry,
  path: SurfacePath,
): CityJSONSemanticSurface | undefined {
  const surfacesList = geom.semantics?.surfaces;
  if (!surfacesList) return undefined;
  let node: unknown = geom.semantics?.values;
  for (const p of path.outer) {
    if (!Array.isArray(node)) return undefined;
    node = node[p];
  }
  if (!Array.isArray(node)) return undefined;
  const index = node[path.surfaceIndex];
  return typeof index === "number" ? surfacesList[index] : undefined;
}

/**
 * Walk a geometry's boundaries at its declared depth: MultiSurface /
 * CompositeSurface = surfaces, Solid = shells of surfaces, MultiSolid /
 * CompositeSolid = solids of shells of surfaces. The output order is the
 * file's order, flattened.
 */
function extractSurfaces(
  geom: CityJSONSurfaceGeometry,
  realVertices: Vec3[],
  objectBBox: MutableBBox,
  lod: string | null,
  ctx: AppearanceContext,
): Surface[] {
  const surfaces: Surface[] = [];
  const visit = (rawSurface: unknown, path: SurfacePath): void => {
    if (!Array.isArray(rawSurface)) return;
    surfaces.push(
      buildSurface(
        geom,
        rawSurface as RawSurface,
        semanticAt(geom, path),
        path,
        realVertices,
        objectBBox,
        lod,
        ctx,
      ),
    );
  };
  const boundaries = geom.boundaries;

  switch (geom.type) {
    case "MultiSurface":
    case "CompositeSurface":
      boundaries.forEach((surface, i) =>
        visit(surface, { outer: [], surfaceIndex: i }),
      );
      break;
    case "Solid":
      boundaries.forEach((shell, si) => {
        if (!Array.isArray(shell)) return;
        shell.forEach((surface, fi) =>
          visit(surface, { outer: [si], surfaceIndex: fi }),
        );
      });
      break;
    case "MultiSolid":
    case "CompositeSolid":
      boundaries.forEach((solid, soi) => {
        if (!Array.isArray(solid)) return;
        solid.forEach((shell, si) => {
          if (!Array.isArray(shell)) return;
          shell.forEach((surface, fi) =>
            visit(surface, { outer: [soi, si], surfaceIndex: fi }),
          );
        });
      });
      break;
    default:
      break;
  }
  return surfaces;
}

// ---------------------------------------------------------------------------
// Object parsing
// ---------------------------------------------------------------------------

/**
 * `ctx` resolves the object's material/texture members against the unit's
 * appearance tables (see `AppearanceMerger.register`); omitted, appearance
 * members are ignored and surfaces come out exactly as before.
 */
export function parseCityObject(
  id: string,
  raw: CityJSONObject,
  realVertices: Vec3[],
  ctx: AppearanceContext = EMPTY_APPEARANCE_CONTEXT,
): CityObject {
  const allSurfaces: Surface[] = [];
  const objectBBox: MutableBBox = [
    Infinity,
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
    -Infinity,
  ];
  let lod: string | null = null;

  for (const geom of raw.geometry ?? []) {
    if (geom.type === "GeometryInstance") continue;
    // Normalised to STRING here, at the boundary: v1.0 wrote `"lod": 2` (a
    // number), and passing it through as one makes the first render work —
    // `2 !== 2` keeps every surface — while the first LoD-dropdown pick
    // compares `2 !== "2"` and silently blanks the layer.
    const geomLod = geom.lod === undefined ? null : String(geom.lod);
    // Track highest LoD for display purposes
    if (
      geomLod !== null &&
      (lod === null || parseFloat(geomLod) > parseFloat(lod))
    ) {
      lod = geomLod;
    }
    const surfaces = extractSurfaces(
      geom,
      realVertices,
      objectBBox,
      geomLod,
      ctx,
    );
    allSurfaces.push(...surfaces);
  }

  const hasBBox = objectBBox[0] !== Infinity;

  return {
    id,
    objectType: raw.type,
    attributes: raw.attributes ?? {},
    surfaces: allSurfaces,
    bbox: hasBBox
      ? [
          objectBBox[0],
          objectBBox[1],
          objectBBox[2],
          objectBBox[3],
          objectBBox[4],
          objectBBox[5],
        ]
      : null,
    children: raw.children ? [...raw.children] : [],
    parents: raw.parents ? [...raw.parents] : [],
    lod,
  };
}

// ---------------------------------------------------------------------------
// Metadata mapping
// ---------------------------------------------------------------------------

export function mapMetadata(raw: CityJSONRoot["metadata"]): CityModelMetadata {
  if (!raw) return {};
  return {
    title: raw.title,
    identifier: raw.identifier,
    referenceDate: raw.referenceDate,
    referenceSystem: raw.referenceSystem,
  };
}
