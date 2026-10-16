/**
 * `CityModel` → {@link CityBatch}, in one flatten pass.
 *
 * The object graph stays the document model the app edits and inspects; the
 * batch is what the render, style and pick paths read. Row `r` of the feature
 * table is the `r`-th entry of `Object.entries(model.objects)`, which is the
 * object index `buildCityMeshArrays` assigns, so the two agree on every index.
 */
import type { CityModel, CityObject, Surface, Vec3 } from "../citymodel/types";
import {
  buildAttrColumn,
  buildDictColumn,
  buildUtf8Column,
  type AttrColumn,
  type JsonColumn,
} from "./columns";
import {
  geometryTypeCode,
  measureBatch,
  type CityBatch,
  type FeatureTable,
  type InstanceTable,
  type SurfaceGeometry,
  type TextureThemeColumns,
} from "./cityBatch";

/**
 * A pool of xyz triples with exact-equality deduplication: two ring vertices
 * share an entry only when all three doubles are bitwise the same value, so
 * every coordinate reads back exactly as it went in.
 */
class VertexPool {
  private coords = new Float64Array(3 * 1024);
  private table = new Int32Array(4096).fill(-1);
  count = 0;
  private readonly scratch = new Float64Array(3);
  private readonly words = new Uint32Array(this.scratch.buffer);

  private hash(x: number, y: number, z: number): number {
    this.scratch[0] = x;
    this.scratch[1] = y;
    this.scratch[2] = z;
    let h = 0x811c9dc5;
    for (let i = 0; i < 6; i++) h = Math.imul(h ^ this.words[i]!, 0x01000193);
    return (h ^ (h >>> 15)) >>> 0;
  }

  add(x: number, y: number, z: number): number {
    if (this.count * 2 >= this.table.length) this.rehash();
    const mask = this.table.length - 1;
    let slot = this.hash(x, y, z) & mask;
    for (;;) {
      const at = this.table[slot]!;
      if (at < 0) break;
      const c = at * 3;
      if (
        Object.is(this.coords[c], x) &&
        Object.is(this.coords[c + 1], y) &&
        Object.is(this.coords[c + 2], z)
      ) {
        return at;
      }
      slot = (slot + 1) & mask;
    }
    const index = this.count++;
    if (index * 3 + 3 > this.coords.length) {
      const grown = new Float64Array(this.coords.length * 2);
      grown.set(this.coords);
      this.coords = grown;
    }
    this.coords[index * 3] = x;
    this.coords[index * 3 + 1] = y;
    this.coords[index * 3 + 2] = z;
    this.table[slot] = index;
    return index;
  }

  private rehash(): void {
    const table = new Int32Array(this.table.length * 2).fill(-1);
    const mask = table.length - 1;
    for (let i = 0; i < this.count; i++) {
      const c = i * 3;
      let slot =
        this.hash(this.coords[c]!, this.coords[c + 1]!, this.coords[c + 2]!) &
        mask;
      while (table[slot]! >= 0) slot = (slot + 1) & mask;
      table[slot] = i;
    }
    this.table = table;
  }

  /** The pool as an owned, exactly sized array. */
  finish(): Float64Array {
    return this.coords.slice(0, this.count * 3);
  }
}

/** Accumulates one LoD's surfaces. */
class BlockBuilder {
  private readonly pool = new VertexPool();
  private readonly ringVertex: number[] = [];
  private readonly ringOffsets: number[] = [0];
  private readonly surfaceRings: number[] = [0];
  private readonly surfaceRow: number[] = [];
  private readonly surfaceOrdinal: number[] = [];
  private readonly surfaceType: number[] = [];
  private readonly names: string[] = [];
  private readonly nameIndex = new Map<string, number>();
  private readonly geometryType: number[] = [];
  private readonly semantic: number[] = [];
  private readonly semanticText: string[] = [];
  private readonly semanticIndex = new Map<string, number>();
  private readonly materialThemes = new Map<string, number[]>();
  private readonly textureThemes = new Map<
    string,
    { index: number[]; offsets: number[]; uvs: number[] }
  >();
  private rings = 0;

  constructor(readonly lod: string | null) {}

