/**
 * Per-cell mesh handles for a streaming layer: the mirror between the
 * main-thread cell cache and the engine meshes on screen.
 *
 * Replaces `src/scene/CitySceneR3F.tsx`'s `buildCellMesh` / `syncStreamingCells`
 * / `rulesStale`, with two differences that matter:
 *
 * - **Placement is a real ENU frame per cell**, not a scene-origin offset. The
 *   worker already baked each cell's vertices as exact local-ENU metres in
 *   `makeEnuFrame(cellLng, cellLat, heightOffset)` (Task C5 Step 4b), so this
 *   module rebuilds the identical frame and the engine uses it as the mesh's
 *   `matrixWorld`. `meshOffset`/`sceneTransform` are retired.
 * - **The engine is injected**, via {@link CellMeshFactory}: nothing here
 *   imports `@navaramap/*` or Three, so it is Node-testable (Global Constraints
 *   -> Testing conventions).
 */
import {
  makeEnuFrame,
  type EnuFrame,
  type PickingIndex,
  type Rule,
} from "@cityjson/navara-core";
// Type-only import: `@cityjson/navara-cityjson`'s barrel re-exports the
// engine-binding modules, but `import type` is erased at compile time, so
// this file stays runnable in Node (Global Constraints -> Testing
// conventions).
//
// These are imported rather than redeclared: a local copy would drift the
// moment either side gained a member — and Task C10b resolves picks through
// exactly `batchIdMap()`/`resolveRaycast()` on this handle.
import type { CityMeshHandle } from "@cityjson/navara-cityjson";
import { cellCentre, type CellKey, type Grid } from "./tileGrid";
import type { CellCache } from "./cellCache";
import type { CellEntry } from "./streamLayer";

/**
 * The engine seam. Task C11's implementation calls
 * `addCityMeshArrays(view, { id, arrays, frame, layerId, cellKey: key })`;
 * tests pass a recording fake. `frame` is the cell's own ENU->ECEF frame —
 * the mesh's `matrixWorld` — and `entry.geometry.positions` are already
 * metres in it.
 *
 * One constraint on the implementation: `CityMeshArraysMesh` *wraps* the color
 * array it is given rather than copying it, and {@link syncCellMeshes} calls
 * `setColors(entry.geometry.ruleColors)` right after `create`. So the arrays
 * handed to the engine must not wrap EITHER of the entry's color buffers —
 * pass `Float32Array.from(ruleColors ?? baseColors)`, which is exactly what
 * `entryToArrays` does. Both branches copy:
 *
 * - wrapping `baseColors` would land the `setColors(ruleColors)` write in the
 *   cache entry's own base buffer, destroying the restore baseline
 *   {@link CellMesh.baseColors} is copied from one line later;
 * - wrapping `ruleColors` is the same hazard one layer on — {@link CellMesh}
 *   holds that buffer by reference and it is the *source* the highlight
 *   restores from, while `paintLayers` writes the highlight into the live
 *   *target* array in place. Alias the two and `source === target`: the
 *   restore becomes a self-copy no-op and a highlight can never be cleared
 *   (proved by Task C10a; `entryToArrays.ts` carries the full reasoning).
 */
export interface CellMeshFactory {
  create(key: CellKey, entry: CellEntry, frame: EnuFrame): CityMeshHandle;
}

export interface CellMesh {
  readonly handle: CityMeshHandle;
  readonly pickingIndex: PickingIndex;
  /** A COPY of the entry's base colors, never the live GPU buffer: highlight
   *  paints into the live buffer in place and needs an untouched restore
   *  baseline (same contract as the static layer path). */
  readonly baseColors: Float32Array;
  ruleColors: Float32Array | null;
  /** Reference identity of the CellEntry this mesh was built from: how a
   *  same-key content change (level/LoD swap, or a settle refetching an
   *  already-resident key) is detected. CellCache.set() always installs a
   *  fresh object, so `!==` is exact (B1, 2026-07-28 final review). */
  sourceEntry: CellEntry;
}

/** The cell's own ENU frame: cell centre in source CRS -> lng/lat -> ENU at
 *  the layer's vertical-datum offset. MUST be built the same way the worker
 *  built it (Task C5 Step 4b) — same function, same arguments — because the
 *  worker's vertices are already exact local-ENU metres in this frame. A
 *  disagreement here floats or sinks every cell by the offset and rotates it
 *  by the grid convergence; `tests/fcbWorkerCache.test.ts` asserts the two
 *  sides agree against the worker's real output. */
