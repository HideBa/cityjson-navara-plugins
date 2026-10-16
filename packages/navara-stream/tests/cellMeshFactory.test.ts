/**
 * Task C11: the real `CellMeshFactory` — the one seam every streamed cell goes
 * through on its way to the engine.
 *
 * This closes Task C10b's "cannot verify" note: `resolvePick`'s
 * `PickedFeatureLike` route reads `properties.cellKey`, and Task B15's router
 * reads `layerId`, but until now nothing proved the factory actually stamps
 * either. `addCityMeshArrays` takes its view structurally, so the whole path
 * runs in Node against a fake view — no `@navaramap/*` anywhere.
 */
import { describe, expect, it } from "vitest";
import { makeEnuFrame } from "@cityjson/navara-core";
import {
  CITY_MESH_ARRAYS_KEY,
  CityMeshArraysMesh,
  type AddCityMeshArraysOptions,
  type CityMeshArraysViewLike,
} from "@cityjson/navara-cityjson";
import { createCellMeshFactory } from "../src/cellMeshFactory";
import type { CellEntry } from "../src/streamLayer";

const FRAME = makeEnuFrame(4.3571, 52.0116, 0);

/** One triangle, with distinct base and rule colours so the copy-vs-alias
 *  invariant is observable. */
function entry(withRuleColors: boolean): CellEntry {
  const v = 3;
  return {
    geometry: {
      positions: Float32Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0]),
      normals: new Float32Array(v * 3).fill(0),
      baseColors: new Float32Array(v * 3).fill(0.25),
      ruleColors: withRuleColors ? new Float32Array(v * 3).fill(0.5) : null,
      objectIndices: new Uint32Array(v).fill(0),
      surfaceIndices: new Uint32Array(v).fill(2),
      objectKeys: ["B1"],
      triangleCount: 1,
    },
    objects: [],
    surfaceAttrKeys: [],
    lodsSeen: [],
    builtWithRulesEnabled: false,
    builtWithRules: [],
  };
}

/** Records every `addMesh` config and hands back a real `CityMeshArraysMesh`,
 *  so the handle under test is the production one. */
function fakeView() {
  const configs: Array<Record<string, AddCityMeshArraysOptions>> = [];
  const deleted: string[] = [];
  const view: CityMeshArraysViewLike = {
    addMesh(config: unknown) {
      const typed = config as Record<string, AddCityMeshArraysOptions>;
      configs.push(typed);
      const opts = typed[CITY_MESH_ARRAYS_KEY]!;
      return {
        ref: { cityMesh: new CityMeshArraysMesh(opts) },
        visible: true,
        delete: () => deleted.push(opts.id),
      };
    },
  };
  return { view, configs, deleted };
}

describe("createCellMeshFactory", () => {
  it("stamps layerId, cellKey, a per-layer mesh id and the pick strategy", () => {
    const { view, configs } = fakeView();
    const factory = createCellMeshFactory({
      layerId: "L1",
      getView: () => view,
      pickStrategy: "own-raycast",
    });

    factory.create("5/14/14", entry(false), FRAME);

    expect(configs).toHaveLength(1);
    expect(configs[0]![CITY_MESH_ARRAYS_KEY]).toMatchObject({
      id: "L1:5/14/14",
      layerId: "L1",
      cellKey: "5/14/14",
      pickStrategy: "own-raycast",
    });
  });

  it("passes the cell's own frame straight through", () => {
    const { view, configs } = fakeView();
    const cellFrame = makeEnuFrame(4.36, 52.02, 43);
    createCellMeshFactory({ layerId: "L1", getView: () => view }).create(
      "5/14/14",
      entry(false),
      cellFrame,
    );
    expect(configs[0]![CITY_MESH_ARRAYS_KEY]!.frame).toBe(cellFrame);
  });

  it("hands the engine a COPY of the colours, on both branches", () => {
    const { view, configs } = fakeView();
    const factory = createCellMeshFactory({
      layerId: "L1",
      getView: () => view,
    });

    const base = entry(false);
    factory.create("a", base, FRAME);
    const baseColors = configs[0]![CITY_MESH_ARRAYS_KEY]!.arrays.colors;
    expect(baseColors).not.toBe(base.geometry.baseColors);
    expect([...baseColors]).toEqual([...base.geometry.baseColors]);

    const ruled = entry(true);
    factory.create("b", ruled, FRAME);
    const ruleColors = configs[1]![CITY_MESH_ARRAYS_KEY]!.arrays.colors;
    expect(ruleColors).not.toBe(ruled.geometry.ruleColors);
    expect([...ruleColors]).toEqual([...ruled.geometry.ruleColors!]);
    // The whole point of the copy: the engine wraps this buffer, so writing
    // through the handle must not reach the cache entry's restore baseline.
    ruleColors.fill(1);
    expect([...ruled.geometry.ruleColors!]).toEqual([
      ...new Float32Array(9).fill(0.5),
    ]);
  });

  it("reads the view per cell, and refuses before there is one", () => {
    const { view, configs } = fakeView();
    let current: CityMeshArraysViewLike | null = null;
    const factory = createCellMeshFactory({
      layerId: "L1",
      getView: () => current,
    });

    expect(() => factory.create("a", entry(false), FRAME)).toThrow(
      /before view\.init\(\)/,
    );
    current = view;
    factory.create("a", entry(false), FRAME);
    expect(configs).toHaveLength(1);
  });
});
