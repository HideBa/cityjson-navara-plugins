/**
 * The multi-row-group fixture is still a CityParquet file this package decodes:
 * 20 translated copies of `two-buildings`, rewritten by `make_fixture.py` with
 * pyarrow. A fixture the reader cannot open would make every range-read test
 * built on it vacuous, so the decode is pinned against the source it came from.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeTableObjects } from "../src/decodeTable";
import { readCityParquetTable } from "../src/tableReader";

const fixture = (dir: string) =>
  fileURLToPath(new URL(`./fixtures/${dir}/building.parquet`, import.meta.url));

const COPIES = 20;
const STEP_M = 50;

describe("multigroup-cityparquet fixture", () => {
  it("decodes to 20 copies of the source objects, copy k translated k*50 m east", async () => {
    const source = decodeTableObjects(
      await readCityParquetTable(
        await readFile(fixture("two-buildings-cityparquet")),
      ),
    );
    const table = await readCityParquetTable(
      await readFile(fixture("multigroup-cityparquet")),
    );
    expect(table.footer.epsg).toBe(7415);
    const objects = decodeTableObjects(table);

    const sourceIds = Object.keys(source);
    expect(Object.keys(objects)).toHaveLength(COPIES * sourceIds.length);

    for (let k = 0; k < COPIES; k++) {
      for (const id of sourceIds) {
        const src = source[id]!;
        const copy = objects[`${id}_${k}`];
        expect(copy, `${id}_${k}`).toBeDefined();
        expect(copy!.objectType).toBe(src.objectType);
        expect(copy!.parents).toEqual(src.parents.map((p) => `${p}_${k}`));
        expect(copy!.children).toEqual(src.children.map((c) => `${c}_${k}`));
        expect(copy!.surfaces).toHaveLength(src.surfaces.length);
        const dx = k * STEP_M;
        for (let s = 0; s < src.surfaces.length; s++) {
          const want = src.surfaces[s]!.rings.map((ring) =>
            ring.map(([x, y, z]) => [x + dx, y, z]),
          );
          expect(copy!.surfaces[s]!.rings).toEqual(want);
        }
        const [x0, y0, z0, x1, y1, z1] = src.bbox!;
        expect(copy!.bbox).toEqual([x0 + dx, y0, z0, x1 + dx, y1, z1]);
      }
    }
  });
});
