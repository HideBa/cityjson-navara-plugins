/**
 * Implicit geometries on real data: the vegetation table and the
 * `implicit_geometries.parquet` sidecar of a package cityparquet-rs wrote
 * (`rs-minimal-implicit-cityparquet/`, see the fixture README), checked against
 * the reference reader's own export of the same package, reduced to its
 * implicit geometries (`rs-minimal-implicit.oracle.json`).
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Vec3 } from "@cityjson/navara-core";
import {
  decodeImplicitTemplates,
  decodeTableObjects,
} from "../src/decodeTable";
import { withImplicitSurfaces, type CityModel } from "@cityjson/navara-core";
import {
  readCityParquetTable,
  readImplicitGeometriesTable,
} from "../src/tableReader";

const PACKAGE = new URL(
  "./fixtures/rs-minimal-implicit-cityparquet/",
  import.meta.url,
);
const ORACLE = new URL(
  "./fixtures/rs-minimal-implicit.oracle.json",
  import.meta.url,
);

interface Oracle {
  objects: Record<
    string,
    { template: number; point: Vec3; transformationMatrix: number[] | null }
  >;
  templates: Array<{ type: string; lod: string; boundaries: number[][][] }>;
  "vertices-templates": Vec3[];
}

async function bytesOf(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(name, PACKAGE)));
}

async function oracle(): Promise<Oracle> {
  return JSON.parse(await readFile(ORACLE, "utf8")) as Oracle;
}

/** A coordinate on a 1e-6 grid, so both arithmetic paths agree. */
function grid(v: Vec3): Vec3 {
  return v.map((c) => Math.round(c * 1e6) / 1e6 || 0) as unknown as Vec3;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe("implicit geometries written by the reference writer", () => {
  it("gives every vegetation object the implicit geometry its export has", async () => {
    const [table, expected] = await Promise.all([
      readCityParquetTable(await bytesOf("vegetation.parquet")),
      oracle(),
    ]);
    const objects = decodeTableObjects(table);
    expect(Object.keys(objects).sort()).toEqual(
      Object.keys(expected.objects).sort(),
    );
    for (const [id, instance] of Object.entries(expected.objects)) {
      const implicit = objects[id]!.implicitGeometry;
      expect(implicit, id).toBeDefined();
      expect(
        {
          templateId: implicit!.templateId,
          referencePoint: grid(implicit!.referencePoint),
          transformationMatrix: implicit!.transformationMatrix,
        },
        id,
      ).toEqual({
        templateId: instance.template,
        referencePoint: grid(instance.point),
        transformationMatrix: instance.transformationMatrix ?? IDENTITY,
      });
    }
  });

  it("reads every template, face by face, in its local coordinates", async () => {
    const [templates, expected] = await Promise.all([
      readImplicitGeometriesTable(
        await bytesOf("implicit_geometries.parquet"),
      ).then((t) => decodeImplicitTemplates(t)),
      oracle(),
    ]);
    expect([...templates.keys()]).toEqual(expected.templates.map((_, i) => i));
    for (const [i, template] of expected.templates.entries()) {
      const decoded = templates.get(i)!;
      expect(decoded.name).toBeNull();
      expect(Number(decoded.lod)).toBe(Number(template.lod));
      expect(
        decoded.surfaces.map((s) => s.rings.map((ring) => ring.map(grid))),
        `template ${String(i)}`,
      ).toEqual(
        template.boundaries.map((face) =>
          face.map((ring) =>
            ring.map((index) => grid(expected["vertices-templates"][index]!)),
          ),
        ),
      );
    }
  });

  it("places each object's template into its surfaces, at the export's coordinates", async () => {
    // What `assembleCityParquetModel` does once the tables are decoded (the
    // fixture has no CRS, so the package itself cannot be georeferenced).
    const [table, templates, expected] = await Promise.all([
      readCityParquetTable(await bytesOf("vegetation.parquet")),
      readImplicitGeometriesTable(
        await bytesOf("implicit_geometries.parquet"),
      ).then((t) => decodeImplicitTemplates(t)),
      oracle(),
    ]);
    const model = withImplicitSurfaces({
      sourceEncoding: "cityparquet",
      metadata: {},
      bbox: null,
      objects: decodeTableObjects(table),
      vertexCount: 0,
      implicitTemplates: templates,
    } satisfies CityModel);
    for (const [id, instance] of Object.entries(expected.objects)) {
      const m = instance.transformationMatrix ?? IDENTITY;
      const p = instance.point;
      const placedVertex = (v: Vec3): Vec3 =>
        grid([
          m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2] + m[3]! + p[0],
          m[4]! * v[0] + m[5]! * v[1] + m[6]! * v[2] + m[7]! + p[1],
          m[8]! * v[0] + m[9]! * v[1] + m[10]! * v[2] + m[11]! + p[2],
        ]);
      const template = expected.templates[instance.template]!;
      expect(
        model.objects[id]!.surfaces.map((s) =>
          s.rings.map((ring) => ring.map(grid)),
        ),
        id,
      ).toEqual(
        template.boundaries.map((face) =>
          face.map((ring) =>
            ring.map((index) =>
              placedVertex(expected["vertices-templates"][index]!),
            ),
          ),
        ),
      );
      expect(model.objects[id]!.bbox, id).not.toBeNull();
    }
  });
});
