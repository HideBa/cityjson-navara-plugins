/**
 * The rule engine's `SurfaceStyleEvaluator`, and the array-in/array-out
 * recoloring entry point built on it.
 *
 * `buildSlotStyleColors` is deliberately rule-agnostic — it walks
 * slots and calls a hook. This module is the one place that hook is
 * compiled from a layer's colorization rules (roof metrics + `matchRule` +
 * RoofSurface gating), so the static main-thread path and the FlatCityBuf
 * worker colorize identically instead of maintaining two rule walkers.
 *
 * Moved out of multiroof-viewer's `src/scene/applyRuleColors.ts` (Task C5):
 * the FCB worker now lives in `@cityjson/navara-flatcitybuf` and cannot
 * import from the app, and duplicating the compile step in the plugin would
 * be exactly the drift this package exists to prevent. The app keeps the
 * `BufferGeometry`-typed `buildRuleColors` wrapper, which is a three concern.
 *
 * Worker-safe: consumes plain typed arrays, no BufferGeometry/Color.
 */
import type { CityModel } from "../citymodel/types";
import { computeRoofMetrics } from "../roofMetrics/metrics";
import { matchRule } from "../rules/evaluate";
import type { Rule } from "../rules/types";
import {
  buildSlotStyleColors,
  type SurfaceStyleEvaluator,
} from "./buildStyleColors";
import { srgbHexToLinear, type RGB } from "./srgb";

const linearCache = new Map<string, RGB>();
function cachedLinear(hex: string): RGB {
  let c = linearCache.get(hex);
  if (!c) {
    c = srgbHexToLinear(hex);
    linearCache.set(hex, c);
  }
  return c;
}

/**
 * Compile a layer's rules into a per-surface styling hook — the
 * `ruleStore-per-layer --compile--> SurfaceStyleEvaluator --> handle.setStyle`
 * edge.
 *
 * Returns null when the layer's rules are switched off (`rulesEnabled`) or
 * when no rule is enabled, so callers can fall back to the base colours without
 * walking any slots. Only RoofSurfaces are rule-colored — every other
 * semantic type keeps its base color.
 *
 * `rulesEnabled` defaults to true so the callers that already applied the
 * layer gate themselves (the FCB worker, via `buildSlotRuleColors`)
 * keep their one-argument call.
 */
export function compileRuleEvaluator(
  rules: ReadonlyArray<Rule>,
  rulesEnabled = true,
): SurfaceStyleEvaluator | null {
  if (!rulesEnabled) return null;
  const enabledRules = rules.filter((r) => r.enabled);
  if (enabledRules.length === 0) return null;

  return (surface, object) => {
    if (surface.surface.type !== "RoofSurface") return null;

    const metrics = computeRoofMetrics(surface.surface);
    // Surface attributes over the object's, which carry its ancestors'.
    const attributes = {
      ...object.attributes,
      ...surface.surface.attributes,
    };
    const colorHex = matchRule(attributes, metrics, enabledRules);
    if (!colorHex) return null;

    return cachedLinear(colorHex);
  };
}

/**
 * Per slot, the colour of the first matching rule over a copy of
 * `slotColors` (see `buildSlotStyleColors`).
 *
 * Returns null if no rule matched anything (all non-roof, or no matches),
 * allowing the caller to fall back to the base colours.
 */
export function buildSlotRuleColors(
  model: CityModel,
  slotObjects: Uint32Array,
  slotSurfaces: Uint32Array,
  objectKeys: ReadonlyArray<string>,
  rules: ReadonlyArray<Rule>,
  slotColors: Float32Array,
): Float32Array | null {
  const evaluate = compileRuleEvaluator(rules);
  if (!evaluate) return null;

  return buildSlotStyleColors(
    model,
    slotObjects,
    slotSurfaces,
    objectKeys,
    evaluate,
    slotColors,
  );
}
