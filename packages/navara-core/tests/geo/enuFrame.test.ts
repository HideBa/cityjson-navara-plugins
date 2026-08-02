import { describe, it, expect } from "vitest";
import proj4 from "proj4";
import {
  ecefToEnu,
  ecefToGeodetic,
  enuToEcef,
  geodeticToEcef,
  makeEnuFrame,
} from "../../src/geo/enuFrame";

// Independent oracle: geocentric WGS84, so the assertions do not re-derive
// the implementation's own formula.
proj4.defs("EPSG:4978", "+proj=geocent +datum=WGS84 +units=m +no_defs");
const DELFT = { lng: 4.3571, lat: 52.0116, h: 0 };

describe("geodeticToEcef", () => {
  it("matches proj4's geocentric transform within 1 mm", () => {
    const got = geodeticToEcef(DELFT.lng, DELFT.lat, DELFT.h);
    const want = proj4("EPSG:4326", "EPSG:4978", [
      DELFT.lng,
      DELFT.lat,
      DELFT.h,
    ]) as [number, number, number];
    expect(got[0]).toBeCloseTo(want[0], 3);
    expect(got[1]).toBeCloseTo(want[1], 3);
    expect(got[2]).toBeCloseTo(want[2], 3);
  });
});

describe("ecefToGeodetic", () => {
  it("inverts geodeticToEcef to sub-millidegree / sub-millimetre", () => {
    const p = geodeticToEcef(DELFT.lng, DELFT.lat, 43.2);
    const g = ecefToGeodetic(p);
    expect(g.lngDeg).toBeCloseTo(DELFT.lng, 9);
    expect(g.latDeg).toBeCloseTo(DELFT.lat, 9);
    expect(g.heightM).toBeCloseTo(43.2, 3);
  });
});

describe("makeEnuFrame", () => {
  it("is z-up ENU: +x is east, +y is north, +z is up — no axis swap, unlike the retired sceneTransform", () => {
    const f = makeEnuFrame(DELFT.lng, DELFT.lat, 0);
    const east = enuToEcef(f, [1, 0, 0]).map((c, i) => c - f.originEcef[i]!);
    const north = enuToEcef(f, [0, 1, 0]).map((c, i) => c - f.originEcef[i]!);
    const up = enuToEcef(f, [0, 0, 1]).map((c, i) => c - f.originEcef[i]!);

    const lam = (DELFT.lng * Math.PI) / 180;
    // East basis is exactly (-sin λ, cos λ, 0).
    expect(east[0]).toBeCloseTo(-Math.sin(lam), 9);
    expect(east[1]).toBeCloseTo(Math.cos(lam), 9);
    expect(east[2]).toBeCloseTo(0, 9);
    // Up points away from the geocentre; north has a positive z component
    // in the northern hemisphere.
    expect(
      up[0]! * f.originEcef[0]! + up[2]! * f.originEcef[2]!,
    ).toBeGreaterThan(0);
    expect(north[2]).toBeGreaterThan(0);
    // Orthonormal.
    expect(
      east[0]! * north[0]! + east[1]! * north[1]! + east[2]! * north[2]!,
    ).toBeCloseTo(0, 9);
  });

  it("round-trips ecefToEnu(enuToEcef(v)) to millimetre accuracy 5 km out", () => {
    const f = makeEnuFrame(DELFT.lng, DELFT.lat, 0);
    const v = [3200, -4100, 87] as const;
    const back = ecefToEnu(f, enuToEcef(f, v));
    expect(back[0]).toBeCloseTo(v[0], 3);
    expect(back[1]).toBeCloseTo(v[1], 3);
    expect(back[2]).toBeCloseTo(v[2], 3);
  });

  it("places a point 1000 m east of the origin at a larger longitude and the same latitude", () => {
    const f = makeEnuFrame(DELFT.lng, DELFT.lat, 0);
    const g = ecefToGeodetic(enuToEcef(f, [1000, 0, 0]));
    expect(g.lngDeg).toBeGreaterThan(DELFT.lng);
    expect(g.latDeg).toBeCloseTo(DELFT.lat, 4);
  });
});
