/**
 * CityJSON appearance: reading the wire `appearance` object, merging the
 * per-unit tables of a sequence into one model-wide table, and resolving a
 * surface's per-theme material / texture entries.
 *
 * Two shapes of source feed this:
 *   - a static CityJSON file carries ONE `appearance` for the whole model;
 *   - a CityJSONSeq or FlatCityBuf feature carries its OWN `appearance`
 *     (local `textures`, `materials`, `vertices-texture`; local indices).
 * The `AppearanceMerger` accepts either: `register()` takes one unit's
 * tables and hands back a context whose remap arrays turn that unit's local
 * indices into model indices. Textures and materials are deduplicated by
 * value, so Rotterdam's ~10 k per-feature texture entries collapse to its
 * 148 real images.
 *
 * Every reader here is TOLERANT: appearance data never blocks geometry. A
 * malformed entry yields "no material" / "untextured" for that surface, never
 * an exception.
 */

import type {
  CityAppearance,
  CityMaterial,
  CityTexture,
  ColorRGB,
  SurfaceTexture,
  TextureWrapMode,
  UV,
  Vec3,
} from "../types";

// ---------------------------------------------------------------------------
// Wire object -> typed tables
// ---------------------------------------------------------------------------

/** One unit's appearance tables, as read from the wire (local indices). */
export interface LocalAppearance {
  readonly materials: ReadonlyArray<CityMaterial>;
  readonly textures: ReadonlyArray<CityTexture>;
  readonly uvs: ReadonlyArray<UV>;
  readonly defaultTextureTheme: string | null;
  readonly defaultMaterialTheme: string | null;
}

const EMPTY_LOCAL: LocalAppearance = {
  materials: [],
  textures: [],
  uvs: [],
  defaultTextureTheme: null,
  defaultMaterialTheme: null,
};

