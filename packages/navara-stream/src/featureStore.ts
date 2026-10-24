/**
 * The decoded features the stream worker has read, per cell, so that a LoD,
 * appearance or level change over cells already read re-bakes them instead of
 * reading the source again (`docs/plans/2026-10-24-phase-4-step-1-design.md`
 * in the app).
 *
 * An entry is one requested cell's bare model — source or bucket coordinates,
 * never a per-cell ENU copy — holding exactly the objects the cell OWNS at its
 * level, plus the LoD ceiling of the read that filled it. Only cells that were
 * requested are filed: a read returns every feature that intersects the query,
 * and the features owned by a cell nobody asked for are an incomplete picture
 * of that cell.
 *
 * A miss costs a read, never a wrong answer: the budget only ever drops
 * entries.
 */
import type { CityModel, CityObject } from "@cityjson/navara-core";
import type { CellKey } from "./tileGrid";

/** Order-of-magnitude retained bytes per element of a decoded model; see
 *  `estimateRetainedBytes` in `streamWorkerCore.ts`, which builds on these. */
export const BYTES_PER_OBJECT = 320;
export const BYTES_PER_SURFACE = 160;
export const BYTES_PER_RING = 40;
export const BYTES_PER_VERTEX = 88;

/** What a decoded model retains, estimated from its structure (±50 %). */
export function modelBytes(model: CityModel): number {
  let objects = 0;
  let surfaces = 0;
  let rings = 0;
  let vertices = 0;
  for (const obj of Object.values(model.objects)) {
    if (!obj) continue;
    objects += 1;
    for (const surface of obj.surfaces) {
      surfaces += 1;
      for (const ring of surface.rings) {
        rings += 1;
        vertices += ring.length;
      }
    }
  }
  return (
    objects * BYTES_PER_OBJECT +
    surfaces * BYTES_PER_SURFACE +
    rings * BYTES_PER_RING +
    vertices * BYTES_PER_VERTEX
  );
}

function numeric(label: string): boolean {
  return label.trim() !== "" && Number.isFinite(Number(label));
}

/**
 * Whether a read held at `ceiling` answers a request at `lod`. `null` is every
 * LoD, on both sides. Numeric labels compare by value, because a read at a
 * ceiling holds every LoD at or below it; any other label answers only itself.
 */
export function ceilingCovers(
  ceiling: string | null,
  lod: string | null,
): boolean {
  if (ceiling === null) return true;
  if (lod === null) return false;
  if (lod === ceiling) return true;
  return numeric(lod) && numeric(ceiling) && Number(lod) <= Number(ceiling);
}

/**
 * `held` as a read at `ceiling` would have returned it: the surfaces above the
 * ceiling dropped, unlabelled ones kept. Everything computed from a cell —
 * its records, its LoD list, its retained bytes, a later `surfaces` reply —
 * must see this view, not the wider read behind it, or a cell baked from the
 * store would differ from one read fresh. `held` is never modified; it is
 * returned itself when nothing would be dropped.
 */
export function lodView(held: CityModel, ceiling: string | null): CityModel {
  if (ceiling === null) return held;
  const kept = (lod: string | null) =>
    lod === null || ceilingCovers(ceiling, lod);
  let changed = false;
  const objects: Record<string, CityObject> = {};
  for (const [id, obj] of Object.entries(held.objects)) {
    if (!obj) continue;
    if (kept(obj.lod) && obj.surfaces.every((s) => kept(s.lod))) {
      objects[id] = obj;
      continue;
    }
    changed = true;
    const surfaces = obj.surfaces.filter((s) => kept(s.lod));
    objects[id] = {
      ...obj,
      surfaces,
      lod: kept(obj.lod) ? obj.lod : highestLod(surfaces),
    };
  }
  return changed ? { ...held, objects } : held;
}

/** The highest LoD label among `surfaces`, numerically, or `null`. Points
 *  and lines carry no surface, so an object whose highest geometry at or
 *  below the ceiling is a point or line reports the LoD of its surfaces
 *  instead, where a fresh read would report the point's or line's. */
function highestLod(surfaces: ReadonlyArray<{ lod: string | null }>) {
  let best: string | null = null;
  for (const { lod } of surfaces) {
    if (lod === null) continue;
    if (best === null || (numeric(lod) && Number(lod) > Number(best))) {
      best = lod;
    }
  }
  return best;
}

interface Entry {
  readonly model: CityModel;
  readonly ceiling: string | null;
  /** Answers only a request for exactly `ceiling` (a source that states no
   *  ceiling: `StreamSourceAdapter.heldCeiling`). */
  readonly exact: boolean;
  readonly bytes: number;
}

/** Held cells, least recently used first (Map insertion order). */
export class FeatureStore {
  private readonly entries = new Map<CellKey, Entry>();
  private total = 0;

  constructor(private readonly budget: number) {}

  /** Estimated bytes held. */
  get bytes(): number {
    return this.total;
  }

  /** The held model for `key` when its read covers `lod`, marking it used. */
  get(key: CellKey, lod: string | null): CityModel | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const covers = entry.exact
      ? entry.ceiling === lod
      : ceilingCovers(entry.ceiling, lod);
    if (!covers) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.model;
  }

  /** Files `model` as everything `key` owns, read at `ceiling`. */
  set(
    key: CellKey,
    model: CityModel,
    ceiling: string | null,
    exact = false,
  ): void {
    this.delete(key);
    const bytes = modelBytes(model);
    this.entries.set(key, { model, ceiling, exact, bytes });
    this.total += bytes;
  }

  /** Drops least recently used entries until the store is within budget,
   *  never one in `keep`. */
  trim(keep: ReadonlySet<CellKey>): void {
    for (const key of [...this.entries.keys()]) {
      if (this.total <= this.budget) return;
      if (!keep.has(key)) this.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  private delete(key: CellKey): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.total -= entry.bytes;
    this.entries.delete(key);
  }
}
