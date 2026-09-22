/**
 * The family index over a stream's packed `bbox` + `parents` columns.
 *
 * A family is a root row (no parents) plus the contiguous non-root rows after
 * it; a query must hand back whole families only, because a building's parts
 * are drawn with (and pick through) their root. Ranges merge across small gaps
 * so a dense viewport becomes a few long reads, but never so far that a sparse
 * hit pattern degenerates into a whole-table read.
 */

import { describe, expect, it } from "vitest";
import type { FamilyColumns, FamilyRange } from "../src/familyIndex";
import { MERGE_GAP_ROWS, buildFamilyIndex } from "../src/familyIndex";

/** One synthetic row: its 2D footprint centre, or `null` for a missing bbox. */
interface SyntheticRow {
  root: boolean;
  at: readonly [number, number] | null;
}

function pack(rows: ReadonlyArray<SyntheticRow>): FamilyColumns {
  const n = rows.length;
  const cols = {
    minX: new Float64Array(n),
    minY: new Float64Array(n),
    minZ: new Float64Array(n),
    maxX: new Float64Array(n),
    maxY: new Float64Array(n),
    maxZ: new Float64Array(n),
    isRoot: new Uint8Array(n),
  };
  rows.forEach((row, i) => {
    cols.isRoot[i] = row.root ? 1 : 0;
    const [x, y] = row.at ?? [Number.NaN, Number.NaN];
    cols.minX[i] = x - 2;
    cols.minY[i] = y - 2;
    cols.minZ[i] = 0;
    cols.maxX[i] = x + 2;
    cols.maxY[i] = y + 2;
    cols.maxZ[i] = 10;
  });
  return cols;
}

/** A deterministic PRNG, so a failing case reproduces. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const CLUSTERS = [
  [0, 0],
  [5000, 0],
  [0, 5000],
] as const;

interface Family {
  table: number;
  start: number;
  end: number;
  cluster: number;
  /** Union of the family's valid rows' boxes, or null when none is valid. */
  box: [number, number, number, number] | null;
}

/**
 * Two tables of families of 1–4 rows. Each table is three contiguous blocks,
 * one per cluster, with a few cluster-0 families sprinkled far inside the
 * cluster-2 block; about 5% of rows have no bbox, and some families have none
 * valid at all.
 */
function clusteredTables(): { tables: FamilyColumns[]; families: Family[] } {
  const rand = lcg(42);
  const families: Family[] = [];
  const tables: FamilyColumns[] = [];
  for (let table = 0; table < 2; table++) {
    const rows: SyntheticRow[] = [];
    for (let block = 0; block < 3; block++) {
      while (rows.length < (block + 1) * 3000) {
        const sprinkled = block === 2 && rows.length % 1500 < 4;
        const cluster = sprinkled ? 0 : block;
        const size = 1 + Math.floor(rand() * 4);
        const allInvalid = rand() < 0.02;
        const start = rows.length;
        let box: Family["box"] = null;
        for (let k = 0; k < size; k++) {
          const invalid = allInvalid || rand() < 0.05;
          const [cx, cy] = CLUSTERS[cluster]!;
          const at: [number, number] | null = invalid
            ? null
            : [cx + rand() * 400, cy + rand() * 400];
          rows.push({ root: k === 0, at });
          if (at) {
            const [x, y] = at;
            box = box
              ? [
                  Math.min(box[0], x - 2),
                  Math.min(box[1], y - 2),
                  Math.max(box[2], x + 2),
                  Math.max(box[3], y + 2),
                ]
              : [x - 2, y - 2, x + 2, y + 2];
          }
        }
        families.push({ table, start, end: rows.length, cluster, box });
      }
    }
    tables.push(pack(rows));
  }
  return { tables, families };
}

