import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseCityJSON } from "../../src/citymodel/cityjson/parseCityJSON";
import type { CityJSONRoot } from "../../src/citymodel/cityjson/types";
import { cityBatchFromModel } from "../../src/columnar/fromCityModel";
import {
  blockRoofMetrics,
  evaluateBlockRules,
  inheritedValue,
} from "../../src/columnar/styleColumns";
import type { Rule } from "../../src/rules/types";
import { expectRulesMatchGraph } from "./styleOracle";

const twoBuildings = () =>
  parseCityJSON(
    JSON.parse(
      fs.readFileSync(
        path.resolve(
          import.meta.dirname!,
          "../../fixtures/two-buildings.city.json",
        ),
        "utf-8",
      ),
    ) as CityJSONRoot,
  );

const rule = (
  id: string,
  conditions: Rule["conditions"],
  logic: Rule["logic"] = "AND",
): Rule => ({
  id,
  name: id,
  color: "#ff0000",
  conditions,
  logic,
  enabled: true,
});

describe("inheritedValue", () => {
  it("reads a part's missing attribute from its building", () => {
    const { features } = cityBatchFromModel(twoBuildings());
    expect(inheritedValue(features, "roofType", 1)).toBe("gabled");
    expect(inheritedValue(features, "roofType", 2)).toBe("flat");
  });

  it("keeps the nearer object's value when both carry the name", () => {
    const { features } = cityBatchFromModel(twoBuildings());
    expect(inheritedValue(features, "measuredHeight", 1)).toBe(3.2);
  });

  it("is null for a name nobody carries", () => {
    const { features } = cityBatchFromModel(twoBuildings());
    expect(inheritedValue(features, "nope", 0)).toBeNull();
  });
});

describe("blockRoofMetrics", () => {
  it("measures roofs once, and nothing else", () => {
    const batch = cityBatchFromModel(twoBuildings());
    const block = batch.lods.get("2.2")!;
    const metrics = blockRoofMetrics(block);
    expect(metrics).toBe(blockRoofMetrics(block));
    // Surface 0 is the first building's ground: not a roof.
    expect(Number.isNaN(metrics.areaSqM[0]!)).toBe(true);
    // Surface 1 is its flat roof part, 10 × 8 m less nothing.
    expect(metrics.areaSqM[1]).toBeGreaterThan(0);
  });
});

describe("evaluateBlockRules", () => {
  it("colours roofs by the first matching rule, as the object graph does", () => {
    const model = twoBuildings();
    const rules = [
      rule("tall", [{ field: "measuredHeight", operator: ">", value: 10 }]),
      rule("gabled", [{ field: "roofType", operator: "=", value: "gabled" }]),
      rule("sloped", [{ field: "inclinationDeg", operator: ">", value: 5 }]),
    ];
    expectRulesMatchGraph(model, rules);
    const batch = cityBatchFromModel(model);
    const matched = evaluateBlockRules(batch, batch.lods.get("2.2")!, rules);
    // The part's roof (surface 8) inherits "gabled" from its building.
    expect(matched[8]).toBe(1);
    // Walls never match.
    expect(matched[3]).toBe(-1);
  });

  it("skips disabled rules and reads semantic attributes over the object's", () => {
    const rules = [
      { ...rule("off", []), enabled: false },
      rule("slope", [{ field: "slope", operator: "=", value: 35 }]),
    ];
    expectRulesMatchGraph(twoBuildings(), rules);
  });
});
