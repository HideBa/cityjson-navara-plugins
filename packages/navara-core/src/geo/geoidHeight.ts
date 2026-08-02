/**
 * EGM2008 geoid undulation sampling.
 *
 * CityJSON z is an orthometric height above a local vertical datum (NAP for
 * EPSG:7415); the ENU frame is built on the WGS84 ellipsoid. The conversion
 * is `ellipsoidal = orthometric + N`, where N is the geoid undulation — so
 * the number this module returns IS the `heightOffset` the ENU transform
 * needs (see `sourceToEnu.ts` and Global Constraints -> Vertical datum).
 *
 * Source: the Re:Earth Terrain service, which publishes EGM2008 as
 * Mapbox Terrain-RGB raster tiles. Global coverage, no API key, no auth.
 *
 * OBSERVED SERVICE SHAPE (verified against the live TileJSON, 2026-08-02):
 *   tilejson    "3.0.0", name "mapterhorn-egm08 / mapbox / geoid"
 *   encoding    "mapbox"   -> the Terrain-RGB branch of `decodeHeight` is
 *                             the correct one; "terrarium" stays implemented
 *                             because the field is authoritative, not assumed.
 *   minzoom/maxzoom 0 / 14 -> the fixed SAMPLE_ZOOM of 5 needs no clamping.
 *   scheme      "xyz"      -> the {z}/{x}/{y} expansion below is right.
 *   tiles[0]    "https://terrain.reearth.land/mapterhorn-egm08/mapbox/geoid/
 *                {z}/{x}/{y}.webp"  — note: a DIFFERENT path from the
 *                TileJSON's own, and .webp rather than .png. That is exactly
 *                why the template is read from the document at runtime and
 *                never hard-coded here. `createImageBitmap` decodes WebP in
 *                every browser Navara targets.
 *   attribution "Re:Earth Terrain, Mapterhorn, EGM2008 (NGA)"
 *
 * ATTRIBUTION IS MANDATORY wherever this is used: CC BY 4.0 Mapterhorn and
 * ODbL OpenStreetMap, plus the service's own credit line (see
 * GEOID_ATTRIBUTION; the app renders it in Task C17's attribution overlay).
 *
 * BEST EFFORT, NO SLA: every failure path resolves 0 with one console.warn
 * rather than rejecting. A model then renders at its old, geoid-separation-
 * low position instead of not rendering at all — the right trade-off for an
 * offline dev session.
 */
export const GEOID_TILEJSON_URL =
  "https://terrain.reearth.land/mapbox/geoid/tilejson.json";

export const GEOID_ATTRIBUTION: readonly string[] = [
  "Geoid (EGM2008): © Mapterhorn, CC BY 4.0",
  "© OpenStreetMap contributors, ODbL",
  "Re:Earth Terrain, EGM2008 (NGA)",
];

/**
 * Fixed sample zoom. The geoid is an extremely smooth field — undulation
 * changes by centimetres per kilometre — so a coarse zoom is both accurate
 * enough and kind to the service. Clamped to the TileJSON's own
 * minzoom/maxzoom at call time.
 */
const SAMPLE_ZOOM = 5;

interface TileJson {
  readonly tiles: readonly string[];
  readonly minzoom?: number;
  readonly maxzoom?: number;
  /** "mapbox" (Terrain-RGB) or "terrarium". Verified at runtime, see below. */
  readonly encoding?: string;
}

export interface RasterPixels {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  readonly data: Uint8ClampedArray;
}

export interface GeoidSampleDeps {
  /** Blob -> RGBA pixels. Injected so the module has no DOM dependency and
   *  the tests need no image codec. Defaults to `decodeWithImageBitmap`. */
  decode?(blob: Blob): Promise<RasterPixels>;
}

let tileJsonPromise: Promise<TileJson> | null = null;

/** Test seam: drops the cached TileJSON promise. */
export function resetGeoidCacheForTest(): void {
  tileJsonPromise = null;
}

