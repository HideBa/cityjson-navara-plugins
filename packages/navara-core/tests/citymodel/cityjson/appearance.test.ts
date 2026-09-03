/**
 * Appearance readers: the wire object, the merger's dedupe + remap, and the
 * per-surface material / texture resolution at every boundary depth.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AppearanceMerger,
  readLocalAppearance,
  resolveSurfaceMaterial,
  resolveSurfaceTexture,
} from "../../../src/citymodel/cityjson/appearance";
import { parseCityJSON } from "../../../src/citymodel/cityjson/parseCityJSON";
import { parseCityJSONSeq } from "../../../src/citymodel/cityjsonseq/parseCityJSONSeq";
import type { CityJSONRoot } from "../../../src/citymodel/cityjson/types";
import type { Vec3 } from "../../../src/citymodel/types";

const rotterdamPath = path.resolve(
  import.meta.dirname!,
  "../../../fixtures/rotterdam-two-textured.city.jsonl",
);
const rotterdamText = fs.readFileSync(rotterdamPath, "utf-8");

describe("readLocalAppearance", () => {
  it("reads materials, textures, uvs and defaults", () => {
    const local = readLocalAppearance({
      materials: [
        { name: "roof", diffuseColor: [0.9, 0.1, 0.1], transparency: 0.2 },
        { diffuseColor: [0, 0, 1] },
      ],
      textures: [
        { image: "a.jpg", type: "JPG", wrapMode: "wrap" },
        { image: "b.png", type: "PNG", wrapMode: "bogus", borderColor: [1, 0, 0, 1] },
      ],
      "vertices-texture": [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      "default-theme-texture": "rgb",
      "default-theme-material": "mat",
    });
    expect(local.materials).toEqual([
      { name: "roof", diffuseColor: [0.9, 0.1, 0.1], transparency: 0.2 },
      { name: "material-1", diffuseColor: [0, 0, 1] },
    ]);
    expect(local.textures).toEqual([
      { image: "a.jpg", type: "JPG", wrapMode: "wrap" },
      { image: "b.png", type: "PNG", borderColor: [1, 0, 0, 1] },
    ]);
    expect(local.uvs).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(local.defaultTextureTheme).toBe("rgb");
    expect(local.defaultMaterialTheme).toBe("mat");
  });

  it("reads garbage as empty", () => {
    expect(readLocalAppearance(undefined).textures).toEqual([]);
    expect(readLocalAppearance("nope").materials).toEqual([]);
    expect(readLocalAppearance({ textures: "x" }).textures).toEqual([]);
  });
});

describe("AppearanceMerger", () => {
  it("returns undefined when nothing was registered", () => {
    expect(new AppearanceMerger().build()).toBeUndefined();
    const merger = new AppearanceMerger();
    merger.register(undefined);
    expect(merger.build()).toBeUndefined();
  });

  it("deduplicates textures and materials across units and remaps indices", () => {
    const merger = new AppearanceMerger();
    const a = merger.register({
      textures: [
        { image: "x.jpg", type: "JPG" },
        { image: "y.jpg", type: "JPG" },
      ],
      materials: [{ name: "m" }],
    });
    const b = merger.register({
      textures: [
        { image: "y.jpg", type: "JPG" },
        { image: "z.jpg", type: "JPG" },
        { image: "x.jpg", type: "JPG", wrapMode: "clamp" },
      ],
      materials: [{ name: "m" }, { name: "n" }],
    });
    expect(a.textureRemap).toEqual([0, 1]);
    expect(b.textureRemap).toEqual([1, 2, 3]);
    expect(a.materialRemap).toEqual([0]);
    expect(b.materialRemap).toEqual([0, 1]);
    a.textureThemes.add("t");
    const built = merger.build()!;
    expect(built.textures.map((t) => t.image)).toEqual([
      "x.jpg",
      "y.jpg",
      "z.jpg",
      "x.jpg",
    ]);
    expect(built.materials.map((m) => m.name)).toEqual(["m", "n"]);
    expect(built.textureThemes).toEqual(["t"]);
  });

  it("marks an image-less texture entry unusable without shifting later ones", () => {
    const merger = new AppearanceMerger();
    const ctx = merger.register({
      textures: [{ type: "JPG" }, { image: "ok.jpg", type: "JPG" }],
    });
    expect(ctx.textureRemap).toEqual([-1, 0]);
  });

  it("offers a declared default theme only when a surface uses it", () => {
    const merger = new AppearanceMerger();
    const ctx = merger.register({
      "default-theme-texture": "used",
      "default-theme-material": "unused",
    });
    ctx.textureThemes.add("used");
    const built = merger.build()!;
    expect(built.defaultTextureTheme).toBe("used");
    expect(built.defaultMaterialTheme).toBeNull();
  });
});

describe("resolveSurfaceMaterial", () => {
  const merger = new AppearanceMerger();
  const ctx = merger.register({ materials: [{ name: "a" }, { name: "b" }] });

  it("walks values at MultiSurface depth and honours null", () => {
    const material = { theme: { values: [1, null, 0] } };
    expect(
      resolveSurfaceMaterial(material, { outer: [], surfaceIndex: 0 }, ctx),
    ).toEqual({ theme: 1 });
    expect(
      resolveSurfaceMaterial(material, { outer: [], surfaceIndex: 1 }, ctx),
    ).toBeUndefined();
    expect(ctx.materialThemes.has("theme")).toBe(true);
  });

  it("walks Solid and MultiSolid depth", () => {
    const solid = { t: { values: [[0, 1]] } };
    expect(
      resolveSurfaceMaterial(solid, { outer: [0], surfaceIndex: 1 }, ctx),
    ).toEqual({ t: 1 });
    const multi = { t: { values: [[[0]], [[null, 1]]] } };
    expect(
      resolveSurfaceMaterial(multi, { outer: [1, 0], surfaceIndex: 1 }, ctx),
    ).toEqual({ t: 1 });
    expect(
      resolveSurfaceMaterial(multi, { outer: [1, 0], surfaceIndex: 0 }, ctx),
    ).toBeUndefined();
  });

  it("applies a scalar `value` to every surface", () => {
    const material = { t: { value: 0 } };
    expect(
      resolveSurfaceMaterial(material, { outer: [3], surfaceIndex: 9 }, ctx),
    ).toEqual({ t: 0 });
  });

  it("ignores undeclared indices and malformed members", () => {
    expect(
      resolveSurfaceMaterial(
        { t: { values: [7] } },
        { outer: [], surfaceIndex: 0 },
        ctx,
      ),
    ).toBeUndefined();
    expect(
      resolveSurfaceMaterial("junk", { outer: [], surfaceIndex: 0 }, ctx),
    ).toBeUndefined();
    expect(
      resolveSurfaceMaterial({ t: 4 }, { outer: [], surfaceIndex: 0 }, ctx),
    ).toBeUndefined();
  });
});

describe("resolveSurfaceTexture", () => {
  const verts: Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ];
  const merger = new AppearanceMerger();
  const ctx = merger.register({
    textures: [
      { image: "a.jpg", type: "JPG" },
      { image: "b.jpg", type: "JPG" },
    ],
    "vertices-texture": [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  });
  const rawRings = [[0, 1, 2, 3]];
  const keptRings = [verts];

  it("resolves one UV per ring vertex with the exterior ring's texture", () => {
    const texture = { rgb: { values: [[[1, 0, 1, 2, 3]]] } };
    const out = resolveSurfaceTexture(
      texture,
      { outer: [], surfaceIndex: 0 },
      rawRings,
      keptRings,
      verts,
      ctx,
    );
    expect(out).toEqual({
      rgb: {
        textureIndex: 1,
        uvs: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        ],
      },
    });
    expect(ctx.textureThemes.has("rgb")).toBe(true);
  });

  it("treats [[null]] as untextured", () => {
    const texture = { rgb: { values: [[[null]]] } };
    expect(
      resolveSurfaceTexture(
        texture,
        { outer: [], surfaceIndex: 0 },
        rawRings,
        keptRings,
        verts,
        ctx,
      ),
    ).toBeUndefined();
  });

  it("rejects a ring whose UV count does not match its vertex count", () => {
    const texture = { rgb: { values: [[[0, 0, 1, 2]]] } };
    expect(
      resolveSurfaceTexture(
        texture,
        { outer: [], surfaceIndex: 0 },
        rawRings,
        keptRings,
        verts,
        ctx,
      ),
    ).toBeUndefined();
  });

  it("rejects an undeclared UV index and an undeclared texture index", () => {
    expect(
      resolveSurfaceTexture(
        { rgb: { values: [[[0, 0, 1, 2, 99]]] } },
        { outer: [], surfaceIndex: 0 },
        rawRings,
        keptRings,
        verts,
        ctx,
      ),
    ).toBeUndefined();
    expect(
      resolveSurfaceTexture(
        { rgb: { values: [[[5, 0, 1, 2, 3]]] } },
        { outer: [], surfaceIndex: 0 },
        rawRings,
        keptRings,
        verts,
        ctx,
      ),
    ).toBeUndefined();
  });

  it("skips the UV of a vertex the geometry walk dropped", () => {
    const sparse: (Vec3 | undefined)[] = [verts[0], verts[1], undefined, verts[3]];
    const kept = [[verts[0]!, verts[1]!, verts[3]!]];
    const out = resolveSurfaceTexture(
      { rgb: { values: [[[0, 0, 1, 2, 3]]] } },
      { outer: [], surfaceIndex: 0 },
      rawRings,
      kept,
      sparse,
      ctx,
    );
    expect(out!.rgb!.uvs[0]).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
  });

  it("requires every ring (holes too) to resolve", () => {
    const rings = [
      [0, 1, 2, 3],
      [0, 1, 2],
    ];
    const kept = [verts, [verts[0]!, verts[1]!, verts[2]!]];
    expect(
      resolveSurfaceTexture(
        { rgb: { values: [[[0, 0, 1, 2, 3], [null]]] } },
        { outer: [], surfaceIndex: 0 },
        rings,
        kept,
        verts,
        ctx,
      ),
    ).toBeUndefined();
    const ok = resolveSurfaceTexture(
      {
        rgb: {
          values: [
            [
              [0, 0, 1, 2, 3],
              [0, 0, 1, 2],
            ],
          ],
        },
      },
      { outer: [], surfaceIndex: 0 },
      rings,
      kept,
      verts,
      ctx,
    );
    expect(ok!.rgb!.uvs).toHaveLength(2);
  });

  it("walks Solid depth", () => {
    const texture = { rgb: { values: [[[[null]], [[0, 3, 2, 1, 0]]]] } };
    const out = resolveSurfaceTexture(
      texture,
      { outer: [0], surfaceIndex: 1 },
      rawRings,
      keptRings,
      verts,
      ctx,
    );
    expect(out!.rgb!.textureIndex).toBe(0);
    expect(out!.rgb!.uvs[0]![0]).toEqual([0, 1]);
  });
});

describe("parseCityJSONSeq with the Rotterdam fixture", () => {
  const model = parseCityJSONSeq(rotterdamText);

  it("merges the two features' local textures into one deduplicated table", () => {
    const appearance = model.appearance!;
    expect(appearance).toBeDefined();
    expect(appearance.textureThemes).toEqual(["rgbTexture"]);
    expect(appearance.materialThemes).toEqual([]);
    const images = appearance.textures.map((t) => t.image);
    expect(new Set(images).size).toBe(images.length);
    expect(images).toContain("appearances/0320_2_12.jpg");
    expect(appearance.defaultTextureTheme).toBeNull();
  });

  it("gives every textured surface one UV per ring vertex and a valid texture index", () => {
    const appearance = model.appearance!;
    let textured = 0;
    let untextured = 0;
    for (const obj of Object.values(model.objects)) {
      for (const surface of obj.surfaces) {
        const tex = surface.texture?.rgbTexture;
        if (!tex) {
          untextured++;
          continue;
        }
        textured++;
        expect(tex.textureIndex).toBeLessThan(appearance.textures.length);
        expect(tex.uvs).toHaveLength(surface.rings.length);
        tex.uvs.forEach((ring, i) =>
          expect(ring).toHaveLength(surface.rings[i]!.length),
        );
      }
    }
    // Each feature's GroundSurface is `[[null]]`.
    expect(untextured).toBe(2);
    expect(textured).toBeGreaterThan(20);
  });

  it("resolves the first surface's texture to the first feature's image 0", () => {
    const first = Object.values(model.objects)[0]!;
    const roof = first.surfaces[0]!;
    expect(roof.type).toBe("RoofSurface");
    const tex = roof.texture!.rgbTexture!;
    expect(model.appearance!.textures[tex.textureIndex]!.image).toBe(
      "appearances/0320_2_12.jpg",
    );
    expect(tex.uvs[0]![0]).toEqual([0.2517, 0.1739]);
  });
});

describe("parseCityJSON with a material theme and a Solid", () => {
  const root: CityJSONRoot = {
    type: "CityJSON",
    version: "2.0",
    transform: { scale: [1, 1, 1], translate: [0, 0, 0] },
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    appearance: {
      materials: [
        { name: "red", diffuseColor: [1, 0, 0] },
        { name: "blue", diffuseColor: [0, 0, 1] },
      ],
      "default-theme-material": "paint",
    },
    CityObjects: {
      box: {
        type: "Building",
        geometry: [
          {
            type: "Solid",
            lod: "2",
            boundaries: [
              [
                [[0, 3, 2, 1]],
                [[4, 5, 6, 7]],
                [[0, 1, 5, 4]],
              ],
            ],
            material: {
              paint: { values: [[0, 1, null]] },
              all: { value: 1 },
            },
          },
        ],
      },
    },
  };
  const model = parseCityJSON(root);

  it("records material themes and defaults", () => {
    expect(model.appearance!.materialThemes).toEqual(["all", "paint"]);
    expect(model.appearance!.defaultMaterialTheme).toBe("paint");
    expect(model.appearance!.textureThemes).toEqual([]);
    expect(model.appearance!.materials).toHaveLength(2);
  });

  it("assigns per-surface material indices at Solid depth", () => {
    const surfaces = model.objects.box!.surfaces;
    expect(surfaces[0]!.material).toEqual({ paint: 0, all: 1 });
    expect(surfaces[1]!.material).toEqual({ paint: 1, all: 1 });
    expect(surfaces[2]!.material).toEqual({ all: 1 });
  });

  it("leaves a model without appearance free of the key", () => {
    const bare = parseCityJSON({ ...root, appearance: undefined });
    expect("appearance" in bare).toBe(false);
    expect(bare.objects.box!.surfaces[0]!.material).toBeUndefined();
  });
});