export function cellFrame(
  grid: Grid,
  key: CellKey,
  toLngLat: (x: number, y: number) => readonly [number, number],
  heightOffsetM = 0,
): EnuFrame {
  const c = cellCentre(grid, key, 0);
  const [lng, lat] = toLngLat(c[0], c[1]);
  return makeEnuFrame(lng, lat, heightOffsetM);
}

/** Whether `entry.geometry.ruleColors` was baked from rules other than the
 *  CURRENT ones. Disabled-vs-disabled never differs regardless of rule content
 *  (colors don't depend on it), so the rule-array comparison only runs when
 *  both are enabled. Rule arrays are small and edited far less often than
 *  cells are installed, so a `JSON.stringify` comparison is cheap — and,
 *  unlike reference identity, it doesn't depend on every rule-editing call
 *  site replacing the array wholesale. */
export function rulesStale(
  entry: CellEntry,
  rules: ReadonlyArray<Rule>,
  rulesEnabled: boolean,
): boolean {
  if (entry.builtWithRulesEnabled !== rulesEnabled) return true;
  if (!rulesEnabled) return false;
  return JSON.stringify(entry.builtWithRules) !== JSON.stringify(rules);
}

export interface SyncCtx {
  readonly cache: CellCache<CellEntry>;
  readonly cells: Map<CellKey, CellMesh>;
  readonly grid: Grid;
  readonly toLngLat: (x: number, y: number) => readonly [number, number];
  readonly factory: CellMeshFactory;
  readonly visible: boolean;
  readonly rules: ReadonlyArray<Rule>;
  readonly rulesEnabled: boolean;
  /** Vertical-datum offset the worker already applied; the frame must match. */
  readonly heightOffsetM?: number;
  /** Stamped into each new cell's `PickingIndex` so a pick resolves to the
   *  owning layer. `PickingIndex.layerId` is readonly, so the caller cannot
   *  fill it after the fact without rebuilding the `CellMesh` — it is passed
   *  in instead. Defaults to `""` for callers that don't route picks. */
  readonly layerId?: string;
}

/**
 * Mirrors the resident-cell cache into engine meshes: builds one for every
 * newly resident cell and deletes the handle of every cell the cache no longer
 * holds (an eviction or a `retain`).
 *
 * Also **rebuilds a cell whose cache ENTRY changed under an UNCHANGED key** —
 * a level/LoD swap, or an ordinary settle refetching a key that was already
 * resident, landing new geometry/objects without the key ever leaving the
 * cache. A plain `cells.has(key)` skip cannot see that: the OLD mesh, OLD
 * pickingIndex and OLD baseColors would persist forever under a key the cache
 * had already moved on from (B1, 2026-07-28 final review).
 *
 * Returns the keys of cells built (or rebuilt) here whose baked colours no
 * longer match the current rules — a fetch that was in flight when the user
 * edited a rule and landed carrying colors from the OLD ones. The layer's own
 * "rules changed" effect only recolors cells that were ALREADY resident when
 * it ran, so a cell installed later would otherwise never be revisited and
 * would show stale colors indefinitely. The caller fires a targeted recolor
 * for exactly these (B2).
 */
export function syncCellMeshes(ctx: SyncCtx): CellKey[] {
  const cacheKeys = new Set(ctx.cache.keys());
  const stale: CellKey[] = [];

  // Deleting the CURRENT key of a Map mid-iteration is well-defined (the key
  // was already visited, so it is neither revisited nor skipped) — no
  // defensive copy needed.
  for (const [key, cell] of ctx.cells) {
    if (cacheKeys.has(key)) continue;
    cell.handle.delete();
    ctx.cells.delete(key);
  }

  for (const key of cacheKeys) {
    const entry = ctx.cache.get(key);
    // Evicted between keys() and get() — the next sync picks it up if it is
    // re-fetched.
    if (!entry) continue;
    const existing = ctx.cells.get(key);
    if (existing && existing.sourceEntry === entry) continue;
    if (existing) existing.handle.delete();

    const handle = ctx.factory.create(
      key,
      entry,
      cellFrame(ctx.grid, key, ctx.toLngLat, ctx.heightOffsetM ?? 0),
    );
    handle.setVisible(ctx.visible);
    if (entry.geometry.ruleColors) handle.setColors(entry.geometry.ruleColors);
    ctx.cells.set(key, {
      handle,
      pickingIndex: {
        layerId: ctx.layerId ?? "",
        objectKeys: entry.geometry.objectKeys,
      },
      baseColors: Float32Array.from(entry.geometry.baseColors),
      ruleColors: entry.geometry.ruleColors,
      sourceEntry: entry,
    });
    if (rulesStale(entry, ctx.rules, ctx.rulesEnabled)) stale.push(key);
  }

  return stale;
}
