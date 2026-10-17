/**
 * The FlatCityBuf adapter's `open`: which `StreamSource` shapes it accepts.
 * `./fcbSource` and `@cityjson/flatcitybuf` are replaced so no real reader
 * is built — the assertions are about what reaches `openFcb`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const openFcb = vi.hoisted(() => vi.fn());
const toCityJSONMetadata = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("@cityjson/flatcitybuf", () => ({
  FcbReader: class {},
  toCityJSONMetadata,
}));
vi.mock("../src/fcbSource", () => ({
  openFcb,
  checkAdmission: () => null,
  headerModel: () => ({
    version: "2.0",
    featuresCount: 1,
    extent: [0, 0, 0, 10, 10, 10],
    referenceSystem: undefined,
    epsg: 28992,
  }),
}));

import { createFcbSourceAdapter } from "../src/fcbSourceAdapter";

beforeEach(() => {
  toCityJSONMetadata.mockReset();
  toCityJSONMetadata.mockReturnValue({});
  openFcb.mockReset();
  openFcb.mockResolvedValue({ header: {} });
});

describe("createFcbSourceAdapter().open", () => {
  it("opens a single url", async () => {
    const opened = await createFcbSourceAdapter().open({
      type: "open",
      id: 0,
      source: { url: "https://x/a.fcb" },
    });
    expect(openFcb).toHaveBeenCalledWith({ url: "https://x/a.fcb" });
    expect(opened.admission).toBeNull();
  });

  it("opens a single blob", async () => {
    const blob = new Blob(["x"]);
    await createFcbSourceAdapter().open({
      type: "open",
      id: 0,
      source: { blob },
    });
    expect(openFcb).toHaveBeenCalledWith({ blob });
  });

  it("unwraps a one-element url list and a one-element blob list", async () => {
    const adapter = createFcbSourceAdapter();
    await adapter.open({
      type: "open",
      id: 0,
      source: { urls: ["https://x/a.fcb"] },
    });
    expect(openFcb).toHaveBeenLastCalledWith({ url: "https://x/a.fcb" });
    const blob = new Blob(["x"]);
    await adapter.open({ type: "open", id: 1, source: { blobs: [blob] } });
    expect(openFcb).toHaveBeenLastCalledWith({ blob });
  });

  it("refuses more than one source with 'multi-source', without opening any", async () => {
    const adapter = createFcbSourceAdapter();
    for (const source of [
      { urls: ["https://x/a.fcb", "https://x/b.fcb"] },
      { blobs: [new Blob(["a"]), new Blob(["b"])] },
    ]) {
      const opened = await adapter.open({ type: "open", id: 0, source });
      expect(opened.admission?.code).toBe("multi-source");
      expect(opened.header.extent).toBeUndefined();
      expect(opened.header.epsg).toBeNull();
    }
    expect(openFcb).not.toHaveBeenCalled();
  });
});

describe("createFcbSourceAdapter().select", () => {
  it("places a feature's implicit geometry from the header's templates", async () => {
    // A unit square template, instanced at (100, 200, 0) scaled by 2.
    toCityJSONMetadata.mockReturnValue({
      transform: { scale: [1, 1, 1], translate: [0, 0, 0] },
      "geometry-templates": {
        templates: [
          { type: "MultiSurface", lod: "2", boundaries: [[[0, 1, 2, 3]]] },
        ],
        "vertices-templates": [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
          [0, 1, 0],
        ],
      },
    });
    const feature = {
      type: "CityJSONFeature",
      id: "T1",
      CityObjects: {
        T1: {
          type: "SolitaryVegetationObject",
          geometry: [
            {
              type: "GeometryInstance",
              template: 0,
              boundaries: [0],
              transformationMatrix: [
                2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1,
              ],
            },
          ],
        },
      },
      vertices: [[100, 200, 0]],
    };
    openFcb.mockResolvedValue({
      header: {},
      select: async () => ({
        async *[Symbol.asyncIterator]() {
          yield { toCityJSON: () => feature };
        },
      }),
    });
    const adapter = createFcbSourceAdapter();
    await adapter.open({
      type: "open",
      id: 0,
      source: { url: "https://x/a.fcb" },
    });
    const models = [];
    for await (const m of adapter.select([0, 0, 1, 1], {
      signal: new AbortController().signal,
    } as never)) {
      models.push(m);
    }
    const tree = models[0]!.objects["T1"]!;
    expect(tree.surfaces).toHaveLength(1);
    expect(tree.surfaces[0]!.rings[0]).toEqual([
      [100, 200, 0],
      [102, 200, 0],
      [102, 202, 0],
      [100, 202, 0],
    ]);
    expect(tree.bbox).toEqual([100, 200, 0, 102, 202, 0]);
  });
});
