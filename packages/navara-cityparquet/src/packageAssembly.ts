/**
 * A CityParquet *package* — a STAC Item manifest plus one or more object
 * tables — as a single normalised `CityModel`.
 *
 * This is the last layer of the read path: `tableReader` turns bytes into rows,
 * `decodeTable` turns rows into `CityObject`s, and this module decides which
 * files of a package are object tables at all, then merges their objects into
 * the one model the viewer draws.
 *
 * Manifest semantics mirror `cityparquet-rs/crates/cityparquet/src/stac/`
 * (`properties.rs::classify_assets` / `table_names_from_manifest_bytes`,
 * `assets.rs`'s role and media-type constants), with two deliberate
 * differences, both in the permissive direction because this is a reader of
 * third-party packages rather than the writer's own round-trip:
 *
 * - **A duplicate href is deduped, not rejected.** The reference writer itself
 *   lists the same table twice (once under the conventional `data` asset key
 *   and once under its own file name), and the Rust classifier only escapes
 *   that because the `data` copy carries no `cityparquet-objects` role. A
 *   package that tagged both would be fatal there; here it loads, and
 *   {@link assembleCityParquetModel}'s first-wins merge means a table read
 *   twice cannot double-count an object either.
 * - **A package with no roles at all still opens.** The Rust reader requires
 *   the `cityparquet-objects` role; a foreign writer that emitted plain STAC
 *   `data` assets would be unreadable. When NO asset carries the role, the
 *   parquet assets minus the three known sidecar file names are used instead.
 *
 * Engine-free: no `@navaramap/*` imports.
 */

import type { BBox3, CityModel, CityObject, Vec3 } from "@cityjson/navara-core";
import { mergeBBox } from "@cityjson/navara-core";
import { CityParquetError } from "./footer";
import { decodeTableObjects } from "./decodeTable";
import { readCityParquetTable } from "./tableReader";

/** STAC asset role identifying an object table (spec §5). */
const ROLE_OBJECT_TABLE = "cityparquet-objects";
/** STAC asset role identifying a materials/textures/templates sidecar (§11–12). */
const ROLE_SIDECAR = "cityparquet-sidecar";
/** IANA media type for Parquet. */
const PARQUET_MEDIA_TYPE = "application/vnd.apache.parquet";

/**
 * The sidecar file names of the format, for the role-less fallback only.
 *
 * A package that tags its assets says which files are sidecars and this set is
 * never consulted; it exists because a writer that emitted bare `data` assets
 * leaves the file name as the only signal, and reading `materials.parquet` as
 * an object table would fail on its very different schema. Names, not paths —
 * matched against an href's last segment.
 */
export const CITYPARQUET_SIDECAR_NAMES: ReadonlySet<string> = new Set([
  "materials.parquet",
  "textures.parquet",
  "geometry_templates.parquet",
]);

/** What a package's manifest declares. */
export interface CityParquetManifest {
  /**
   * Object-table hrefs in manifest order, with any leading `"./"` stripped.
   *
   * They are whatever the manifest wrote, so a caller resolves them against
   * the manifest's own URL (`new URL(href, manifestUrl)`) — which handles a
   * relative name and an absolute one identically.
   */
  objectTables: string[];
}

