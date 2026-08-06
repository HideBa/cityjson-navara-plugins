import { describe, it, expect } from "vitest";
import { CellCache } from "../src/cellCache";
import type { CellEntry } from "../src/streamLayer";
import type { CellGeometry } from "../src/workerProtocol";
import type { Grid } from "../src/tileGrid";
import {
  cellStatsFromGeometry,
  commitNormal,
  commitSwap,
  ladderEquals,
  lodSelectionEquals,
  lodToWireLabel,
  planCommit,
  resolveLod,
} from "../src/commitPlanner";

function geom(
  triangleCount: number,
  overrides?: Partial<CellGeometry>,
): CellGeometry {
  const v = triangleCount * 3;
  return {
    positions: new Float32Array(v * 3).fill(1),
    normals: new Float32Array(v * 3).fill(2),
    baseColors: new Float32Array(v * 3).fill(3),
    ruleColors: null,
    objectIndices: new Uint32Array(v).fill(0),
    surfaceIndices: new Uint32Array(v).fill(0),
    objectKeys: [],
    triangleCount,
    ...overrides,
  };
}

function fakeEntry(tag: string): CellEntry {
  return {
    geometry: geom(1),
    objects: [],
    surfaceAttrKeys: [tag],
    lodsSeen: [],
    builtWithRulesEnabled: false,
    builtWithRules: [],
  };
}

// ---------------------------------------------------------------------
describe("lodToWireLabel", () => {
  it("maps an exact selection to its label", () => {
    expect(lodToWireLabel({ kind: "exact", lod: "2" })).toBe("2");
  });
  it("maps 'all' to null (no filter)", () => {
    expect(lodToWireLabel({ kind: "all" })).toBeNull();
  });
  it("maps 'unlabelled' to null — the wire protocol has no representation for it (documented gap)", () => {
    expect(lodToWireLabel({ kind: "unlabelled" })).toBeNull();
  });
});

describe("resolveLod", () => {
  it("manual mode with a non-null selectedLod pins that exact label, ignoring the ladder", () => {
    expect(
      resolveLod({ lodMode: "manual", selectedLod: "1.2" }, ["0", "1.2"], 50),
    ).toEqual({ kind: "exact", lod: "1.2" });
  });
  it("manual mode with a null selectedLod means 'all', same as a non-streaming layer", () => {
    expect(
      resolveLod({ lodMode: "manual", selectedLod: null }, ["0", "1.2"], 50),
    ).toEqual({ kind: "all" });
  });
  it("auto mode delegates to lodForCellSize", () => {
    // n=3 ladder, cellSize 300 falls in the "middle band" -> ladder[1]
    expect(
      resolveLod({ lodMode: "auto", selectedLod: null }, ["0", "1", "2"], 300),
    ).toEqual({ kind: "exact", lod: "1" });
  });
});

describe("lodSelectionEquals", () => {
  it("true for identical exact selections", () => {
    expect(
      lodSelectionEquals(
        { kind: "exact", lod: "1" },
        { kind: "exact", lod: "1" },
      ),
    ).toBe(true);
  });
  it("false for different exact labels", () => {
    expect(
      lodSelectionEquals(
        { kind: "exact", lod: "1" },
        { kind: "exact", lod: "2" },
      ),
    ).toBe(false);
  });
  it("true for two 'all' selections", () => {
    expect(lodSelectionEquals({ kind: "all" }, { kind: "all" })).toBe(true);
  });
  it("false across different kinds", () => {
    expect(
      lodSelectionEquals({ kind: "all" }, { kind: "exact", lod: "1" }),
    ).toBe(false);
  });
});

