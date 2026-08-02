import { describe, it, expect } from "vitest";
import { makeEnuFrame, enuToEcef, type EnuFrame } from "@cityjson/navara-core";
import { EPS, viewportFootprint, type Ray } from "../src/viewportFootprint";
import { MAX_FOOTPRINT_SPAN_M, T_MAX_M } from "../src/constants";

const FRAME: EnuFrame = makeEnuFrame(4.3571, 52.0116, 0);

/** A ray from `enuEye` toward `enuTarget`, both in the frame's ENU metres. */
function ray(
  enuEye: readonly [number, number, number],
  enuTarget: readonly [number, number, number],
): Ray {
  const o = enuToEcef(FRAME, enuEye);
  const t = enuToEcef(FRAME, enuTarget);
  const d = [t[0] - o[0], t[1] - o[1], t[2] - o[2]] as const;
  const len = Math.hypot(d[0], d[1], d[2]);
  return { origin: o, direction: [d[0] / len, d[1] / len, d[2] / len] };
}

// The local metres-per-degree of FRAME's tangent plane, measured once through
// core's own enuToEcef/ecefToGeodetic at a 1 km offset. Feeding them back as
// a linear degree->metre grid makes `toSourceXY` the inverse of the tangent
// mapping, so a corner that hits ENU (x, y) lands at source (x, y) to within
// a few centimetres out to T_MAX_M. The assertions below can therefore be
// written in the ENU metres the fixtures are authored in, and they exercise
// the footprint pipeline rather than proj4.
const M_PER_DEG_LNG = 68660.2646;
const M_PER_DEG_LAT = 111267.66;

const toSourceXY = (lng: number, lat: number) =>
  [
    (lng - FRAME.lngDeg) * M_PER_DEG_LNG,
    (lat - FRAME.latDeg) * M_PER_DEG_LAT,
  ] as const;