/** One already-fetched file of a package. */
export interface CityParquetPackageFile {
  /** The table's name, for error messages — normally its manifest href. */
  name: string;
  bytes: Uint8Array;
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A map with NO prototype, for keys that come out of a third-party file.
 *
 * The merged object map is keyed by ids a stranger wrote, so it gets the same
 * treatment `decodeTable` gives its per-table maps: on a plain `{}`,
 * `map["__proto__"] = obj` invokes the inherited setter instead of storing the
 * object, and `"toString" in map` is true of an empty map. Every consumer of
 * `CityModel.objects` in core and in the host app reads it with
 * `Object.keys`/`Object.values`/`Object.entries` or a bare index (audited
 * 2026-08-08: `buildCityMeshArrays`, `buildStyleColors`, the layer store, the
 * stats/table/inspector panels) — none calls `objects.hasOwnProperty(...)`,
 * which is the one pattern a null-prototype map would break.
 */
function bareMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** An asset's href with any leading `./` segments removed. */
function normalizeHref(href: string): string {
  return href.replace(/^(?:\.\/)+/, "");
}

/** The last path segment of an href, for the sidecar-name test. */
function baseName(href: string): string {
  const segments = href.split("/");
  return segments[segments.length - 1] ?? href;
}

interface ManifestAsset {
  href: string;
  mediaType: string | null;
  roles: ReadonlyArray<string>;
}

/**
 * The assets of a STAC Item, narrowed to the three fields this reader uses.
 *
 * An entry without a usable `href` is dropped rather than rejected: a manifest
 * can legitimately carry assets this reader knows nothing about, and the
 * "no object tables" error at the end is the honest report of a manifest that
 * turned out to declare none.
 */
function readAssets(metadataJson: unknown): ManifestAsset[] {
  if (!isPlainObject(metadataJson) || metadataJson.type !== "Feature") {
    throw new CityParquetError(
      "This CityParquet package's metadata.json is not a STAC Item, so its object tables could not be found.",
    );
  }
  const raw = metadataJson.assets;
  if (raw !== undefined && !isPlainObject(raw)) {
    throw new CityParquetError(
      "This CityParquet package's metadata.json is not a STAC Item: its 'assets' member is not an object.",
    );
  }
  const assets: ManifestAsset[] = [];
  for (const value of Object.values(raw ?? {})) {
    if (!isPlainObject(value)) continue;
    const href = value.href;
    if (typeof href !== "string" || href === "") continue;
    const roles = Array.isArray(value.roles)
      ? value.roles.filter((r: unknown): r is string => typeof r === "string")
      : [];
    assets.push({
      href: normalizeHref(href),
      mediaType: typeof value.type === "string" ? value.type : null,
      roles,
    });
  }
  return assets;
}

/**
 * The object tables a package's `metadata.json` declares, in manifest order.
 *
 * Assets tagged `cityparquet-objects` win outright; only when NO asset carries
 * that role does the media-type fallback run, so a tagged package can never
 * pick up an untagged parquet file it deliberately left out.
 *
 * Throws a `CityParquetError` if the document is not a STAC Item, or declares
 * no object table.
 */
export function parseCityParquetManifest(
  metadataJson: unknown,
): CityParquetManifest {
  const assets = readAssets(metadataJson);

  const tagged = assets.filter((a) => a.roles.includes(ROLE_OBJECT_TABLE));
  const candidates =
    tagged.length > 0
      ? tagged
      : assets.filter(
          (a) =>
            !a.roles.includes(ROLE_SIDECAR) &&
            !CITYPARQUET_SIDECAR_NAMES.has(baseName(a.href)) &&
            (a.mediaType === PARQUET_MEDIA_TYPE || a.href.endsWith(".parquet")),
        );

  const objectTables: string[] = [];
  const seen = new Set<string>();
  for (const asset of candidates) {
    if (seen.has(asset.href)) continue;
    seen.add(asset.href);
    objectTables.push(asset.href);
  }

  if (objectTables.length === 0) {
    throw new CityParquetError(
      "This CityParquet package declares no object tables, so there is nothing to load.",
    );
  }
  return { objectTables };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** One decoded table, kept with its file name for error messages. */
interface DecodedTable {
  name: string;
  epsg: number | null;
  objects: Record<string, CityObject>;
}

/**
 * The CRS every table of a package must agree on.
 *
 * A package is one model in one frame: the app projects its vertices through a
 * single proj4 definition, so a table with a different (or unresolvable) EPSG
 * cannot be drawn alongside the others and is refused by name rather than
 * silently misplaced by hundreds of metres.
 */
function consensusEpsg(tables: ReadonlyArray<DecodedTable>): number {
  const missing = tables.filter((t) => t.epsg === null);
  if (missing.length > 0) {
    const names = missing.map((t) => `'${t.name}'`).join(", ");
    throw new CityParquetError(
      `This CityParquet package cannot be georeferenced: ${names} has no EPSG-resolvable CRS.`,
    );
  }
  const first = tables[0];
  if (first === undefined || first.epsg === null) {
    throw new CityParquetError(
      "This CityParquet package has no object tables, so there is nothing to load.",
    );
  }
  const disagreeing = tables.filter((t) => t.epsg !== first.epsg);
  if (disagreeing.length > 0) {
    const others = disagreeing
      .map((t) => `'${t.name}' (EPSG:${String(t.epsg)})`)
      .join(", ");
    throw new CityParquetError(
      `This CityParquet package's tables declare different coordinate reference systems: '${first.name}' is EPSG:${String(first.epsg)} but ${others}. Every table of a package must share one CRS.`,
    );
  }
  return first.epsg;
}

/** The min/max of an object's ring vertices, for a row that stored no bbox. */
function bboxOfSurfaces(object: CityObject): BBox3 | null {
  let box: [number, number, number, number, number, number] | null = null;
  for (const surface of object.surfaces) {
    for (const ring of surface.rings) {
      for (const v of ring) {
        box = extend(box, v);
      }
    }
  }
  return box;
}

function extend(
  box: [number, number, number, number, number, number] | null,
  v: Vec3,
): [number, number, number, number, number, number] {
  if (box === null) return [v[0], v[1], v[2], v[0], v[1], v[2]];
  if (v[0] < box[0]) box[0] = v[0];
  if (v[1] < box[1]) box[1] = v[1];
  if (v[2] < box[2]) box[2] = v[2];
  if (v[0] > box[3]) box[3] = v[0];
  if (v[1] > box[4]) box[4] = v[1];
  if (v[2] > box[5]) box[5] = v[2];
  return box;
}

/** Ring vertices in an object, the unit `CityModel.vertexCount` counts here. */
function countRingVertices(object: CityObject): number {
  let total = 0;
  for (const surface of object.surfaces) {
    for (const ring of surface.rings) total += ring.length;
  }
  return total;
}

/**
 * Every object table of a package as one `CityModel`.
 *
 * Tables are read one at a time rather than with `Promise.all`: the decode is
 * CPU-bound, so concurrency buys nothing on the one thread that would run it,
 * while holding every table's rows at once would multiply peak memory on the
 * large packages this format exists for. It also keeps the first error a
 * caller sees the first error in manifest order.
 *
 * The merge is FIRST-WINS on a duplicate id, with a single summary warning: an
 * id is unique per table by construction, so a cross-table duplicate means two
 * modules describe the same object, and taking the first keeps the result
 * stable in manifest order. `CityModel.objects` is a null-prototype map for the
 * same reason `decodeTable`'s is — see {@link bareMap}.
 *
 * `vertexCount` is the total number of RING vertices. CityJSON reports the
 * length of its shared vertex table, which CityParquet has no equivalent of
 * (every WKB face carries its own coordinates), so the same city reports a
 * larger number here than it does as CityJSON. The field is documented as
 * diagnostic ("total vertex count before normalization") and nothing computes
 * on it, so counting what the format actually stores beats reporting 0.
 */
export async function assembleCityParquetModel(
  files: ReadonlyArray<CityParquetPackageFile>,
): Promise<CityModel> {
  if (files.length === 0) {
    throw new CityParquetError(
      "This CityParquet package has no object tables, so there is nothing to load.",
    );
  }

  const tables: DecodedTable[] = [];
  for (const file of files) {
    const table = await readCityParquetTable(file.bytes);
    tables.push({
      name: file.name,
      epsg: table.footer.epsg,
      objects: decodeTableObjects(table),
    });
  }

  const epsg = consensusEpsg(tables);

  const objects = bareMap<CityObject>();
  let duplicates = 0;
  for (const table of tables) {
    for (const [id, object] of Object.entries(table.objects)) {
      if (hasOwn(objects, id)) {
        duplicates += 1;
        continue;
      }
      objects[id] = object;
    }
  }
  if (duplicates > 0) {
    console.warn(
      `CityParquet: ${duplicates} object id(s) appear in more than one table of this package; the first table's version was kept.`,
    );
  }

  let bbox: BBox3 | null = null;
  let vertexCount = 0;
  for (const object of Object.values(objects)) {
    bbox = mergeBBox(bbox, object.bbox ?? bboxOfSurfaces(object));
    vertexCount += countRingVertices(object);
  }

  return {
    sourceEncoding: "cityparquet",
    metadata: {
      referenceSystem: `https://www.opengis.net/def/crs/EPSG/0/${String(epsg)}`,
    },
    bbox,
    objects,
    vertexCount,
  };
}
