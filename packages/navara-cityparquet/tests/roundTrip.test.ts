/**
 * The correctness oracle for the whole CityParquet read path.
 *
 * The fixture package was written from `two-buildings.city.json`, so parsing
 * both and comparing the two `CityModel`s answers the only question that
 * matters: does a dataset look the same opened as CityParquet as it does
 * opened as CityJSON? Every earlier test in this package pins one layer in
 * isolation (footer, WKB, row decode); this one is the end-to-end check that
 * they compose into the same city.
 *
 * Two deliberate asymmetries are filtered out rather than asserted away:
 *
 * - The writer synthesizes an LoD0 footprint the CityJSON source does not
 *   have, so surfaces are compared only at the LoDs BOTH models carry.
 * - CityParquet stores absolute doubles while CityJSON stores quantized
 *   integers, so coordinates are compared at 1e-5 (the fixture's scale is
 *   1e-3, an order of magnitude coarser).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CityJSONRoot, Surface, Vec3 } from "@cityjson/navara-core";
import { parseCityJSON } from "@cityjson/navara-core";
import { readCityParquetTable } from "../src/tableReader";
import { assembleCityParquetModel } from "../src/packageAssembly";

const PARQUET = fileURLToPath(
  new URL(
    "./fixtures/two-buildings-cityparquet/building.parquet",
    import.meta.url,
  ),
);
/** Committed copy — no absolute parent-repo paths in the standalone submodule. */
const SOURCE = fileURLToPath(
  new URL("./fixtures/two-buildings.city.json", import.meta.url),
);

/**
 * A coordinate as a comparison key at 1e-5.
 *
 * `-0` is normalised to `0`: a ground vertex is exactly zero in the quantized
 * CityJSON and can arrive as a negative zero double from the WKB, and
 * `(-0).toFixed(5)` is `"-0.00000"` — a spurious mismatch on the one value the
 * fixture is most likely to carry.
 */
function coordKey(v: Vec3): string {
  return v.map((c) => (c === 0 ? 0 : c).toFixed(5)).join(",");
}

function surfaceSignature(s: Surface): string {
  return `${s.lod}:${s.type}`;
}

describe("cityparquet round-trip vs the CityJSON parser", () => {
  it("agrees on objects, hierarchy, surfaces and coordinates", async () => {
    const root = JSON.parse(await readFile(SOURCE, "utf8")) as CityJSONRoot;
    const cj = parseCityJSON(root);
    const cp = await assembleCityParquetModel([
      { name: "building.parquet", bytes: await readFile(PARQUET) },
    ]);

    expect(Object.keys(cp.objects).sort()).toEqual(
      Object.keys(cj.objects).sort(),
    );

    // Guards the shared-LoD filter below from passing vacuously: if it ever
    // intersected to nothing, every comparison would be `[] === []`.
    let comparedSurfaces = 0;
    let comparedVertices = 0;

    for (const [id, a] of Object.entries(cj.objects)) {
      const b = cp.objects[id];
      expect(b, `cityparquet object '${id}'`).toBeDefined();
      if (b === undefined) continue;

      expect(b.objectType, id).toBe(a.objectType);
      expect([...b.parents].sort(), id).toEqual([...a.parents].sort());
      expect([...b.children].sort(), id).toEqual([...a.children].sort());

      // The parquet adds a synthesized LoD0 footprint the source may not have;
      // compare only the LoDs present in BOTH.
      const sharedLods = new Set(
        [...new Set(a.surfaces.map((s) => s.lod))].filter((lod) =>
          b.surfaces.some((s) => s.lod === lod),
        ),
      );
      const aS = a.surfaces
        .filter((s) => sharedLods.has(s.lod))
        .map(surfaceSignature)
        .sort();
      const bS = b.surfaces
        .filter((s) => sharedLods.has(s.lod))
        .map(surfaceSignature)
        .sort();
      expect(bS, id).toEqual(aS);
      comparedSurfaces += bS.length;

      // Coordinate agreement: every cityparquet ring vertex exists in the
      // cityjson surfaces of the same object (±1e-5).
      const cjVerts = new Set(
        a.surfaces.flatMap((s) => s.rings.flat()).map(coordKey),
      );
      for (const s of b.surfaces.filter((s) => sharedLods.has(s.lod))) {
        for (const v of s.rings.flat()) {
          expect(cjVerts.has(coordKey(v)), `${id} vertex ${coordKey(v)}`).toBe(
            true,
          );
          comparedVertices += 1;
        }
      }
    }

    expect(comparedSurfaces).toBeGreaterThan(0);
    expect(comparedVertices).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scale check — skipped unless the (uncommitted, 2.4 MB) Delft table is present
// ---------------------------------------------------------------------------

const DELFT =
  "/data2/hideba/cityparquet-paper/benchmarking/data/cityparquet/delft/building.parquet";

describe("cityparquet at city scale", () => {
  it.skipIf(!existsSync(DELFT))(
    "decodes the Delft 3D BAG table",
    async () => {
      const bytes = await readFile(DELFT);
      const table = await readCityParquetTable(bytes);
      expect(table.rows.length).toBe(2231);
      expect(table.footer.epsg).toBe(7415);
      const lods = [...new Set(table.geometryColumns.map((c) => c.lod))];
      expect(lods.sort()).toEqual(["0", "1.2", "1.3", "2.2"]);

      const model = await assembleCityParquetModel([
        { name: "building.parquet", bytes },
      ]);
      expect(Object.keys(model.objects).length).toBe(2231);

      // Every row yields a drawable object, because the writer synthesizes an
      // LoD0 footprint for all of them.
      const withSurfaces = Object.values(model.objects).filter(
        (o) => o.surfaces.length > 0,
      );
      expect(withSurfaces.length).toBe(2231);

      // ...but the solid geometry is on the PARTS: this 3D BAG extract splits
      // into 1115 attribute-carrying `Building`s (LoD0 footprint only) and 1116
      // `BuildingPart`s (LoD 1.2/1.3/2.2), which is exactly the split the
      // attribute-inheritance display exists for. So "a roof at LoD 2.2" tops
      // out at the part count, not the row count.
      const withRoofAtLod22 = Object.values(model.objects).filter((o) =>
        o.surfaces.some((s) => s.lod === "2.2" && s.type === "RoofSurface"),
      );
      expect(withRoofAtLod22.length).toBeGreaterThan(1000);
      expect(
        withRoofAtLod22.every((o) => o.objectType === "BuildingPart"),
      ).toBe(true);
      expect(model.metadata.referenceSystem).toBe(
        "https://www.opengis.net/def/crs/EPSG/0/7415",
      );
      expect(model.bbox).not.toBeNull();
    },
    60_000,
  );
});