const WRAP_MODES: ReadonlySet<string> = new Set([
  "none",
  "wrap",
  "mirror",
  "clamp",
  "border",
]);
const TEXTURE_TYPES: ReadonlySet<string> = new Set([
  "unknown",
  "specific",
  "typical",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readColor(v: unknown): ColorRGB | undefined {
  if (
    Array.isArray(v) &&
    v.length >= 3 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    typeof v[2] === "number"
  ) {
    return [v[0], v[1], v[2]];
  }
  return undefined;
}

function readNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readMaterial(raw: unknown, index: number): CityMaterial {
  const r = isRecord(raw) ? raw : {};
  const material: {
    name: string;
    diffuseColor?: ColorRGB;
    emissiveColor?: ColorRGB;
    specularColor?: ColorRGB;
    ambientIntensity?: number;
    shininess?: number;
    transparency?: number;
    isSmooth?: boolean;
  } = {
    name: typeof r.name === "string" ? r.name : `material-${index}`,
  };
  const diffuse = readColor(r.diffuseColor);
  if (diffuse) material.diffuseColor = diffuse;
  const emissive = readColor(r.emissiveColor);
  if (emissive) material.emissiveColor = emissive;
  const specular = readColor(r.specularColor);
  if (specular) material.specularColor = specular;
  const ambient = readNumber(r.ambientIntensity);
  if (ambient !== undefined) material.ambientIntensity = ambient;
  const shininess = readNumber(r.shininess);
  if (shininess !== undefined) material.shininess = shininess;
  const transparency = readNumber(r.transparency);
  if (transparency !== undefined) material.transparency = transparency;
  if (typeof r.isSmooth === "boolean") material.isSmooth = r.isSmooth;
  return material;
}

/** A texture without a usable `image` is dropped — nothing could draw it. */
function readTexture(raw: unknown): CityTexture | null {
  if (!isRecord(raw) || typeof raw.image !== "string" || raw.image === "") {
    return null;
  }
  const texture: {
    image: string;
    type: "PNG" | "JPG";
    wrapMode?: TextureWrapMode;
    textureType?: "unknown" | "specific" | "typical";
    borderColor?: readonly [number, number, number, number];
  } = {
    image: raw.image,
    type: raw.type === "PNG" ? "PNG" : "JPG",
  };
  if (typeof raw.wrapMode === "string" && WRAP_MODES.has(raw.wrapMode)) {
    texture.wrapMode = raw.wrapMode as TextureWrapMode;
  }
  if (
    typeof raw.textureType === "string" &&
    TEXTURE_TYPES.has(raw.textureType)
  ) {
    texture.textureType = raw.textureType as "unknown" | "specific" | "typical";
  }
  const bc = raw.borderColor;
  if (
    Array.isArray(bc) &&
    bc.length >= 4 &&
    bc.slice(0, 4).every((c) => typeof c === "number")
  ) {
    texture.borderColor = [bc[0], bc[1], bc[2], bc[3]];
  }
  return texture;
}

/**
 * Read a wire `appearance` object into typed local tables. Anything that is
 * not an object reads as empty; a texture entry with no image is dropped and
 * its slot is left unusable, so indices that pointed at it resolve to
 * "untextured" instead of shifting the rest.
 */
export function readLocalAppearance(raw: unknown): LocalAppearance {
  if (!isRecord(raw)) return EMPTY_LOCAL;
  const materials = Array.isArray(raw.materials)
    ? raw.materials.map((m, i) => readMaterial(m, i))
    : [];
  const textures = Array.isArray(raw.textures)
    ? raw.textures.map((t) => readTexture(t))
    : [];
  const rawUvs = raw["vertices-texture"];
  const uvs: UV[] = Array.isArray(rawUvs)
    ? rawUvs.map((uv): UV =>
        Array.isArray(uv) &&
        typeof uv[0] === "number" &&
        typeof uv[1] === "number"
          ? [uv[0], uv[1]]
          : [0, 0],
      )
    : [];
  return {
    materials,
    // Kept positional (null-free for the type, but see `register`): the
    // merger keeps a parallel "usable" mask so a dropped entry does not shift
    // the indices after it.
    textures: textures.map(
      (t) => t ?? { image: "", type: "JPG" as const },
    ),
    uvs,
    defaultTextureTheme:
      typeof raw["default-theme-texture"] === "string"
        ? raw["default-theme-texture"]
        : null,
    defaultMaterialTheme:
      typeof raw["default-theme-material"] === "string"
        ? raw["default-theme-material"]
        : null,
  };
}

// ---------------------------------------------------------------------------
// Merger
// ---------------------------------------------------------------------------

/** Everything a boundary walker needs to resolve one unit's surfaces. */
export interface AppearanceContext {
  readonly uvs: ReadonlyArray<UV>;
  /** Local texture index -> model index; `-1` for an unusable entry. */
  readonly textureRemap: ReadonlyArray<number>;
  readonly materialRemap: ReadonlyArray<number>;
  /** Theme names observed on surfaces are recorded here (shared with the merger). */
  readonly textureThemes: Set<string>;
  readonly materialThemes: Set<string>;
}

/** A context that resolves nothing — for units that carry no appearance. */
export const EMPTY_APPEARANCE_CONTEXT: AppearanceContext = {
  uvs: [],
  textureRemap: [],
  materialRemap: [],
  textureThemes: new Set(),
  materialThemes: new Set(),
};

/**
 * Accumulates one model-wide appearance from any number of local units.
 *
 * `register` is called once per unit BEFORE its objects are parsed; the
 * returned context is what `parseCityObject` walks with. `build()` is called
 * once at the end and returns `undefined` when nothing at all was seen, so a
 * model without appearances stays exactly as it was.
 */
export class AppearanceMerger {
  private readonly materials: CityMaterial[] = [];
  private readonly materialKeys = new Map<string, number>();
  private readonly textures: CityTexture[] = [];
  private readonly textureKeys = new Map<string, number>();
  private readonly textureThemes = new Set<string>();
  private readonly materialThemes = new Set<string>();
  private defaultTextureTheme: string | null = null;
  private defaultMaterialTheme: string | null = null;
  private seenAny = false;

  register(raw: unknown): AppearanceContext {
    if (!isRecord(raw)) return this.emptyContext();
    const local = readLocalAppearance(raw);
    this.seenAny = true;
    const textureRemap = local.textures.map((t) => {
      if (t.image === "") return -1;
      const key = JSON.stringify(t);
      let index = this.textureKeys.get(key);
      if (index === undefined) {
        index = this.textures.length;
        this.textures.push(t);
        this.textureKeys.set(key, index);
      }
      return index;
    });
    const materialRemap = local.materials.map((m) => {
      const key = JSON.stringify(m);
      let index = this.materialKeys.get(key);
      if (index === undefined) {
        index = this.materials.length;
        this.materials.push(m);
        this.materialKeys.set(key, index);
      }
      return index;
    });
    // First unit to name a default wins — a sequence repeats the same one.
    if (this.defaultTextureTheme === null && local.defaultTextureTheme) {
      this.defaultTextureTheme = local.defaultTextureTheme;
    }
    if (this.defaultMaterialTheme === null && local.defaultMaterialTheme) {
      this.defaultMaterialTheme = local.defaultMaterialTheme;
    }
    return {
      uvs: local.uvs,
      textureRemap,
      materialRemap,
      textureThemes: this.textureThemes,
      materialThemes: this.materialThemes,
    };
  }

  /** A context for a unit without appearance that still records themes. */
  private emptyContext(): AppearanceContext {
    return {
      uvs: [],
      textureRemap: [],
      materialRemap: [],
      textureThemes: this.textureThemes,
      materialThemes: this.materialThemes,
    };
  }

  build(): CityAppearance | undefined {
    if (
      !this.seenAny &&
      this.textureThemes.size === 0 &&
      this.materialThemes.size === 0
    ) {
      return undefined;
    }
    const textureThemes = [...this.textureThemes].sort();
    const materialThemes = [...this.materialThemes].sort();
    return {
      materials: this.materials,
      textures: this.textures,
      textureThemes,
      materialThemes,
      // A declared default that no surface uses is not offered.
      defaultTextureTheme:
        this.defaultTextureTheme !== null &&
        this.textureThemes.has(this.defaultTextureTheme)
          ? this.defaultTextureTheme
          : null,
      defaultMaterialTheme:
        this.defaultMaterialTheme !== null &&
        this.materialThemes.has(this.defaultMaterialTheme)
          ? this.defaultMaterialTheme
          : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Per-surface resolution
// ---------------------------------------------------------------------------

/** Where a surface sits in its geometry's boundary nesting. */
export interface SurfacePath {
  /** Indices ABOVE the surface level: `[]` (MultiSurface), `[shell]` (Solid),
   *  `[solid, shell]` (MultiSolid / CompositeSolid). */
  readonly outer: ReadonlyArray<number>;
  readonly surfaceIndex: number;
}

export interface ResolvedSurfaceAppearance {
  readonly material?: Readonly<Record<string, number>>;
  readonly texture?: Readonly<Record<string, SurfaceTexture>>;
}

function descend(values: unknown, path: SurfacePath): unknown {
  let node: unknown = values;
  for (const p of path.outer) {
    if (!Array.isArray(node)) return undefined;
    node = node[p];
  }
  if (!Array.isArray(node)) return undefined;
  return node[path.surfaceIndex];
}

/**
 * Resolve a surface's per-theme material indices (model-wide, via the
 * context's remap) from the geometry's `material` member.
 *
 * `material.<theme>.value` is one index for every surface of the geometry;
 * `values` is nested two levels shallower than the boundaries (one entry per
 * surface). `null`, a non-number, or an index the unit did not declare all
 * read as "no material in that theme".
 */
export function resolveSurfaceMaterial(
  material: unknown,
  path: SurfacePath,
  ctx: AppearanceContext,
): Readonly<Record<string, number>> | undefined {
  if (!isRecord(material)) return undefined;
  let result: Record<string, number> | undefined;
  for (const [theme, ref] of Object.entries(material)) {
    if (!isRecord(ref)) continue;
    const local =
      typeof ref.value === "number" ? ref.value : descend(ref.values, path);
    if (typeof local !== "number") continue;
    const index = ctx.materialRemap[local];
    if (index === undefined || index < 0) continue;
    (result ??= {})[theme] = index;
    ctx.materialThemes.add(theme);
  }
  return result;
}

/**
 * Resolve a surface's per-theme texture (model-wide index + one UV per ring
 * vertex) from the geometry's `texture` member.
 *
 * `texture.<theme>.values` is nested like the boundaries; at the surface
 * level each ring is `[textureIndex, uvIndex, ...]` with exactly one UV index
 * per ring vertex, or `[null]` for an untextured ring. The exterior ring's
 * texture is the surface's; a surface is textured in a theme only when EVERY
 * ring resolves cleanly (right length, every UV index declared), so a
 * triangulation never has to invent coordinates for half a polygon.
 *
 * `rawRings` are the boundary index arrays and `keptRings` the resolved
 * coordinates the walker actually kept — a vertex index the file never
 * declared is skipped by the geometry walk, and its UV is skipped here the
 * same way so the two stay paired.
 */
export function resolveSurfaceTexture(
  texture: unknown,
  path: SurfacePath,
  rawRings: ReadonlyArray<ReadonlyArray<number>>,
  keptRings: ReadonlyArray<ReadonlyArray<Vec3>>,
  realVertices: ReadonlyArray<Vec3 | undefined>,
  ctx: AppearanceContext,
): Readonly<Record<string, SurfaceTexture>> | undefined {
  if (!isRecord(texture) || rawRings.length === 0) return undefined;
  let result: Record<string, SurfaceTexture> | undefined;
  for (const [theme, ref] of Object.entries(texture)) {
    if (!isRecord(ref)) continue;
    const entry = descend(ref.values, path);
    if (!Array.isArray(entry)) continue;
    const exterior = entry[0];
    if (!Array.isArray(exterior) || typeof exterior[0] !== "number") continue;
    const textureIndex = ctx.textureRemap[exterior[0]];
    if (textureIndex === undefined || textureIndex < 0) continue;

    const uvRings: UV[][] = [];
    let ok = true;
    for (let r = 0; r < rawRings.length && ok; r++) {
      const ring = rawRings[r]!;
      const values = entry[r];
      if (!Array.isArray(values) || values.length !== ring.length + 1) {
        ok = false;
        break;
      }
      const uvRing: UV[] = [];
      for (let k = 0; k < ring.length; k++) {
        if (!realVertices[ring[k]!]) continue; // vertex the walk dropped
        const uvIndex = values[k + 1];
        const uv = typeof uvIndex === "number" ? ctx.uvs[uvIndex] : undefined;
        if (!uv) {
          ok = false;
          break;
        }
        uvRing.push(uv);
      }
      if (!ok || uvRing.length !== (keptRings[r]?.length ?? -1)) {
        ok = false;
        break;
      }
      uvRings.push(uvRing);
    }
    if (!ok) continue;
    (result ??= {})[theme] = { textureIndex, uvs: uvRings };
    ctx.textureThemes.add(theme);
  }
  return result;
}
