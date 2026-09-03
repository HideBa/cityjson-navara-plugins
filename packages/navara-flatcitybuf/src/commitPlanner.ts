/**
 * The pure decision core of the streaming driver: footprint → probe budget →
 * level → desired/missing → hysteresis, plus the two cache-commit paths the
 * plan resolves to.
 *
 * Every function here is pure and store-free — no camera, no worker, no
 * Zustand — which is why the decision logic carries its own unit tests
 * (`tests/commitPlanner.test.ts`) rather than being exercised only through the
 * driver hook that calls it.
 */
import {
  appearanceThemesEqual,
  type AppearanceTheme,
} from "@cityjson/navara-core";
import { CellCache, type CellStats } from "./cellCache";
import {
  chooseLevel,
  cellSize,
  lodForCellSize,
  type LodSelection,
} from "./levelPolicy";
import { keysCovering, type CellKey, type Grid } from "./tileGrid";
import { shouldRefetch, type CommitView } from "./throttleGates";
import { VIEWPORT_FEATURE_BUDGET } from "./constants";
import type { CellGeometry } from "./workerProtocol";
import type { CellEntry } from "./streamLayer";
import type { Footprint } from "./viewportFootprint";

/**
 * `WorkerRequest['fetch'].lod` is `string | null` on the wire: it can carry
 * an EXACT label or "no filter" (`null`), but has no representation for
 * "unlabelled geometry only". This is not a gap introduced here:
 * `lodForCellSize` (`levelPolicy.ts`) never actually PRODUCES
 * `{kind:"unlabelled"}` — a ladder of length 0 already maps to `"all"` per
 * the design doc's §9 — so `sel.kind === "unlabelled"` is unreachable from
 * `resolveLod` below today. Mapped to `null` (same as "all") rather than
 * silently miscompiled, and documented rather than "fixed" by widening
 * `workerProtocol.ts`.
 */
export function lodToWireLabel(sel: LodSelection): string | null {
  return sel.kind === "exact" ? sel.lod : null;
}

/** The layer-level LoD choice this planner needs, as plain data — the store
 *  shape it used to be a `Pick<>` of stays in the app. */
export interface LodConfig {
  readonly lodMode: "auto" | "manual";
  readonly selectedLod: string | null;
}

/**
 * `cfg.selectedLod === null` already means "do not filter" for a manual
 * layer — same meaning a non-streaming layer gives it — so it resolves to
 * `"all"`, not `"unlabelled"`.
 */
export function resolveLod(
  cfg: LodConfig,
  ladder: ReadonlyArray<string>,
  cellSizeM: number,
): LodSelection {
  if (cfg.lodMode === "manual") {
    return cfg.selectedLod === null
      ? { kind: "all" }
      : { kind: "exact", lod: cfg.selectedLod };
  }
  return lodForCellSize(ladder, cellSizeM);
}

export function lodSelectionEquals(a: LodSelection, b: LodSelection): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "exact" && b.kind === "exact" ? a.lod === b.lod : true;
}

/** Order-and-content equality for two ladders. `buildLadder` always returns
 *  a freshly-allocated array (even when nothing new was observed), so a
 *  reference check can't tell "unchanged" from "same content, new array" —
 *  used to avoid an unnecessary `setLadder` store write (and the re-render
 *  it triggers) on every commit that observes no NEW LoD label. */
