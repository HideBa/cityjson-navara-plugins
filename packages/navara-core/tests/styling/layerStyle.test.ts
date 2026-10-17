/**
 * Colour expressions on the MapLibre style spec, per surface, and the rules
 * compiled to one: on the fixtures, every slot's colour from
 * `rulesToStyleExpression(rules)` equals `compileRuleEvaluator(rules)`'s.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCityJSON } from "../../src/citymodel/cityjson/parseCityJSON";
import { parseCityJSONSeq } from "../../src/citymodel/cityjsonseq/parseCityJSONSeq";
import type { CityJSONRoot } from "../../src/citymodel/cityjson/types";
import type { CityModel, Surface } from "../../src/citymodel/types";
import { buildCityMeshArrays } from "../../src/geometry/buildCityMeshArrays";
import type { Rule } from "../../src/rules/types";
import { buildSlotStyleColors } from "../../src/styling/buildStyleColors";
import {
  compileStyleExpression,
  rulesToStyleExpression,
} from "../../src/styling/layerStyle";
import { compileRuleEvaluator } from "../../src/styling/ruleColors";
import { srgbHexToLinear, type RGB } from "../../src/styling/srgb";

const fixtures = path.resolve(import.meta.dirname!, "../../fixtures");
const twoBuildings = parseCityJSON(
  JSON.parse(
    fs.readFileSync(path.join(fixtures, "two-buildings.city.json"), "utf-8"),
  ) as CityJSONRoot,
);
const rotterdam = parseCityJSONSeq(
  fs.readFileSync(
    path.join(fixtures, "rotterdam-two-textured.city.jsonl"),
    "utf-8",
  ),
);

function evaluator(expression: unknown) {
  const compiled = compileStyleExpression(expression);
  if (!compiled.ok) throw new Error(compiled.errors.join("; "));
  return compiled.evaluator;
}

const roof: Surface = {
  type: "RoofSurface",
  rings: [
    [
      [0, 0, 10],
      [10, 0, 10],
      [10, 10, 10],
      [0, 10, 10],
    ],
  ],
  attributes: { colour: "red" },
  lod: "2",
};
const BASE: RGB = [0.2, 0.3, 0.4];

function paint(expression: unknown, attributes: Record<string, unknown> = {}) {
  return evaluator(expression)(
    { surfaceIndex: 0, surface: roof },
    {
      objectId: "B1",
      object: {
        id: "B1",
        objectType: "BuildingPart",
        attributes,
        surfaces: [roof],
        bbox: null,
        children: [],
        parents: [],
        lod: "2",
      },
      attributes,
    },
    BASE,
  );
}

const RED = srgbHexToLinear("#ff0000");

describe("compileStyleExpression", () => {
  it("reads attributes, roof metrics and the surface's identity", () => {
    expect(
      paint(["match", ["get", "fn"], "house", "#ff0000", "#000000"], {
        fn: "house",
      }),
    ).toEqual(RED);
    expect(
      paint([
        "case",
        ["<", ["get", "inclinationDeg"], 1],
        "#ff0000",
        "#000000",
      ]),
    ).toEqual(RED);
    expect(
      paint(["case", [">", ["get", "areaSqM"], 99], "#ff0000", "#000000"]),
    ).toEqual(RED);
    expect(
      paint([
        "match",
        ["get", "$surface"],
        "RoofSurface",
        "#ff0000",
        "#000000",
      ]),
    ).toEqual(RED);
    expect(
      paint(["match", ["get", "$type"], "BuildingPart", "#ff0000", "#000000"]),
    ).toEqual(RED);
    expect(
      paint(["match", ["get", "$id"], "B1", "#ff0000", "#000000"]),
    ).toEqual(RED);
    expect(paint(["match", ["id"], "B1", "#ff0000", "#000000"])).toEqual(RED);
  });

  it("puts surface attributes over the object's, and metrics over both", () => {
    expect(
      paint(["match", ["get", "colour"], "red", "#ff0000", "#000000"], {
        colour: "blue",
      }),
    ).toEqual(RED);
    expect(
      paint(["case", [">", ["get", "areaSqM"], 99], "#ff0000", "#000000"], {
        areaSqM: 1,
      }),
    ).toEqual(RED);
  });

  it("keeps the base colour for $base, null, transparency and runtime errors", () => {
    expect(paint(["get", "$base"])).toBeNull();
    expect(paint(["case", false, "#ff0000", ["get", "$base"]])).toBeNull();
    expect(paint(["get", "nothing"])).toBeNull();
    expect(paint("rgba(0, 0, 0, 0)")).toBeNull();
    expect(paint(["to-color", ["get", "colour"]])).toEqual(RED);
    expect(paint(["to-color", ["get", "nothing"]])).toBeNull();
  });

  it("derives a colour from the base", () => {
    const half = paint([
      "interpolate",
      ["linear"],
      0.5,
      0,
      ["to-color", ["get", "$base"]],
      1,
      "#ffffff",
    ]);
    expect(half).not.toBeNull();
    expect(half![0]).toBeGreaterThan(BASE[0]);
  });

  it("refuses an expression that does not compile, with the spec's messages", () => {
    const zoom = compileStyleExpression([
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      "#000000",
      1,
      "#ffffff",
    ]);
    expect(zoom.ok).toBe(false);
    const nonsense = compileStyleExpression(["frobnicate", 1]);
    expect(nonsense.ok).toBe(false);
    if (!nonsense.ok) expect(nonsense.errors.join()).toMatch(/frobnicate/);
    expect(compileStyleExpression(42).ok).toBe(false);
  });

  it("keeps every base colour when nothing is styled", () => {
    const arrays = buildCityMeshArrays(twoBuildings, "L");
    expect(
      buildSlotStyleColors(
        twoBuildings,
        arrays.slotObjects,
        arrays.slotSurfaces,
        arrays.objectKeys,
        evaluator(["get", "$base"]),
        arrays.slotColors,
      ),
    ).toBeNull();
  });
});

const flat = (enabled = true): Rule => ({
  id: "flat",
  name: "Flat",
  color: "#3b82f6",
  logic: "AND",
  enabled,
  conditions: [{ field: "inclinationDeg", operator: "<", value: 10 }],
});

const RULE_SETS: Record<string, Rule[]> = {
  "no rules": [],
  flat: [flat()],
  "disabled only": [flat(false)],
  "south or steep": [
    {
      id: "s",
      name: "South",
      color: "#f0a800",
      logic: "OR",
      enabled: true,
      conditions: [
        { field: "azimuthDeg", operator: ">=", value: 135 },
        { field: "inclinationDeg", operator: ">", value: 45 },
      ],
    },
  ],
  "solar suitable": [
    {
      id: "solar",
      name: "Solar",
      color: "#ffc530",
      logic: "AND",
      enabled: true,
      conditions: [
        { field: "azimuthDeg", operator: ">=", value: 120 },
        { field: "azimuthDeg", operator: "<=", value: 240 },
        { field: "inclinationDeg", operator: ">=", value: 15 },
        { field: "areaSqM", operator: ">", value: 20 },
      ],
    },
  ],
  "attributes, typed oddly": [
    {
      id: "a",
      name: "String compared by order",
      color: "#ff0000",
      logic: "AND",
      enabled: true,
      conditions: [{ field: "elevationM", operator: "<", value: "9" }],
    },
    {
      id: "b",
      name: "Missing attribute",
      color: "#00ff00",
      logic: "AND",
      enabled: true,
      conditions: [{ field: "nope", operator: "=", value: 1 }],
    },
    {
      id: "c",
      name: "Empty OR",
      color: "#abc",
      logic: "OR",
      enabled: true,
      conditions: [],
    },
  ],
  "first match wins, then a catch-all": [
    flat(),
    {
      id: "all",
      name: "Unmatched",
      color: "#777777",
      logic: "AND",
      enabled: true,
      conditions: [],
    },
  ],
  "an invalid colour": [{ ...flat(), color: "not a colour" }],
};

function slotColours(
  model: CityModel,
  evaluate: ReturnType<typeof compileRuleEvaluator>,
): number[] {
  const arrays = buildCityMeshArrays(model, "L");
  const colours = evaluate
    ? buildSlotStyleColors(
        model,
        arrays.slotObjects,
        arrays.slotSurfaces,
        arrays.objectKeys,
        evaluate,
        arrays.slotColors,
      )
    : null;
  return [...(colours ?? arrays.slotColors)];
}

describe("rulesToStyleExpression", () => {
  for (const [name, rules] of Object.entries(RULE_SETS)) {
    for (const [modelName, model] of [
      ["two buildings", twoBuildings],
      ["Rotterdam", rotterdam],
    ] as const) {
      it(`colours ${modelName} exactly as the rules do: ${name}`, () => {
        const expression = evaluator(rulesToStyleExpression(rules));
        expect(slotColours(model, expression)).toEqual(
          slotColours(model, compileRuleEvaluator(rules)),
        );
      });
    }
  }

  it("matches some roofs and not others on the fixtures, so the parity is not vacuous", () => {
    const base = slotColours(twoBuildings, null);
    const flatRoofs = slotColours(twoBuildings, compileRuleEvaluator([flat()]));
    expect(flatRoofs).not.toEqual(base);
  });
});
