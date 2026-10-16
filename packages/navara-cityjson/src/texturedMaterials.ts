/**
 * Everything a textured city mesh needs beyond its arrays: resolving a
 * texture's image path against the DATASET's URL, loading images through an
 * injectable seam, and one material per texture group.
 *
 * Engine-free (imports `three` only) and Node-importable: the default
 * `TextureSource` wraps three's `TextureLoader`, which touches the DOM only
 * when `load` is called, and every test injects a fake instead.
 *
 * Why images are a FLAG rather than a colour: both mesh classes multiply the
 * material's `map` by the surface's style colour, and that colour is also how
 * rules, hover and selection are drawn. A slot whose image is ready carries
 * `SLOT_TEXTURED`, which the shader draws white, so the image shows as-is;
 * a slot whose image is still loading, failed, or could not be resolved (a
 * relative path in a local file) keeps its colour and degrades to the plain
 * look for exactly those faces. Selection and hover take precedence over the
 * flag, so a selected textured face tints — it is still visibly selected.
 */
import {
  ClampToEdgeWrapping,
  MirroredRepeatWrapping,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  type Texture,
} from "three";
import type { CityTexture, TextureGroup } from "@cityjson/navara-core";
import { createCityMaterial } from "./cityMaterial";
import type { CityStyleMaterial, CityStyleUniforms } from "./cityStyle";

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

export type TextureChangeListener = (
  textureIndex: number,
  entry: TextureCacheEntry,
) => void;

export interface TextureCacheOptions {
  /** The definitions, by model texture index — an array for a static model,
   *  or a lookup for a streaming layer whose table grows cell by cell. */
  readonly textures:
    | ReadonlyArray<CityTexture>
    | ((textureIndex: number) => CityTexture | undefined);
  readonly baseUrl: string | null | undefined;
  readonly source: TextureSource;
  /** An image became ready (or failed): the owner re-applies materials and
   *  repaints. Called only for indices previously requested. Streaming
   *  layers use {@link TextureCache.subscribe} instead. */
  readonly onChange?: TextureChangeListener;
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
  private readonly listeners = new Set<TextureChangeListener>();
  private disposed = false;
  private unresolvable = 0;

  constructor(private readonly options: TextureCacheOptions) {
    if (options.onChange) this.listeners.add(options.onChange);
  }

  get(textureIndex: number): TextureCacheEntry | undefined {
    return this.entries.get(textureIndex);
  }

  /** True when the image for `textureIndex` is on the GPU-ready side. */
  isReady(textureIndex: number): boolean {
    return this.entries.get(textureIndex)?.status === "ready";
  }

  /** Listen for readiness/failure; returns the unsubscribe. */
  subscribe(listener: TextureChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private definition(textureIndex: number): CityTexture | undefined {
    const textures = this.options.textures;
    return typeof textures === "function"
      ? textures(textureIndex)
      : textures[textureIndex];
  }

  private notify(textureIndex: number, entry: TextureCacheEntry): void {
    for (const listener of [...this.listeners]) listener(textureIndex, entry);
  }

  /** Start loading `textureIndex` unless it is already known. */
  request(textureIndex: number): TextureCacheEntry {
    const known = this.entries.get(textureIndex);
    if (known) return known;
    const definition = this.definition(textureIndex);
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
        this.notify(textureIndex, ready);
      },
      () => {
        if (this.disposed) return;
        const failed: TextureCacheEntry = { status: "failed", texture: null };
        this.entries.set(textureIndex, failed);
        this.notify(textureIndex, failed);
      },
    );
    // A source that answers synchronously has already replaced `loading`.
    return this.entries.get(textureIndex) ?? loading;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.texture?.dispose();
    this.entries.clear();
    this.listeners.clear();
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
 * One city material per group — the same lit, double-sided material as the
 * untextured mesh (`createCityMaterial`), reading the mesh's style texture
 * through `uniforms`, plus a `map` where the group's image is ready. Group
 * `g` uses material `g`. The CALLER registers these with its shadow hooks;
 * this builder has no engine seam.
 */
export function buildGroupMaterials(
  groups: ReadonlyArray<TextureGroup>,
  cache: TextureCache,
  uniforms: CityStyleUniforms,
): CityStyleMaterial[] {
  return groups.map((group) => {
    const material = createCityMaterial(uniforms);
    if (group.textureIndex >= 0) {
      const entry = cache.request(group.textureIndex);
      if (entry.status === "ready") material.map = entry.texture;
    }
    return material;
  });
}
