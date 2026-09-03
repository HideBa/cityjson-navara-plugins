/**
 * Everything a textured city mesh needs beyond its arrays: resolving a
 * texture's image path against the DATASET's URL, loading images through an
 * injectable seam, one material per texture group, and the per-vertex
 * "white-out" that lets an image show unmodulated where it has loaded.
 *
 * Engine-free (imports `three` only) and Node-importable: the default
 * `TextureSource` wraps three's `TextureLoader`, which touches the DOM only
 * when `load` is called, and every test injects a fake instead.
 *
 * Why images are a MASK rather than a colour: both mesh classes multiply the
 * material's `map` by the vertex colour (`vertexColors: true`), and the vertex
 * colour is also how rules, hover and selection are drawn. Writing WHITE over
 * the vertices of a group whose image is ready shows the image as-is; leaving
 * the semantic colour where an image is still loading, failed, or could not
 * be resolved (a relative path in a local file) degrades to the plain look
 * for exactly those faces. Highlights are painted after the mask, so a
 * selected textured face tints — it is still visibly selected.
 */
import {
  ClampToEdgeWrapping,
  DoubleSide,
  MeshBasicMaterial,
  MirroredRepeatWrapping,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  type Texture,
} from "three";
import type { CityTexture, TextureGroup } from "@cityjson/navara-core";

/**
 * The image-loading seam. `load` starts fetching `url` and reports through
 * the callbacks; it never throws. The default is three's `TextureLoader`
 * with anonymous cross-origin credentials — the image host must send CORS
 * headers, exactly like the dataset host had to for the JSON.
 */
export interface TextureSource {
  load(
    url: string,
    onLoad: (texture: Texture) => void,
    onError: (error: unknown) => void,
  ): void;
}

export function defaultTextureSource(): TextureSource {
  let loader: TextureLoader | null = null;
  return {
    load(url, onLoad, onError) {
      loader ??= new TextureLoader().setCrossOrigin("anonymous");
      loader.load(url, onLoad, undefined, onError);
    },
  };
}

/**
 * Resolve a texture's `image` against the dataset's URL.
 *
 * `appearances/0320_2_18.jpg` in a file served from
 * `https://host/path/rotterdam.jsonl` is `https://host/path/appearances/…`,
 * NOT anything on the app's own origin — which is what a bare relative fetch
 * would produce. Returns `null` when the path is relative and there is no
 * base (a local file), or when the result is not a URL at all.
 */
export function resolveTextureUrl(
  image: string,
  baseUrl: string | null | undefined,
): string | null {
  try {
    if (baseUrl) return new URL(image, baseUrl).href;
    return new URL(image).href; // absolute, or throws
  } catch {
    return null;
  }
}

export type TextureStatus = "loading" | "ready" | "failed";

export interface TextureCacheEntry {
  readonly status: TextureStatus;
  readonly texture: Texture | null;
}

export interface TextureCacheOptions {
  readonly textures: ReadonlyArray<CityTexture>;
  readonly baseUrl: string | null | undefined;
  readonly source: TextureSource;
  /** An image became ready (or failed): the owner re-applies materials and
   *  repaints. Called only for indices previously requested. */
  readonly onChange: (textureIndex: number, entry: TextureCacheEntry) => void;
  /** Where to send the one-per-cache "could not resolve" warning. */
  readonly warn?: (message: string) => void;
}

/**
 * Per-mesh cache of loaded images, keyed by model texture index. Survives LoD
 * rebuilds (the geometry changes, the images do not) and dies with the mesh
 * or with a change of texture theme.
 */
export class TextureCache {
  private readonly entries = new Map<number, TextureCacheEntry>();
  private disposed = false;
  private unresolvable = 0;

  constructor(private readonly options: TextureCacheOptions) {}

  get(textureIndex: number): TextureCacheEntry | undefined {
    return this.entries.get(textureIndex);
  }

  /** Start loading `textureIndex` unless it is already known. */
  request(textureIndex: number): TextureCacheEntry {
    const known = this.entries.get(textureIndex);
    if (known) return known;
    const definition = this.options.textures[textureIndex];
    const url = definition
      ? resolveTextureUrl(definition.image, this.options.baseUrl)
      : null;
    if (!definition || url === null) {
      const failed: TextureCacheEntry = { status: "failed", texture: null };
      this.entries.set(textureIndex, failed);
      this.unresolvable++;
      if (this.unresolvable === 1) {
        this.options.warn?.(
          `Texture image "${definition?.image ?? "?"}" cannot be resolved${
            this.options.baseUrl
              ? ""
              : " (relative path, and the layer was not loaded from a URL)"
          }; those surfaces render untextured.`,
        );
      }
      return failed;
    }
    const loading: TextureCacheEntry = { status: "loading", texture: null };
    this.entries.set(textureIndex, loading);
    this.options.source.load(
      url,
      (texture) => {
        if (this.disposed) {
          texture.dispose();
          return;
        }
        applyTextureSettings(texture, definition);
        const ready: TextureCacheEntry = { status: "ready", texture };
        this.entries.set(textureIndex, ready);
        this.options.onChange(textureIndex, ready);
      },
      () => {
        if (this.disposed) return;
        const failed: TextureCacheEntry = { status: "failed", texture: null };
        this.entries.set(textureIndex, failed);
        this.options.onChange(textureIndex, failed);
      },
    );
    return loading;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.texture?.dispose();
    this.entries.clear();
  }
}

/** Colour space, wrapping and filtering for a freshly decoded image. */
export function applyTextureSettings(
  texture: Texture,
  definition: CityTexture,
): void {
  // A JPG/PNG facade photo is sRGB-encoded; without this the albedo reads
  // linear and the whole facade washes out under the exposure-10 pipeline.
  texture.colorSpace = SRGBColorSpace;
  // `flipY` stays at three's default (true): CityJSON's (0,0) is the image's
  // bottom-left corner, the same convention three uploads with.
  const wrap =
    definition.wrapMode === "wrap"
      ? RepeatWrapping
      : definition.wrapMode === "mirror"
        ? MirroredRepeatWrapping
        : ClampToEdgeWrapping;
  texture.wrapS = wrap;
  texture.wrapT = wrap;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
}

/**
 * One unlit, double-sided, vertex-coloured material per group — the same
 * calibration as the untextured mesh (see `CityModelMesh`'s material comment),
 * plus a `map` where the group's image is ready. Group `g` uses material `g`.
 */
export function buildGroupMaterials(
  groups: ReadonlyArray<TextureGroup>,
  cache: TextureCache,
): MeshBasicMaterial[] {
  return groups.map((group) => {
    const material = new MeshBasicMaterial({
      vertexColors: true,
      side: DoubleSide,
    });
    if (group.textureIndex >= 0) {
      const entry = cache.request(group.textureIndex);
      if (entry.status === "ready") material.map = entry.texture;
    }
    return material;
  });
}

/**
 * Write white over every vertex of a group whose image is ready, so the map
 * shows unmodulated; every other vertex keeps `source`'s colour. Returns
 * `source` itself when nothing is masked, so callers can skip a copy.
 */
export function maskReadyTextures(
  source: Float32Array,
  groups: ReadonlyArray<TextureGroup> | null | undefined,
  isReady: (textureIndex: number) => boolean,
): Float32Array {
  if (!groups) return source;
  let out: Float32Array | null = null;
  for (const group of groups) {
    if (group.textureIndex < 0 || !isReady(group.textureIndex)) continue;
    out ??= Float32Array.from(source);
    out.fill(1, group.start * 3, (group.start + group.count) * 3);
  }
  return out ?? source;
}
