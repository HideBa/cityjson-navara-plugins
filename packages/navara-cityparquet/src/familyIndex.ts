/**
 * The family index of a CityParquet stream: which row ranges to read for a
 * viewport box.
 *
 * A **family** is a root row (its `parents` is null or empty) plus the
 * contiguous following rows that do have parents — a Building and its parts,
 * as the CityParquet writer lays them out. A leading non-root run at a table's
 * start (no root before it) is a family of its own. Families are the unit of
 * reading: a query returns whole families only, because a part is drawn with,
 * and picks through, its root.
 *
 * A family's box is the union of its VALID rows' boxes (all six coordinates
 * finite); a family with no valid row cannot be placed and is left out of the
 * index, its rows counted in `invalidBBoxRows`. Invalid rows are still read
 * when they sit inside a family (or a merge gap) that a query returns.
 *
 * The index holds per-family typed arrays only — start, end and a 2D box —
 * and a query is a linear scan: on the largest known source (884 106 rows)
 * that is well under a frame's worth of work, and it keeps the structure as
 * small as the columns it was built from.
 *
 * Engine-free: no `@navaramap/*` imports.
 */

import type { BBox3 } from "@cityjson/navara-core";

/** Hit families closer than this many rows are read as one range: a range
 *  read costs a request (or a page decode) of its own, so bridging a small
 *  gap is cheaper than splitting it, while a larger gap would read rows no
 *  viewport asked for. */
export const MERGE_GAP_ROWS = 1024;

export interface FamilyRange {
  readonly table: number;
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

export interface FamilyIndex {
  /** Rows with a valid bbox. */
  readonly rowCount: number;
  /** Rows excluded from placement: a missing or non-finite bbox. */
  readonly invalidBBoxRows: number;
  /** Union of every valid row's box, in the coordinates the columns were
   *  given in (the stream's projected CRS). All-NaN when no row is valid. */
  readonly extent: BBox3;
  /** Ranges covering every family whose union bbox intersects `bbox`,
   *  merged across gaps ≤ {@link MERGE_GAP_ROWS}, in table then row order. */
  query(bbox: readonly [number, number, number, number]): FamilyRange[];
  /** Rows `query(bbox)` would read, gaps included — the probe's answer. */
  readCost(bbox: readonly [number, number, number, number]): number;
}

/** One table's packed `bbox` + `parents` columns, one entry per row. */
export interface FamilyColumns {
  readonly minX: Float64Array;
  readonly minY: Float64Array;
  readonly minZ: Float64Array;
  readonly maxX: Float64Array;
  readonly maxY: Float64Array;
  readonly maxZ: Float64Array;
  /** 1 where `parents` is null/empty. */
  readonly isRoot: Uint8Array;
}

/** One table's families, packed: `[start, end)` and a 2D union box each. */
interface TableFamilies {
  readonly start: Uint32Array;
  readonly end: Uint32Array;
  readonly minX: Float64Array;
  readonly minY: Float64Array;
  readonly maxX: Float64Array;
  readonly maxY: Float64Array;
}

function isValidRow(cols: FamilyColumns, i: number): boolean {
  return (
    Number.isFinite(cols.minX[i]!) &&
    Number.isFinite(cols.minY[i]!) &&
    Number.isFinite(cols.minZ[i]!) &&
    Number.isFinite(cols.maxX[i]!) &&
    Number.isFinite(cols.maxY[i]!) &&
    Number.isFinite(cols.maxZ[i]!)
  );
}

export function buildFamilyIndex(
  tables: ReadonlyArray<FamilyColumns>,
): FamilyIndex {
  let rowCount = 0;
  let invalidBBoxRows = 0;
  const extent = [
    Infinity,
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
    -Infinity,
  ];
  const packed: TableFamilies[] = [];

  for (const cols of tables) {
    const n = cols.isRoot.length;
    for (const column of [
      cols.minX,
      cols.minY,
      cols.minZ,
      cols.maxX,
      cols.maxY,
      cols.maxZ,
    ]) {
      if (column.length !== n) {
        throw new Error(
          "buildFamilyIndex: every column of a table must have one entry per row.",
        );
      }
    }
    const start: number[] = [];
    const end: number[] = [];
    const minX: number[] = [];
    const minY: number[] = [];
    const maxX: number[] = [];
    const maxY: number[] = [];

    let i = 0;
    while (i < n) {
      const familyStart = i;
      let fx0 = Infinity;
      let fy0 = Infinity;
      let fx1 = -Infinity;
      let fy1 = -Infinity;
      let valid = 0;
      do {
        if (isValidRow(cols, i)) {
          valid += 1;
          fx0 = Math.min(fx0, cols.minX[i]!);
          fy0 = Math.min(fy0, cols.minY[i]!);
          fx1 = Math.max(fx1, cols.maxX[i]!);
          fy1 = Math.max(fy1, cols.maxY[i]!);
          extent[2] = Math.min(extent[2]!, cols.minZ[i]!);
          extent[5] = Math.max(extent[5]!, cols.maxZ[i]!);
        } else {
          invalidBBoxRows += 1;
        }
        i += 1;
      } while (i < n && cols.isRoot[i] === 0);

      if (valid === 0) continue;
      rowCount += valid;
      start.push(familyStart);
      end.push(i);
      minX.push(fx0);
      minY.push(fy0);
      maxX.push(fx1);
      maxY.push(fy1);
      extent[0] = Math.min(extent[0]!, fx0);
      extent[1] = Math.min(extent[1]!, fy0);
      extent[3] = Math.max(extent[3]!, fx1);
      extent[4] = Math.max(extent[4]!, fy1);
    }

    packed.push({
      start: Uint32Array.from(start),
      end: Uint32Array.from(end),
      minX: Float64Array.from(minX),
      minY: Float64Array.from(minY),
      maxX: Float64Array.from(maxX),
      maxY: Float64Array.from(maxY),
    });
  }

  const finalExtent = (rowCount === 0
    ? extent.map(() => Number.NaN)
    : extent) as unknown as BBox3;

  function query(
    bbox: readonly [number, number, number, number],
  ): FamilyRange[] {
    const [qx0, qy0, qx1, qy1] = bbox;
    const out: FamilyRange[] = [];
    packed.forEach((families, table) => {
      let open: { start: number; end: number } | null = null;
      for (let f = 0; f < families.start.length; f++) {
        if (
          families.minX[f]! > qx1 ||
          families.maxX[f]! < qx0 ||
          families.minY[f]! > qy1 ||
          families.maxY[f]! < qy0
        ) {
          continue;
        }
        const s = families.start[f]!;
        const e = families.end[f]!;
        if (open !== null && s - open.end <= MERGE_GAP_ROWS) {
          open.end = e;
        } else {
          if (open !== null) out.push({ table, ...open });
          open = { start: s, end: e };
        }
      }
      if (open !== null) out.push({ table, ...open });
    });
    return out;
  }

  return {
    rowCount,
    invalidBBoxRows,
    extent: finalExtent,
    query,
    readCost: (bbox) =>
      query(bbox).reduce((rows, r) => rows + (r.end - r.start), 0),
  };
}
