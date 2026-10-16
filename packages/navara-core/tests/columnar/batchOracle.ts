/**
 * The content oracle for a {@link CityBatch}: every object, attribute,
 * relation and surface of the model it was built from reads back from the
 * columns exactly. Shared by the unit tests and the app's Delft integration
 * test.
 */
import { expect } from "vitest";
import type { CityModel, Surface } from "../../src/citymodel/types";
import {
  rowOf,
  surfaceFromBlock,
  type CityBatch,
} from "../../src/columnar/cityBatch";
import { columnValue, dictValue, utf8Value } from "../../src/columnar/columns";

/** UVs are stored as float32, which is what the GPU draws them with. */
function withFloat32Uvs(surface: Surface): Surface {
  if (!surface.texture) return surface;
  const texture = Object.fromEntries(
    Object.entries(surface.texture).map(([theme, t]) => [
      theme,
      {
        textureIndex: t.textureIndex,
        uvs: t.uvs.map((ring) =>
          ring.map(([u, v]) => [Math.fround(u), Math.fround(v)] as const),
        ),
      },
    ]),
  );
  return { ...surface, texture };
}

export function expectBatchMatchesModel(
  batch: CityBatch,
  model: CityModel,
): void {
  const objects = Object.values(model.objects).filter((o) => o !== undefined);
  const { features } = batch;
  expect(features.length).toBe(objects.length);
  const rows = new Map<string, number>();
  objects.forEach((o, r) => rows.set(o.id, r));

  objects.forEach((o, r) => {
    expect(utf8Value(features.id, r)).toBe(o.id);
    expect(rowOf(features, o.id)).toBe(r);
    expect(dictValue(features.objectType, r)).toBe(o.objectType);
    const box = Array.from(features.bbox.subarray(r * 6, r * 6 + 6));
    if (o.bbox) expect(box).toEqual([...o.bbox]);
    else expect(box.every(Number.isNaN)).toBe(true);

    const parents = Array.from(
      features.parentRows.subarray(
        features.parentOffsets[r]!,
        features.parentOffsets[r + 1]!,
      ),
    );
    expect(parents).toEqual(o.parents.map((id) => rows.get(id) ?? -1));
    const children = Array.from(
      features.childRows.subarray(
        features.childOffsets[r]!,
        features.childOffsets[r + 1]!,
      ),
    );
    expect(children).toEqual(o.children.map((id) => rows.get(id) ?? -1));
    if (o.childrenRoles) {
      const roles = [];
      for (
        let k = features.childOffsets[r]!;
        k < features.childOffsets[r + 1]!;
        k++
      ) {
        roles.push(dictValue(features.childRoles!, k));
      }
      expect(roles).toEqual(o.childrenRoles);
    }
    if (o.address) {
      expect(columnValue(features.address!, r)).toEqual(
        JSON.parse(JSON.stringify(o.address)),
      );
    }

    for (const [name, column] of features.columns) {
      const value = o.attributes[name];
      const read = columnValue(column, r);
      if (value === undefined || value === null) expect(read).toBeNull();
      else if (typeof value === "bigint") {
        expect(read).toBe(
          Number.isSafeInteger(Number(value))
            ? Number(value)
            : value.toString(),
        );
      } else expect(read).toEqual(value);
    }
    for (const name of Object.keys(o.attributes)) {
      expect(features.columns.has(name)).toBe(true);
    }
  });

  // Every surface, found through (row, ordinal), rebuilds exactly.
  const where = new Map<string, [string | null, number]>();
  for (const [lod, block] of batch.lods) {
    expect(block.lod).toBe(lod);
    for (let s = 0; s < block.surfaceCount; s++) {
      where.set(`${block.surfaceRow[s]}:${block.surfaceOrdinal[s]}`, [lod, s]);
    }
  }
  let total = 0;
  objects.forEach((o, r) => {
    o.surfaces.forEach((surface, i) => {
      total++;
      const found = where.get(`${r}:${i}`);
      expect(found, `${o.id} surface ${i}`).toBeDefined();
      const [lod, s] = found!;
      expect(surfaceFromBlock(batch.lods.get(lod)!, s)).toEqual(
        withFloat32Uvs(surface),
      );
    });
  });
  expect(where.size).toBe(total);
}