function intersects(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function covered(ranges: FamilyRange[], f: Family): boolean {
  return ranges.some(
    (r) => r.table === f.table && r.start <= f.start && f.end <= r.end,
  );
}

describe("buildFamilyIndex", () => {
  const { tables, families } = clusteredTables();
  const index = buildFamilyIndex(tables);
  const boundaries = new Set(
    families.flatMap((f) => [`${f.table}:${f.start}`, `${f.table}:${f.end}`]),
  );

  it("counts valid and invalid rows and bounds the valid ones", () => {
    const invalid = tables.reduce(
      (n, t) => n + Array.from(t.minX).filter((v) => Number.isNaN(v)).length,
      0,
    );
    const total = tables.reduce((n, t) => n + t.isRoot.length, 0);
    expect(invalid).toBeGreaterThan(0);
    expect(index.invalidBBoxRows).toBe(invalid);
    expect(index.rowCount).toBe(total - invalid);
    const [x0, y0, , x1, y1] = index.extent;
    for (const f of families) {
      if (!f.box) continue;
      expect(f.box[0]).toBeGreaterThanOrEqual(x0);
      expect(f.box[1]).toBeGreaterThanOrEqual(y0);
      expect(f.box[2]).toBeLessThanOrEqual(x1);
      expect(f.box[3]).toBeLessThanOrEqual(y1);
    }
    expect(index.extent[2]).toBe(0);
    expect(index.extent[5]).toBe(10);
  });

  for (const [name, box] of [
    ["cluster 0", [100, 100, 250, 250]],
    ["cluster 1", [5000, 0, 5400, 400]],
    ["cluster 2 corner", [0, 5000, 60, 5060]],
    ["between clusters", [2000, 2000, 2100, 2100]],
  ] as const) {
    it(`covers every family intersecting ${name} whole, and nothing out of bounds`, () => {
      const ranges = index.query(box);
      const hits = families.filter((f) => f.box && intersects(f.box, box));
      for (const f of hits) expect(covered(ranges, f)).toBe(true);

      for (const r of ranges) {
        const rows = tables[r.table]!.isRoot.length;
        expect(r.start).toBeGreaterThanOrEqual(0);
        expect(r.end).toBeLessThanOrEqual(rows);
        expect(r.end).toBeGreaterThan(r.start);
        // No family is split across a range boundary.
        expect(boundaries.has(`${r.table}:${r.start}`)).toBe(true);
        expect(boundaries.has(`${r.table}:${r.end}`)).toBe(true);
        // Every range holds at least one hit: invalid rows only ride along.
        expect(hits.some((f) => covered([r], f))).toBe(true);
      }
      expect(index.readCost(box)).toBe(
        ranges.reduce((n, r) => n + (r.end - r.start), 0),
      );
    });
  }

  it("keeps the sprinkled far families as separate ranges instead of one whole-table read", () => {
    const box = [0, 0, 400, 400] as const;
    const ranges = index.query(box).filter((r) => r.table === 0);
    expect(ranges.length).toBeGreaterThan(1);
    const rows = tables[0]!.isRoot.length;
    const read = ranges.reduce((n, r) => n + (r.end - r.start), 0);
    expect(read).toBeLessThan(rows / 2);
  });

  it("returns nothing for a box that hits no family", () => {
    const box = [-9000, -9000, -8000, -8000] as const;
    expect(index.query(box)).toEqual([]);
    expect(index.readCost(box)).toBe(0);
  });

  it.each([
    ["a NaN corner", [Number.NaN, 0, 400, 400]],
    ["an infinite corner", [0, 0, Number.POSITIVE_INFINITY, 400]],
    ["an inverted x span", [400, 0, 0, 400]],
    ["an inverted y span", [0, 400, 400, 0]],
  ] as const)("returns nothing for a box with %s", (_, box) => {
    expect(index.query(box)).toEqual([]);
    expect(index.readCost(box)).toBe(0);
  });
});

describe("family boundaries", () => {
  it("makes a leading non-root run at a table start its own family", () => {
    const index = buildFamilyIndex([
      pack([
        { root: false, at: [0, 0] },
        { root: false, at: [100, 0] },
        { root: true, at: [200, 0] },
        { root: false, at: [300, 0] },
      ]),
    ]);
    expect(index.query([99, -1, 101, 1])).toEqual([
      { table: 0, start: 0, end: 2 },
    ]);
    expect(index.query([299, -1, 301, 1])).toEqual([
      { table: 0, start: 2, end: 4 },
    ]);
  });

  it("finds a family by any valid member, and excludes a family with none", () => {
    const index = buildFamilyIndex([
      pack([
        { root: true, at: null },
        { root: false, at: [500, 500] },
        { root: true, at: null },
        { root: false, at: null },
      ]),
    ]);
    expect(index.invalidBBoxRows).toBe(3);
    expect(index.rowCount).toBe(1);
    expect(index.query([499, 499, 501, 501])).toEqual([
      { table: 0, start: 0, end: 2 },
    ]);
    expect(index.query([-1e9, -1e9, 1e9, 1e9])).toEqual([
      { table: 0, start: 0, end: 2 },
    ]);
  });

  it("merges families across a gap of MERGE_GAP_ROWS, not one row more", () => {
    const rows = (gap: number): SyntheticRow[] => [
      { root: true, at: [0, 0] },
      ...Array.from({ length: gap }, () => ({
        root: true,
        at: [9000, 9000] as const,
      })),
      { root: true, at: [0, 0] },
    ];
    const box = [-1, -1, 1, 1] as const;
    const merged = buildFamilyIndex([pack(rows(MERGE_GAP_ROWS))]).query(box);
    expect(merged).toEqual([{ table: 0, start: 0, end: MERGE_GAP_ROWS + 2 }]);
    const split = buildFamilyIndex([pack(rows(MERGE_GAP_ROWS + 1))]).query(box);
    expect(split).toHaveLength(2);
  });
});

describe("a sparse hit pattern", () => {
  it("reads about one family per hit across 50 000 rows, never the whole table", () => {
    const ROWS = 50_000;
    const EVERY = 1_100;
    const rand = lcg(7);
    const rows: SyntheticRow[] = [];
    let largestFamily = 0;
    while (rows.length < ROWS) {
      const size = Math.min(1 + Math.floor(rand() * 4), ROWS - rows.length);
      largestFamily = Math.max(largestFamily, size);
      const start = rows.length;
      // A family is a hit when it contains a multiple of EVERY.
      const hit = Math.floor((start + size - 1) / EVERY) * EVERY >= start;
      for (let k = 0; k < size; k++) {
        rows.push({
          root: k === 0,
          at: hit ? [0, 0] : [10_000 + start, 10_000],
        });
      }
    }
    const index = buildFamilyIndex([pack(rows)]);
    const box = [-5, -5, 5, 5] as const;
    const ranges = index.query(box);
    const hits = Math.ceil(ROWS / EVERY);
    const total = ranges.reduce((n, r) => n + (r.end - r.start), 0);
    expect(ranges).toHaveLength(hits);
    expect(total).toBeLessThanOrEqual(hits * largestFamily);
    expect(index.readCost(box)).toBe(total);
  });
});
