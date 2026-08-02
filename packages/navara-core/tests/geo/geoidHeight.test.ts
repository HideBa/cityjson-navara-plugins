import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GEOID_ATTRIBUTION,
  GEOID_TILEJSON_URL,
  geoidHeightAt,
  resetGeoidCacheForTest,
} from "../../src/geo/geoidHeight";

const TILEJSON = {
  tilejson: "2.2.0",
  tiles: ["https://terrain.reearth.land/mapbox/geoid/{z}/{x}/{y}.png"],
  minzoom: 0,
  maxzoom: 9,
  encoding: "mapbox",
};

/**
 * A synthetic 2x2 Terrain-RGB tile. Mapbox encoding is
 * `height = -10000 + (R * 65536 + G * 256 + B) * 0.1`, so a target height h
 * needs the integer `(h + 10000) / 0.1` split across the three channels.
 */
function rgbFor(height: number): [number, number, number] {
  const v = Math.round((height + 10000) / 0.1);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Row-major RGBA for a 2x2 tile: [topLeft, topRight, bottomLeft, bottomRight]. */
function tilePixels(heights: readonly [number, number, number, number]) {
  const data = new Uint8ClampedArray(2 * 2 * 4);
  heights.forEach((h, i) => {
    const [r, g, b] = rgbFor(h);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  });
  return { width: 2, height: 2, data };
}

/** fetch fake: TileJSON first, then the raster tile as a Blob whose decoded
 *  pixels the module reads through the injected decoder seam. */
function makeFetch(
  heights: readonly [number, number, number, number],
  opts: { tileStatus?: number; tileJsonStatus?: number } = {},
) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === GEOID_TILEJSON_URL) {
      return new Response(JSON.stringify(TILEJSON), {
        status: opts.tileJsonStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(new Blob([new Uint8Array([1, 2, 3])]), {
      status: opts.tileStatus ?? 200,
    });
  });
  return {
    impl: impl as unknown as typeof fetch,
    calls,
    pixels: tilePixels(heights),
  };
}

describe("geoidHeightAt", () => {
  beforeEach(() => {
    resetGeoidCacheForTest();
    vi.restoreAllMocks();
  });

  it("decodes a Terrain-RGB pixel into metres of undulation", async () => {
    // All four texels carry the same value, so fractional sampling is
    // irrelevant here and the assertion is purely about decoding.
    const f = makeFetch([43.2, 43.2, 43.2, 43.2]);
    const h = await geoidHeightAt(4.3571, 52.0116, f.impl, {
      decode: async () => f.pixels,
    });
    // Terrain-RGB quantises to 0.1 m, so 0.05 m is the tightest honest bound.
    expect(h).toBeCloseTo(43.2, 1);
  });

  it("fetches the TileJSON once and reuses it across calls", async () => {
    const f = makeFetch([43, 43, 43, 43]);
    const decode = async () => f.pixels;
    await geoidHeightAt(4.35, 52.01, f.impl, { decode });
    await geoidHeightAt(5.12, 52.09, f.impl, { decode });
    expect(f.calls.filter((u) => u === GEOID_TILEJSON_URL)).toHaveLength(1);
    // ...but each sample still fetches its own raster tile.
    expect(
      f.calls.filter((u) => u !== GEOID_TILEJSON_URL).length,
    ).toBeGreaterThan(1);
  });

  it("expands the TileJSON template with the slippy-map tile for the coordinate", async () => {
    const f = makeFetch([1, 1, 1, 1]);
    await geoidHeightAt(0, 0, f.impl, { decode: async () => f.pixels });
    const tileUrl = f.calls.find((u) => u !== GEOID_TILEJSON_URL)!;
    // (0,0) at the plan's fixed zoom 5 is the tile just past the middle of
    // the 32x32 grid in both axes.
    expect(tileUrl).toBe(
      "https://terrain.reearth.land/mapbox/geoid/5/16/16.png",
    );
  });

  it("samples at the FRACTIONAL position inside the tile, not always texel 0", async () => {
    // Top-left 0 m, top-right 100 m: a coordinate in the tile's right half
    // must read the right-hand texel.
    const f = makeFetch([0, 100, 0, 100]);
    const decode = async () => f.pixels;
    // Longitude chosen to land in the right half of its tile at zoom 5.
    const right = await geoidHeightAt(11.2, 0.0001, f.impl, { decode });
    expect(right).toBeCloseTo(100, 1);
  });

  it("falls back to 0 with a warning when the tile request fails (offline / no SLA)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = makeFetch([43, 43, 43, 43], { tileStatus: 404 });
    await expect(
      geoidHeightAt(4.35, 52.01, f.impl, { decode: async () => f.pixels }),
    ).resolves.toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/geoid/i);
  });

  it("falls back to 0 when the TileJSON itself is unreachable, and does not cache the failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = makeFetch([43, 43, 43, 43], { tileJsonStatus: 503 });
    await expect(
      geoidHeightAt(4.35, 52.01, bad.impl, { decode: async () => bad.pixels }),
    ).resolves.toBe(0);
    // A later call must be able to succeed — a transient 503 at startup must
    // not poison every layer for the rest of the session.
    const good = makeFetch([43, 43, 43, 43]);
    await expect(
      geoidHeightAt(4.35, 52.01, good.impl, {
        decode: async () => good.pixels,
      }),
    ).resolves.toBeCloseTo(43, 1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to 0 when the decoder throws, rather than rejecting", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = makeFetch([43, 43, 43, 43]);
    await expect(
      geoidHeightAt(4.35, 52.01, f.impl, {
        decode: async () => {
          throw new Error("no ImageBitmap here");
        },
      }),
    ).resolves.toBe(0);
  });

  it("exposes the licence strings the app is required to display", () => {
    expect(GEOID_ATTRIBUTION.join(" ")).toMatch(/Mapterhorn/);
    expect(GEOID_ATTRIBUTION.join(" ")).toMatch(/OpenStreetMap/);
  });
});
