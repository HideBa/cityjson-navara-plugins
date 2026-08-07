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
 * The comparison is deliberately two-way and cardinality-aware, because a
 * one-way subset check is nearly vacuous here: `cityparquet ⊆ cityjson` still
 * holds if the reader drops a hole ring, truncates a ring, duplicates
 * vertices, or files a ring under the wrong semantic type. So each object is
 * checked on three axes at the shared LoDs — the surface signatures, the
 * MULTISET of per-surface ring lengths keyed by that signature, and set
 * equality of the ring vertices in BOTH directions — plus its attributes.
 *
 * One deliberate asymmetry is filtered out rather than asserted away: the
 * writer synthesizes an LoD0 footprint the CityJSON source does not have, so
 * surfaces are compared only at the LoDs BOTH models carry.
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
 * A vertex as a comparison key, quantized onto the fixture's OWN 1e-3 grid.
 *
 * CityParquet stores absolute doubles while CityJSON stores integers plus a
 * `transform`, so the two arrive by different arithmetic and must be compared
 * with slack. A `toFixed(n)` key is a rounding-BOUNDARY comparison rather than
 * a tolerance — two values a single ulp apart can round to different strings —
 * and the checks below are now two-way, which doubles the exposure. The
 * fixture's transform scales every axis by 1e-3, so every true coordinate lies
 * exactly on a 1e-3 grid and `Math.round(c * 1000)` lands on the same integer
 * from either side with ~8 orders of magnitude of headroom (the float error at
 * this magnitude is ~1e-11 m, the nearest boundary is 5e-4 m away). That makes
 * the key exact rather than merely close, which no digit-rounding key can be.
 *
 * `-0` is normalised to `0`: a ground vertex is exactly zero in the quantized
 * CityJSON and can arrive as a negative zero double from the WKB, and
 * `String(-0)` is `"0"` while `Math.round(-0) === -0` — harmless via template
 * literal, normalised anyway so the key cannot depend on that subtlety.
 */
function coordKey(v: Vec3): string {
  return v
    .map((c) => {
      const grid = Math.round(c * 1000);
      return grid === 0 ? 0 : grid;
    })
    .join(",");
}

function surfaceSignature(s: Surface): string {
  return `${s.lod}:${s.type}`;
}

/**
 * A surface as its signature plus, per ring, that ring's vertex keys SORTED.
 *
 * This is the assertion that actually pins the geometry, and each part of it
 * earns its place:
 *
 * - Keeping the rings separate (rather than pooling the surface's vertices)
 *   catches a dropped interior ring, a truncated ring and a duplicated vertex
 *   — ring lengths are implied by the key.
 * - Keying it by `lod:type` catches a ring filed under the wrong semantic
 *   type. `face_semantics` pairs with the WKB faces by INDEX, so an off-by-one
 *   there is a real, plausible bug that a viewer only shows as a colour;
 *   comparing ring *lengths* alone misses it whenever the two surfaces have
 *   the same length, which for a box-shaped building is nearly always.
 * - Sorting WITHIN a ring keeps the two legitimate freedoms the formats have:
 *   a ring may start at a different vertex and may be wound the other way. Both
 *   describe the same polygon, and neither is something this reader promises to
 *   preserve.
 */
function surfaceShape(s: Surface): string {
  const rings = s.rings
    .map((ring) => `[${ring.map(coordKey).sort().join(" ")}]`)
    .join("");
  return `${surfaceSignature(s)}:${rings}`;
}

