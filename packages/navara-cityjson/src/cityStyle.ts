/**
 * The style lookup texture and the city material that reads it.
 *
 * Every drawn surface is a SLOT: a vertex attribute (`citySlot`) names it, and
 * one RGBA8 texel per slot says how it looks. RGB is its colour, stored sRGB
 * (the texture is `SRGBColorSpace`, so the GPU decodes it to linear on fetch);
 * A is a bit set of flags, read linear. Restyling a layer writes texels,
 * highlighting writes flags, and neither touches a vertex buffer: on Delft a
 * full restyle uploads one texel per surface instead of 12 bytes per vertex.
 *
 * The material is a `MeshLambertMaterial` subclass whose `onBeforeCompile`
 * and `customProgramCacheKey` live on the PROTOTYPE. That is load-bearing:
 * the engine's cascaded-shadow registry binds both at registration and, on
 * rollback, `delete`s the instance's `onBeforeCompile` without restoring an
 * original. A prototype method survives that delete, so unregistering a live
 * material can never strip the style patch and leave plain Lambert. The
 * engine's G-buffer patch lives in `ShaderLib.lambert` itself, and the shadow
 * pass draws through `CityStyleDepthMaterial`, a plain depth material with
 * the same hide step, so a hidden slot is gone from the colour, G-buffer and
 * shadow passes alike.
 *
 * Engine-free: `three` only.
 */
