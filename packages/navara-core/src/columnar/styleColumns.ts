/**
 * What styling reads from a {@link CityBatch}: attributes with their
 * ancestors' folded in, roof metrics measured once per block, and the rules
 * evaluated per surface over both.
 *
 * Same answers as the object-graph path (`compileRuleEvaluator`): only
 * RoofSurfaces are ruled; a field that names a roof metric reads the metric,
 * anything else reads the surface's own semantic attributes over the
 * object's, and an object's missing attribute comes from the nearest
 * ancestor that carries it (`inheritedAttributes`). What changes is the cost:
 * the inheritance and the metrics are computed once per batch and per block,
 * not once per surface per evaluation.
 */
import type { RoofMetrics } from "../roofMetrics/types";
import { computeRoofMetrics } from "../roofMetrics/metrics";
import { evaluateCondition } from "../rules/evaluate";
import type { Rule } from "../rules/types";
import {
  surfaceFromBlock,
  type CityBatch,
  type FeatureTable,
  type SurfaceGeometry,
} from "./cityBatch";
import {
  columnValue,
  isValid,
  utf8Value,
  utf8Values,
  type AttrColumn,
} from "./columns";

const inheritance = new WeakMap<FeatureTable, Map<string, Int32Array>>();

/**
 * Per row, the row whose value of `name` that row reads: itself when it
 * carries one, else the first ancestor breadth-first (parents in listed
 * order), -1 when none does. Built once per table and name.
 */
