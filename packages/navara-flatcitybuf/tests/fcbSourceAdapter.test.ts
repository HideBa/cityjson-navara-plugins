/**
 * The FlatCityBuf adapter's `open`: which `StreamSource` shapes it accepts.
 * `./fcbSource` and `@cityjson/flatcitybuf` are replaced so no real reader
 * is built — the assertions are about what reaches `openFcb`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const openFcb = vi.hoisted(() => vi.fn());

vi.mock("@cityjson/flatcitybuf", () => ({
  FcbReader: class {},
  toCityJSONMetadata: () => ({}),
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
