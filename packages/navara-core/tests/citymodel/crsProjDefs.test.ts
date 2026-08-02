import { describe, it, expect } from "vitest";
import proj4 from "proj4";
import { ensureProjDef, parseEpsgCode } from "../../src/citymodel/crsProjDefs";

// ensureProjDef mutates proj4's global registry, so these cases assert on the
// registry's observable state rather than on isolation between them.
describe("ensureProjDef", () => {
  it("reports true for CRS proj4 ships built in, without registering anything", () => {
    expect(ensureProjDef(4326)).toBe(true);
    expect(proj4.defs("EPSG:4326")).toBeTruthy();
  });

  // proj4 parses a "+proj=…" string into an object whose projection name is
  // `projName` (there is no `proj` key on the parsed def), so that is what the
  // two cases below read.
  it("registers RD New for EPSG:28992 and reports metres", () => {
    expect(ensureProjDef(28992)).toBe(true);
    const def = proj4.defs("EPSG:28992") as {
      units?: string;
      projName?: string;
    };
    expect(def.projName).toBe("sterea");
    expect(def.units).toBe("m");
  });

  it("registers the RD New horizontal component for the EPSG:7415 compound CRS", () => {
    expect(ensureProjDef(7415)).toBe(true);
    const def = proj4.defs("EPSG:7415") as {
      units?: string;
      projName?: string;
    };
    expect(def.projName).toBe("sterea");
    expect(def.units).toBe("m");
  });

  it("is idempotent — a second call keeps the same definition", () => {
    ensureProjDef(28992);
    const first = proj4.defs("EPSG:28992");
    expect(ensureProjDef(28992)).toBe(true);
    expect(proj4.defs("EPSG:28992")).toBe(first);
  });

  it("reports false for a CRS that is neither built in nor in the fixed list", () => {
    expect(ensureProjDef(99999)).toBe(false);
    expect(proj4.defs("EPSG:99999")).toBeUndefined();
  });

  it("reprojects an RD New coordinate into WGS84 near Delft", () => {
    ensureProjDef(28992);
    const [lon, lat] = proj4("EPSG:28992", "EPSG:4326", [85530, 446100]);
    expect(lon).toBeCloseTo(4.36, 1);
    expect(lat).toBeCloseTo(52.01, 1);
  });
});

// Moved verbatim from tests/unit/features/solar/solarStore.test.ts (the five
// parseEpsgCode cases); the app file keeps its own describes for the solar
// store itself.
describe("parseEpsgCode", () => {
  it("parses an OGC CRS URI", () => {
    expect(parseEpsgCode("https://www.opengis.net/def/crs/EPSG/0/7415")).toBe(
      7415,
    );
  });

  it("parses a bare EPSG path", () => {
    expect(parseEpsgCode("EPSG/0/28992")).toBe(28992);
  });

  it("returns null for undefined", () => {
    expect(parseEpsgCode(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseEpsgCode("")).toBeNull();
  });

  it("returns null when the last segment is not a positive number", () => {
    expect(parseEpsgCode("https://example.com/crs/foo")).toBeNull();
  });
});
