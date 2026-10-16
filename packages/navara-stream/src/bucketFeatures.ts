/**
 * Splits one query result into cells by bbox centre.
 *
 * This is what lets a commit cost ONE R-tree traversal instead of one per
 * cell. Ownership is post-decode because Feature exposes no bbox.
 */
import type { BBox3, CityModel, CityObject } from "@cityjson/navara-core";
import { ownerKey, type CellKey, type Grid } from "./tileGrid";

/**
 * How a model's objects are assigned to cells: `"object"` by each object's
 * own bbox centre (a building and its parts may land in different cells);
 * `"feature"` every object by the MODEL's bbox centre — the family union — so
 * a feature is always baked whole, in one cell.
 */
export type CellOwnership = "object" | "feature";

export function bucketFeatures(
  models: ReadonlyArray<CityModel>,
  grid: Grid,
  level: number,
  residentKeys: ReadonlySet<CellKey>,
  ownership: CellOwnership = "object",
): Map<CellKey, CityModel> {
  const out = new Map<
    CellKey,
    { objects: Record<string, CityObject>; meta: CityModel }
  >();

  const entryFor = (
    m: CityModel,
    bbox: BBox3,
  ): Record<string, CityObject> | null => {
    const key = ownerKey(grid, bbox, level);
    if (key === null) return null; // non-finite bbox — diagnostics
    if (residentKeys.has(key)) return null; // saves triangulation, not decode
    let entry = out.get(key);
    if (!entry) {
      entry = { objects: {}, meta: m };
      out.set(key, entry);
    }
    return entry.objects;
  };

  for (const m of models) {
    if (ownership === "feature") {
      // The whole family goes to one cell — including a geometry-less
      // parent (a Building whose geometry lives only in its parts), which
      // the inspector and the hidden-type lookup still need to see.
      if (!m.bbox) continue;
      const objects = entryFor(m, m.bbox);
      if (!objects) continue;
      for (const obj of Object.values(m.objects)) {
        if (obj) objects[obj.id] = obj;
      }
      continue;
    }
    for (const obj of Object.values(m.objects)) {
      // No bbox, no owner: an object without geometry is never filed.
      if (!obj?.bbox) continue;
      const objects = entryFor(m, obj.bbox);
      if (objects) objects[obj.id] = obj;
    }
  }

  const result = new Map<CellKey, CityModel>();
  for (const [key, { objects, meta }] of out) {
    result.set(key, {
      sourceEncoding: meta.sourceEncoding,
      metadata: meta.metadata,
      bbox: meta.bbox,
      vertexCount: 0,
      objects,
    });
  }
  return result;
}
