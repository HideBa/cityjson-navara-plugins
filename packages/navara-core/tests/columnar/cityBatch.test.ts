import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseCityJSON } from "../../src/citymodel/cityjson/parseCityJSON";
import { parseCityJSONSeq } from "../../src/citymodel/cityjsonseq/parseCityJSONSeq";
import type { CityJSONRoot } from "../../src/citymodel/cityjson/types";
import type { CityModel } from "../../src/citymodel/types";
import { cityBatchFromModel } from "../../src/columnar/fromCityModel";
import {
  batchTransferables,
  rowOf,
  surfaceFromBlock,
} from "../../src/columnar/cityBatch";
import { columnValue, dictValue, utf8Value } from "../../src/columnar/columns";
import { expectBatchMatchesModel } from "./batchOracle";

const fixture = (name: string) =>
  fs.readFileSync(
    path.resolve(import.meta.dirname!, "../../fixtures", name),
    "utf-8",
  );

const twoBuildings = (): CityModel =>
  parseCityJSON(JSON.parse(fixture("two-buildings.city.json")) as CityJSONRoot);

describe("cityBatchFromModel", () => {
  it("makes one feature-table row per object, in the model's order", () => {
    const { features } = cityBatchFromModel(twoBuildings());
    expect(features.length).toBe(3);
    expect([0, 1, 2].map((r) => utf8Value(features.id, r))).toEqual([
      "NL.IMBAG.Pand.0001",
      "NL.IMBAG.Pand.0001-part1",
      "NL.IMBAG.Pand.0002",
    ]);
    expect([0, 1, 2].map((r) => dictValue(features.objectType, r))).toEqual([
      "Building",
      "BuildingPart",
      "Building",
    ]);
    expect(rowOf(features, "NL.IMBAG.Pand.0002")).toBe(2);
    expect(rowOf(features, "nope")).toBe(-1);
  });

  it("links parts to their parent and to their feature's root", () => {
    const { features } = cityBatchFromModel(twoBuildings());
    expect(Array.from(features.parentRow)).toEqual([-1, 0, -1]);
    expect(Array.from(features.featureRow)).toEqual([0, 0, 2]);
    expect(Array.from(features.childOffsets)).toEqual([0, 1, 1, 1]);
    expect(Array.from(features.childRows)).toEqual([1]);
  });

  it("types each attribute column by its values", () => {
    const { features } = cityBatchFromModel(twoBuildings());
    const height = features.columns.get("measuredHeight")!;
    expect(height.kind).toBe("float64");
    expect([0, 1, 2].map((r) => columnValue(height, r))).toEqual([
      8.4, 3.2, 12.1,
    ]);
    const roof = features.columns.get("roofType")!;
    expect(roof.kind).toBe("dict");
    expect([0, 1, 2].map((r) => columnValue(roof, r))).toEqual([
      "gabled",
      null,
      "flat",
    ]);
  });

  it("pools each LoD's vertices once, as CityJSON does", () => {
    const batch = cityBatchFromModel(twoBuildings());
    expect([...batch.lods.keys()]).toEqual(["2.2"]);
    const block = batch.lods.get("2.2")!;
    expect(block.surfaceCount).toBe(19);
    // 9 + 8 + 8 distinct corners, though the rings list 75 of them.
    expect(block.vertices.length).toBe(25 * 3);
    expect(block.ringVertex.length).toBe(75);
    expect(Array.from(block.surfaceRow.subarray(0, 8))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  it("gives back every surface exactly as the object graph holds it", () => {
    const model = twoBuildings();
    expectBatchMatchesModel(cityBatchFromModel(model), model);
  });

  it("keeps appearance per theme, textures with their UVs", () => {
    const model = parseCityJSONSeq(
      fixture("rotterdam-two-textured.city.jsonl"),
    );
    const batch = cityBatchFromModel(model);
    expectBatchMatchesModel(batch, model);
    const [block] = [...batch.lods.values()];
    expect(block!.textures.size).toBeGreaterThan(0);
  });

  it("counts its bytes exactly, and every buffer it counts is transferable", () => {
    const batch = cityBatchFromModel(twoBuildings());
    const buffers = batchTransferables(batch);
    const sum = buffers.reduce((n, b) => n + b.byteLength, 0);
    expect(batch.byteLength).toBe(sum);
    expect(new Set(buffers).size).toBe(buffers.length);
    const block = batch.lods.get("2.2")!;
    // The geometry's own share, by hand: 25 vertices × 24 B, 75 ring
    // vertices × 4 B, 20 ring offsets and 20 surface offsets × 4 B, and per
    // surface a row (4), an ordinal (4), a type (2), a geometry type (1) and
    // a semantic index (4).
    expect(
      block.vertices.byteLength +
        block.ringVertex.byteLength +
        block.ringOffsets.byteLength +
        block.surfaceRings.byteLength +
        block.surfaceRow.byteLength +
        block.surfaceOrdinal.byteLength +
        block.surfaceType.byteLength +
        block.surfaceGeometryType.byteLength +
        block.surfaceSemantic.byteLength,
    ).toBe(25 * 24 + 75 * 4 + 20 * 4 + 20 * 4 + 19 * (4 + 4 + 2 + 1 + 4));
  });

  it("survives structuredClone, which is what postMessage does", () => {
    const model = twoBuildings();
    const clone = structuredClone(cityBatchFromModel(model));
    expectBatchMatchesModel(clone, model);
    expect(rowOf(clone.features, "NL.IMBAG.Pand.0001-part1")).toBe(1);
  });

  it("rebuilds one surface for the inspector", () => {
    const model = twoBuildings();
    const block = cityBatchFromModel(model).lods.get("2.2")!;
    const surface = surfaceFromBlock(block, 2);
    expect(surface).toEqual(model.objects["NL.IMBAG.Pand.0001"]!.surfaces[2]);
  });
});

describe("implicit geometry", () => {
  it("places one instance per object, the reference point folded into the matrix", () => {
    const square = {
      type: "unknown" as const,
      rings: [
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
        ] as const,
      ],
      attributes: {},
      lod: "1",
    };
    const tree = (id: string, x: number, scale: number) => ({
      id,
      objectType: "SolitaryVegetationObject",
      attributes: {},
      surfaces: [],
      bbox: null,
      children: [],
      parents: [],
      lod: null,
      implicitGeometry: {
        templateId: 7,
        referencePoint: [x, 2, 3] as const,
        transformationMatrix: [
          scale,
          0,
          0,
          0.5,
          0,
          scale,
          0,
          0,
          0,
          0,
          scale,
          0,
          0,
          0,
          0,
          1,
        ],
      },
    });
    const model: CityModel = {
      sourceEncoding: "cityjson",
      metadata: {},
      bbox: null,
      vertexCount: 0,
      objects: {
        a: tree("a", 10, 1),
        plain: { ...tree("plain", 0, 1), implicitGeometry: undefined },
        b: tree("b", 20, 2),
      },
      implicitTemplates: new Map([
        [7, { id: 7, name: null, surfaces: [square], lod: "1" }],
      ]),
    };
    const { instances } = cityBatchFromModel(model);
    expect(Array.from(instances!.templateIds)).toEqual([7]);
    expect(instances!.templates[0]!.surfaceCount).toBe(1);
    const { table } = instances!;
    expect(table.length).toBe(2);
    expect(Array.from(table.featureRow)).toEqual([0, 2]);
    expect(Array.from(table.templateIndex)).toEqual([0, 0]);
    expect(Array.from(table.transform.subarray(16, 32))).toEqual([
      2, 0, 0, 20.5, 0, 2, 0, 2, 0, 0, 2, 3, 0, 0, 0, 1,
    ]);
  });
});
