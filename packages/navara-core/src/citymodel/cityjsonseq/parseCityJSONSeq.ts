/**
 * Parser for CityJSON Text Sequences (.city.jsonl).
 *
 * Reads newline-delimited JSON where:
 *   Line 1: CityJSON header with transform, metadata, empty CityObjects/vertices
 *   Line 2+: CityJSONFeature objects, each carrying local vertices
 *
 * Each feature's vertices are dequantized using the header's transform.
 * The output is a single normalized CityModel identical to what parseCityJSON produces.
 */

import type { BBox3, CityModel, CityObject } from "../types";
import type { CityJSONObject, CityJSONRoot } from "../cityjson/types";
import type { CityJSONFeature } from "./types";
import {
  IDENTITY_TRANSFORM,
  dequantizeAll,
  mapMetadata,
  mergeBBox,
  parseCityObject,
} from "../cityjson/parseHelpers";
import { AppearanceMerger } from "../cityjson/appearance";

/** Same gate as parseCityJSON — see the note there for why 1.x is admitted. */
const SUPPORTED_VERSION = /^[12]\./;

export function parseCityJSONSeq(text: string): CityModel {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new Error("Empty CityJSONSeq file.");
  }

  // Line 1: CityJSON header
  const header = JSON.parse(lines[0]!) as CityJSONRoot;

  if (header.type !== "CityJSON") {
    throw new Error(
      `Invalid CityJSONSeq header: expected "type": "CityJSON", got "${String(header.type)}".`,
    );
  }
  if (!SUPPORTED_VERSION.test(header.version)) {
    throw new Error(
      `Unsupported CityJSON version "${header.version}". Only v1.x and v2.x are supported.`,
    );
  }

  // A v1.0 header may omit `transform`; its features then carry real
  // coordinates, which the identity transform passes through unchanged.
  const transform = header.transform ?? IDENTITY_TRANSFORM;

  const objects: Record<string, CityObject> = {};
  let modelBBox: BBox3 | null = null;
  let totalVertexCount = 0;
  // Appearance is LOCAL to each feature (own textures, own UV list, own
  // indices — the spec says so); the merger folds every feature's tables
  // into one model-wide table. The header is registered too: the spec does
  // not give it an appearance, but a writer that put one there loses nothing.
  const appearance = new AppearanceMerger();
  appearance.register(header.appearance);

  // Lines 2+: CityJSONFeature objects
  for (let i = 1; i < lines.length; i++) {
    const feature = JSON.parse(lines[i]!) as CityJSONFeature;
    if (feature.type !== "CityJSONFeature") continue;

    // Each feature carries its own local vertex array, dequantized with the header's transform
    const realVertices = dequantizeAll(feature.vertices, transform);
    totalVertexCount += feature.vertices.length;
    const ctx = appearance.register(feature.appearance);

    for (const [id, rawObj] of Object.entries(feature.CityObjects) as [
      string,
      CityJSONObject,
    ][]) {
      const obj = parseCityObject(id, rawObj, realVertices, ctx);
      objects[id] = obj;
      modelBBox = mergeBBox(modelBBox, obj.bbox);
    }
  }

  const built = appearance.build();
  return {
    sourceEncoding: "cityjsonseq",
    metadata: mapMetadata(header.metadata),
    bbox: modelBBox,
    objects,
    vertexCount: totalVertexCount,
    ...(built === undefined ? {} : { appearance: built }),
  };
}