/** The ring vertices of the given surfaces as a set of {@link coordKey}s. */
function vertexKeys(surfaces: ReadonlyArray<Surface>): Set<string> {
  return new Set(surfaces.flatMap((s) => s.rings.flat()).map(coordKey));
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

      // Attributes survive the column round-trip byte for byte on this fixture
      // — no normalisation needed. `toEqual` ignores key order (the parquet
      // yields them in footer-column order, the CityJSON in file order) and
      // ignores the prototype (the CityParquet map is null-prototype on
      // purpose; see packageAssembly's bareMap).
      expect(b.attributes, id).toEqual(a.attributes);

      // The parquet adds a synthesized LoD0 footprint the source may not have;
      // compare only the LoDs present in BOTH.
      const sharedLods = new Set(
        [...new Set(a.surfaces.map((s) => s.lod))].filter((lod) =>
          b.surfaces.some((s) => s.lod === lod),
        ),
      );
      const aShared = a.surfaces.filter((s) => sharedLods.has(s.lod));
      const bShared = b.surfaces.filter((s) => sharedLods.has(s.lod));

      expect(bShared.map(surfaceSignature).sort(), id).toEqual(
        aShared.map(surfaceSignature).sort(),
      );

      // Cardinality AND placement: the multiset of per-surface, per-ring
      // vertex sets, keyed by `lod:type`. Equality here is what a subset check
      // cannot give — a lost hole, a short ring, a duplicated vertex or a ring
      // filed under the wrong semantic type all break it.
      expect(bShared.map(surfaceShape).sort(), id).toEqual(
        aShared.map(surfaceShape).sort(),
      );
      comparedSurfaces += bShared.length;

      // Coordinate agreement, BOTH ways: the two models' ring-vertex sets at
      // the shared LoDs are the same set. One-way (`cp ⊆ cj`) would still pass
      // with geometry missing from the CityParquet side.
      const aVerts = vertexKeys(aShared);
      const bVerts = vertexKeys(bShared);
      expect([...bVerts].sort(), `${id}: cityparquet vertices`).toEqual(
        [...aVerts].sort(),
      );
      comparedVertices += bVerts.size;
    }

    expect(comparedSurfaces).toBeGreaterThan(0);
    expect(comparedVertices).toBeGreaterThan(0);
  });

  /**
   * The oracle's own tripwire: it asserts EQUALITY, so it is only as good as
   * the key it compares, and a key that collapses a real difference makes the
   * whole test above quietly decorative. Each mutation here is a decode bug
   * this reader could plausibly have — the `face_semantics` pairing is
   * index-based, the WKB ring loop is index-based — applied to a surface at a
   * SHARED LoD (a mutation at the synthesized LoD0 is invisible by design, and
   * an earlier draft of this check was fooled by exactly that).
   */
  it("would notice a decode bug: every mutation changes the compared keys", async () => {
    const cp = await assembleCityParquetModel([
      { name: "building.parquet", bytes: await readFile(PARQUET) },
    ]);
    const object = cp.objects["NL.IMBAG.Pand.0001"];
    expect(object).toBeDefined();
    if (object === undefined) return;

    const shared = object.surfaces.filter((s) => s.lod === "2.2");
    const baseline = shared.map(surfaceShape).sort();
    const at = (i: number): Surface => {
      const s = shared[i];
      if (s === undefined) throw new Error(`no surface ${i}`);
      return s;
    };
    const replace = (index: number, s: Surface): string[] =>
      shared
        .map((original, i) => (i === index ? s : original))
        .map(surfaceShape)
        .sort();

    const first = at(0);
    const firstRing = first.rings[0];
    if (firstRing === undefined) throw new Error("no ring");
    const other = shared.find((s) => s.type !== first.type);
    if (other === undefined) throw new Error("no differently-typed surface");
    const moved = firstRing[0];
    if (moved === undefined) throw new Error("empty ring");

    // A dropped ring (a lost hole), a truncated ring, and a duplicated vertex.
    expect(replace(0, { ...first, rings: first.rings.slice(1) })).not.toEqual(
      baseline,
    );
    expect(replace(0, { ...first, rings: [firstRing.slice(1)] })).not.toEqual(
      baseline,
    );
    expect(
      replace(0, { ...first, rings: [[...firstRing, moved]] }),
    ).not.toEqual(baseline);

    // A ring filed under the wrong semantic type — invisible to a ring-LENGTH
    // comparison, because both of these surfaces are quads.
    expect(replace(0, { ...first, rings: other.rings })).not.toEqual(baseline);

    // A whole surface lost.
    expect(shared.slice(1).map(surfaceShape).sort()).not.toEqual(baseline);

    // A vertex half a metre out — the projection/quantization class of bug.
    const shifted: Vec3 = [moved[0] + 0.5, moved[1], moved[2]];
    expect(
      replace(0, { ...first, rings: [[shifted, ...firstRing.slice(1)]] }),
    ).not.toEqual(baseline);
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