describe("ladderEquals", () => {
  it("true for two empty ladders", () => {
    expect(ladderEquals([], [])).toBe(true);
  });
  it("true for identical content even across two DIFFERENT array instances", () => {
    expect(ladderEquals(["0", "1.2"], ["0", "1.2"])).toBe(true);
  });
  it("false when lengths differ", () => {
    expect(ladderEquals(["0"], ["0", "1.2"])).toBe(false);
  });
  it("false when content differs at the same length", () => {
    expect(ladderEquals(["0", "1.2"], ["0", "2.2"])).toBe(false);
  });
  it("false when order differs — position matters (levelPolicy.ts indexes into the ladder by position)", () => {
    expect(ladderEquals(["0", "1.2"], ["1.2", "0"])).toBe(false);
  });
});

describe("cellStatsFromGeometry", () => {
  it("sums triangleCount and every typed array's byteLength, excluding ruleColors when null", () => {
    const g = geom(2); // v=6; positions/normals/baseColors len 18 f32 (72B each); indices len 6 u32 (24B each)
    const stats = cellStatsFromGeometry(g);
    expect(stats.triangles).toBe(2);
    expect(stats.bytes).toBe(72 + 72 + 72 + 24 + 24);
  });
  it("includes ruleColors bytes when present", () => {
    const g = geom(1, { ruleColors: new Float32Array(9).fill(0) }); // v=3, len9 f32 = 36B
    const withRule = cellStatsFromGeometry(g);
    const without = cellStatsFromGeometry({ ...g, ruleColors: null });
    expect(withRule.bytes - without.bytes).toBe(36);
  });
});

// ---------------------------------------------------------------------
// planCommit — hand-derived grid/bbox fixture, not re-derived through
// chooseLevel/keysCovering in the assertions themselves (Task 4's lesson:
// deriving the expectation via the same helper under test is tautological).
//
// Grid: origin (0,0), rootCell 900, maxLevel 3 -> cell sizes 900/450/225/112.5
// bbox [0,0,675,675] (span 675):
//   L0(900): 1x1=1 cell        L1(450): 2x2=4 cells
//   L2(225): 4x4=16 cells  <- first level with count in [9,64] -> chosen
//   (L3 never reached)
// desired = 16 keys "2/c/r" for c,r in 0..3.
// ---------------------------------------------------------------------
const GRID: Grid = { originX: 0, originY: 0, rootCell: 900, maxLevel: 3 };
const BBOX: [number, number, number, number] = [0, 0, 675, 675];
const FOOTPRINT = {
  bbox: BBOX,
  span: 675,
  centre: [337.5, 337.5] as [number, number],
};
const DESIRED_16: string[] = [];
for (let c = 0; c < 4; c++)
  for (let r = 0; r < 4; r++) DESIRED_16.push(`2/${c}/${r}`);

function newCache(): CellCache<CellEntry> {
  return new CellCache<CellEntry>({
    maxTriangles: Infinity,
    maxBytes: Infinity,
  });
}

