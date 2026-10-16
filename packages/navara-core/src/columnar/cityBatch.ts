/**
 * A batch of city objects as columns: one {@link FeatureTable} row per
 * CityObject and one {@link SurfaceGeometry} block per LoD, keeping CityJSON's
 * shared vertex pool. This is what CityJSON, FlatCityBuf and CityParquet
 * already store, so a reader fills it with little conversion, and what the
 * render, style and pick paths read instead of the object graph.
 *
 * Plain data on purpose: no methods and no closures, so a batch crosses
 * `postMessage` by structured clone with {@link batchTransferables} as the
 * transfer list, and its {@link CityBatch.byteLength} is a measurement rather
 * than a guess. Helpers that need an index ({@link rowOf}) build it once per
 * table and cache it beside the data.
 */
import type {
  BuildingSurfaceType,
  Surface,
  SurfaceTexture,
  UV,
  Vec3,
} from "../citymodel/types";
import type { CityJSONGeometryType } from "../citymodel/cityjson/types";
import {
  columnBuffers,
  utf8Value,
  utf8Values,
  type AttrColumn,
  type DictColumn,
  type JsonColumn,
  type Utf8Column,
} from "./columns";

/** One row per CityObject. Row order is the source's object order, which is
 *  also the object index every mesh and pick path uses. */
export interface FeatureTable {
  readonly length: number;
  readonly id: Utf8Column;
  readonly objectType: DictColumn;
  /** The first parent the batch holds, or -1 for a root. */
  readonly parentRow: Int32Array;
  /** The row of the object's root — its feature, i.e. CityParquet's
   *  `feature_id`. A root is its own feature. */
  readonly featureRow: Int32Array;
  /** Every listed parent, in order: rows `parentOffsets[r] ..
   *  parentOffsets[r + 1]` of {@link parentRows}, -1 for a parent the batch
   *  does not hold. */
  readonly parentOffsets: Uint32Array;
  readonly parentRows: Int32Array;
  /** Every listed child, in order, like the parents; -1 for one not held. */
  readonly childOffsets: Uint32Array;
  readonly childRows: Int32Array;
  /** One role per entry of {@link childRows}; `null` when no object names
   *  roles. */
  readonly childRoles: DictColumn | null;
  /** 6 per row (min x, y, z, max x, y, z); NaN for an object with no box. */
  readonly bbox: Float64Array;
  /** The object's addresses as JSON; `null` when no object carries one. */
  readonly address: JsonColumn | null;
  /** The source attributes, one column per name. */
  readonly columns: ReadonlyMap<string, AttrColumn>;
}

/** A texture theme of one block: per surface the image, per ring its UVs. */
export interface TextureThemeColumns {
  /** Per surface, an index into the layer's textures, or -1. */
  readonly textureIndex: Int32Array;
  /** `rings + 1` offsets into {@link uvs} in UV PAIRS; a ring of an
   *  untextured surface has none. */
  readonly uvOffsets: Uint32Array;
  /** Two per UV, paired with the ring's vertices in order. */
  readonly uvs: Float32Array;
}

/** The surfaces of one LoD, every vertex pooled once. */
export interface SurfaceGeometry {
  readonly lod: string | null;
  readonly surfaceCount: number;
  /** The shared pool, xyz, in the source's coordinates. */
  readonly vertices: Float64Array;
  /** Per ring vertex, its index in the pool. */
  readonly ringVertex: Uint32Array;
  /** `rings + 1` offsets into {@link ringVertex}. */
  readonly ringOffsets: Uint32Array;
  /** `surfaces + 1` offsets into the rings; a surface's first ring is its
   *  exterior. */
  readonly surfaceRings: Uint32Array;
  /** Per surface, its object's row in the {@link FeatureTable}. */
  readonly surfaceRow: Uint32Array;
  /** Per surface, its index in the object's own surface list. */
  readonly surfaceOrdinal: Uint32Array;
  /** Per surface, an index into {@link semanticNames}. */
  readonly surfaceType: Uint16Array;
  readonly semanticNames: Utf8Column;
  /** Per surface, {@link geometryTypeCode} of the geometry it came from. */
  readonly surfaceGeometryType: Uint8Array;
  /** Per surface, an index into {@link semanticAttributes}, or -1 for none. */
  readonly surfaceSemantic: Int32Array;
  /** Each distinct set of extra semantic attributes, as JSON. */
  readonly semanticAttributes: Utf8Column;
  /** Material theme → per surface an index into the materials, or -1. */
  readonly materials: ReadonlyMap<string, Int32Array>;
  readonly textures: ReadonlyMap<string, TextureThemeColumns>;
}

