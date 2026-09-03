/**
 * Parser that converts a raw CityJSON object into a normalized CityModel.
 *
 * Delegates vertex dequantization, surface extraction, and object
 * parsing to shared helpers in parseHelpers.ts.
 */

import type { BBox3, CityModel, CityObject } from "../types";
import type { CityJSONObject, CityJSONRoot } from "./types";
import {
  IDENTITY_TRANSFORM,
  dequantizeAll,
  mapMetadata,
  mergeBBox,
  parseCityObject,
} from "./parseHelpers";
import { AppearanceMerger } from "./appearance";

/**
 * v1.x and v2.x only. The two differ in vocabulary (object types, semantic
 * surfaces, the LoD spelling) rather than in the parts this parser reads, so
 * refusing 1.x would only lock out real catalog data — much of the published
 * corpus predates v1.1 — for no structural reason.
 */
const SUPPORTED_VERSION = /^[12]\./;

export function parseCityJSON(root: CityJSONRoot): CityModel {
  if (!SUPPORTED_VERSION.test(root.version)) {
    throw new Error(
      `Unsupported CityJSON version "${root.version}". Only v1.x and v2.x are supported.`,
    );
  }

  // `transform` is optional in v1.0 — absent means the vertices are already
  // real coordinates, which the identity transform expresses exactly.
  const realVertices = dequantizeAll(
    root.vertices,
    root.transform ?? IDENTITY_TRANSFORM,
  );

  const objects: Record<string, CityObject> = {};
  let modelBBox: BBox3 | null = null;
  const appearance = new AppearanceMerger();
  const ctx = appearance.register(root.appearance);

  for (const [id, rawObj] of Object.entries(root.CityObjects) as [
    string,
    CityJSONObject,
  ][]) {
    const obj = parseCityObject(id, rawObj, realVertices, ctx);
    objects[id] = obj;
    modelBBox = mergeBBox(modelBBox, obj.bbox);
  }

  return {
    sourceEncoding: "cityjson",
    metadata: mapMetadata(root.metadata),
    bbox: modelBBox,
    objects,
    vertexCount: root.vertices.length,
    ...withAppearance(appearance.build()),
  };
}

/** Spread helper: a model without appearance has NO `appearance` key at all. */
function withAppearance(
  appearance: ReturnType<AppearanceMerger["build"]>,
): { appearance?: NonNullable<ReturnType<AppearanceMerger["build"]>> } {
  return appearance === undefined ? {} : { appearance };
}
