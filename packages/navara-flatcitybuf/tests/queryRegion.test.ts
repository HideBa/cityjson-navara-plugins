/**
 * `queryRegionFrom`: the footprint a commit fetched, reshaped for a UI.
 *
 * Engine-free — the projection is injected, so nothing here reaches proj4 or
 * `@navaramap/*` (Global Constraints -> Testing conventions).
 */
import { describe, it, expect } from "vitest";
import {
  queryRegionFrom,
  RING_POINTS_PER_EDGE,
  type QueryRegionInput,
} from "../src/queryRegion";
import type { Footprint } from "../src/viewportFootprint";

/** A source-CRS AABB and the footprint wrapper the handle hands over. */
function footprint(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Footprint {
  return {
    bbox: [minX, minY, maxX, maxY],
    span: Math.max(maxX - minX, maxY - minY),
    centre: [minX + (maxX - minX) / 2, minY + (maxY - minY) / 2],
  };
}

/** A deliberately trivial, exactly-representable "projection": the ring
 *  assertions are about which POINTS are sampled, not about proj4. */
const TO_LNG_LAT = (x: number, y: number) =>
  [x / 1000, y / 1000] as const satisfies readonly [number, number];

function input(overrides: Partial<QueryRegionInput> = {}): QueryRegionInput {
  return {
    layerId: "l1",
    footprint: footprint(1000, 2000, 3000, 6000),
    epsg: 28992,
    heightM: 43.5,
    toLngLat: TO_LNG_LAT,
    ...overrides,
  };
}

describe("queryRegionFrom", () => {
  it("carries the source-CRS bbox through untouched", () => {
    // The whole point of the seam: the drawn region and the fetched region
    // are the same numbers, not two computations that agree today.
    const region = queryRegionFrom(input())!;
    expect(region.bbox).toEqual([1000, 2000, 3000, 6000]);
    expect(region.span).toBe(4000);
    expect(region.epsg).toBe(28992);
    expect(region.heightM).toBe(43.5);
    expect(region.layerId).toBe("l1");
  });

  it("densifies each edge and never repeats the closing corner", () => {
    const region = queryRegionFrom(input())!;
    expect(region.ring).toHaveLength(4 * RING_POINTS_PER_EDGE);
    // First point is the min/min corner...
    expect(region.ring[0]).toEqual([1, 2]);
    // ...and the last is one sample short of coming back to it, so a renderer
    // that closes the loop itself does not draw a zero-length segment.
    const last = region.ring[region.ring.length - 1]!;
    expect(last).not.toEqual(region.ring[0]);
    expect(last[0]).toBe(1);
  });

  it("walks the corners counter-clockwise in bbox order", () => {
    const region = queryRegionFrom(input())!;
    const corners = [0, 1, 2, 3].map(
      (i) => region.ring[i * RING_POINTS_PER_EDGE]!,
    );
    expect(corners).toEqual([
      [1, 2],
      [3, 2],
      [3, 6],
      [1, 6],
    ]);
  });

  it("keeps every densified sample on its edge", () => {
    const region = queryRegionFrom(input())!;
    // Bottom edge: y pinned at the bbox minimum, x strictly increasing.
    const bottom = region.ring.slice(0, RING_POINTS_PER_EDGE);
    for (const [, lat] of bottom) expect(lat).toBe(2);
    for (let i = 1; i < bottom.length; i++) {
      expect(bottom[i]![0]).toBeGreaterThan(bottom[i - 1]![0]);
    }
  });

  it("refuses a projection that goes non-finite", () => {
    // A ray that missed the globe, or a point outside the projection domain —
    // the same failure `viewportFootprint` answers `null` for. A NaN vertex
    // reaching a line renderer is a mesh smeared across the planet.
    const region = queryRegionFrom(
      input({ toLngLat: (x, y) => [x === 3000 ? NaN : x, y] as const }),
    );
    expect(region).toBeNull();
  });
});