export function ladderEquals(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Order-and-content equality for two hidden-type lists. Both sides come from
 *  `FcbStreamLayerHandle`, which normalises (sorts and dedups) every list it
 *  accepts, so a positional compare is exact. */
export function hiddenTypesEqual(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Bytes actually held post-decode, mirroring `CellCache`'s "measured after
 *  decode, not predicted" budget doc — `triangleCount` alone doesn't bound
 *  memory, and `ruleColors` is optional so it must be counted only when
 *  present. */
export function cellStatsFromGeometry(g: CellGeometry): CellStats {
  return {
    triangles: g.triangleCount,
    bytes:
      g.positions.byteLength +
      g.normals.byteLength +
      g.baseColors.byteLength +
      (g.ruleColors?.byteLength ?? 0) +
      g.objectIndices.byteLength +
      g.surfaceIndices.byteLength +
      (g.uvs?.byteLength ?? 0),
  };
}

export interface PlanCommitInput {
  readonly footprint: Footprint | null;
  readonly probeCount: number | null;
  readonly grid: Grid;
  readonly cache: CellCache<CellEntry>;
  readonly prevLevel: number | null;
  readonly prevCommit: CommitView | null;
  readonly prevLod: LodSelection | null;
  /** The hidden-type list the RESIDENT cells were fetched under, or `null`
   *  before this layer's first commit. */
  readonly prevHiddenTypes: ReadonlyArray<string> | null;
  /** The theme the RESIDENT cells were baked under; `undefined` before this
   *  layer's first commit (`null` is a real value — plain colours). */
  readonly prevAppearance?: AppearanceTheme | null;
  readonly ladder: ReadonlyArray<string>;
  readonly lodMode: "auto" | "manual";
  readonly selectedLod: string | null;
  /** The hidden-type list the NEXT fetch will carry. */
  readonly hiddenTypes: ReadonlyArray<string>;
  /** The theme the NEXT fetch will bake. Omitted reads as `null`. */
  readonly appearance?: AppearanceTheme | null;
}

/** Value equality for two appearance selections (core's helper, re-exported
 *  under the name the planner's callers use). */
export const appearanceEquals = appearanceThemesEqual;

export type CommitPlan =
  | { readonly kind: "too-far"; readonly reason: string }
  | { readonly kind: "skip" }
  | {
      readonly kind: "commit";
      readonly level: number;
      readonly lod: LodSelection;
      readonly desired: readonly CellKey[];
      readonly toFetch: readonly CellKey[];
      readonly isSwap: boolean;
      readonly commitView: CommitView;
    };

/**
 * The pure decision core: footprint → probe budget → level → desired/missing
 * → hysteresis. No I/O — every impure step (probing, fetching, committing to
 * the cache/store) happens around a call to this function in
 * `commitStreamingLayer`, which is why this function (not the hook) carries
 * the dedicated test coverage for the decision logic.
 */
export function planCommit(input: PlanCommitInput): CommitPlan {
  const { footprint } = input;
  if (footprint === null) return { kind: "too-far", reason: "footprint" };
  if (input.probeCount === null) return { kind: "too-far", reason: "no-probe" };
  if (input.probeCount > VIEWPORT_FEATURE_BUDGET) {
    return { kind: "too-far", reason: "feature-budget" };
  }

  const level = chooseLevel(input.grid, footprint.bbox);
  if (level === null) return { kind: "too-far", reason: "no-level" };

  const desired = keysCovering(input.grid, footprint.bbox, level);
  const missing = desired.filter((k) => !input.cache.has(k));
  const hasHoles = missing.length > 0;
  const levelChanged = level !== input.prevLevel;

  const lod = resolveLod(
    { lodMode: input.lodMode, selectedLod: input.selectedLod },
    input.ladder,
    cellSize(input.grid, level),
  );
  // A LoD change invalidates every resident cell AT THE CURRENT LEVEL the
  // same way a level change invalidates the whole old level: the geometry
  // cached under an unchanged key was decoded under the OLD lod. Once
  // hasHoles stops being true for those keys (they're already resident,
  // just stale), hysteresis could otherwise serve stale-lod geometry
  // indefinitely on a pan back to them. Treated as a swap for that reason,
  // even though the eviction-policy text only names level changes by name.
  const lodChanged =
    input.prevLod !== null && !lodSelectionEquals(lod, input.prevLod);
  // Identical argument for the hidden-type set: a resident cell was BAKED
  // without the types hidden at fetch time, so a toggle leaves every cached
  // key stale under an unchanged key — invisible to `hasHoles`, and served
  // forever by hysteresis if it is not treated as a swap.
  const hiddenTypesChanged =
    input.prevHiddenTypes !== null &&
    !hiddenTypesEqual(input.hiddenTypes, input.prevHiddenTypes);
  // An appearance change is a swap for the same reason a hidden-type change
  // is: the worker BAKES it (vertex order, UVs, base colours), so a resident
  // cell built under the old theme cannot be patched, only refetched.
  const appearanceChanged =
    input.prevAppearance !== undefined &&
    !appearanceEquals(input.appearance ?? null, input.prevAppearance);
  const isSwap =
    levelChanged || lodChanged || hiddenTypesChanged || appearanceChanged;

  const commitView: CommitView = {
    centre: footprint.centre,
    span: footprint.span,
  };
  if (!shouldRefetch(input.prevCommit, commitView, hasHoles, isSwap)) {
    return { kind: "skip" };
  }

  return {
    kind: "commit",
    level,
    lod,
    desired,
    toFetch: isSwap ? desired : missing,
    isSwap,
    commitView,
  };
}

export interface FetchedCell {
  readonly entry: CellEntry;
  readonly stats: CellStats;
}

/**
 * Normal commit. Touches every DESIRED cell — including ones already
 * resident — which is what protects an off-screen-but-cached cell from
 * being starved out by `evictToBudget` on the very next commit. Inserts
 * newly fetched cells, then evicts down to budget. Never calls `retain()`:
 * dropping every cell outside the viewport on a normal commit would force a
 * refetch on every pan-back and defeat the entire reason the cache exists.
 */
export function commitNormal(
  cache: CellCache<CellEntry>,
  desired: ReadonlyArray<CellKey>,
  fetched: ReadonlyMap<CellKey, FetchedCell>,
): CellKey[] {
  for (const key of desired) cache.touch(key);
  for (const [key, { entry, stats }] of fetched) cache.set(key, entry, stats);
  return cache.evictToBudget();
}

/**
 * Level/LoD swap — the ONLY situation that calls `retain()`. Insert the new
 * cover's cells, then drop everything else in one all-or-nothing step: the
 * old level's (or old LoD's) cells can never be reused. Call this only
 * after the WHOLE new cover has fetched successfully; on a
 * a partial fetch the caller abandons (a stale epoch) must be discarded
 * and never call this, leaving the old level/cache untouched.
 *
 * Also enforces the resident budget on the NEW cover via `evictToBudget()`,
 * same as `commitNormal` — a swap is a legitimate commit path too (in
 * particular, the very FIRST commit for a freshly-opened layer: `prevLevel`
 * is null, so `planCommit`'s `levelChanged` is true and every initial load
 * is a swap), so skipping the budget check here let a complex enough
 * viewport blow past both declared budgets on first paint, undetected,
 * because `retain()` alone only drops cells OUTSIDE the new cover — it has
 * no opinion on whether the cover itself fits (B4, 2026-07-28 final review).
 */
export function commitSwap(
  cache: CellCache<CellEntry>,
  newCover: ReadonlyArray<CellKey>,
  fetched: ReadonlyMap<CellKey, FetchedCell>,
): CellKey[] {
  for (const [key, { entry, stats }] of fetched) cache.set(key, entry, stats);
  const droppedOldCover = cache.retain(newCover);
  const droppedOverBudget = cache.evictToBudget();
  return [...droppedOldCover, ...droppedOverBudget];
}
