import { describe, expect, it } from "vitest";
import {
  LinearSRGBColorSpace,
  MeshDepthMaterial,
  ShaderChunk,
  ShaderLib,
  SRGBColorSpace,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from "three";
import {
  CityStyleDepthMaterial,
  CityStyleMaterial,
  CityStyleTexture,
  createStyleUniforms,
  SlotStyle,
} from "../src/cityStyle";
import { DEFAULT_HIGHLIGHT_RGB } from "../src/surfaceColorLayers";
import { SLOT_HIDDEN, SLOT_SELECTED, SLOT_TEXTURED } from "../src/slotFlags";

function lambertShader(): WebGLProgramParametersWithUniforms {
  return {
    vertexShader: ShaderLib.lambert.vertexShader,
    fragmentShader: ShaderLib.lambert.fragmentShader,
    uniforms: {},
  } as unknown as WebGLProgramParametersWithUniforms;
}

const renderer = {} as WebGLRenderer;

function material(): CityStyleMaterial {
  return new CityStyleMaterial(
    createStyleUniforms(new CityStyleTexture(4), DEFAULT_HIGHLIGHT_RGB),
  );
}

describe("CityStyleTexture", () => {
  it("is as wide as its slots up to 1024, and grows in rows beyond", () => {
    expect(new CityStyleTexture(3).texture.image.width).toBe(3);
    const big = new CityStyleTexture(2500);
    expect(big.texture.image.width).toBe(1024);
    expect(big.texture.image.height).toBe(3);
    expect(new CityStyleTexture(0).texture.image.width).toBe(1);
  });

  it("stores colour as sRGB, so the GPU decodes it, and flags raw", () => {
    const t = new CityStyleTexture(2);
    expect(t.texture.colorSpace).toBe(SRGBColorSpace);
    expect(t.texture.colorSpace).not.toBe(LinearSRGBColorSpace);
    t.setColor(1, 1, 0, 0.25);
    t.setFlags(1, SLOT_SELECTED | SLOT_TEXTURED);
    expect(t.texel(1)).toEqual([255, 0, 137, SLOT_SELECTED | SLOT_TEXTURED]);
    t.clearFlags(SLOT_SELECTED);
    expect(t.texel(1)[3]).toBe(SLOT_TEXTURED);
  });
});

describe("CityStyleMaterial", () => {
  it("reads its colour from the style texture and replaces the colour attribute", () => {
    const m = material();
    const shader = lambertShader();
    m.onBeforeCompile(shader, renderer);
    expect(shader.vertexShader).toContain("citySlot");
    expect(shader.vertexShader).toContain("texelFetch");
    expect(shader.vertexShader).not.toContain("#include <color_vertex>");
    expect(shader.vertexShader).toContain(`& ${SLOT_HIDDEN}`);
    // The SAME uniform objects, so a later texture swap reaches the program.
    expect(shader.uniforms.cityStyleTex).toBe(m.styleUniforms.cityStyleTex);
  });

  it("writes vColor at the width three declares it", () => {
    // three r183 declares `varying vec4 vColor` whatever the defines; a vec3
    // assignment does not compile, and the mesh draws nothing.
    const width = /varying (vec[34]) vColor/.exec(
      ShaderChunk.color_pars_vertex,
    )![1]!;
    const shader = lambertShader();
    material().onBeforeCompile(shader, renderer);
    const writes = [...shader.vertexShader.matchAll(/vColor = (\w+)\(/g)];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w[1]).toBe(width);
  });

  it("declares citySlot as uint, the input three binds a Uint32Array to", () => {
    // three binds UNSIGNED_INT data with vertexAttribIPointer; a float input
    // fed that way makes every draw INVALID_OPERATION and nothing renders.
    const shader = lambertShader();
    material().onBeforeCompile(shader, renderer);
    expect(shader.vertexShader).toMatch(/attribute uint citySlot;/);
  });

  it("keeps the patch when an instance handler is deleted (the shadow registry's rollback)", () => {
    const m = material();
    m.onBeforeCompile = () => {};
    delete (m as { onBeforeCompile?: unknown }).onBeforeCompile;
    const shader = lambertShader();
    m.onBeforeCompile(shader, renderer);
    expect(shader.vertexShader).toContain("citySlot");
  });

  it("has its own program key, and a clone shares the uniforms", () => {
    const m = material();
    expect(m.customProgramCacheKey()).toMatch(/^city-style-/);
    const clone = m.clone();
    expect(clone.styleUniforms).toBe(m.styleUniforms);
  });
});

describe("CityStyleDepthMaterial", () => {
  it("is a plain depth material that hides a hidden slot from the shadow pass", () => {
    const uniforms = createStyleUniforms(
      new CityStyleTexture(4),
      DEFAULT_HIGHLIGHT_RGB,
    );
    const d = new CityStyleDepthMaterial(uniforms);
    expect(d).toBeInstanceOf(MeshDepthMaterial);
    const shader = {
      vertexShader: ShaderLib.depth.vertexShader,
      fragmentShader: ShaderLib.depth.fragmentShader,
      uniforms: {},
    } as unknown as WebGLProgramParametersWithUniforms;
    d.onBeforeCompile(shader, renderer);
    expect(shader.vertexShader).toContain("attribute uint citySlot;");
    expect(shader.vertexShader).toContain(`& ${SLOT_HIDDEN}`);
    expect(shader.uniforms.cityStyleTex).toBe(uniforms.cityStyleTex);
    expect(d.customProgramCacheKey()).not.toBe(
      new CityStyleMaterial(uniforms).customProgramCacheKey(),
    );
  });
});

describe("SlotStyle", () => {
  const tables = {
    slotObjects: Uint32Array.from([0, 1]),
    slotSurfaces: Uint32Array.from([0, 0]),
    slotTextures: Int32Array.from([-1, 3]),
    objectKeys: ["a", "b"],
  };

  it("re-points every material at the new texture on a rebuild", () => {
    const style = new SlotStyle(tables, DEFAULT_HIGHLIGHT_RGB);
    const before = style.uniforms.cityStyleTex.value;
    style.replace({ ...tables, slotObjects: Uint32Array.from([0, 1, 1]) });
    expect(style.uniforms.cityStyleTex.value).not.toBe(before);
    expect(style.styleTexture.slotCount).toBe(3);
  });

  it("draws selection over hover over the image over the colour", () => {
    const style = new SlotStyle(tables, DEFAULT_HIGHLIGHT_RGB);
    style.setColors([0, 0, 0, 0, 0, 0]);
    style.setTextured((i) => i === 3);
    expect(style.drawnColor(0)).toEqual([0, 0, 0]);
    expect(style.drawnColor(1)).toEqual([1, 1, 1]);
    const b = { kind: "object" as const, layerId: "L", objectId: "b" };
    style.setHighlight([], b);
    const hover = DEFAULT_HIGHLIGHT_RGB.hover;
    expect(style.drawnColor(1)[0]).toBeCloseTo(hover[0], 6);
    style.setHighlight([b], b);
    const highlight = DEFAULT_HIGHLIGHT_RGB.highlight;
    expect(style.drawnColor(1)[0]).toBeCloseTo(highlight[0], 6);
  });
});
