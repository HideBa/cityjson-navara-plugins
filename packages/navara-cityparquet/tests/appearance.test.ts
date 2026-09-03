/**
 * CityParquet appearance: the `texture_lod*` JSON column resolved through
 * the `textures.parquet` sidecar (dataset-global ids, inline UV pairs) on a
 * five-feature package written by the reference implementation from the
 * textured Rotterdam CityJSONSeq.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assembleCityParquetModel,
  parseCityParquetManifest,
  sidecarKindOf,
} from "../src/packageAssembly";
import { readPackageAppearance } from "../src/sidecars";

const PKG = resolve(import.meta.dirname!, "fixtures/rotterdam5_pkg");

async function pkgFile(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(PKG, name)));
}

describe("parseCityParquetManifest sidecars", () => {
  it("lists the textures sidecar the package declares", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(PKG, "metadata.json"), "utf-8"),
    ) as unknown;
    const parsed = parseCityParquetManifest(manifest);
    expect(parsed.objectTables).toEqual(["building.parquet"]);
    expect(parsed.sidecars.textures).toBe("textures.parquet");
    expect(parsed.sidecars.materials).toBeUndefined();
  });

  it("classifies sidecar names", () => {
    expect(sidecarKindOf("a/b/textures.parquet")).toBe("textures");
    expect(sidecarKindOf("materials.parquet")).toBe("materials");
    expect(sidecarKindOf("building.parquet")).toBeNull();
  });
});

describe("readPackageAppearance", () => {
  it("reads the textures sidecar by id", async () => {
    const appearance = await readPackageAppearance({
      textures: await pkgFile("textures.parquet"),
    });
    expect(appearance).not.toBeNull();
    expect(appearance!.textureLocalById.size).toBe(21);
    const built = appearance!.merger.build()!;
    expect(built.textures).toHaveLength(21);
    expect(built.textures[0]!.image).toMatch(/^appearances\/.*\.jpg$/);
    expect(built.textures[0]!.type).toBe("JPG");
  });

  it("returns null without sidecars", async () => {
    expect(await readPackageAppearance(undefined)).toBeNull();
    expect(await readPackageAppearance({})).toBeNull();
  });
});

describe("assembleCityParquetModel with sidecars", () => {
  it("attaches per-face textures with inline UVs, one per ring vertex", async () => {
    const model = await assembleCityParquetModel(
      [{ name: "building.parquet", bytes: await pkgFile("building.parquet") }],
      { sidecars: { textures: await pkgFile("textures.parquet") } },
    );
    const appearance = model.appearance!;
    expect(appearance.textureThemes).toEqual(["rgbTexture"]);
    expect(appearance.textures).toHaveLength(21);
    let textured = 0;
    let untextured = 0;
    for (const object of Object.values(model.objects)) {
      for (const surface of object.surfaces) {
        if (surface.lod !== "2") continue;
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
    // One GroundSurface per building is `[[null]]`.
    expect(untextured).toBe(5);
    expect(textured).toBeGreaterThan(20);
  });

  it("decodes plain (no appearance) without sidecars, as before", async () => {
    const model = await assembleCityParquetModel([
      { name: "building.parquet", bytes: await pkgFile("building.parquet") },
    ]);
    expect(model.appearance).toBeUndefined();
    const any = Object.values(model.objects)[0]!.surfaces[0]!;
    expect(any.texture).toBeUndefined();
  });
});
