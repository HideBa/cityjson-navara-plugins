/**
 * The one seam that says what a stream's coordinates are: EPSG:6697 (JGD2011
 * lon/lat, heights in metres) into the UTM zone of a centre chosen once, or
 * into navara-core's pinned bucket frame about it; a metric EPSG unchanged in
 * either space; anything else refused.
 *
 * The projected 6697 path must reproduce the app's `normalizeCityParquetCrs`
 * exactly — the same proj4 source definition, lon/lat input order, zone rule
 * and untouched heights — so a streamed and a resident layer line up. The
 * bucket path must reproduce `makeLocalMetricFrame` exactly, so that every
 * user of the index (the tile grid, the camera footprint, a cell's centre)
 * computes the same metres.
 */

import { NonMetricCrsError, makeLocalMetricFrame } from "@cityjson/navara-core";
import type { CityObject } from "@cityjson/navara-core";
import proj4 from "proj4";
import { describe, expect, it } from "vitest";
import {
  coordinateTargetFor,
  isBucketTarget,
  projectCityObjects,
} from "../src/geographicToProjected";

const JGD2011_LONGLAT = "+proj=longlat +ellps=GRS80 +no_defs";

describe("coordinateTargetFor", () => {
  it("maps EPSG:6697 around Yokohama to UTM zone 54N and agrees with proj4", () => {
    const target = coordinateTargetFor(6697, [139.6, 35.45]);
    expect(target.sourceEpsg).toBe(6697);
    expect(target.epsg).toBe(32654);
    expect(target.frame).toBeNull();
    const reference = proj4(JGD2011_LONGLAT, "EPSG:32654");
    for (const [lon, lat] of [
      [139.6, 35.45],
      [139.55, 35.4],
      [139.71, 35.52],
    ] as const) {
      const [x, y] = target.toTarget(lon, lat);
      const [rx, ry] = reference.forward([lon, lat]);
      expect(Math.abs(x - rx!)).toBeLessThan(1e-6);
      expect(Math.abs(y - ry!)).toBeLessThan(1e-6);
    }
  });

  it("picks the southern-hemisphere zone for a southern centre", () => {
    expect(coordinateTargetFor(6697, [151.2, -33.9]).epsg).toBe(32756);
  });

  it("refuses EPSG:6697 without a centre, or with one outside the UTM range", () => {
    expect(() => coordinateTargetFor(6697, null)).toThrow(NonMetricCrsError);
    expect(() => coordinateTargetFor(6697, [139.6, 88])).toThrow();
  });

  it("passes a metric EPSG through unchanged", () => {
    const target = coordinateTargetFor(7415, [4.37, 52]);
    expect(target.sourceEpsg).toBe(7415);
    expect(target.epsg).toBe(7415);
    expect(target.toTarget(85000.5, 446000.25)).toEqual([85000.5, 446000.25]);
  });

  it("refuses a non-metric EPSG other than 6697", () => {
    expect(() => coordinateTargetFor(4326, [4.37, 52])).toThrow(
      NonMetricCrsError,
    );
  });
});

describe("coordinateTargetFor in bucket space", () => {
  it("maps EPSG:6697 into the pinned bucket frame about the centre, with no EPSG", () => {
    const target = coordinateTargetFor(6697, [139.6, 35.45], "bucket");
    expect(target.sourceEpsg).toBe(6697);
    // No EPSG code names a local metric frame, so the stream reports none and
    // carries the frame's descriptor instead.
    expect(target.epsg).toBeNull();
    expect(target.frame).toEqual({
      kind: "local-metric",
      lngDeg: 139.6,
      latDeg: 35.45,
    });
    expect(isBucketTarget(target)).toBe(true);

    const frame = makeLocalMetricFrame(139.6, 35.45);
    for (const [lon, lat] of [
      [139.6, 35.45],
      [139.55, 35.4],
      [139.71, 35.52],
    ] as const) {
      // Bit-for-bit the frame's own arithmetic: every user of bucket space has
      // to compute the SAME numbers.
      expect(target.toTarget(lon, lat)).toEqual(frame.toMetric(lon, lat));
    }
    expect(target.toTarget(139.6, 35.45)).toEqual([0, 0]);
  });

  it("is defined outside the UTM latitude band, where the projected target is not", () => {
    expect(() => coordinateTargetFor(6697, [15, 85])).toThrow();
    const target = coordinateTargetFor(6697, [15, 85], "bucket");
    expect(target.frame).toEqual({
      kind: "local-metric",
      lngDeg: 15,
      latDeg: 85,
    });
  });

  it("still refuses EPSG:6697 without a centre, a bogus centre, and another geographic CRS", () => {
    expect(() => coordinateTargetFor(6697, null, "bucket")).toThrow(
      NonMetricCrsError,
    );
    expect(() => coordinateTargetFor(6697, [139.6, 95], "bucket")).toThrow();
    expect(() =>
      coordinateTargetFor(6697, [Number.NaN, 35.45], "bucket"),
    ).toThrow();
    expect(() => coordinateTargetFor(4326, [4.37, 52], "bucket")).toThrow(
      NonMetricCrsError,
    );
  });

  it("leaves a projected source exactly as the projected target does", () => {
    const target = coordinateTargetFor(7415, [4.37, 52], "bucket");
    expect(target.sourceEpsg).toBe(7415);
    expect(target.epsg).toBe(7415);
    expect(target.frame).toBeNull();
    expect(isBucketTarget(target)).toBe(false);
    expect(target.toTarget(85000.5, 446000.25)).toEqual([85000.5, 446000.25]);
  });
});

function objectAt(lon: number, lat: number): CityObject {
  return {
    id: "a",
    objectType: "Building",
    attributes: {},
    surfaces: [
      {
        type: "RoofSurface",
        rings: [
          [
            [lon, lat, 12],
            [lon + 0.0001, lat, 12],
            [lon + 0.0001, lat + 0.0001, 13],
          ],
        ],
        attributes: {},
        lod: "2",
      },
    ],
    bbox: [lon, lat, 12, lon + 0.0001, lat + 0.0001, 13],
    children: [],
    parents: [],
    lod: "2",
  };
}

describe("projectCityObjects", () => {
  it("projects rings and bbox into the target, heights unchanged", () => {
    const target = coordinateTargetFor(6697, [139.6, 35.45]);
    const objects: Record<string, CityObject> = {
      a: objectAt(139.6, 35.45),
    };
    projectCityObjects(objects, target);
    const ring = objects.a!.surfaces[0]!.rings[0]!;
    const [x0, y0] = target.toTarget(139.6, 35.45);
    expect(ring[0]).toEqual([x0, y0, 12]);
    expect(ring[2]![2]).toBe(13);
    const bbox = objects.a!.bbox!;
    // Metric now, and it contains every projected vertex.
    for (const [x, y] of ring) {
      expect(x).toBeGreaterThanOrEqual(bbox[0]);
      expect(y).toBeGreaterThanOrEqual(bbox[1]);
      expect(x).toBeLessThanOrEqual(bbox[3]);
      expect(y).toBeLessThanOrEqual(bbox[4]);
    }
    expect(bbox[2]).toBe(12);
    expect(bbox[5]).toBe(13);
    expect(bbox[3] - bbox[0]).toBeGreaterThan(5); // ~9 m, not 0.0001
  });

  it("leaves objects untouched for an identity target", () => {
    const target = coordinateTargetFor(7415, null);
    const object = objectAt(85000, 446000);
    const objects: Record<string, CityObject> = { a: object };
    projectCityObjects(objects, target);
    expect(objects.a).toBe(object);
  });
});