  add(surface: Surface, row: number, ordinal: number): void {
    const s = this.surfaceRow.length;
    const firstRing = this.rings;
    for (const ring of surface.rings) {
      for (const p of ring) {
        this.ringVertex.push(this.pool.add(p[0], p[1], p[2]));
      }
      this.ringOffsets.push(this.ringVertex.length);
      this.rings++;
    }
    this.surfaceRings.push(this.rings);
    this.surfaceRow.push(row);
    this.surfaceOrdinal.push(ordinal);
    let name = this.nameIndex.get(surface.type);
    if (name === undefined) {
      name = this.names.length;
      this.names.push(surface.type);
      this.nameIndex.set(surface.type, name);
    }
    this.surfaceType.push(name);
    this.geometryType.push(geometryTypeCode(surface.geometryType));
    this.semantic.push(this.internSemantic(surface.attributes));

    for (const [theme, index] of Object.entries(surface.material ?? {})) {
      this.materialColumn(theme)[s] = index;
    }
    // A theme first seen here starts with empty UV rings for every ring
    // before this surface; then every theme gets one offset per new ring.
    for (const theme of Object.keys(surface.texture ?? {})) {
      if (!this.textureThemes.has(theme)) {
        this.textureThemes.set(theme, {
          index: [],
          offsets: new Array<number>(firstRing + 1).fill(0),
          uvs: [],
        });
      }
    }
    for (const [theme, t] of this.textureThemes) {
      const texture = surface.texture?.[theme];
      if (texture) t.index[s] = texture.textureIndex;
      for (let r = 0; r < surface.rings.length; r++) {
        for (const uv of texture?.uvs[r] ?? []) t.uvs.push(uv[0], uv[1]);
        t.offsets.push(t.uvs.length / 2);
      }
    }
  }

  private internSemantic(
    attributes: Readonly<Record<string, unknown>>,
  ): number {
    if (Object.keys(attributes).length === 0) return -1;
    const text = JSON.stringify(attributes);
    let i = this.semanticIndex.get(text);
    if (i === undefined) {
      i = this.semanticText.length;
      this.semanticText.push(text);
      this.semanticIndex.set(text, i);
    }
    return i;
  }

  private materialColumn(theme: string): number[] {
    let column = this.materialThemes.get(theme);
    if (!column) {
      column = [];
      this.materialThemes.set(theme, column);
    }
    return column;
  }

  finish(): SurfaceGeometry {
    const surfaceCount = this.surfaceRow.length;
    const perSurface = (values: number[]): Int32Array => {
      const out = new Int32Array(surfaceCount).fill(-1);
      values.forEach((v, i) => {
        if (v !== undefined) out[i] = v;
      });
      return out;
    };
    const textures = new Map<string, TextureThemeColumns>();
    for (const [theme, t] of this.textureThemes) {
      textures.set(theme, {
        textureIndex: perSurface(t.index),
        uvOffsets: Uint32Array.from(t.offsets),
        uvs: Float32Array.from(t.uvs),
      });
    }
    return {
      lod: this.lod,
      surfaceCount,
      vertices: this.pool.finish(),
      ringVertex: Uint32Array.from(this.ringVertex),
      ringOffsets: Uint32Array.from(this.ringOffsets),
      surfaceRings: Uint32Array.from(this.surfaceRings),
      surfaceRow: Uint32Array.from(this.surfaceRow),
      surfaceOrdinal: Uint32Array.from(this.surfaceOrdinal),
      surfaceType: Uint16Array.from(this.surfaceType),
      semanticNames: buildUtf8Column(this.names),
      surfaceGeometryType: Uint8Array.from(this.geometryType),
      surfaceSemantic: Int32Array.from(this.semantic),
      semanticAttributes: buildUtf8Column(this.semanticText),
      materials: new Map(
        [...this.materialThemes].map(([theme, v]) => [theme, perSurface(v)]),
      ),
      textures,
    };
  }
}

/** One block per LoD, in first-seen order; template blocks use row 0. */
function blocksOf(
  surfaced: ReadonlyArray<{ readonly surfaces: ReadonlyArray<Surface> }>,
): Map<string | null, SurfaceGeometry> {
  const builders = new Map<string | null, BlockBuilder>();
  surfaced.forEach((obj, row) => {
    obj.surfaces.forEach((surface, ordinal) => {
      let builder = builders.get(surface.lod);
      if (!builder) {
        builder = new BlockBuilder(surface.lod);
        builders.set(surface.lod, builder);
      }
      builder.add(surface, row, ordinal);
    });
  });
  return new Map([...builders].map(([lod, b]) => [lod, b.finish()]));
}

/** Offsets and rows of a list-per-row relation, -1 for an id not held. */
function relation(
  objects: ReadonlyArray<CityObject>,
  list: (o: CityObject) => ReadonlyArray<string>,
  rowOfId: ReadonlyMap<string, number>,
): { offsets: Uint32Array; rows: Int32Array } {
  const offsets = new Uint32Array(objects.length + 1);
  const rows: number[] = [];
  objects.forEach((o, r) => {
    for (const id of list(o)) rows.push(rowOfId.get(id) ?? -1);
    offsets[r + 1] = rows.length;
  });
  return { offsets, rows: Int32Array.from(rows) };
}

