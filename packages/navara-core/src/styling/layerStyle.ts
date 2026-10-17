/**
 * Colour expressions on the MapLibre style spec, evaluated per surface.
 *
 * An expression is a style-spec `color` expression over one feature: the
 * surface. Its properties are, in increasing precedence, the object's
 * attributes (with its ancestors'), the surface's own attributes, the four
 * roof metrics (`areaSqM`, `inclinationDeg`, `azimuthDeg`, `elevationM`,
 * computed only when read), and the reserved `$surface` (semantic type),
 * `$type` (object type), `$id` (object id, also `["id"]`) and `$base` (the
 * colour the surface would have unstyled).
 *
 * The result keeps the base colour when it IS `$base`, is null, is fully
 * transparent, or fails to evaluate; a colour derived from `$base` is a new
 * colour. Engine-free and worker-safe.
 *
 * {@link rulesToStyleExpression} compiles a rule list to the expression that
 * colours exactly as `compileRuleEvaluator` does, so a rule set can be
 * carried into an expression and edited from there.
 */
import {
  Color,
  createPropertyExpression,
  type ExpressionSpecification,
  type StylePropertySpecification,
} from "@maplibre/maplibre-gl-style-spec";
import { computeRoofMetrics } from "../roofMetrics/metrics";
import type { RoofMetrics } from "../roofMetrics/types";
import type { Surface } from "../citymodel/types";
import type { Condition, Rule } from "../rules/types";
import type { SurfaceStyleEvaluator } from "./buildStyleColors";
import { srgbToLinear, type RGB } from "./srgb";

export type StyleExpression = ExpressionSpecification;

export type CompiledStyle =
  | { readonly ok: true; readonly evaluator: SurfaceStyleEvaluator }
  | { readonly ok: false; readonly errors: readonly string[] };

const COLOR_PROPERTY = {
  type: "color",
  "property-type": "data-driven",
  expression: { interpolated: true, parameters: ["feature"] },
} as unknown as StylePropertySpecification;

const METRICS: ReadonlyArray<keyof RoofMetrics> = [
  "areaSqM",
  "inclinationDeg",
  "azimuthDeg",
  "elevationM",
];
const METRIC_SET: ReadonlySet<string> = new Set(METRICS);

/**
 * The feature's properties, as a prototype chain so a slot copies nothing
 * per object: the instance holds the surface's attributes and the reserved
 * `$` names; its prototype holds the metric getters (computed only when `get`
 * or `has` reads one, once per surface); that layer's prototype is the
 * object's attributes, shared by every surface of the object.
 */
const objectLayers = new WeakMap<object, object>();

function objectLayer(attributes: Readonly<Record<string, unknown>>): object {
  let layer = objectLayers.get(attributes);
  if (!layer) {
    layer = Object.create(attributes) as object;
    for (const metric of METRICS) {
      Object.defineProperty(layer, metric, {
        get(this: { $metrics?: RoofMetrics; $ring: Surface }) {
          this.$metrics ??= computeRoofMetrics(this.$ring);
          return this.$metrics[metric];
        },
        enumerable: true,
      });
    }
    objectLayers.set(attributes, layer);
  }
  return layer;
}

/** Linear base -> the style spec's (sRGB) Color. */
function linearToColor(rgb: RGB): Color {
  const c = (v: number) =>
    v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return new Color(c(rgb[0]), c(rgb[1]), c(rgb[2]), 1);
}

export function compileStyleExpression(expression: unknown): CompiledStyle {
  const compiled = createPropertyExpression(
    expression,
    "color",
    COLOR_PROPERTY,
  );
  if (compiled.result !== "success") {
    return {
      ok: false,
      errors: compiled.value.map(
        (e) => (e.key ? `${e.key}: ` : "") + e.message,
      ),
    };
  }
  const style = compiled.value;
  const globals = { zoom: 0 };
  const evaluator: SurfaceStyleEvaluator = (surface, object, base) => {
    const properties = Object.create(objectLayer(object.attributes)) as Record<
      string,
      unknown
    >;
    const own = surface.surface.attributes;
    for (const key in own) {
      if (!METRIC_SET.has(key)) properties[key] = own[key];
    }
    properties.$ring = surface.surface;
    const baseColor = base ? linearToColor(base) : null;
    properties.$surface = surface.surface.type;
    properties.$type = object.object.objectType;
    properties.$id = object.objectId;
    properties.$base = baseColor;
    const result = style.evaluate(globals, {
      type: "Polygon",
      id: object.objectId,
      properties,
    } as never) as Color | null | undefined;
    if (!result || result === baseColor || result.a === 0) return null;
    const a = result.a;
    return srgbToLinear([result.r / a, result.g / a, result.b / a]);
  };
  return { ok: true, evaluator };
}

/** Three- or six-digit CSS hex, as `srgbHexToLinear` reads it; anything else
 *  is white, as it is there. */
function ruleColor(hex: string): string {
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)
    ? hex.startsWith("#")
      ? hex
      : `#${hex}`
    : "#ffffff";
}

/** One condition with `evaluateCondition`'s semantics: `=` is strict, the
 *  order operators compare numbers only and are false for anything else. */
function conditionExpression(condition: Condition): unknown {
  const field = ["get", condition.field];
  if (condition.operator === "=") {
    return ["==", field, ["literal", condition.value]];
  }
  if (typeof condition.value !== "number") return false;
  return [
    "all",
    ["==", ["typeof", field], "number"],
    [condition.operator, field, condition.value],
  ];
}

/**
 * The expression that colours as `compileRuleEvaluator(rules)` does: enabled
 * rules only, first match wins, roofs only, everything else at its base.
 */
export function rulesToStyleExpression(
  rules: ReadonlyArray<Rule>,
): StyleExpression {
  const keep = ["get", "$base"];
  const enabled = rules.filter((r) => r.enabled);
  if (enabled.length === 0) return keep as StyleExpression;
  const branches = enabled.flatMap((rule) => {
    const conditions = rule.conditions.map(conditionExpression);
    // Zero conditions match whatever the logic says.
    const matches =
      conditions.length === 0
        ? true
        : [rule.logic === "OR" ? "any" : "all", ...conditions];
    return [
      ["all", ["==", ["get", "$surface"], "RoofSurface"], matches],
      ruleColor(rule.color),
    ];
  });
  return ["case", ...branches, keep] as unknown as StyleExpression;
}