describe("viewportFootprint", () => {
  it("gives a centred rectangle for a straight-down view", () => {
    const eye = [0, 0, 500] as const;
    const f = viewportFootprint({
      cornerRays: [
        ray(eye, [-400, -250, 0]),
        ray(eye, [400, -250, 0]),
        ray(eye, [400, 250, 0]),
        ray(eye, [-400, 250, 0]),
      ],
      frame: FRAME,
      toSourceXY,
    });
    expect(f).not.toBeNull();
    expect(f!.centre[0]).toBeCloseTo(0, 0);
    expect(f!.centre[1]).toBeCloseTo(0, 0);
    expect(f!.bbox[0]).toBeCloseTo(-400, 0);
    expect(f!.bbox[1]).toBeCloseTo(-250, 0);
    expect(f!.bbox[2]).toBeCloseTo(400, 0);
    expect(f!.bbox[3]).toBeCloseTo(250, 0);
    expect(f!.span).toBeCloseTo(800, 0);
  });

  it("clamps an up-looking (horizon) ray at T_MAX_M instead of running to infinity", () => {
    const eye = [0, 0, 300] as const;
    const horizon = ray(eye, [0, 100000, 300.0001]);
    const f = viewportFootprint({
      cornerRays: [
        ray(eye, [-200, -200, 0]),
        ray(eye, [200, -200, 0]),
        horizon,
        horizon,
      ],
      frame: FRAME,
      toSourceXY,
    });
    expect(f).not.toBeNull();
    expect(f!.bbox.every(Number.isFinite)).toBe(true);
    expect(f!.bbox[3]).toBeLessThanOrEqual(T_MAX_M + 1);
    // Clamped, not collapsed: the ray still travels its full T_MAX_M.
    expect(f!.bbox[3]).toBeGreaterThan(T_MAX_M - 10);
  });

  it("treats T_MAX_M as metres even when the injected direction is not unit length", () => {
    // getPickRay hands back a normalised Three Ray, but t is only in metres
    // for a unit direction — an unnormalised one would put this clamped
    // corner 15 km out (and blow the span limit) instead of 5 km.
    const eye = [0, 0, 300] as const;
    const base = ray(eye, [0, 100000, 300.0001]);
    const long: Ray = {
      origin: base.origin,
      direction: [
        base.direction[0] * 3,
        base.direction[1] * 3,
        base.direction[2] * 3,
      ],
    };
    const f = viewportFootprint({
      cornerRays: [
        ray(eye, [-200, -200, 0]),
        ray(eye, [200, -200, 0]),
        long,
        long,
      ],
      frame: FRAME,
      toSourceXY,
    });
    expect(f).not.toBeNull();
    expect(f!.bbox[3]).toBeCloseTo(T_MAX_M, -2);
  });

  it("uses T_MAX_M — not the true, larger intersection — when a corner's real ground hit is beyond it", () => {
    const eye = [0, 0, 1000] as const;
    // dz/|d| shallow enough that the true hit is ~20 km out.
    const far = ray(eye, [0, 20000, 0]);
    const f = viewportFootprint({
      cornerRays: [far, far, ray(eye, [0, -10, 0]), ray(eye, [10, 0, 0])],
      frame: FRAME,
      toSourceXY,
    });
    expect(f).not.toBeNull();
    expect(f!.bbox[3]).toBeLessThan(T_MAX_M + 1);
    // An implementation that dropped the clamp would put this edge at ~20000.
    expect(f!.bbox[3]).toBeGreaterThan(4000);
  });

  it("keeps a shallow but above-EPS ray's real ground hit instead of over-excluding it", () => {
    // dz/|d| ≈ -1.4e-4, ~140x above EPS: a grazing yet legitimate hit at
    // ~3571 m. A coarser EPS would wrongly clamp this corner to T_MAX_M.
    const eye = [0, 0, 0.5] as const;
    const grazing = ray(eye, [1e6, 0, 0.5 - 140]);
    const f = viewportFootprint({
      cornerRays: [
        grazing,
        grazing,
        ray(eye, [-5, -5, 0]),
        ray(eye, [5, 5, 0]),
      ],
      frame: FRAME,
      toSourceXY,
    });
    expect(f).not.toBeNull();
    expect(f!.bbox[2]).toBeGreaterThan(3500);
    expect(f!.bbox[2]).toBeLessThan(3650);
  });

  it("falls back to T_MAX_M when |dirUp| is inside the EPS band, matching the pre-migration branch", () => {
    expect(EPS).toBe(1e-6);
    // dz/|d| = -8e-8 sits strictly inside the EPS band, yet the true
    // algebraic hit is 0.0002 / 8e-8 = 2500 m — finite and well inside
    // T_MAX_M. Only an implementation that honours the EPS guard discards
    // that reachable hit and clamps to T_MAX_M, so the two branches are
    // distinguishable by output here.
    expect(-0.08 / Math.hypot(1e6, 0.08)).toBeGreaterThan(-EPS);
    expect(-0.08 / Math.hypot(1e6, 0.08)).toBeLessThan(0);
    const eye = [0, 0, 0.0002] as const;
    const flat = ray(eye, [1e6, 0, 0.0002 - 0.08]);
    const f = viewportFootprint({
      cornerRays: [flat, flat, ray(eye, [-5, -5, 0]), ray(eye, [5, 5, 0])],
      frame: FRAME,
      toSourceXY,
    });
    expect(f).not.toBeNull();
    expect(f!.bbox[2]).toBeGreaterThan(4900); // T_MAX_M, not the 2500 m hit
  });

  it("falls back to T_MAX_M, not a zero-length ray, when the eye sits exactly on the ground plane", () => {
    // eye up = 0, so tHit === 0 for every corner regardless of direction;
    // `tHit > 0` must reject that rather than collapsing every corner onto
    // the eye's own position.
    const eye = [0, 0, 0] as const;
    const f = viewportFootprint({
      cornerRays: [
        ray(eye, [-100, -100, -100]),
        ray(eye, [100, -100, -100]),
        ray(eye, [100, 100, -100]),
        ray(eye, [-100, 100, -100]),
      ],
      frame: FRAME,
      toSourceXY,
    });
    expect(f).not.toBeNull();
    expect(f!.span).toBeGreaterThan(1000); // nowhere near a zero-size footprint
  });

  it("falls back to T_MAX_M when a below-ground ray descends away from the plane (negative tHit)", () => {
    const eye = [0, 0, -50] as const;
    const f = viewportFootprint({
      cornerRays: [
        ray(eye, [-100, -100, -150]),
        ray(eye, [100, -100, -150]),
        ray(eye, [100, 100, -150]),
        ray(eye, [-100, 100, -150]),
      ],
      frame: FRAME,
      toSourceXY,
    });
    expect(f).not.toBeNull();
    expect(f!.bbox[0]).toBeLessThanOrEqual(f!.bbox[2]);
    expect(f!.bbox[1]).toBeLessThanOrEqual(f!.bbox[3]);
    expect(f!.span).toBeGreaterThan(1000);
  });

  it("intersects normally when the eye is below the plane and the ray ascends toward it", () => {
    const eye = [0, 0, -50] as const;
    const f = viewportFootprint({
      cornerRays: [
        ray(eye, [-100, -100, 0]),
        ray(eye, [100, -100, 0]),
        ray(eye, [100, 100, 0]),
        ray(eye, [-100, 100, 0]),
      ],
      frame: FRAME,
      toSourceXY,
    });
    expect(f).not.toBeNull();
    expect(f!.span).toBeCloseTo(200, 0);
  });

  it("rejects a footprint wider than MAX_FOOTPRINT_SPAN_M rather than returning an oversized rectangle", () => {
    // Every corner ray is clamped to T_MAX_M, so no two footprint points can
    // be more than 2*T_MAX_M = 10 km apart — MAX_FOOTPRINT_SPAN_M = 8 km sits
    // inside that reachable range, so a wide enough view genuinely exceeds
    // it. These corners hit the ground 4.8 km out along each axis (4826 m of
    // travel, inside the clamp), for a 9.6 km span.
    const eye = [0, 0, 500] as const;
    const f = viewportFootprint({
      cornerRays: [
        ray(eye, [-4800, 0, 0]),
        ray(eye, [0, -4800, 0]),
        ray(eye, [4800, 0, 0]),
        ray(eye, [0, 4800, 0]),
      ],
      frame: FRAME,
      toSourceXY,
    });
    expect(f).toBeNull();
    expect(MAX_FOOTPRINT_SPAN_M).toBeLessThan(12000);
  });

  it("returns null when the projection refuses a corner (unprojectable coordinates)", () => {
    const eye = [0, 0, 500] as const;
    const f = viewportFootprint({
      cornerRays: [
        ray(eye, [-100, -100, 0]),
        ray(eye, [100, -100, 0]),
        ray(eye, [100, 100, 0]),
        ray(eye, [-100, 100, 0]),
      ],
      frame: FRAME,
      toSourceXY: () => null,
    });
    expect(f).toBeNull();
  });

  it("returns null when the projection returns a non-finite coordinate", () => {
    const eye = [0, 0, 500] as const;
    const f = viewportFootprint({
      cornerRays: [
        ray(eye, [-100, -100, 0]),
        ray(eye, [100, -100, 0]),
        ray(eye, [100, 100, 0]),
        ray(eye, [-100, 100, 0]),
      ],
      frame: FRAME,
      toSourceXY: (lng) => [lng * Number.MAX_VALUE * 1e10, 0] as const,
    });
    expect(f).toBeNull();
  });

  it("rejects a degenerate ray at the ray stage, not by relying on NaN reaching the projection", () => {
    // A zero-length direction normalises to NaN, and with a real proj4
    // forward that NaN happens to survive as far as the finite check. This
    // projection launders it into a finite value instead — so the footprint
    // is only null if the degenerate ray is caught before the projection.
    const eye = [0, 0, 500] as const;
    const f = viewportFootprint({
      cornerRays: [
        { origin: enuToEcef(FRAME, eye), direction: [0, 0, 0] },
        ray(eye, [100, -100, 0]),
        ray(eye, [100, 100, 0]),
        ray(eye, [-100, 100, 0]),
      ],
      frame: FRAME,
      toSourceXY: () => [0, 0] as const,
    });
    expect(f).toBeNull();
  });

  it("computes an overflow-safe centre when bbox extremes are large same-sign finite values", () => {
    // Both x extremes round to 9e307 (individually finite, well under
    // Number.MAX_VALUE), but their naive sum overflows to Infinity — so the
    // naive midpoint (a + b) / 2 is Infinity while the true midpoint is
    // exactly representable.
    expect(9e307 + 9e307).toBe(Infinity); // sanity-check the premise itself
    const eye = [0, 0, 500] as const;
    const f = viewportFootprint({
      cornerRays: [
        ray(eye, [-100, -100, 0]),
        ray(eye, [100, -100, 0]),
        ray(eye, [100, 100, 0]),
        ray(eye, [-100, 100, 0]),
      ],
      frame: FRAME,
      toSourceXY: (_lng, lat) =>
        [9e307, (lat - FRAME.latDeg) * M_PER_DEG_LAT] as const,
    });
    expect(f).not.toBeNull();
    expect(Number.isFinite(f!.centre[0])).toBe(true);
    expect(f!.centre[0]).toBe(9e307);
  });
});
