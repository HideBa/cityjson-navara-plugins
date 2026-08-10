import { afterEach, describe, it, expect, vi } from "vitest";
import proj4 from "proj4";
import {
  ensureProjDef,
  ensureProjDefAsync,
  isMetricCrs,
  parseEpsgCode,
} from "../../src/citymodel/crsProjDefs";

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
    // Ground truth from PROJ (cs2cs EPSG:28992 → EPSG:4326), pinned to ~5 m:
    // proj4's +towgs84 wants position-vector rotations, EPSG publishes
    // coordinate-frame ones, and a half-negated conversion (the def this test
    // shipped with) put every Dutch layer ~76 m ENE of truth — a regression
    // this tolerance catches while decimetre-level datum residue passes.
    expect(lon).toBeCloseTo(4.375584, 4);
    expect(lat).toBeCloseTo(51.998927, 4);
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

  it("parses an OGC URN with an empty version field", () => {
    expect(parseEpsgCode("urn:ogc:def:crs:EPSG::3414")).toBe(3414);
  });

  it("parses an OGC URN with an explicit version", () => {
    expect(parseEpsgCode("urn:ogc:def:crs:EPSG:6.9:3414")).toBe(3414);
  });

  it("parses a bare EPSG:code", () => {
    expect(parseEpsgCode("EPSG:3414")).toBe(3414);
  });

  it("takes the FIRST code of a compound URN — the horizontal CRS, not the height system", () => {
    // The tail here is EPSG:5709, NAP HEIGHTS — resolving that would
    // georeference the layer on a vertical CRS.
    expect(
      parseEpsgCode("urn:ogc:def:crs,crs:EPSG::28992,crs:EPSG::5709"),
    ).toBe(28992);
    expect(
      parseEpsgCode("urn:ogc:def:crs,crs:EPSG:9.9.1:28992,crs:EPSG::5709"),
    ).toBe(28992);
  });

  it("returns null for a URN whose code is not a number", () => {
    expect(parseEpsgCode("urn:ogc:def:crs:OGC:1.3:CRS84")).toBeNull();
  });

  it("returns null for garbage with colons", () => {
    expect(parseEpsgCode("not:a:crs")).toBeNull();
    expect(parseEpsgCode("EPSG:")).toBeNull();
  });
});

// EPSG:3414 (SVY21 / Singapore TM) — a real def, used as the fetched body so
// the registration assertions exercise proj4's real parser.
const SVY21_DEF =
  "+proj=tmerc +lat_0=1.366666666666667 +lon_0=103.8333333333333 +k=1 +x_0=28001.642 +y_0=38744.572 +ellps=WGS84 +units=m +no_defs";

// proj4's registry is process-global and these cases register into it, so each
// case uses a code no other case (or the app) touches.
describe("ensureProjDefAsync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("short-circuits a code the sync path already answers, without fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(ensureProjDefAsync(28992)).resolves.toBe(true);
    await expect(ensureProjDefAsync(4326)).resolves.toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches an unknown code from epsg.io and registers it", async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(SVY21_DEF, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(ensureProjDefAsync(93414)).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://epsg.io/93414.proj4",
    );

    const def = proj4.defs("EPSG:93414") as {
      units?: string;
      projName?: string;
    };
    expect(def).toBeTruthy();
    expect(def.projName).toBe("tmerc");
    expect(def.units).toBe("m");

    // Registered once is registered for good — no second request.
    await expect(ensureProjDefAsync(93414)).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns false on a 404 and retries on a later call (no failure caching)", async () => {
    const fetchSpy = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(ensureProjDefAsync(93415)).resolves.toBe(false);
    await expect(ensureProjDefAsync(93415)).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(proj4.defs("EPSG:93415")).toBeUndefined();
  });

  it("returns false when the body is not a proj4 string", async () => {
    const fetchSpy = vi.fn(
      async () => new Response("<html>Not found</html>", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(ensureProjDefAsync(93416)).resolves.toBe(false);
    expect(proj4.defs("EPSG:93416")).toBeUndefined();
  });

  it("returns false when the network throws", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(ensureProjDefAsync(93417)).resolves.toBe(false);
  });

  it("shares one request between concurrent calls for the same code", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchSpy = vi.fn(async () => {
      await gate;
      return new Response(SVY21_DEF, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const calls = Promise.all([
      ensureProjDefAsync(93418),
      ensureProjDefAsync(93418),
      ensureProjDefAsync(93418),
    ]);
    release!();

    expect(await calls).toEqual([true, true, true]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("still refuses a remotely fetched degree-based CRS at the units gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("+proj=longlat +datum=WGS84 +no_defs", { status: 200 }),
      ),
    );

    await expect(ensureProjDefAsync(93419)).resolves.toBe(true);
    expect(isMetricCrs(93419)).toBe(false);
  });
});