async function loadTileJson(fetchImpl: typeof fetch): Promise<TileJson> {
  if (tileJsonPromise) return tileJsonPromise;
  const pending = (async () => {
    const res = await fetchImpl(GEOID_TILEJSON_URL);
    if (!res.ok) throw new Error(`TileJSON HTTP ${res.status}`);
    return (await res.json()) as TileJson;
  })();
  tileJsonPromise = pending;
  // A transient failure at startup must not poison every later layer, so
  // drop the cache on rejection and keep it only on success.
  pending.catch(() => {
    if (tileJsonPromise === pending) tileJsonPromise = null;
  });
  return pending;
}

/**
 * Default decoder. `createImageBitmap` + OffscreenCanvas exist in both the
 * window and (in modern browsers) worker contexts, so this works from the
 * FCB worker too; where OffscreenCanvas is missing it throws and the caller
 * falls back to 0. Nothing in the plan calls this from Node — the tests
 * inject `decode` instead.
 */
async function decodeWithImageBitmap(blob: Blob): Promise<RasterPixels> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context for geoid tile decoding");
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: image.width, height: image.height, data: image.data };
  } finally {
    bitmap.close();
  }
}

/** Slippy-map tile coordinate, kept fractional so the caller can address a
 *  texel inside the tile rather than only the tile itself. */
function tileCoords(
  lngDeg: number,
  latDeg: number,
  zoom: number,
): { x: number; y: number } {
  const n = 2 ** zoom;
  const lat =
    (Math.max(-85.05112878, Math.min(85.05112878, latDeg)) * Math.PI) / 180;
  return {
    x: ((lngDeg + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n,
  };
}

/**
 * Mapbox Terrain-RGB: `height = -10000 + (R * 65536 + G * 256 + B) * 0.1`.
 *
 * The TileJSON's `encoding` field is authoritative and is read, not assumed;
 * the live service reports "mapbox" (see the header comment), so the
 * Terrain-RGB branch is the one taken today. The "terrarium" branch stays in
 * place because the field is what decides, not this comment.
 */
function decodeHeight(
  r: number,
  g: number,
  b: number,
  encoding: string | undefined,
): number {
  if (encoding === "terrarium") return r * 256 + g + b / 256 - 32768;
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

export async function geoidHeightAt(
  lngDeg: number,
  latDeg: number,
  fetchImpl: typeof fetch = fetch,
  deps: GeoidSampleDeps = {},
): Promise<number> {
  try {
    const tileJson = await loadTileJson(fetchImpl);
    const template = tileJson.tiles[0];
    if (!template) throw new Error("TileJSON has no tile template");

    const zoom = Math.max(
      tileJson.minzoom ?? 0,
      Math.min(tileJson.maxzoom ?? SAMPLE_ZOOM, SAMPLE_ZOOM),
    );
    const { x, y } = tileCoords(lngDeg, latDeg, zoom);
    const tileX = Math.floor(x);
    const tileY = Math.floor(y);

    const url = template
      .replace("{z}", String(zoom))
      .replace("{x}", String(tileX))
      .replace("{y}", String(tileY));
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`geoid tile HTTP ${res.status}`);

    const decode = deps.decode ?? decodeWithImageBitmap;
    const pixels = await decode(await res.blob());

    // Address the texel the coordinate actually falls on: the fractional
    // part of the tile coordinate scaled by the tile's pixel size.
    const px = Math.min(
      pixels.width - 1,
      Math.max(0, Math.floor((x - tileX) * pixels.width)),
    );
    const py = Math.min(
      pixels.height - 1,
      Math.max(0, Math.floor((y - tileY) * pixels.height)),
    );
    const i = (py * pixels.width + px) * 4;
    return decodeHeight(
      pixels.data[i]!,
      pixels.data[i + 1]!,
      pixels.data[i + 2]!,
      tileJson.encoding,
    );
  } catch (error) {
    console.warn(
      `[geoid] Could not sample geoid undulation at ${lngDeg.toFixed(4)}, ${latDeg.toFixed(4)}; ` +
        `falling back to 0 m (the model will sit at its geoid separation below terrain).`,
      error,
    );
    return 0;
  }
}
