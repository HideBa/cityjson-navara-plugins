/**
 * The reserved columns and naming rules of the current specification, read
 * from a package the reference writer produced (`spec-columns-cityparquet/`,
 * see the fixture README) and checked against the CityJSON that the same
 * writer's own reader exports from it (`spec-columns.export.city.json`).
 *
 * The export is the oracle: it is cityparquet-rs's decode of these exact
 * bytes, so a disagreement is a defect in this reader. Each object is compared
 * whole — type, attributes, hierarchy and every surface — against
 * `parseCityJSON` of the export, so a dropped or renamed attribute cannot hide
 * behind a key-by-key check.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  CityJSONRoot,
  CityModel,
  CityObject,
  Surface,
  Vec3,
} from "@cityjson/navara-core";
import { parseCityJSON } from "@cityjson/navara-core";
import {
  assembleCityParquetModel,
  parseCityParquetManifest,
} from "../src/packageAssembly";

const PACKAGE = new URL("./fixtures/spec-columns-cityparquet/", import.meta.url);
const EXPORT = new URL(
  "./fixtures/spec-columns.export.city.json",
  import.meta.url,
);

async function readPackage(): Promise<CityModel> {
  const manifest = parseCityParquetManifest(
    JSON.parse(await readFile(new URL("metadata.json", PACKAGE), "utf8")),
  );
  const files = await Promise.all(
    manifest.objectTables.map(async (href) => ({
      name: href,
      bytes: new Uint8Array(await readFile(new URL(href, PACKAGE))),
    })),
  );
  return assembleCityParquetModel(files);
}

async function readExport(): Promise<{ raw: CityJSONRoot; model: CityModel }> {
  const raw = JSON.parse(await readFile(EXPORT, "utf8")) as CityJSONRoot;
  return { raw, model: parseCityJSON(raw) };
}

/** A coordinate on the source's 1e-3 grid, so both arithmetic paths agree. */
function grid(v: Vec3): Vec3 {
  return v.map((c) => Math.round(c * 1000) / 1000 || 0) as unknown as Vec3;
}

/** A surface as the comparable parts both readers produce. */
function surfaceOf(s: Surface): unknown {
  return {
    type: s.type,
    lod: s.lod === null ? null : Number(s.lod),
    attributes: s.attributes,
    rings: s.rings.map((ring) => ring.map(grid)),
  };
}

/** The fields of an object both readers fill, normalised for comparison:
 *  the LoD display spelling differs (`"1"` here, the export's `"1.0"`). */
function comparable(o: CityObject): unknown {
  return {
    id: o.id,
    objectType: o.objectType,
    attributes: o.attributes,
    children: o.children,
    parents: o.parents,
    lod: o.lod === null ? null : Number(o.lod),
    surfaces: o.surfaces.map(surfaceOf),
  };
}

describe("a package written by the reference writer", () => {
  it("decodes every object as its own reader exports it", async () => {
    const [parquet, { model: cityjson }] = await Promise.all([
      readPackage(),
      readExport(),
    ]);
    expect(Object.keys(parquet.objects).sort()).toEqual(
      Object.keys(cityjson.objects).sort(),
    );
    for (const id of Object.keys(cityjson.objects)) {
      expect(comparable(parquet.objects[id]!), id).toEqual(
        comparable(cityjson.objects[id]!),
      );
    }
  });

  it("restores the 'other' column into the attributes", async () => {
    const parquet = await readPackage();
    expect(parquet.objects.b1!.attributes.roofColour).toEqual({
      name: "red",
      rgb: [200, 30, 30],
    });
  });
});