function featureTableOf(objects: ReadonlyArray<CityObject>): FeatureTable {
  const length = objects.length;
  const rowOfId = new Map<string, number>();
  objects.forEach((o, r) => {
    if (!rowOfId.has(o.id)) rowOfId.set(o.id, r);
  });
  const parents = relation(objects, (o) => o.parents, rowOfId);
  const children = relation(objects, (o) => o.children, rowOfId);

  const parentRow = new Int32Array(length).fill(-1);
  for (let r = 0; r < length; r++) {
    for (let k = parents.offsets[r]!; k < parents.offsets[r + 1]!; k++) {
      if (parents.rows[k]! >= 0) {
        parentRow[r] = parents.rows[k]!;
        break;
      }
    }
  }
  // The root along first parents; a cycle stops at the first row seen twice.
  const featureRow = new Int32Array(length);
  for (let r = 0; r < length; r++) {
    let at = r;
    const seen = new Set<number>([r]);
    while (parentRow[at]! >= 0 && !seen.has(parentRow[at]!)) {
      at = parentRow[at]!;
      seen.add(at);
    }
    featureRow[r] = at;
  }

  const bbox = new Float64Array(length * 6).fill(Number.NaN);
  objects.forEach((o, r) => {
    if (o.bbox) bbox.set(o.bbox, r * 6);
  });

  const anyRoles = objects.some((o) => o.childrenRoles !== undefined);
  const childRoles = anyRoles
    ? buildDictColumn(
        objects.flatMap((o) =>
          o.children.map((_, i) => o.childrenRoles?.[i] ?? null),
        ),
      )
    : null;

  const anyAddress = objects.some((o) => o.address !== undefined);
  const address = anyAddress
    ? (buildAttrColumn(
        objects.map((o) => (o.address === undefined ? null : [...o.address])),
      ) as JsonColumn)
    : null;

  const names = new Set<string>();
  for (const o of objects)
    for (const k of Object.keys(o.attributes)) names.add(k);
  const columns = new Map<string, AttrColumn>();
  for (const name of names) {
    columns.set(name, buildAttrColumn(objects.map((o) => o.attributes[name])));
  }

  return {
    length,
    id: buildUtf8Column(objects.map((o) => o.id)),
    objectType: buildDictColumn(objects.map((o) => o.objectType)),
    parentRow,
    featureRow,
    parentOffsets: parents.offsets,
    parentRows: parents.rows,
    childOffsets: children.offsets,
    childRows: children.rows,
    childRoles,
    bbox,
    address,
    columns,
  };
}

function instancesOf(
  model: CityModel,
  objects: ReadonlyArray<CityObject>,
): CityBatch["instances"] {
  const templates = model.implicitTemplates;
  if (!templates || templates.size === 0) return null;
  const ids = [...templates.keys()];
  const templateIndexOf = new Map(ids.map((id, i) => [id, i]));
  const templateIndex: number[] = [];
  const featureRow: number[] = [];
  const transform: number[] = [];
  objects.forEach((o, row) => {
    const ref = o.implicitGeometry;
    if (!ref) return;
    const t = templateIndexOf.get(ref.templateId);
    if (t === undefined) return;
    const m = ref.transformationMatrix;
    const p: Vec3 = ref.referencePoint;
    const placed = Array.from({ length: 16 }, (_, i) => m[i] ?? 0);
    placed[3] = placed[3]! + p[0];
    placed[7] = placed[7]! + p[1];
    placed[11] = placed[11]! + p[2];
    templateIndex.push(t);
    featureRow.push(row);
    transform.push(...placed);
  });
  const table: InstanceTable = {
    length: templateIndex.length,
    templateIndex: Uint32Array.from(templateIndex),
    featureRow: Uint32Array.from(featureRow),
    transform: Float64Array.from(transform),
  };
  const blocks = ids.map((id) => {
    const template = templates.get(id)!;
    const built = blocksOf([template]);
    return (
      built.get(template.lod) ??
      built.values().next().value ??
      new BlockBuilder(template.lod).finish()
    );
  });
  return { templateIds: Int32Array.from(ids), templates: blocks, table };
}

export function cityBatchFromModel(model: CityModel): CityBatch {
  const objects = Object.values(model.objects).filter(
    (o): o is CityObject => o !== undefined,
  );
  const partial = {
    features: featureTableOf(objects),
    lods: blocksOf(objects),
    instances: instancesOf(model, objects),
  };
  return { ...partial, byteLength: measureBatch(partial) };
}
