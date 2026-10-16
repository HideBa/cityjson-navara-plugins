/**
 * Merges a streaming layer's resident cells into a flat view for consumers
 * (stats, inspector, table, rule builder) that need "the objects currently
 * loaded for this layer" without caring about cell boundaries.
 *
 * Deliberately a plain memoised function over the cache, NOT a store selector.
 * A layer's version bumps on every cell commit — every pan/zoom settle — and a
 * subscription-based state library re-evaluates every selector on every
 * notification to decide whether to re-render. A selector shaped like
 * `s => residentModel(s)` would rebuild this merged Record on every single
 * commit, whether or not anything ever reads the result: exactly the eager
 * materialization viewport streaming exists to avoid. Calling this
 * imperatively from a mounted consumer's render body means the merge only runs
 * when something actually asks for it, and the memo means even repeated calls
 * at the same version are free (a comparison, not a rebuild).
 *
 * The cache comes in as an argument rather than being read from a store, so
 * this module is store-free and testable without one: the app's per-layer
 * store binding lives in its own shim (`src/features/streaming/residentModel`),
 * which owns one `createResidentModelMemo()` per layer id.
 */
import type { CellCache } from "./cellCache";
import type { CellEntry } from "./streamLayer";
import type { ResidentObjectRecord } from "./workerProtocol";

export interface ResidentModel {
  readonly objects: Readonly<Record<string, ResidentObjectRecord>>;
  readonly cellCount: number;
  readonly featureCount: number;
  readonly surfaceAttrKeys: ReadonlyArray<string>;
}

/**
 * Merges every resident cell in `cache` into one flat model. Pure: same cache
 * contents in, equal model out (a fresh object each call — see
 * `createResidentModelMemo` for reference stability).
 */
export function buildResidentModel(
  cache: CellCache<CellEntry>,
): ResidentModel {
  const objects: Record<string, ResidentObjectRecord> = {};
  const attrKeys = new Set<string>();
  let cellCount = 0;

  for (const key of cache.keys()) {
    const entry = cache.get(key);
    if (!entry) continue; // evicted between keys() and get() — skip, don't fabricate
    cellCount++;
    for (const obj of entry.objects) {
      objects[obj.id] = obj;
    }
    for (const attrKey of entry.surfaceAttrKeys) attrKeys.add(attrKey);
  }

  return {
    objects,
    cellCount,
    featureCount: Object.keys(objects).length,
    surfaceAttrKeys: [...attrKeys].sort(),
  };
}

/**
 * Creates a single-entry memo over `buildResidentModel`: it holds the most
 * recently computed model plus the (cache, version) it was computed from, and
 * returns that identical object — reference equality — when asked again for
 * the same pair, so callers can use the result directly as a `useMemo`/
 * `useEffect` dependency. Any other pair recomputes and replaces the one
 * entry; there is no history to keep and nothing recomputes until a caller
 * actually asks.
 *
 * `version` is supplied by the caller (the layer's commit counter) rather than
 * derived here, because the cache mutates in place: its identity cannot tell
 * you that a cell was committed. The cache is part of the key too, so a layer
 * that is torn down and re-registered with a fresh cache can never be served a
 * model merged from the old one.
 *
 * One memo per layer — a shared one would thrash between layers.
 */
export function createResidentModelMemo(): (
  cache: CellCache<CellEntry>,
  version: number,
) => ResidentModel {
  let cached: {
    cache: CellCache<CellEntry>;
    version: number;
    model: ResidentModel;
  } | null = null;
  return (cache, version) => {
    if (cached && cached.version === version && cached.cache === cache) {
      return cached.model;
    }
    const model = buildResidentModel(cache);
    cached = { cache, version, model };
    return model;
  };
}
