import { describe, it, expect, vi } from "vitest";
import {
  ClampToEdgeWrapping,
  MeshLambertMaterial,
  MirroredRepeatWrapping,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
} from "three";
import type { CityTexture, TextureGroup } from "@cityjson/navara-core";
import {
  applyTextureSettings,
  buildGroupMaterials,
  maskReadyTextures,
  resolveTextureUrl,
  TextureCache,
  type TextureSource,
} from "../src/texturedMaterials";

/** A source that hands the callbacks back so a test decides the outcome. */
function fakeSource() {
  const pending: Array<{
    url: string;
    onLoad: (t: Texture) => void;
    onError: (e: unknown) => void;
  }> = [];
  const source: TextureSource = {
    load: (url, onLoad, onError) => {
      pending.push({ url, onLoad, onError });
    },
  };
  return { source, pending };
}

const textures: CityTexture[] = [
  { image: "appearances/a.jpg", type: "JPG" },
  { image: "https://img.example/b.png", type: "PNG", wrapMode: "wrap" },
];

describe("resolveTextureUrl", () => {
  it("resolves a relative image against the DATASET url, not the app", () => {
    expect(
      resolveTextureUrl(
        "appearances/0320_2_18.jpg",
        "https://cityjson.open3d.city/cityjsonseq/rotterdam/rotterdam.jsonl",
      ),
    ).toBe(
      "https://cityjson.open3d.city/cityjsonseq/rotterdam/appearances/0320_2_18.jpg",
    );
  });

  it("keeps an absolute image url whatever the base", () => {
    expect(resolveTextureUrl("https://img.example/b.png", null)).toBe(
      "https://img.example/b.png",
    );
    expect(
      resolveTextureUrl("https://img.example/b.png", "https://host/x.json"),
    ).toBe("https://img.example/b.png");
  });

  it("returns null for a relative image with no base (local file)", () => {
    expect(resolveTextureUrl("appearances/a.jpg", null)).toBeNull();
    expect(resolveTextureUrl("appearances/a.jpg", undefined)).toBeNull();
  });
});

describe("TextureCache", () => {
  it("requests each image once and reports readiness", () => {
    const { source, pending } = fakeSource();
    const onChange = vi.fn();
    const cache = new TextureCache({
      textures,
      baseUrl: "https://host/data/city.jsonl",
      source,
      onChange,
    });
    expect(cache.request(0).status).toBe("loading");
    expect(cache.request(0).status).toBe("loading");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.url).toBe("https://host/data/appearances/a.jpg");
    const texture = new Texture();
    pending[0]!.onLoad(texture);
    expect(cache.get(0)).toEqual({ status: "ready", texture });
    expect(onChange).toHaveBeenCalledWith(0, { status: "ready", texture });
    expect(texture.colorSpace).toBe(SRGBColorSpace);
    cache.dispose();
  });

  it("marks a failed load and an unresolvable path as failed, warning once", () => {
    const { source, pending } = fakeSource();
    const onChange = vi.fn();
    const warn = vi.fn();
    const cache = new TextureCache({
      textures,
      baseUrl: null,
      source,
      onChange,
      warn,
    });
    expect(cache.request(0).status).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("not loaded from a URL");
    expect(cache.request(1).status).toBe("loading");
    pending[0]!.onError(new Error("404"));
    expect(cache.get(1)).toEqual({ status: "failed", texture: null });
    expect(onChange).toHaveBeenCalledWith(1, { status: "failed", texture: null });
    expect(cache.request(99).status).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("disposes a texture that lands after dispose and stops reporting", () => {
    const { source, pending } = fakeSource();
    const onChange = vi.fn();
    const cache = new TextureCache({
      textures,
      baseUrl: "https://host/x.json",
      source,
      onChange,
    });
    cache.request(1);
    cache.dispose();
    const texture = new Texture();
    const dispose = vi.spyOn(texture, "dispose");
    pending[0]!.onLoad(texture);
    expect(dispose).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("TextureCache with a synchronous source", () => {
  it("returns the ready entry when onLoad fires inside load()", () => {
    const source: TextureSource = {
      load: (_url, onLoad) => onLoad(new Texture()),
    };
    const cache = new TextureCache({
      textures,
      baseUrl: "https://host/x.json",
      source,
      onChange: () => {},
    });
    expect(cache.request(1).status).toBe("ready");
    expect(cache.isReady(1)).toBe(true);
  });
});

describe("applyTextureSettings", () => {
  it("maps wrap modes and marks the texture sRGB", () => {
    const t = new Texture();
    applyTextureSettings(t, { image: "x", type: "JPG", wrapMode: "wrap" });
    expect(t.wrapS).toBe(RepeatWrapping);
    applyTextureSettings(t, { image: "x", type: "JPG", wrapMode: "mirror" });
    expect(t.wrapT).toBe(MirroredRepeatWrapping);
    applyTextureSettings(t, { image: "x", type: "JPG", wrapMode: "border" });
    expect(t.wrapS).toBe(ClampToEdgeWrapping);
    applyTextureSettings(t, { image: "x", type: "JPG" });
    expect(t.wrapS).toBe(ClampToEdgeWrapping);
    expect(t.colorSpace).toBe(SRGBColorSpace);
    expect(t.flipY).toBe(true);
  });
});

describe("buildGroupMaterials", () => {
  it("makes one vertex-coloured double-sided material per group and requests images", () => {
    const { source, pending } = fakeSource();
    const cache = new TextureCache({
      textures,
      baseUrl: "https://host/x.json",
      source,
      onChange: () => {},
    });
    const groups: TextureGroup[] = [
      { start: 0, count: 6, textureIndex: -1 },
      { start: 6, count: 3, textureIndex: 1 },
    ];
    const materials = buildGroupMaterials(groups, cache);
    expect(materials).toHaveLength(2);
    // Lit, like the untextured material: the sun and its shadows shade it.
    expect(materials[0]).toBeInstanceOf(MeshLambertMaterial);
    expect(materials[0]!.vertexColors).toBe(true);
    expect(materials[0]!.map).toBeNull();
    expect(materials[1]!.map).toBeNull(); // not ready yet
    expect(pending.map((p) => p.url)).toEqual(["https://img.example/b.png"]);
    const texture = new Texture();
    pending[0]!.onLoad(texture);
    // A rebuild after readiness attaches the map immediately.
    expect(buildGroupMaterials(groups, cache)[1]!.map).toBe(texture);
  });
});

describe("maskReadyTextures", () => {
  const groups: TextureGroup[] = [
    { start: 0, count: 3, textureIndex: -1 },
    { start: 3, count: 3, textureIndex: 0 },
    { start: 6, count: 3, textureIndex: 1 },
  ];
  const source = new Float32Array(27).fill(0.25);

  it("returns the source itself when no image is ready", () => {
    expect(maskReadyTextures(source, groups, () => false)).toBe(source);
    expect(maskReadyTextures(source, null, () => true)).toBe(source);
  });

  it("whites out exactly the vertices of ready groups", () => {
    const out = maskReadyTextures(source, groups, (i) => i === 1);
    expect(out).not.toBe(source);
    expect(Array.from(out.slice(0, 18))).toEqual(new Array(18).fill(0.25));
    expect(Array.from(out.slice(18))).toEqual(new Array(9).fill(1));
    expect(source[20]).toBe(0.25); // untouched
  });
});