/** Implicit geometry: one row per placement of a template. */
export interface InstanceTable {
  readonly length: number;
  /** Index into {@link CityBatch.instances}' templates. */
  readonly templateIndex: Uint32Array;
  /** The placing object's row. */
  readonly featureRow: Uint32Array;
  /** 16 per row: the row-major 4×4 matrix with the reference point added to
   *  its translation, so a template vertex `v` sits at `T · (v, 1)`. */
  readonly transform: Float64Array;
}

export interface CityBatch {
  readonly features: FeatureTable;
  readonly lods: ReadonlyMap<string | null, SurfaceGeometry>;
  readonly instances: {
    /** The source's template ids, one per template. */
    readonly templateIds: Int32Array;
    readonly templates: ReadonlyArray<SurfaceGeometry>;
    readonly table: InstanceTable;
  } | null;
  /** Exact: the sum of every buffer {@link batchTransferables} returns. */
  readonly byteLength: number;
}

/** Geometry types by {@link SurfaceGeometry.surfaceGeometryType}: 0 means the
 *  surface carries no type, 1 that it carries an explicit `null`. */
export const GEOMETRY_TYPE_NAMES: ReadonlyArray<CityJSONGeometryType> = [
  "MultiPoint",
  "MultiLineString",
  "MultiSurface",
  "CompositeSurface",
  "Solid",
  "MultiSolid",
  "CompositeSolid",
  "GeometryInstance",
];
const GEOMETRY_TYPE_OFFSET = 2;

export function geometryTypeCode(
  type: CityJSONGeometryType | null | undefined,
): number {
  if (type === undefined) return 0;
  if (type === null) return 1;
  const i = GEOMETRY_TYPE_NAMES.indexOf(type);
  return i < 0 ? 0 : i + GEOMETRY_TYPE_OFFSET;
}

export function geometryTypeOfCode(
  code: number,
): CityJSONGeometryType | null | undefined {
  if (code === 0) return undefined;
  if (code === 1) return null;
  return GEOMETRY_TYPE_NAMES[code - GEOMETRY_TYPE_OFFSET];
}

const rowIndexes = new WeakMap<FeatureTable, Map<string, number>>();

/** The row holding `id`, or -1. The index is built on first use. */
export function rowOf(table: FeatureTable, id: string): number {
  let index = rowIndexes.get(table);
  if (!index) {
    index = new Map();
    const ids = utf8Values(table.id);
    for (let r = 0; r < table.length; r++) {
      const v = ids[r];
      if (v !== null && v !== undefined && !index.has(v)) index.set(v, r);
    }
    rowIndexes.set(table, index);
  }
  return index.get(id) ?? -1;
}

export function featureTableBuffers(t: FeatureTable): ArrayBufferView[] {
  return [
    ...columnBuffers(t.id),
    ...columnBuffers(t.objectType),
    t.parentRow,
    t.featureRow,
    t.parentOffsets,
    t.parentRows,
    t.childOffsets,
    t.childRows,
    ...(t.childRoles ? columnBuffers(t.childRoles) : []),
    t.bbox,
    ...(t.address ? columnBuffers(t.address) : []),
    ...[...t.columns.values()].flatMap(columnBuffers),
  ];
}