export function inheritedSourceRows(
  table: FeatureTable,
  name: string,
): Int32Array | null {
  const column = table.columns.get(name);
  if (!column) return null;
  let byName = inheritance.get(table);
  if (!byName) {
    byName = new Map();
    inheritance.set(table, byName);
  }
  let sources = byName.get(name);
  if (sources) return sources;
  sources = new Int32Array(table.length).fill(-1);
  const queue: number[] = [];
  const seen = new Set<number>();
  for (let r = 0; r < table.length; r++) {
    if (isValid(column.validity, r)) {
      sources[r] = r;
      continue;
    }
    queue.length = 0;
    seen.clear();
    queue.push(r);
    seen.add(r);
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i]!;
      if (i > 0 && isValid(column.validity, at)) {
        sources[r] = at;
        break;
      }
      for (
        let k = table.parentOffsets[at]!;
        k < table.parentOffsets[at + 1]!;
        k++
      ) {
        const parent = table.parentRows[k]!;
        if (parent >= 0 && !seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
  }
  byName.set(name, sources);
  return sources;
}

/** Row `row`'s value of `name`, inherited; `null` when nobody carries it. */
export function inheritedValue(
  table: FeatureTable,
  name: string,
  row: number,
): unknown {
  const sources = inheritedSourceRows(table, name);
  if (!sources || sources[row]! < 0) return null;
  return columnValue(table.columns.get(name)!, sources[row]!);
}

/** Roof metrics per surface of a block, NaN for a surface that is not a
 *  RoofSurface; an azimuth of NaN on a roof is "no aspect" (`null`). */
export interface BlockRoofMetrics {
  readonly areaSqM: Float64Array;
  readonly inclinationDeg: Float64Array;
  readonly azimuthDeg: Float64Array;
  readonly elevationM: Float64Array;
}

const metricsCache = new WeakMap<SurfaceGeometry, BlockRoofMetrics>();

function roofTypeIndex(block: SurfaceGeometry): number {
  return utf8Values(block.semanticNames).indexOf("RoofSurface");
}

export function blockRoofMetrics(block: SurfaceGeometry): BlockRoofMetrics {
  const cached = metricsCache.get(block);
  if (cached) return cached;
  const n = block.surfaceCount;
  const metrics: BlockRoofMetrics = {
    areaSqM: new Float64Array(n).fill(Number.NaN),
    inclinationDeg: new Float64Array(n).fill(Number.NaN),
    azimuthDeg: new Float64Array(n).fill(Number.NaN),
    elevationM: new Float64Array(n).fill(Number.NaN),
  };
  const roof = roofTypeIndex(block);
  if (roof >= 0) {
    for (let s = 0; s < n; s++) {
      if (block.surfaceType[s] !== roof) continue;
      const m = computeRoofMetrics(surfaceFromBlock(block, s));
      metrics.areaSqM[s] = m.areaSqM;
      metrics.inclinationDeg[s] = m.inclinationDeg;
      metrics.azimuthDeg[s] = m.azimuthDeg ?? Number.NaN;
      metrics.elevationM[s] = m.elevationM;
    }
  }
  metricsCache.set(block, metrics);
  return metrics;
}

const METRIC_FIELDS: ReadonlySet<string> = new Set<keyof RoofMetrics>([
  "areaSqM",
  "inclinationDeg",
  "azimuthDeg",
  "elevationM",
]);

const semanticCache = new WeakMap<
  SurfaceGeometry,
  ReadonlyArray<Readonly<Record<string, unknown>>>
>();

/** Each distinct set of semantic attributes, parsed once per block. */
function semanticRecords(
  block: SurfaceGeometry,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  let records = semanticCache.get(block);
  if (!records) {
    records = Array.from(
      { length: block.semanticAttributes.length },
      (_, i) =>
        JSON.parse(utf8Value(block.semanticAttributes, i)!) as Record<
          string,
          unknown
        >,
    );
    semanticCache.set(block, records);
  }
  return records;
}

/** A field as a per-surface reader, resolved once per evaluation. */
function fieldReader(
  batch: CityBatch,
  block: SurfaceGeometry,
  field: string,
): (s: number) => unknown {
  const semantic = semanticRecords(block);
  const own = (s: number): { hit: boolean; value: unknown } => {
    const i = block.surfaceSemantic[s]!;
    if (i < 0) return { hit: false, value: undefined };
    const record = semantic[i]!;
    return field in record
      ? { hit: true, value: record[field] }
      : { hit: false, value: undefined };
  };
  if (METRIC_FIELDS.has(field)) {
    const values = blockRoofMetrics(block)[field as keyof BlockRoofMetrics];
    return (s) => {
      const v = values[s]!;
      return Number.isNaN(v) ? null : v;
    };
  }
  const sources = inheritedSourceRows(batch.features, field);
  const column: AttrColumn | undefined = batch.features.columns.get(field);
  return (s) => {
    const mine = own(s);
    if (mine.hit) return mine.value;
    if (!sources || !column) return undefined;
    const from = sources[block.surfaceRow[s]!]!;
    return from < 0 ? undefined : columnValue(column, from);
  };
}

/**
 * Per surface of `block`, the index into `rules` of the first enabled rule
 * that matches it, or -1. Only RoofSurfaces match; an empty condition list
 * matches every roof.
 */
export function evaluateBlockRules(
  batch: CityBatch,
  block: SurfaceGeometry,
  rules: ReadonlyArray<Rule>,
): Int32Array {
  const out = new Int32Array(block.surfaceCount).fill(-1);
  const roof = roofTypeIndex(block);
  const live = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.enabled);
  if (roof < 0 || live.length === 0) return out;
  const readers = new Map<string, (s: number) => unknown>();
  const reader = (field: string) => {
    let r = readers.get(field);
    if (!r) {
      r = fieldReader(batch, block, field);
      readers.set(field, r);
    }
    return r;
  };
  for (let s = 0; s < block.surfaceCount; s++) {
    if (block.surfaceType[s] !== roof) continue;
    for (const { rule, index } of live) {
      const test = (c: Rule["conditions"][number]) =>
        evaluateCondition(reader(c.field)(s), c);
      const hit =
        rule.conditions.length === 0 ||
        (rule.logic === "AND"
          ? rule.conditions.every(test)
          : rule.conditions.some(test));
      if (hit) {
        out[s] = index;
        break;
      }
    }
  }
  return out;
}
