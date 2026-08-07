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
