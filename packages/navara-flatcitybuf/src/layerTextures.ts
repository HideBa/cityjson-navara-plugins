/**
 * A streaming layer's images: one cache shared by every resident cell, keyed
 * by the LAYER-wide texture index the worker's appearance merger assigns,
 * plus the definitions behind those indices as cells report them.
 *
 * Per layer rather than per cell because the same facade image is referenced
 * by every feature that uses it, and two neighbouring cells routinely share
 * one; loading it once is the whole point. Relative image paths resolve
 * against the `.fcb`'s own URL (a `Blob` source has none, so its relative
 * images stay unresolved and those faces keep their colours).
 */
import type { CityTexture } from "@cityjson/navara-core";
import {
  TextureCache,
  defaultTextureSource,
  type TextureSource,
} from "@cityjson/navara-cityjson";

export interface LayerTextures {
  readonly cache: TextureCache;
  /** Layer-wide texture index -> definition, filled from cell messages. */
  readonly definitions: Map<number, CityTexture>;
}

export interface LayerTexturesOptions {
  readonly baseUrl: string | null;
  readonly source?: TextureSource;
  readonly warn?: (message: string) => void;
}

export function createLayerTextures(options: LayerTexturesOptions): LayerTextures {
  const definitions = new Map<number, CityTexture>();
  const cache = new TextureCache({
    textures: (index) => definitions.get(index),
    baseUrl: options.baseUrl,
    source: options.source ?? defaultTextureSource(),
    warn: options.warn,
  });
  return { cache, definitions };
}
