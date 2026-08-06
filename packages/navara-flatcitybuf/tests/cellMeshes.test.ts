/**
 * Task C8: per-cell ENU mesh handles, content-changed resync (B1) and
 * stale-rule flagging (B2).
 *
 * The mesh factory is a recording fake implementing the REAL
 * `CityMeshHandle` (imported, not redeclared), so this file stays engine-free
 * and Node-runnable while still breaking loudly if the shared handle contract
 * gains a member.
 */
import { describe, it, expect, vi } from "vitest";
import proj4 from "proj4";
import {
  ensureProjDef,
  geodeticToEcef,
  makeEnuFrame,
} from "@cityjson/navara-core";
import {
  cellFrame,
  rulesStale,
  syncCellMeshes,
  type CellMesh,
} from "../src/cellMeshes";
import { CellCache } from "../src/cellCache";
import type { CellEntry } from "../src/streamLayer";
import { cellCentre, makeGrid, type Grid } from "../src/tileGrid";
import type { Rule } from "@cityjson/navara-core";
import type { CityMeshHandle, ThemeStyle } from "@cityjson/navara-cityjson";

const GRID: Grid = { originX: 0, originY: 0, rootCell: 1000, maxLevel: 4 };

function entry(tag: string, rules: ReadonlyArray<Rule> = []): CellEntry {
  return {
    geometry: {
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      baseColors: new Float32Array(9).fill(0.5),
      ruleColors: null,
      objectIndices: new Uint32Array(3),
      surfaceIndices: new Uint32Array(3),
      objectKeys: [tag],
      triangleCount: 1,
    },
    objects: [],
    surfaceAttrKeys: [],
    lodsSeen: [],
    builtWithRulesEnabled: rules.length > 0,
    builtWithRules: rules,
  };
}

/** Fake CityMeshHandle. Every member of the real interface is present —
 *  including `batchIdMap`/`resolveRaycast`, which Task C10b calls — so a
 *  future member added to the interface breaks this file loudly instead of
 *  only breaking at runtime in the streaming path. */
function factory() {
  const created: Array<{
    key: string;
    entry: CellEntry;
    frame: ReturnType<typeof makeEnuFrame>;
    deleted: boolean;
    handle: CityMeshHandle;
  }> = [];
  return {
    created,
    create(
      key: string,
      cellEntry: CellEntry,
      frame: ReturnType<typeof makeEnuFrame>,
    ) {
      const handle = {
        ref: null,
        setColors: vi.fn(),
        setVisible: vi.fn(),
        setThemeStyle: vi.fn(),
        triangleCount: () => 1,
        batchIdMap: () => [{ objectIndex: 0, surfaceIndex: 0 }],
        resolveRaycast: () => null,
        delete: () => {
          rec.deleted = true;
        },
      } satisfies CityMeshHandle;
      const rec = { key, entry: cellEntry, frame, deleted: false, handle };
      created.push(rec);
      return handle;
    },
  };
}

const RULE: Rule = {
  id: "r1",
  name: "n",
  color: "#ff0000",
  conditions: [],
  logic: "AND",
  enabled: true,
};