export function surfaceGeometryBuffers(g: SurfaceGeometry): ArrayBufferView[] {
  return [
    g.vertices,
    g.ringVertex,
    g.ringOffsets,
    g.surfaceRings,
    g.surfaceRow,
    g.surfaceOrdinal,
    g.surfaceType,
    ...columnBuffers(g.semanticNames),
    g.surfaceGeometryType,
    g.surfaceSemantic,
    ...columnBuffers(g.semanticAttributes),
    ...g.materials.values(),
    ...[...g.textures.values()].flatMap((t) => [
      t.textureIndex,
      t.uvOffsets,
      t.uvs,
    ]),
  ];
}

function batchViews(batch: Omit<CityBatch, "byteLength">): ArrayBufferView[] {
  return [
    ...featureTableBuffers(batch.features),
    ...[...batch.lods.values()].flatMap(surfaceGeometryBuffers),
    ...(batch.instances
      ? [
          batch.instances.templateIds,
          ...batch.instances.templates.flatMap(surfaceGeometryBuffers),
          batch.instances.table.templateIndex,
          batch.instances.table.featureRow,
          batch.instances.table.transform,
        ]
      : []),
  ];
}

/** The exact byte size of a batch's buffers. */
export function measureBatch(batch: Omit<CityBatch, "byteLength">): number {
  let n = 0;
  for (const v of batchViews(batch)) n += v.byteLength;
  return n;
}

/**
 * Every buffer the batch owns, each once: the transfer list for
 * `postMessage`. Each view must own its whole buffer, which every builder in
 * this module guarantees; a subarray of a shared buffer would transfer, and
 * detach, its neighbours.
 */
export function batchTransferables(batch: CityBatch): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  for (const v of batchViews(batch)) seen.add(v.buffer as ArrayBuffer);
  return [...seen];
}

/** The rings of surface `s` of `block`, as coordinate tuples. */
export function surfaceRingsOf(block: SurfaceGeometry, s: number): Vec3[][] {
  const rings: Vec3[][] = [];
  const v = block.vertices;
  for (let r = block.surfaceRings[s]!; r < block.surfaceRings[s + 1]!; r++) {
    const ring: Vec3[] = [];
    for (let k = block.ringOffsets[r]!; k < block.ringOffsets[r + 1]!; k++) {
      const p = block.ringVertex[k]! * 3;
      ring.push([v[p]!, v[p + 1]!, v[p + 2]!]);
    }
    rings.push(ring);
  }
  return rings;
}

/** Surface `s` of `block` as the object graph's {@link Surface}, for the
 *  inspector and for code that has not moved to columns. */
export function surfaceFromBlock(block: SurfaceGeometry, s: number): Surface {
  const names = utf8Values(block.semanticNames);
  const semantic = block.surfaceSemantic[s]!;
  const attributes =
    semantic < 0
      ? {}
      : (JSON.parse(utf8Value(block.semanticAttributes, semantic)!) as Record<
          string,
          unknown
        >);
  const geometryType = geometryTypeOfCode(block.surfaceGeometryType[s]!);
  const material: Record<string, number> = {};
  for (const [theme, values] of block.materials) {
    if (values[s]! >= 0) material[theme] = values[s]!;
  }
  const texture: Record<string, SurfaceTexture> = {};
  for (const [theme, t] of block.textures) {
    const textureIndex = t.textureIndex[s]!;
    if (textureIndex < 0) continue;
    const uvs: UV[][] = [];
    for (let r = block.surfaceRings[s]!; r < block.surfaceRings[s + 1]!; r++) {
      const ring: UV[] = [];
      for (let k = t.uvOffsets[r]!; k < t.uvOffsets[r + 1]!; k++) {
        ring.push([t.uvs[k * 2]!, t.uvs[k * 2 + 1]!]);
      }
      uvs.push(ring);
    }
    texture[theme] = { textureIndex, uvs };
  }
  return {
    type: names[block.surfaceType[s]!] as BuildingSurfaceType,
    rings: surfaceRingsOf(block, s),
    attributes,
    lod: block.lod,
    ...(geometryType !== undefined ? { geometryType } : {}),
    ...(Object.keys(material).length > 0 ? { material } : {}),
    ...(Object.keys(texture).length > 0 ? { texture } : {}),
  };
}