describe("planCommit", () => {
  it("too-far when the footprint is null", () => {
    const plan = planCommit({
      footprint: null,
      probeCount: null,
      grid: GRID,
      cache: newCache(),
      prevLevel: null,
      prevCommit: null,
      prevLod: null,
      prevHiddenTypes: [],
      hiddenTypes: [],
      ladder: [],
      lodMode: "auto",
      selectedLod: null,
    });
    expect(plan).toEqual({ kind: "too-far", reason: "footprint" });
  });

  it("too-far when probeCount is null despite a valid footprint (defensive: unreachable via the current driver wiring, but part of this function's own contract)", () => {
    const plan = planCommit({
      footprint: FOOTPRINT,
      probeCount: null,
      grid: GRID,
      cache: newCache(),
      prevLevel: null,
      prevCommit: null,
      prevLod: null,
      prevHiddenTypes: [],
      hiddenTypes: [],
      ladder: [],
      lodMode: "auto",
      selectedLod: null,
    });
    expect(plan).toEqual({ kind: "too-far", reason: "no-probe" });
  });

  it("too-far when probeCount exceeds VIEWPORT_FEATURE_BUDGET", () => {
    const plan = planCommit({
      footprint: FOOTPRINT,
      probeCount: 20001,
      grid: GRID,
      cache: newCache(),
      prevLevel: null,
      prevCommit: null,
      prevLod: null,
      prevHiddenTypes: [],
      hiddenTypes: [],
      ladder: [],
      lodMode: "auto",
      selectedLod: null,
    });
    expect(plan).toEqual({ kind: "too-far", reason: "feature-budget" });
  });

  it("too-far when no level's cover count falls in [MIN_COVER_CELLS, MAX_COVER_CELLS] (tiny footprint)", () => {
    const plan = planCommit({
      footprint: { bbox: [0, 0, 10, 10], span: 10, centre: [5, 5] },
      probeCount: 0,
      grid: GRID,
      cache: newCache(),
      prevLevel: null,
      prevCommit: null,
      prevLod: null,
      prevHiddenTypes: [],
      hiddenTypes: [],
      ladder: [],
      lodMode: "auto",
      selectedLod: null,
    });
    expect(plan).toEqual({ kind: "too-far", reason: "no-level" });
  });

  it("chooses level 2 with a 16-cell cover for the canonical fixture (literal, not re-derived)", () => {
    const plan = planCommit({
      footprint: FOOTPRINT,
      probeCount: 0,
      grid: GRID,
      cache: newCache(),
      prevLevel: null,
      prevCommit: null,
      prevLod: null,
      prevHiddenTypes: [],
      hiddenTypes: [],
      ladder: [],
      lodMode: "auto",
      selectedLod: null,
    });
    expect(plan.kind).toBe("commit");
    if (plan.kind !== "commit") throw new Error("expected commit");
    expect(plan.level).toBe(2);
    expect(plan.desired).toHaveLength(16);
    expect([...plan.desired].sort()).toEqual([...DESIRED_16].sort());
  });

  it("skips a fully-covered, unmoved view (hysteresis, no bypass)", () => {
    const cache = newCache();
    for (const k of DESIRED_16)
      cache.set(k, fakeEntry(k), { triangles: 1, bytes: 1 });
    const plan = planCommit({
      footprint: FOOTPRINT,
      probeCount: 0,
      grid: GRID,
      cache,
      prevLevel: 2,
      prevCommit: { centre: FOOTPRINT.centre, span: FOOTPRINT.span },
      prevLod: { kind: "all" },
      prevHiddenTypes: [],
      hiddenTypes: [],
      ladder: [],
      lodMode: "auto",
      selectedLod: null,
    });
    expect(plan).toEqual({ kind: "skip" });
  });

  it("commits (isSwap=false, toFetch=missing) when the cover has holes, even with zero movement", () => {
    const cache = newCache();
    // Populate only 10 of 16 desired cells -> 6 missing.
    for (const k of DESIRED_16.slice(0, 10)) {
      cache.set(k, fakeEntry(k), { triangles: 1, bytes: 1 });
    }
    const plan = planCommit({
      footprint: FOOTPRINT,
      probeCount: 0,
      grid: GRID,
      cache,
      prevLevel: 2,
      prevCommit: { centre: FOOTPRINT.centre, span: FOOTPRINT.span }, // identical -> no hysteresis trigger
      prevLod: { kind: "all" },
      prevHiddenTypes: [],
      hiddenTypes: [],
      ladder: [],
      lodMode: "auto",
      selectedLod: null,
    });
    expect(plan.kind).toBe("commit");
    if (plan.kind !== "commit") throw new Error("expected commit");
    expect(plan.isSwap).toBe(false);
    expect([...plan.toFetch].sort()).toEqual(DESIRED_16.slice(10).sort());
  });

  it("commits as a SWAP (toFetch=desired, including already-resident keys) when the level changed", () => {
    const cache = newCache();
    for (const k of DESIRED_16)
      cache.set(k, fakeEntry(k), { triangles: 1, bytes: 1 }); // fully resident at the NEW level's keys
    const plan = planCommit({
      footprint: FOOTPRINT,
      probeCount: 0,
      grid: GRID,
      cache,
      prevLevel: 1, // different from the chosen level 2
      prevCommit: { centre: FOOTPRINT.centre, span: FOOTPRINT.span },
      prevLod: { kind: "all" },
      prevHiddenTypes: [],
      hiddenTypes: [],
      ladder: [],
      lodMode: "auto",
      selectedLod: null,
    });
    expect(plan.kind).toBe("commit");
    if (plan.kind !== "commit") throw new Error("expected commit");
    expect(plan.isSwap).toBe(true);
    expect([...plan.toFetch].sort()).toEqual([...DESIRED_16].sort());
  });

  it("commits as a SWAP when only the LoD changed at the same level", () => {
    const cache = newCache();
    for (const k of DESIRED_16)
      cache.set(k, fakeEntry(k), { triangles: 1, bytes: 1 });
    const ladder = ["0", "1", "2"]; // cellSize(grid,2)=225 -> middle band -> ladder[1]="1"
    const plan = planCommit({
      footprint: FOOTPRINT,
      probeCount: 0,
      grid: GRID,
      cache,
      prevLevel: 2, // SAME level
      prevCommit: { centre: FOOTPRINT.centre, span: FOOTPRINT.span },
      prevLod: { kind: "exact", lod: "0" }, // different from the resolved "1"
      prevHiddenTypes: [],
      hiddenTypes: [],
      ladder,
      lodMode: "auto",
      selectedLod: null,
    });
    expect(plan.kind).toBe("commit");
    if (plan.kind !== "commit") throw new Error("expected commit");
    expect(plan.lod).toEqual({ kind: "exact", lod: "1" });
    expect(plan.isSwap).toBe(true);
    expect([...plan.toFetch].sort()).toEqual([...DESIRED_16].sort());
  });

  // Same argument as the LoD case: the cells resident under an unchanged key
  // were BAKED without the previously hidden types, so once `hasHoles` is
  // false hysteresis would serve that stale geometry indefinitely.
  it("commits as a SWAP when only the hidden types changed", () => {
    const cache = newCache();
    for (const k of DESIRED_16)
      cache.set(k, fakeEntry(k), { triangles: 1, bytes: 1 });
    const plan = planCommit({
      footprint: FOOTPRINT,
      probeCount: 0,
      grid: GRID,
      cache,
      prevLevel: 2,
      prevCommit: { centre: FOOTPRINT.centre, span: FOOTPRINT.span },
      prevLod: { kind: "all" },
      prevHiddenTypes: [],
      hiddenTypes: ["Building"],
      ladder: [],
      lodMode: "auto",
      selectedLod: null,
    });
    expect(plan.kind).toBe("commit");
    if (plan.kind !== "commit") throw new Error("expected commit");
    expect(plan.isSwap).toBe(true);
    expect([...plan.toFetch].sort()).toEqual([...DESIRED_16].sort());
  });

  it("does not swap for an unchanged hidden-type list, or before the first commit", () => {
    const cache = newCache();
    for (const k of DESIRED_16)
      cache.set(k, fakeEntry(k), { triangles: 1, bytes: 1 });
    const base = {
      footprint: FOOTPRINT,
      probeCount: 0,
      grid: GRID,
      cache,
      prevLevel: 2,
      // Moved far enough to defeat hysteresis, so the plan is a commit either
      // way and the assertion is really about `isSwap`.
      prevCommit: { centre: [0, 0] as const, span: 675 },
      prevLod: { kind: "all" } as const,
      ladder: [],
      lodMode: "auto" as const,
      selectedLod: null,
    };
    for (const input of [
      { ...base, prevHiddenTypes: ["Building"], hiddenTypes: ["Building"] },
      { ...base, prevHiddenTypes: null, hiddenTypes: ["Building"] },
    ]) {
      const plan = planCommit(input);
      if (plan.kind !== "commit") throw new Error("expected commit");
      expect(plan.isSwap).toBe(false);
    }
  });

  it("commits (not a swap) with an EMPTY toFetch when hysteresis alone triggers a refresh of an already fully-covered view", () => {
    const cache = newCache();
    for (const k of DESIRED_16)
      cache.set(k, fakeEntry(k), { triangles: 1, bytes: 1 });
    const plan = planCommit({
      footprint: FOOTPRINT, // centre [337.5, 337.5], span 675
      probeCount: 0,
      grid: GRID,
      cache,
      prevLevel: 2,
      prevCommit: { centre: [0, 0], span: 675 }, // moved = hypot(337.5,337.5)=477.3 > 675*0.2=135
      prevLod: { kind: "all" },
      prevHiddenTypes: [],
      hiddenTypes: [],
      ladder: [],
      lodMode: "auto",
      selectedLod: null,
    });
    expect(plan.kind).toBe("commit");
    if (plan.kind !== "commit") throw new Error("expected commit");
    expect(plan.isSwap).toBe(false);
    expect(plan.toFetch).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
describe("commitNormal", () => {
  it("touches every desired cell (protecting it from LRU eviction) before evicting to budget", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: 100,
      maxBytes: Infinity,
    });
    cache.set("resident", fakeEntry("resident"), { triangles: 60, bytes: 0 }); // lastSeen 1
    cache.set("stale", fakeEntry("stale"), { triangles: 60, bytes: 0 }); // lastSeen 2, total 120 > 100
    const evicted = commitNormal(cache, ["resident"], new Map());
    expect(evicted).toEqual(["stale"]);
    expect(cache.has("resident")).toBe(true);
  });

  it("inserts newly fetched cells and leaves off-screen (non-desired) cells untouched — never calls retain()", () => {
    const cache = newCache();
    cache.set("off-screen", fakeEntry("off"), { triangles: 1, bytes: 1 });
    const fetched = new Map([
      [
        "new-cell",
        { entry: fakeEntry("new"), stats: { triangles: 1, bytes: 1 } },
      ],
    ]);
    const evicted = commitNormal(cache, ["new-cell"], fetched);
    expect(evicted).toEqual([]);
    expect(cache.has("off-screen")).toBe(true);
    expect(cache.get("new-cell")).toEqual(fetched.get("new-cell")!.entry);
  });
});

describe("commitSwap", () => {
  it("inserts the new cover's cells then retain()s, dropping everything outside it", () => {
    const cache = newCache();
    cache.set("old/A", fakeEntry("A"), { triangles: 1, bytes: 1 });
    cache.set("old/B", fakeEntry("B"), { triangles: 1, bytes: 1 });
    const fetched = new Map([
      [
        "new/A",
        { entry: fakeEntry("newA"), stats: { triangles: 1, bytes: 1 } },
      ],
    ]);
    const evicted = commitSwap(cache, ["new/A"], fetched);
    expect([...evicted].sort()).toEqual(["old/A", "old/B"]);
    expect(cache.has("old/A")).toBe(false);
    expect(cache.has("old/B")).toBe(false);
    expect(cache.has("new/A")).toBe(true);
  });

  it("also enforces the resident budget on the NEW cover — a swap (including the very first commit, since prevLevel=null makes it one) must not bypass evictToBudget (B4, 2026-07-28 final review)", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: 100,
      maxBytes: Infinity,
    });
    // The new cover alone (60+60=120 triangles) already exceeds the budget
    // (100) — no OLD cells are involved at all, so `retain()` alone (which
    // only drops cells outside `newCover`) would have nothing to drop and
    // silently accept a viewport 20% over budget.
    const fetched = new Map([
      ["new/A", { entry: fakeEntry("A"), stats: { triangles: 60, bytes: 0 } }],
      ["new/B", { entry: fakeEntry("B"), stats: { triangles: 60, bytes: 0 } }],
    ]);
    const evicted = commitSwap(cache, ["new/A", "new/B"], fetched);
    expect(cache.totals().triangles).toBeLessThanOrEqual(100);
    expect(evicted.length).toBeGreaterThan(0);
    // Exactly one of the two must have survived (60 fits, 120 doesn't).
    expect(cache.has("new/A") !== cache.has("new/B")).toBe(true);
  });
});
