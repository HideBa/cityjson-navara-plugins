/**
 * Edge extraction from a non-indexed triangle soup — the one new rendering
 * capability behind the cartoon ink and the wireframe hidden-line look.
 *
 * The oracles here are hand-built solids with known silhouettes (a unit cube, a
 * split quad, a roof fold at a known dihedral), never a second call to the
 * function under test.
 */
import { describe, expect, it } from "vitest";
import {
  buildCityEdgeSegments,
  DEFAULT_EDGE_ANGLE_DEG,
} from "../../src/geometry/buildCityEdgeSegments";
import * as barrel from "../../src/index";

/** Two triangles per quad, wound consistently from the ring order given. */
function quad(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
): number[] {
  return [...a, ...b, ...c, ...a, ...c, ...d];
}

/** Unit cube [0,1]^3 as 12 outward-wound triangles. */
function unitCube(): Float32Array {
  const p: Record<string, readonly number[]> = {
    v000: [0, 0, 0],
    v100: [1, 0, 0],
    v110: [1, 1, 0],
    v010: [0, 1, 0],
    v001: [0, 0, 1],
    v101: [1, 0, 1],
    v111: [1, 1, 1],
    v011: [0, 1, 1],
  };
  return Float32Array.from([
    ...quad(p.v001!, p.v101!, p.v111!, p.v011!), // top  (+z)
    ...quad(p.v000!, p.v010!, p.v110!, p.v100!), // base (-z)
    ...quad(p.v000!, p.v100!, p.v101!, p.v001!), // -y
    ...quad(p.v110!, p.v010!, p.v011!, p.v111!), // +y
    ...quad(p.v000!, p.v001!, p.v011!, p.v010!), // -x
    ...quad(p.v100!, p.v110!, p.v111!, p.v101!), // +x
  ]);
}

/** Segment lengths, so "did a face diagonal survive?" is a length question. */
function lengths(segments: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < segments.length; i += 6) {
    out.push(
      Math.hypot(
        segments[i + 3]! - segments[i]!,
        segments[i + 4]! - segments[i + 1]!,
        segments[i + 5]! - segments[i + 2]!,
      ),
    );
  }
  return out;
}

const segmentCount = (segments: Float32Array) => segments.length / 6;

describe("buildCityEdgeSegments", () => {
  it("emits six floats per segment", () => {
    const segments = buildCityEdgeSegments(unitCube());
    expect(segments).toBeInstanceOf(Float32Array);
    expect(segments.length % 6).toBe(0);
  });

  it("reduces a 12-triangle cube to its 12 structural edges", () => {
    const segments = buildCityEdgeSegments(unitCube());
    expect(segmentCount(segments)).toBe(12);
    // Every cube edge has length 1; a surviving face diagonal would be √2. The
    // count alone cannot say that — 12 diagonals would also be 12 segments.
    for (const l of lengths(segments)) expect(l).toBeCloseTo(1, 5);
  });

  it("keeps a flat quad's four boundary edges and drops its diagonal", () => {
    const flat = Float32Array.from(
      quad([0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]),
    );
    const segments = buildCityEdgeSegments(flat);
    expect(segmentCount(segments)).toBe(4);
    for (const l of lengths(segments)) expect(l).toBeCloseTo(4, 5);
  });

  it("drops a coplanar diagonal even at threshold 0", () => {
    // A coplanar pair's dihedral is 0°, which is never "more than" the
    // threshold — and the coplanarity tolerance keeps float noise from
    // promoting it. A tilted plane, so the normals are not exact by luck.
    const tilted = Float32Array.from(
      quad([0, 0, 0], [4, 0, 1], [4, 4, 1], [0, 4, 0]),
    );
    expect(segmentCount(buildCityEdgeSegments(tilted, 0))).toBe(4);
  });

  it("keeps a 30° roof fold at the default threshold and drops it at 45°", () => {
    // Two quads meeting along y = 0: one flat, one tilted 30° about the x
    // axis. The shared edge's face normals differ by exactly 30°.
    const t = Math.tan((30 * Math.PI) / 180);
    const fold = Float32Array.from([
      ...quad([0, 0, 0], [4, 0, 0], [4, -4, 0], [0, -4, 0]),
      ...quad([0, 0, 0], [0, 4, 4 * t], [4, 4, 4 * t], [4, 0, 0]),
    ]);
    // Kept at 25°: 6 outer boundary edges + the fold; both diagonals dropped.
    expect(segmentCount(buildCityEdgeSegments(fold))).toBe(7);
    // Dropped at 45°: the fold is below the threshold, the boundary is not.
    expect(segmentCount(buildCityEdgeSegments(fold, 45))).toBe(6);
  });

  it("merges endpoints that differ below the quantization grid", () => {
    // The second triangle's copy of the shared edge is off by 1e-6 m — far
    // inside the 1e-4 grid, so the two must be ONE edge. Without merging the
    // shared edge would count as two boundary edges and the total would be 6.
    const e = 1e-6;
    const soup = Float32Array.from([
      0, 0, 0, 4, 0, 0, 4, 4, 0,
      // second triangle, sharing (0,0,0)-(4,4,0) to within 1e-6
      e, e, 0, 4 + e, 4 - e, 0, 0, 4, 0,
    ]);
    expect(segmentCount(buildCityEdgeSegments(soup))).toBe(4);
  });

  it("ignores a degenerate triangle rather than emitting its edges", () => {
    const withSliver = Float32Array.from([
      ...quad([0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]),
      // zero area: two coincident vertices, so it has no normal to compare
      10, 10, 0, 12, 10, 0, 10, 10, 0,
    ]);
    expect(segmentCount(buildCityEdgeSegments(withSliver))).toBe(4);
  });

  it("treats a T-junction edge as a crease when ANY adjacent pair folds", () => {
    // Three triangles on one edge: two coplanar, one folded 90° away. The
    // coplanar pair alone would drop it; the folded one must win.
    const soup = Float32Array.from([
      0, 0, 0, 4, 0, 0, 2, 2, 0, // +y half
      4, 0, 0, 0, 0, 0, 2, -2, 0, // -y half, coplanar with the first
      0, 0, 0, 4, 0, 0, 2, 0, 3, // folded up 90°
    ]);
    const segments = buildCityEdgeSegments(soup);
    const shared = lengths(segments).filter((l) => Math.abs(l - 4) < 1e-5);
    expect(shared.length).toBe(1);
  });

  it("returns nothing for an empty soup", () => {
    expect(buildCityEdgeSegments(new Float32Array(0)).length).toBe(0);
  });

  // The builder is consumed from OUTSIDE this package (navara-cityjson's
  // themed meshes), so the barrel is part of its contract, not a convenience.
  it("is reachable from the package barrel, with its default threshold", () => {
    expect(barrel.buildCityEdgeSegments).toBe(buildCityEdgeSegments);
    expect(barrel.DEFAULT_EDGE_ANGLE_DEG).toBe(DEFAULT_EDGE_ANGLE_DEG);
  });
});