describe("cellFrame", () => {
  it("places the cell at its centre's geodetic position, not the grid origin", () => {
    const toLngLat = (x: number, y: number) =>
      [4.35 + x / 68000, 52.0 + y / 111000] as const;
    const f = cellFrame(GRID, "1/1/0", toLngLat); // centre = (750, 250)
    const want = makeEnuFrame(4.35 + 750 / 68000, 52.0 + 250 / 111000, 0);
    expect(f.lngDeg).toBeCloseTo(want.lngDeg, 12);
    expect(f.latDeg).toBeCloseTo(want.latDeg, 12);
    expect(f.heightM).toBe(0);
  });

  it("carries the layer's vertical-datum offset into the frame, matching what the worker used", () => {
    const toLngLat = (x: number, y: number) =>
      [4.35 + x / 68000, 52.0 + y / 111000] as const;
    const f = cellFrame(GRID, "1/1/0", toLngLat, 43);
    expect(f.heightM).toBe(43);
    // A 43 m lift moves the frame origin ~43 m further from the geocentre.
    const flat = cellFrame(GRID, "1/1/0", toLngLat, 0);
    const d = Math.hypot(
      f.originEcef[0] - flat.originEcef[0],
      f.originEcef[1] - flat.originEcef[1],
      f.originEcef[2] - flat.originEcef[2],
    );
    expect(d).toBeCloseTo(43, 6);
  });

  /**
   * CROSS-SEAM (Task C5 review, CRITICAL). `fcb.worker.ts` bakes every cell's
   * vertices in `makeEnuFrame(...place.toLngLat(cellCentre(grid, key, 0)),
   * place.heightOffset)`. If `cellFrame` builds anything else, every cell
   * floats, sinks or rotates — and nothing in either module's own tests would
   * notice, because each is self-consistent. So assert the two constructions
   * agree, element for element, using the SAME helpers the worker imports
   * (`makeGrid`/`cellCentre`, a proj4 EPSG->WGS84 converter, `makeEnuFrame`).
   *
   * `fcbWorkerCache.test.ts` carries the other half of this seam: the worker's
   * actually-emitted vertices, mapped back to ECEF through THIS `cellFrame`.
   */
  it("builds the identical frame the worker bakes its vertices in (cross-seam)", () => {
    const extent: [number, number, number, number, number, number] = [
      80000, 400000, 0, 180000, 500000, 30,
    ];
    const heightOffset = 43.25;
    const key = "2/1/2";
    const grid = makeGrid(extent);

    ensureProjDef(28992);
    const converter = proj4("EPSG:28992", "WGS84") as {
      forward(coords: [number, number]): [number, number];
    };

    // The worker's construction, verbatim (fcb.worker.ts, 'fetch' handler).
    const origin = cellCentre(grid, key, 0);
    const [cellLng, cellLat] = converter.forward([origin[0], origin[1]]);
    const workerFrame = makeEnuFrame(cellLng, cellLat, heightOffset);

    // This module's construction, from the same grid + key + converter.
    const mine = cellFrame(
      grid,
      key,
      (x, y) => converter.forward([x, y]),
      heightOffset,
    );

    expect(mine.lngDeg).toBe(workerFrame.lngDeg);
    expect(mine.latDeg).toBe(workerFrame.latDeg);
    expect(mine.heightM).toBe(workerFrame.heightM);
    expect([...mine.originEcef]).toEqual([...workerFrame.originEcef]);
    expect([...mine.matrix]).toEqual([...workerFrame.matrix]);

    // ...and the frame really is the one that puts the cell in the right
    // place on the globe: its origin is the cell centre's ECEF position,
    // raised by the vertical-datum offset.
    const truth = geodeticToEcef(cellLng, cellLat, heightOffset);
    expect(mine.originEcef[0]).toBeCloseTo(truth[0], 6);
    expect(mine.originEcef[1]).toBeCloseTo(truth[1], 6);
    expect(mine.originEcef[2]).toBeCloseTo(truth[2], 6);
    // A cell that far into the grid must NOT sit at the grid origin.
    const originCellEcef = geodeticToEcef(
      ...converter.forward([extent[0], extent[1]]),
      heightOffset,
    );
    expect(
      Math.hypot(
        mine.originEcef[0] - originCellEcef[0],
        mine.originEcef[1] - originCellEcef[1],
        mine.originEcef[2] - originCellEcef[2],
      ),
    ).toBeGreaterThan(1000);
  });
});

