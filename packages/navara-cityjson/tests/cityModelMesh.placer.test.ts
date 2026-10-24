/**
 * A static layer projects each vertex once for its life: a LoD switch reuses
 * the vertices an earlier build projected, and so does a new placement (a
 * new height offset), which only redoes the arithmetic into its frame.
 */
import { describe, it, expect, vi } from "vitest";
import type { CityModel, Surface } from "@cityjson/navara-core";

const placers = vi.hoisted(() => [] as Array<{ projectedCount(): number }>);
vi.mock("@cityjson/navara-core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@cityjson/navara-core")>();
  return {
    ...core,
    createVertexPlacer: (
      ...args: Parameters<typeof core.createVertexPlacer>
    ) => {
      const placer = core.createVertexPlacer(...args);
      placers.push(placer);
      return placer;
    },
  };
});

const { CityModelMesh } = await import("../src/cityModelMesh");

// A box whose LoD 1 and LoD 2 share their four footprint corners, as the
// 3DBAG's LoDs share vertices: LoD 2 adds a ridge.
const sw: [number, number, number] = [85000, 446000, 0];
const se: [number, number, number] = [85010, 446000, 0];
const ne: [number, number, number] = [85010, 446010, 0];
const nw: [number, number, number] = [85000, 446010, 0];
const ridgeW: [number, number, number] = [85000, 446005, 8];
const ridgeE: [number, number, number] = [85010, 446005, 8];
const surface = (
  lod: string,
  type: Surface["type"],
  ring: Array<[number, number, number]>,
): Surface => ({ type, rings: [ring], attributes: {}, lod });
const model: CityModel = {
  sourceEncoding: "cityjson",
  metadata: { referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/7415" },
  bbox: [85000, 446000, 0, 85010, 446010, 8],
  objects: {
    A: {
      id: "A",
      objectType: "Building",
      attributes: {},
      surfaces: [
        surface("1", "GroundSurface", [sw, nw, ne, se]),
        surface("2", "GroundSurface", [sw, nw, ne, se]),
        surface("2", "RoofSurface", [sw, se, ridgeE, ridgeW]),
        surface("2", "RoofSurface", [ne, nw, ridgeW, ridgeE]),
      ],
      bbox: [85000, 446000, 0, 85010, 446010, 8],
      children: [],
      parents: [],
      lod: "2",
    },
  },
  vertexCount: 6,
};
const opts = {
  id: "L1",
  model,
  crs: "https://www.opengis.net/def/crs/EPSG/0/7415",
  lod: "2",
};

function positions(m: InstanceType<typeof CityModelMesh>): number[] {
  return [
    ...(m.object3d.geometry.getAttribute("position").array as Float32Array),
  ];
}

describe("CityModelMesh vertex placement", () => {
  it("places each shared vertex once across LoD switches", () => {
    placers.length = 0;
    const m = new CityModelMesh(opts);
    expect(placers).toHaveLength(1);
    expect(placers[0]!.projectedCount()).toBe(6);
    m.setLod("1");
    m.setLod("2");
    expect(placers).toHaveLength(1);
    expect(placers[0]!.projectedCount()).toBe(6);
  });

  it("draws the same positions after a LoD round trip as a fresh build", () => {
    const m = new CityModelMesh(opts);
    m.setLod("1");
    m.setLod("2");
    expect(positions(m)).toEqual(positions(new CityModelMesh(opts)));
  });

  it("places a new height offset from the projections it already has", () => {
    placers.length = 0;
    const m = new CityModelMesh(opts);
    m.setHeightOffset(43);
    m.setLod("1");
    // A new placer for the new frame, on the same projections: LoD 1's four
    // corners were projected for LoD 2, so the count stays at six.
    expect(placers).toHaveLength(2);
    expect(placers[1]!.projectedCount()).toBe(6);
    expect(positions(m)).toEqual(
      positions(new CityModelMesh({ ...opts, lod: "1", heightOffset: 43 })),
    );
  });
});
