/**
 * Per-layer streaming state shapes.
 *
 * Currently only the resident-cell payload, which the commit planner needs to
 * type its cache. The rest of the layer state (the store the app still owns)
 * lands here in Tasks C10a/C10b.
 */
import type { Rule } from "@cityjson/navara-core";
import {
  emptyCellGeometry,
  type CellGeometry,
  type ResidentObjectRecord,
} from "./workerProtocol";

/**
 * What the main-thread cache holds per resident cell. Mirrors the worker's
 * `'cell'` response payload (see workerProtocol.ts) minus the envelope
 * fields (`type`/`id`/`key` — `key` is the cache's own map key, not part of
 * the value). This is what the scene layer builds `CellSceneState`
 * (mesh/pickingIndex/baseColors/ruleColors) from, and what the inspector/
 * table read object attributes from without re-fetching.
 */
export interface CellEntry {
  readonly geometry: CellGeometry;
  readonly objects: ReadonlyArray<ResidentObjectRecord>;
  readonly surfaceAttrKeys: ReadonlyArray<string>;
  readonly lodsSeen: ReadonlyArray<string>;
  /** The layer's `rulesEnabled`/`rules` at the moment THIS cell's fetch was
   *  dispatched (`commitStreamingLayer`) — exactly what `geometry.ruleColors`
   *  was computed from. A fetch can still be in flight when the user edits a
   *  rule; if it lands afterwards, the layer's CURRENT rules (by the time the
   *  scene installs this entry) may already differ from these. Comparing the
   *  two is how the scene's cell sync detects a newly-installed cell carrying
   *  stale colors and asks for an immediate recolor — otherwise nothing would
   *  ever revisit it: the "rules changed" effect only recolors cells that were
   *  ALREADY resident at the moment it ran, and a cell arriving later never
   *  triggers it again on its own (B2, 2026-07-28 final review). */
  readonly builtWithRulesEnabled: boolean;
  readonly builtWithRules: ReadonlyArray<Rule>;
}

export function emptyCellEntry(
  rulesEnabled: boolean,
  rules: ReadonlyArray<Rule>,
): CellEntry {
  return {
    geometry: emptyCellGeometry(),
    objects: [],
    surfaceAttrKeys: [],
    lodsSeen: [],
    builtWithRulesEnabled: rulesEnabled,
    builtWithRules: rules,
  };
}