describe("syncCellMeshes", () => {
  const toLngLat = (x: number, y: number) =>
    [4.35 + x / 68000, 52.0 + y / 111000] as const;

  it("creates a mesh for a newly resident cell", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: 1e6,
      maxBytes: 1e9,
    });
    cache.set("1/0/0", entry("a"), { triangles: 1, bytes: 10 });
    const cells = new Map<string, CellMesh>();
    const f = factory();
    syncCellMeshes({
      cache,
      cells,
      grid: GRID,
      toLngLat,
      factory: f,
      visible: true,
      rules: [],
      rulesEnabled: false,
    });
    expect([...cells.keys()]).toEqual(["1/0/0"]);
    expect(f.created).toHaveLength(1);
  });

  // The same rule `visible` follows: a cell built while a theme is active has
  // to come up themed, because nothing revisits it afterwards.
  it("pushes the layer's active theme to a cell it builds", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: 1e6,
      maxBytes: 1e9,
    });
    cache.set("1/0/0", entry("a"), { triangles: 1, bytes: 10 });
    const themeStyle: ThemeStyle = {
      fill: "tint",
      tintRGB: [0.02, 0.02, 0.03],
      edges: { color: 0xffffff },
    };
    const f = factory();
    syncCellMeshes({
      cache,
      cells: new Map<string, CellMesh>(),
      grid: GRID,
      toLngLat,
      factory: f,
      visible: true,
      rules: [],
      rulesEnabled: false,
      themeStyle,
    });
    expect(f.created[0]!.handle.setThemeStyle).toHaveBeenCalledWith(themeStyle);
  });

  it("places each cell in its OWN frame, and hands the factory the layer's height offset", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: 1e6,
      maxBytes: 1e9,
    });
    cache.set("1/0/0", entry("a"), { triangles: 1, bytes: 10 });
    cache.set("1/1/1", entry("b"), { triangles: 1, bytes: 10 });
    const f = factory();
    syncCellMeshes({
      cache,
      cells: new Map<string, CellMesh>(),
      grid: GRID,
      toLngLat,
      factory: f,
      visible: true,
      rules: [],
      rulesEnabled: false,
      heightOffsetM: 43.25,
    });
    const byKey = new Map(f.created.map((c) => [c.key, c.frame]));
    expect(byKey.get("1/0/0")).toEqual(
      cellFrame(GRID, "1/0/0", toLngLat, 43.25),
    );
    expect(byKey.get("1/1/1")).toEqual(
      cellFrame(GRID, "1/1/1", toLngLat, 43.25),
    );
    expect(byKey.get("1/0/0")!.lngDeg).not.toBe(byKey.get("1/1/1")!.lngDeg);
    expect(byKey.get("1/0/0")!.heightM).toBe(43.25);
  });

  it("applies the layer's visibility and the cell's pre-baked rule colors on install", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: 1e6,
      maxBytes: 1e9,
    });
    const withColors = entry("a");
    const ruleColors = new Float32Array(9).fill(0.25);
    const colored: CellEntry = {
      ...withColors,
      geometry: { ...withColors.geometry, ruleColors },
    };
    cache.set("1/0/0", colored, { triangles: 1, bytes: 10 });
    const cells = new Map<string, CellMesh>();
    const f = factory();
    syncCellMeshes({
      cache,
      cells,
      grid: GRID,
      toLngLat,
      factory: f,
      visible: false,
      rules: [],
      rulesEnabled: false,
    });
    expect(f.created[0]!.handle.setVisible).toHaveBeenCalledWith(false);
    expect(f.created[0]!.handle.setColors).toHaveBeenCalledWith(ruleColors);
    const cell = cells.get("1/0/0")!;
    expect(cell.ruleColors).toBe(ruleColors);
    // baseColors is a COPY: highlighting mutates the live buffer in place and
    // needs an untouched restore baseline (same contract as a static layer).
    expect(cell.baseColors).not.toBe(colored.geometry.baseColors);
    expect(cell.baseColors).toEqual(colored.geometry.baseColors);
  });

  it("deletes the mesh of an evicted cell", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: 1e6,
      maxBytes: 1e9,
    });
    cache.set("1/0/0", entry("a"), { triangles: 1, bytes: 10 });
    const cells = new Map<string, CellMesh>();
    const f = factory();
    const args = {
      cache,
      cells,
      grid: GRID,
      toLngLat,
      factory: f,
      visible: true,
      rules: [],
      rulesEnabled: false,
    };
    syncCellMeshes(args);
    cache.retain([]);
    syncCellMeshes(args);
    expect(cells.size).toBe(0);
    expect(f.created[0]!.deleted).toBe(true);
  });

  it("REBUILDS a cell whose cache entry changed under an UNCHANGED key — a swap or refetch landing new data (B1)", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: 1e6,
      maxBytes: 1e9,
    });
    cache.set("1/0/0", entry("old"), { triangles: 1, bytes: 10 });
    const cells = new Map<string, CellMesh>();
    const f = factory();
    const args = {
      cache,
      cells,
      grid: GRID,
      toLngLat,
      factory: f,
      visible: true,
      rules: [],
      rulesEnabled: false,
    };
    syncCellMeshes(args);
    const fresh = entry("new");
    cache.set("1/0/0", fresh, { triangles: 1, bytes: 10 });
    syncCellMeshes(args);
    expect(f.created).toHaveLength(2);
    expect(f.created[0]!.deleted).toBe(true);
    expect(cells.get("1/0/0")!.sourceEntry).toBe(fresh);
    // The whole CellMesh moves on with the entry, not just `sourceEntry`:
    // a stale pickingIndex would resolve picks to the OLD object ids.
    expect(cells.get("1/0/0")!.pickingIndex.objectKeys).toEqual(["new"]);
    expect(cells.get("1/0/0")!.handle).toBe(f.created[1]!.handle);
    expect(f.created[1]!.deleted).toBe(false);
  });

  it("does NOT rebuild a cell whose entry is the same object across repeated syncs", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: 1e6,
      maxBytes: 1e9,
    });
    cache.set("1/0/0", entry("a"), { triangles: 1, bytes: 10 });
    const cells = new Map<string, CellMesh>();
    const f = factory();
    const args = {
      cache,
      cells,
      grid: GRID,
      toLngLat,
      factory: f,
      visible: true,
      rules: [],
      rulesEnabled: false,
    };
    syncCellMeshes(args);
    syncCellMeshes(args);
    syncCellMeshes(args);
    expect(f.created).toHaveLength(1);
  });

  it("flags a newly installed cell built with rules that no longer match the current ones (B2)", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: 1e6,
      maxBytes: 1e9,
    });
    cache.set("1/0/0", entry("a", [RULE]), { triangles: 1, bytes: 10 });
    const stale = syncCellMeshes({
      cache,
      cells: new Map(),
      grid: GRID,
      toLngLat,
      factory: factory(),
      visible: true,
      rules: [{ ...RULE, color: "#00ff00" }],
      rulesEnabled: true,
    });
    expect(stale).toEqual(["1/0/0"]);
  });

  it("does NOT flag a cell whose fetch already matches the current rules", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: 1e6,
      maxBytes: 1e9,
    });
    cache.set("1/0/0", entry("a", [RULE]), { triangles: 1, bytes: 10 });
    const stale = syncCellMeshes({
      cache,
      cells: new Map(),
      grid: GRID,
      toLngLat,
      factory: factory(),
      visible: true,
      rules: [RULE],
      rulesEnabled: true,
    });
    expect(stale).toEqual([]);
  });

  it("flags only the cells it (re)built, never an unchanged resident one (B2)", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: 1e6,
      maxBytes: 1e9,
    });
    const resident = entry("a", [RULE]);
    cache.set("1/0/0", resident, { triangles: 1, bytes: 10 });
    const cells = new Map<string, CellMesh>();
    const args = {
      cache,
      cells,
      grid: GRID,
      toLngLat,
      factory: factory(),
      visible: true,
      rules: [{ ...RULE, color: "#00ff00" }],
      rulesEnabled: true,
    };
    expect(syncCellMeshes(args)).toEqual(["1/0/0"]);
    // Second pass: same entry object, so nothing is rebuilt — and a cell that
    // was already flagged (and recolored by the caller) must not be flagged
    // again on every subsequent sync.
    expect(syncCellMeshes(args)).toEqual([]);
    // A LATE-arriving cell, though, is flagged the moment it is installed.
    cache.set("1/1/1", entry("b", [RULE]), { triangles: 1, bytes: 10 });
    expect(syncCellMeshes(args)).toEqual(["1/1/1"]);
  });
});

describe("rulesStale", () => {
  it("is false for disabled-vs-disabled regardless of rule content", () => {
    // Built with rules PRESENT but colorization OFF — `entry()`'s shorthand
    // ties the two together, so spell the disabled-with-rules case out. While
    // rules are off on both sides the baked colors cannot depend on them, so
    // no content difference makes the cell stale.
    const disabled: CellEntry = {
      ...entry("a", [RULE]),
      builtWithRulesEnabled: false,
    };
    expect(rulesStale(disabled, [], false)).toBe(false);
    expect(rulesStale(disabled, [{ ...RULE, color: "#00ff00" }], false)).toBe(
      false,
    );
  });
  it("is true when enabled-ness itself differs", () => {
    expect(rulesStale(entry("a"), [RULE], true)).toBe(true);
  });
  it("compares rules by VALUE, not reference — an equal-but-fresh array is not stale", () => {
    const e = entry("a", [RULE]);
    expect(rulesStale(e, [{ ...RULE }], true)).toBe(false);
    expect(rulesStale(e, [{ ...RULE, enabled: false }], true)).toBe(true);
  });
});
