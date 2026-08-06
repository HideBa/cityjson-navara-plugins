/**
 * The second-level -> first-level fold. The vocabulary is closed by the
 * CityJSON spec, so the table is asserted against a literal list here rather
 * than against itself.
 */
import { describe, it, expect } from "vitest";
import {
  TOPLEVEL_BY_SECOND_LEVEL,
  toplevelCityObjectType,
} from "../../src/citymodel/toplevelType";
import type { CityJSONObjectType } from "../../src/citymodel/cityjson/types";

/** Every first-level type in CityJSON v2.0 — the ones that must map to
 *  themselves. Written out rather than derived from the map under test. */
const FIRST_LEVEL: ReadonlyArray<CityJSONObjectType> = [
  "Building",
  "Bridge",
  "Tunnel",
  "CityFurniture",
  "CityObjectGroup",
  "GenericCityObject",
  "LandUse",
  "OtherConstruction",
  "PlantCover",
  "SolitaryVegetationObject",
  "TINRelief",
  "Road",
  "Railway",
  "Waterway",
  "TransportSquare",
  "WaterBody",
];

describe("toplevelCityObjectType", () => {
  it("folds every Building second-level type into Building", () => {
    for (const t of [
      "BuildingPart",
      "BuildingInstallation",
      "BuildingConstructiveElement",
      "BuildingFurniture",
      "BuildingStorey",
      "BuildingRoom",
      "BuildingUnit",
    ]) {
      expect(toplevelCityObjectType(t)).toBe("Building");
    }
  });

  it("folds every Bridge and Tunnel second-level type into its parent", () => {
    for (const t of [
      "BridgePart",
      "BridgeInstallation",
      "BridgeConstructiveElement",
      "BridgeRoom",
      "BridgeFurniture",
    ]) {
      expect(toplevelCityObjectType(t)).toBe("Bridge");
    }
    for (const t of [
      "TunnelPart",
      "TunnelInstallation",
      "TunnelConstructiveElement",
      "TunnelHollowSpace",
      "TunnelFurniture",
    ]) {
      expect(toplevelCityObjectType(t)).toBe("Tunnel");
    }
  });

  it("maps every first-level type to itself", () => {
    for (const t of FIRST_LEVEL) expect(toplevelCityObjectType(t)).toBe(t);
  });

  it("maps an Extension type and an unknown string to themselves", () => {
    // "+Extension" types are opaque by construction: an extension may declare
    // a parent relationship the schema knows nothing about, so folding one
    // would be a guess.
    expect(toplevelCityObjectType("+NoiseCityFurnitureSegment")).toBe(
      "+NoiseCityFurnitureSegment",
    );
    expect(toplevelCityObjectType("BuildingSomethingNew")).toBe(
      "BuildingSomethingNew",
    );
    expect(toplevelCityObjectType("")).toBe("");
  });

  it("holds 17 second-level names, and none of them is its own parent", () => {
    expect(Object.keys(TOPLEVEL_BY_SECOND_LEVEL)).toHaveLength(17);
    for (const [child, parent] of Object.entries(TOPLEVEL_BY_SECOND_LEVEL)) {
      expect(child).not.toBe(parent);
      expect(FIRST_LEVEL).toContain(parent);
    }
  });
});
