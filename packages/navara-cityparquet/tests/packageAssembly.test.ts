/**
 * The manifest reader and the package assembler.
 *
 * The manifest cases pin the two ways a package can declare its object tables
 * — by STAC role, and by media type when a foreign writer omitted the roles —
 * and the assembly cases pin what a multi-file package becomes: one CityModel,
 * one CRS, one object map.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CITYPARQUET_SIDECAR_NAMES,
  assembleCityParquetModel,
  parseCityParquetManifest,
} from "../src/packageAssembly";

const DIR = new URL("./fixtures/two-buildings-cityparquet/", import.meta.url);

function fixtureBytes(name: string, dir: URL = DIR): Promise<Buffer> {
  return readFile(fileURLToPath(new URL(name, dir)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseCityParquetManifest", () => {
  it("reads object tables from the fixture STAC Item by role", async () => {
    const meta: unknown = JSON.parse(
      await readFile(fileURLToPath(new URL("metadata.json", DIR)), "utf8"),
    );
    expect(parseCityParquetManifest(meta).objectTables).toEqual([
      "building.parquet",
    ]);
  });

  it("falls back to parquet assets minus sidecars when roles are absent", () => {
    const item = {
      type: "Feature",
      assets: {
        a: {
          href: "./building.parquet",
          type: "application/vnd.apache.parquet",
        },
        b: {
          href: "./materials.parquet",
          type: "application/vnd.apache.parquet",
        },
      },
    };
    expect(parseCityParquetManifest(item).objectTables).toEqual([
      "building.parquet",
    ]);
  });

  it("dedupes an href a writer listed under two asset keys", () => {
    const item = {
      type: "Feature",
      assets: {
        data: { href: "./building.parquet", roles: ["data"] },
        "building.parquet": {
          href: "./building.parquet",
          roles: ["data", "cityparquet-objects"],
        },
        second: {
          href: "./bridge.parquet",
          roles: ["data", "cityparquet-objects"],
        },
      },
    };
    expect(parseCityParquetManifest(item).objectTables).toEqual([
      "building.parquet",
      "bridge.parquet",
    ]);
  });

  it("excludes role-tagged sidecars even when they are parquet", () => {
    const item = {
      type: "Feature",
      assets: {
        a: { href: "./building.parquet", roles: ["cityparquet-objects"] },
        b: { href: "./appearance.parquet", roles: ["cityparquet-sidecar"] },
      },
    };
    expect(parseCityParquetManifest(item).objectTables).toEqual([
      "building.parquet",
    ]);
  });

  it("keeps each object table's file:size, keyed by its normalised href", async () => {
    const meta: unknown = JSON.parse(
      await readFile(
        fileURLToPath(
          new URL(
            "./fixtures/multigroup-cityparquet/metadata.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    );
    expect(parseCityParquetManifest(meta).sizes).toEqual({
      "building.parquet": 252640,
    });
    const item = {
      type: "Feature",
      assets: {
        a: {
          href: "./a/building.parquet",
          roles: ["cityparquet-objects"],
          "file:size": 610,
        },
        // Unusable sizes are left out, never guessed.
        b: {
          href: "./b/building.parquet",
          roles: ["cityparquet-objects"],
          "file:size": -1,
        },
        c: {
          href: "./c/building.parquet",
          roles: ["cityparquet-objects"],
          "file:size": "12",
        },
        d: { href: "./d/building.parquet", roles: ["cityparquet-objects"] },
        // A sidecar's size is not an object table's.
        t: {
          href: "./textures.parquet",
          roles: ["cityparquet-sidecar"],
          "file:size": 99,
        },
      },
    };
    expect(parseCityParquetManifest(item).sizes).toEqual({
      "a/building.parquet": 610,
    });
  });

  it("names one family per object table, in manifest order, keyed by its asset", async () => {
    const meta: unknown = JSON.parse(
      await readFile(fileURLToPath(new URL("metadata.json", DIR)), "utf8"),
    );
    const parsed = parseCityParquetManifest(meta);
    // The reference writer keys each table by its own FILE NAME (and lists it
    // again under a generic `data` key): the family key is that name without
    // the extension, so a PLATEAU package reads as `building`, `bridge`, …
    expect(parsed.families).toEqual([
      { key: "building", href: "building.parquet", size: 22930 },
    ]);
    // One family per object table, in the same order: the app pairs them up.
    expect(parsed.families.map((f) => f.href)).toEqual(parsed.objectTables);
  });

  it("prefers a descriptive asset key over the file name, and skips a generic one", () => {
    const item = {
      type: "Feature",
      assets: {
        roofs: {
          href: "./part-a.parquet",
          roles: ["cityparquet-objects"],
          "file:size": 7,
        },
        data: { href: "./bridge.parquet", roles: ["cityparquet-objects"] },
      },
    };
    expect(parseCityParquetManifest(item).families).toEqual([
      { key: "roofs", href: "part-a.parquet", size: 7 },
      // `data` names the asset's role, not the family: the file name decides,
      // and an unknown size is null rather than 0.
      { key: "bridge", href: "bridge.parquet", size: null },
    ]);
  });

  it("keeps two tables that produce the same key as distinct families", () => {
    const item = {
      type: "Feature",
      assets: {
        "building.parquet": {
          href: "./east/building.parquet",
          roles: ["cityparquet-objects"],
        },
        // A second copy of the same family name, keyed generically, so both
        // tables end up on the key `building`.
        data: {
          href: "./west/building.parquet",
          roles: ["cityparquet-objects"],
        },
      },
    };
    // Same key, distinct hrefs: the app disambiguates the LABELS later; the
    // manifest must not collapse two real tables into one family.
    expect(parseCityParquetManifest(item).families).toEqual([
      { key: "building", href: "east/building.parquet", size: null },
      { key: "building", href: "west/building.parquet", size: null },
    ]);
  });

  it("never lists a sidecar as a family", () => {
    const tagged = {
      type: "Feature",
      assets: {
        "building.parquet": {
          href: "./building.parquet",
          roles: ["cityparquet-objects"],
        },
        "textures.parquet": {
          href: "./textures.parquet",
          roles: ["cityparquet-sidecar"],
        },
      },
    };
    expect(parseCityParquetManifest(tagged).families).toEqual([
      { key: "building", href: "building.parquet", size: null },
    ]);
    const roleless = {
      type: "Feature",
      assets: {
        data: { href: "./building.parquet" },
        materials: { href: "./materials.parquet" },
        textures: { href: "./textures.parquet" },
        templates: { href: "./geometry_templates.parquet" },
      },
    };
    expect(parseCityParquetManifest(roleless).families).toEqual([
      { key: "building", href: "building.parquet", size: null },
    ]);
  });

  it("names the three sidecar files a role-less package must skip", () => {
    expect([...CITYPARQUET_SIDECAR_NAMES].sort()).toEqual([
      "geometry_templates.parquet",
      "materials.parquet",
      "textures.parquet",
    ]);
  });

  it("rejects a manifest with no object tables", () => {
    expect(() =>
      parseCityParquetManifest({ type: "Feature", assets: {} }),
    ).toThrow(/no object tables/i);
  });

  it("rejects a document that is not a STAC Item", () => {
    expect(() => parseCityParquetManifest({ type: "Catalog" })).toThrow(
      /STAC Item/i,
    );
    expect(() => parseCityParquetManifest("nonsense")).toThrow(/STAC Item/i);
  });
});

describe("assembleCityParquetModel", () => {
  it("assembles the fixture package into a CityModel", async () => {
    const bytes = await fixtureBytes("building.parquet");
    const model = await assembleCityParquetModel([
      { name: "building.parquet", bytes },
    ]);
    expect(model.sourceEncoding).toBe("cityparquet");
    expect(model.metadata.referenceSystem).toBe(
      "https://www.opengis.net/def/crs/EPSG/0/7415",
    );
    expect(Object.keys(model.objects).length).toBe(3);
    expect(model.bbox).not.toBeNull();
    expect(model.vertexCount).toBeGreaterThan(0);
  });

  it("merges duplicate ids first-wins with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bytes = await fixtureBytes("building.parquet");
    const model = await assembleCityParquetModel([
      { name: "a.parquet", bytes },
      { name: "b.parquet", bytes },
    ]);
    expect(Object.keys(model.objects).length).toBe(3);
    expect(
      warn.mock.calls.filter((call) =>
        String(call[0]).includes("appear in more than one"),
      ),
    ).toHaveLength(1);
  });

  it("rejects CRS disagreement across files", async () => {
    const bytes7415 = await fixtureBytes("building.parquet");
    const bytes28992 = await fixtureBytes(
      "../two-buildings-cityparquet-28992/building.parquet",
    );
    await expect(
      assembleCityParquetModel([
        { name: "a.parquet", bytes: bytes7415 },
        { name: "b.parquet", bytes: bytes28992 },
      ]),
    ).rejects.toThrow(/CRS|EPSG/i);
  });

  it("rejects a package with no tables at all", async () => {
    await expect(assembleCityParquetModel([])).rejects.toThrow(/no .*table/i);
  });

  it("keys objects on a null-prototype map", async () => {
    const bytes = await fixtureBytes("building.parquet");
    const model = await assembleCityParquetModel([
      { name: "building.parquet", bytes },
    ]);
    expect(Object.getPrototypeOf(model.objects)).toBeNull();
  });
});
