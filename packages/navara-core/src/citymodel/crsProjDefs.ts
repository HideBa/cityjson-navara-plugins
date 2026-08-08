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
 * Parse an EPSG code out of the spellings CityJSON files use in the wild.
 *
 * The spec recommends the OGC URI ("https://www.opengis.net/def/crs/EPSG/0/7415"),
 * but published data is not that tidy: URNs ("urn:ogc:def:crs:EPSG::3414", and
 * the versioned "urn:ogc:def:crs:EPSG:6.9:3414" that older tools emit) and the
 * bare "EPSG:3414" are both common. All of them put the code last, separated by
 * "/" or ":", so one pass over each separator covers the lot — and anything that
 * does not end in a positive number is still rejected.
 *
 * COMPOUND URNs are the one form where "last" is WRONG: in
 * "urn:ogc:def:crs,crs:EPSG::28992,crs:EPSG::5709" the second code is the
 * VERTICAL CRS (NAP heights), and taking the tail would georeference the layer
 * on a height system. The horizontal component comes first, so the URN regex
 * runs before the tail heuristics and takes the FIRST code — the same rule
 * `xmlHelpers.ts`'s CityGML srsName parser already applies.
 */
const URN_EPSG = /urn:ogc:def:crs(?:,crs)?:EPSG:[\d.]*:(\d+)/;

export function parseEpsgCode(uri: string | undefined): number | null {
  if (!uri) return null;

  const urnMatch = URN_EPSG.exec(uri);
  if (urnMatch) {
    const urnCode = Number(urnMatch[1]);
    return Number.isFinite(urnCode) && urnCode > 0 ? urnCode : null;
  }

  const bySlash = uri.split("/");
  const last = bySlash[bySlash.length - 1];
  if (!last) return null;

  const code = Number(last);
  if (Number.isFinite(code) && code > 0) return code;

  // Not a number — a URN or a bare "EPSG:3414" ends in a ":"-separated code.
  // A URN's empty version field ("EPSG::3414") leaves an empty segment, so the
  // last NON-EMPTY one is the code.
  if (!last.includes(":")) return null;
  const byColon = last.split(":").filter((s) => s.length > 0);
  const tail = byColon[byColon.length - 1];
  if (!tail) return null;

  const urnCode = Number(tail);
  return Number.isFinite(urnCode) && urnCode > 0 ? urnCode : null;
}

/**
 * Remote proj4 definitions, fetched from epsg.io on demand.
 *
 * {@link KNOWN_PROJ4_DEFS} above only covers Dutch RD, because that is what the
 * project started on — but the STAC catalog is worldwide (Singapore's SVY21 /
 * EPSG:3414, every national grid a city publishes in), and a fixed list can
 * never keep up. epsg.io serves a plain-text proj4 string per code, so a CRS the
 * fixed list does not know can still be admitted.
 *
 * This does NOT loosen the units gate: {@link assertMetricCrs} still runs
 * afterwards and still refuses anything whose definition is not explicitly
 * `+units=m`, so a degree-based def fetched remotely is rejected exactly like a
 * degree-based one we shipped ourselves. What the fetch buys is coverage, not
 * permission.
 *
 * Failure is never fatal and never cached: the network is allowed to be down,
 * and a later load of the same layer should try again.
 */
const REMOTE_DEF_TIMEOUT_MS = 10_000;

/** In-flight fetches per code, so N concurrent layers share ONE request. */
const inFlightDefs = new Map<number, Promise<boolean>>();

/**
 * Resolve a proj4 def for `epsg`, fetching `https://epsg.io/{code}.proj4` when
 * the fixed list does not know it. Registers with proj4 on success. Never throws.
 *
 * Successes need no cache of their own — proj4's registry IS the cache, and the
 * synchronous {@link ensureProjDef} short-circuits every later call.
 */
export async function ensureProjDefAsync(epsg: number): Promise<boolean> {
  if (ensureProjDef(epsg)) return true;

  const pending = inFlightDefs.get(epsg);
  if (pending) return pending;

  const request = fetchAndRegisterDef(epsg).finally(() => {
    inFlightDefs.delete(epsg);
  });
  inFlightDefs.set(epsg, request);
  return request;
}

async function fetchAndRegisterDef(epsg: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_DEF_TIMEOUT_MS);

  try {
    const res = await fetch(`https://epsg.io/${epsg}.proj4`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;

    const def = (await res.text()).trim();
    // epsg.io answers an unknown code with an error page, not a 404 body we can
    // trust, so the body itself has to look like a proj4 string.
    if (!def || !def.includes("+proj=")) return false;

    proj4.defs(`EPSG:${epsg}`, def);
    // proj4 accepts the string silently even when it cannot parse it into a
    // usable projection, so confirm the registry actually gained something.
    return Boolean(proj4.defs(`EPSG:${epsg}`));
  } catch {
    // Offline, CORS, abort, or a def string proj4 rejects — all "not resolved".
    return false;
  } finally {
    clearTimeout(timer);
  }
}
