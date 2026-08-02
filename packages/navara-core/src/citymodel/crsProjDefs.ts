/**
 * Known proj4 definitions for CRS commonly used in CityJSON/FlatCityBuf
 * datasets that proj4 does not ship built in.
 *
 * proj4 bundles a small fixed set of CRS (WGS84/EPSG:4326, NAD83/EPSG:4269,
 * Web Mercator/EPSG:3857, the WGS84 UTM zones, and the two UPS polar
 * projections — see proj4's `lib/global.js`); national or regional grids
 * like the Dutch RD New need explicit registration before proj4 can report
 * their units or reproject through them at all.
 *
 * This module is the single place that registration happens. It lives in
 * the core package so both host-facing features (solar position, which
 * reprojects a model's CRS to lat/lon) and format-agnostic plugin code
 * (FlatCityBuf admission, which only needs to know whether a CRS is metric)
 * share one list instead of maintaining two that can silently drift apart.
 *
 * It is also the single place the *units* gate lives ({@link assertMetricCrs}):
 * the static load path (`@cityjson/navara-cityjson`'s `resolveMetricEpsg`) and
 * the FlatCityBuf streaming admission check both call it, so "is this CRS
 * metre-based?" has exactly one answer per CRS in the whole system.
 */
import proj4 from "proj4";

const RD_NEW_DEF =
  "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.2369,50.0087,465.658,-0.40685733032239757,-0.3507326765425626,1.8703473836067956,4.0812 +units=m +no_defs";

const KNOWN_PROJ4_DEFS: Record<number, string> = {
  28992: RD_NEW_DEF, // EPSG:28992 — RD New (Netherlands) horizontal
  7415: RD_NEW_DEF, // EPSG:7415 — compound CRS, horizontal component is RD New
};

/**
 * Registers `epsgCode` with proj4 if it is not already known, using the
 * fixed list above. Returns whether proj4 now has SOME definition for it
 * (built in, registered by an earlier call, or registered here) — this says
 * nothing about whether that definition is metric; callers that care about
 * units read `proj4.defs(\`EPSG:${epsgCode}\`)?.units` themselves afterwards.
 */
export function ensureProjDef(epsgCode: number): boolean {
  const key = `EPSG:${epsgCode}`;
  if (proj4.defs(key)) return true; // already registered (built in or prior call)

  const def = KNOWN_PROJ4_DEFS[epsgCode];
  if (!def) return false;

  proj4.defs(key, def);
  return true;
}

export class NonMetricCrsError extends Error {
  constructor(
    readonly epsg: number,
    readonly units: string | undefined,
  ) {
    super(
      `Cannot georeference this layer: CRS EPSG:${epsg} is not metre-based (units: ${
        units ?? "unspecified"
      }). CityJSON z, the geoid offset and every downstream distance are metres, so this layer cannot be placed.`,
    );
    this.name = "NonMetricCrsError";
  }
}

/**
 * The units gate: `epsg`'s proj4 definition must *explicitly* declare metres.
 *
 * proj4 reprojects x/y out of a foot-based or degree-based CRS perfectly well,
 * so nothing downstream would fail loudly — the layer would just render with
 * heights (and a geoid offset, and every metre-denominated distance constant)
 * scaled wrong, which is far worse than a refusal. Absence of an explicit
 * `+units=m` is treated as "not established": an unregistered code, or one
 * whose definition omits `+units`, is refused for the same reason a known
 * degree-based one is.
 *
 * Registration is attempted first, so a caller that has not already run
 * {@link ensureProjDef} cannot get a spurious refusal for a CRS this package
 * knows about.
 */
export function assertMetricCrs(epsg: number): void {
  ensureProjDef(epsg);
  const units = proj4.defs(`EPSG:${epsg}`)?.units as string | undefined;
  if (units !== "m") throw new NonMetricCrsError(epsg, units);
}

/**
 * Boolean form of {@link assertMetricCrs}, for the admission paths that
 * report a refusal as data rather than throwing (FlatCityBuf's
 * `checkAdmission` returns an `AdmissionError`). Same gate, same answer.
 */
export function isMetricCrs(epsg: number): boolean {
  try {
    assertMetricCrs(epsg);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse EPSG code from an OGC URI like
 * "https://www.opengis.net/def/crs/EPSG/0/7415" → 7415.
 */
export function parseEpsgCode(uri: string | undefined): number | null {
  if (!uri) return null;
  const segments = uri.split("/");
  const last = segments[segments.length - 1];
  if (!last) return null;
  const code = Number(last);
  return Number.isFinite(code) && code > 0 ? code : null;
}
