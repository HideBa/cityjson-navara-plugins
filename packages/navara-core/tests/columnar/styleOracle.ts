/**
 * Rule evaluation over columns must agree with the object graph's, surface by
 * surface: the graph's answer is `matchRule` over the object's inherited
 * attributes, the surface's own attributes over them, and the roof metrics
 * measured from the surface's rings. Shared with the app's Delft test.
 */
import { expect } from "vitest";
import type { CityModel } from "../../src/citymodel/types";
import { inheritedAttributes } from "../../src/citymodel/inheritedAttributes";
import { computeRoofMetrics } from "../../src/roofMetrics/metrics";
import { evaluateRule } from "../../src/rules/evaluate";
import type { Rule } from "../../src/rules/types";
import { cityBatchFromModel } from "../../src/columnar/fromCityModel";
import { evaluateBlockRules } from "../../src/columnar/styleColumns";

export function expectRulesMatchGraph(
  model: CityModel,
  rules: ReadonlyArray<Rule>,
): { roofs: number; matched: number } {
  const batch = cityBatchFromModel(model);
  const objects = Object.values(model.objects).filter((o) => o !== undefined);
  let roofs = 0;
  let matched = 0;
  for (const block of batch.lods.values()) {
    const got = evaluateBlockRules(batch, block, rules);
    for (let s = 0; s < block.surfaceCount; s++) {
      const object = objects[block.surfaceRow[s]!]!;
      const surface = object.surfaces[block.surfaceOrdinal[s]!]!;
      let want = -1;
      if (surface.type === "RoofSurface") {
        roofs++;
        const attributes = {
          ...inheritedAttributes(object, (id) => model.objects[id]),
          ...surface.attributes,
        };
        const metrics = computeRoofMetrics(surface);
        want = rules.findIndex(
          (r) => r.enabled && evaluateRule(attributes, metrics, r),
        );
      }
      if (want >= 0) matched++;
      expect(got[s], `${object.id} surface ${block.surfaceOrdinal[s]}`).toBe(
        want,
      );
    }
  }
  return { roofs, matched };
}