import {
  Color,
  DataTexture,
  DoubleSide,
  MeshDepthMaterial,
  MeshLambertMaterial,
  NearestFilter,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from "three";

import type { HighlightRGB } from "./cityColors";
import type { Selection } from "./selection";
import {
  SLOT_HIDDEN,
  SLOT_HOVERED,
  SLOT_SELECTED,
  SLOT_TEXTURED,
} from "./slotFlags";
import { paintSlotFlags } from "./surfaceColorLayers";

/** Texels per row at most; the height grows with the slot count. A cell
 *  with fewer slots gets a texture exactly as wide as it needs. */
export const STYLE_TEXTURE_WIDTH = 1024;

/** Bumped whenever the shader patch changes, so no cached program is reused. */
const PATCH_VERSION = "city-style-5";

function linearToSrgbByte(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * One texel per slot. Writes go to the CPU copy; {@link commit} uploads it,
 * once per burst of writes.
 */
export class CityStyleTexture {
  readonly texture: DataTexture;
  readonly slotCount: number;
  private readonly data: Uint8Array;

  constructor(slotCount: number) {
    this.slotCount = slotCount;
    const width = Math.max(1, Math.min(STYLE_TEXTURE_WIDTH, slotCount));
    const height = Math.max(1, Math.ceil(slotCount / width));
    this.data = new Uint8Array(width * height * 4);
    this.texture = new DataTexture(
      this.data,
      width,
      height,
      RGBAFormat,
      UnsignedByteType,
    );
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.magFilter = NearestFilter;
    this.texture.minFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    this.texture.needsUpdate = true;
  }

  /** Set a slot's colour from LINEAR rgb (what the palettes hold). */
  setColor(slot: number, r: number, g: number, b: number): void {
    const i = slot * 4;
    this.data[i] = linearToSrgbByte(r);
    this.data[i + 1] = linearToSrgbByte(g);
    this.data[i + 2] = linearToSrgbByte(b);
  }

  /** Every slot's colour from a linear rgb array, 3 per slot. */
  setColors(linear: ArrayLike<number>): void {
    for (let s = 0; s < this.slotCount; s++) {
      this.setColor(s, linear[s * 3]!, linear[s * 3 + 1]!, linear[s * 3 + 2]!);
    }
  }

  flags(slot: number): number {
    return this.data[slot * 4 + 3]!;
  }

  setFlags(slot: number, flags: number): void {
    this.data[slot * 4 + 3] = flags;
  }

  /** Clear `bits` on every slot. */
  clearFlags(bits: number): void {
    const keep = ~bits & 0xff;
    for (let s = 0; s < this.slotCount; s++) this.data[s * 4 + 3]! &= keep;
  }

  /** The texel bytes, for tests. */
  texel(slot: number): [number, number, number, number] {
    const i = slot * 4;
    return [
      this.data[i]!,
      this.data[i + 1]!,
      this.data[i + 2]!,
      this.data[i + 3]!,
    ];
  }

  commit(): void {
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/** The uniforms one mesh's materials share: its style texture and the
 *  highlight colours (linear). */
export interface CityStyleUniforms {
  readonly cityStyleTex: { value: DataTexture };
  readonly cityHighlightColor: { value: Color };
  readonly cityHoverColor: { value: Color };
}

export function createStyleUniforms(
  texture: CityStyleTexture,
  colors: HighlightRGB,
): CityStyleUniforms {
  return {
    cityStyleTex: { value: texture.texture },
    cityHighlightColor: { value: new Color().setRGB(...colors.highlight) },
    cityHoverColor: { value: new Color().setRGB(...colors.hover) },
  };
}

/** What a mesh's style needs from its build: who each slot is, and its
 *  image. Satisfied by `CityMeshArrays`. */
export interface SlotTables {
  readonly slotObjects: Uint32Array;
  readonly slotSurfaces: Uint32Array;
  readonly slotTextures: Int32Array;
  readonly objectKeys: readonly string[];
}

/**
 * One mesh's style: its texture, the uniforms its materials share, and the
 * writes both mesh classes make — colours, highlight and the texture mask.
 * Each write uploads the texture once; none touches a vertex.
 */
export class SlotStyle {
  readonly uniforms: CityStyleUniforms;
  private texture: CityStyleTexture;
  private tables: SlotTables;

  constructor(tables: SlotTables, colors: HighlightRGB) {
    this.tables = tables;
    this.texture = new CityStyleTexture(tables.slotObjects.length);
    this.uniforms = createStyleUniforms(this.texture, colors);
  }

  /** The texture, for tests and for a caller reading a texel back. */
  get styleTexture(): CityStyleTexture {
    return this.texture;
  }

  /**
   * A new build: a texture sized for its slots, picked up by every material
   * (and the shadow-depth clone) through the shared uniform. Colours and
   * flags start clear, so the caller writes all three layers again.
   */
  replace(tables: SlotTables): void {
    const old = this.texture;
    this.tables = tables;
    this.texture = new CityStyleTexture(tables.slotObjects.length);
    this.uniforms.cityStyleTex.value = this.texture.texture;
    old.dispose();
  }

  /** Every slot's colour, linear rgb, 3 per slot. */
  setColors(linear: ArrayLike<number>): void {
    this.texture.setColors(linear);
    this.texture.commit();
  }

  /** Selection and hover, already narrowed to this mesh's layer. */
  setHighlight(
    selections: readonly Selection[],
    hovered: Selection | null,
  ): void {
    const t = this.tables;
    paintSlotFlags(
      this.texture,
      t.slotObjects,
      t.slotSurfaces,
      t.objectKeys,
      selections,
      hovered,
    );
    this.texture.commit();
  }

  /** Hide every slot of the objects `objectHidden` marks (one byte per
   *  object index, 1 = hidden), and show every other slot. */
  setHidden(objectHidden: Uint8Array): void {
    const objects = this.tables.slotObjects;
    for (let slot = 0; slot < objects.length; slot++) {
      const flags = this.texture.flags(slot) & ~SLOT_HIDDEN;
      this.texture.setFlags(
        slot,
        objectHidden[objects[slot]!] === 1 ? flags | SLOT_HIDDEN : flags,
      );
    }
    this.texture.commit();
  }

  isHidden(slot: number): boolean {
    return (this.texture.flags(slot) & SLOT_HIDDEN) !== 0;
  }

  /** Flag every slot whose image is ready, so it draws unmodulated. */
  setTextured(isReady: (textureIndex: number) => boolean): void {
    const textures = this.tables.slotTextures;
    for (let slot = 0; slot < textures.length; slot++) {
      const index = textures[slot]!;
      const flags = this.texture.flags(slot) & ~SLOT_TEXTURED;
      this.texture.setFlags(
        slot,
        index >= 0 && isReady(index) ? flags | SLOT_TEXTURED : flags,
      );
    }
    this.texture.commit();
  }

  /**
   * The colour the shader draws `slot` in, linear rgb — the CPU twin of
   * `VERTEX_COLOR`, for tests and readbacks. The texel's sRGB bytes are
   * decoded as the GPU decodes them, so it carries the same 8-bit rounding.
   */
  drawnColor(slot: number): [number, number, number] {
    const [r, g, b, flags] = this.texture.texel(slot);
    const pick = (c: { value: Color }): [number, number, number] => [
      c.value.r,
      c.value.g,
      c.value.b,
    ];
    if ((flags & SLOT_SELECTED) !== 0) {
      return pick(this.uniforms.cityHighlightColor);
    }
    if ((flags & SLOT_HOVERED) !== 0) return pick(this.uniforms.cityHoverColor);
    if ((flags & SLOT_TEXTURED) !== 0) return [1, 1, 1];
    return [srgbByteToLinear(r), srgbByteToLinear(g), srgbByteToLinear(b)];
  }

  dispose(): void {
    this.texture.dispose();
  }
}

function srgbByteToLinear(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** After `#include <common>`: the slot, its texture and how to read a texel.
 *  Shared by the lit and the depth material. */
const VERTEX_SLOT_PARS = /* glsl */ `
// An integer input: three binds a Uint32Array with vertexAttribIPointer.
attribute uint citySlot;
uniform highp sampler2D cityStyleTex;
vec4 cityStyleTexel() {
  int i = int(citySlot);
  int w = textureSize(cityStyleTex, 0).x;
  return texelFetch(cityStyleTex, ivec2(i % w, i / w), 0);
}
int cityStyleFlags(vec4 texel) {
  return int(texel.a * 255.0 + 0.5);
}
`;

const VERTEX_COLOR_PARS = /* glsl */ `
uniform vec3 cityHighlightColor;
uniform vec3 cityHoverColor;
`;

/** Replaces `#include <color_vertex>`: the colour comes from the texel. */
const VERTEX_COLOR = /* glsl */ `
vec4 cityTexel = cityStyleTexel();
int cityFlags = cityStyleFlags(cityTexel);
vec3 cityRgb = cityTexel.rgb;
if ((cityFlags & ${SLOT_TEXTURED}) != 0) cityRgb = vec3(1.0);
// Selection wins over hover where both apply, as it always has.
if ((cityFlags & ${SLOT_HOVERED}) != 0) cityRgb = cityHoverColor;
if ((cityFlags & ${SLOT_SELECTED}) != 0) cityRgb = cityHighlightColor;
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  // three declares "varying vec4 vColor" whatever the defines.
  vColor = vec4(cityRgb, 1.0);
#endif
`;

/** After `#include <project_vertex>`: a hidden slot's vertices all land on
 *  one point beyond the far plane, so its triangles rasterise nothing in any
 *  pass. */
const VERTEX_HIDE = /* glsl */ `
if ((cityStyleFlags(cityStyleTexel()) & ${SLOT_HIDDEN}) != 0) {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}
`;

export class CityStyleMaterial extends MeshLambertMaterial {
  readonly styleUniforms: CityStyleUniforms;

  constructor(uniforms: CityStyleUniforms) {
    // Lit, double-sided and vertex-coloured: see `createCityMaterial` for
    // why each. "Vertex-coloured" now means `vColor`, which the patch writes
    // from the style texture; the mesh carries no colour attribute.
    super({ vertexColors: true, side: DoubleSide });
    this.styleUniforms = uniforms;
  }

  override copy(source: CityStyleMaterial): this {
    super.copy(source);
    // A clone must read the SAME texture; share the uniform objects.
    (this as { styleUniforms: CityStyleUniforms }).styleUniforms =
      source.styleUniforms;
    return this;
  }
}

function patch(
  this: CityStyleMaterial,
  shader: WebGLProgramParametersWithUniforms,
  _renderer: WebGLRenderer,
): void {
  // The SAME objects every compile, never a copy: a recompile (a define
  // change) must keep reading what the mesh writes.
  Object.assign(shader.uniforms, this.styleUniforms);
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>\n${VERTEX_SLOT_PARS}\n${VERTEX_COLOR_PARS}`,
    )
    .replace("#include <color_vertex>", VERTEX_COLOR)
    .replace(
      "#include <project_vertex>",
      `#include <project_vertex>\n${VERTEX_HIDE}`,
    );
}

CityStyleMaterial.prototype.onBeforeCompile = patch;
CityStyleMaterial.prototype.customProgramCacheKey = function (): string {
  return PATCH_VERSION;
};

/**
 * What a city mesh draws into the shadow map: three's own depth material
 * plus the hide step, reading the mesh's style texture, so a hidden slot
 * casts no shadow. Deliberately NOT a clone of the lit material: that one
 * samples the shadow maps, and drawing it into one is a feedback loop WebGL
 * refuses, so nothing would cast at all.
 */
export class CityStyleDepthMaterial extends MeshDepthMaterial {
  readonly styleUniforms: CityStyleUniforms;

  constructor(uniforms: CityStyleUniforms) {
    super();
    this.styleUniforms = uniforms;
  }
}

CityStyleDepthMaterial.prototype.onBeforeCompile = function (
  this: CityStyleDepthMaterial,
  shader: WebGLProgramParametersWithUniforms,
): void {
  Object.assign(shader.uniforms, this.styleUniforms);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${VERTEX_SLOT_PARS}`)
    .replace(
      "#include <project_vertex>",
      `#include <project_vertex>\n${VERTEX_HIDE}`,
    );
};
CityStyleDepthMaterial.prototype.customProgramCacheKey = function (): string {
  return `${PATCH_VERSION}-depth`;
};
