/**
 * The CityParquet source adapter, on the reader's own fixtures read through
 * real range buffers (Blob sources, and a fake HTTP server for url sources).
 *
 * `multigroup-cityparquet` is 20 copies of `two-buildings` (copy k = rows
 * 3k..3k+2, k*50 m east of x 85000): the family Pand.0001_k + its part
 * Pand.0001-part1_k, then the family Pand.0002_k. EPSG:7415, LoDs 0 and 2.2.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CityObject } from "@cityjson/navara-core";
import {
  asyncBufferFromBlob,
  openCityParquetStream,
  type ReadBatch,
} from "@cityjson/navara-cityparquet";
import {
  createCityParquetSourceAdapter,
  familyModels,
  MAX_FETCH_READ_ROWS,
} from "../src/cityParquetSourceAdapter";
import type { OpenRequest } from "../src/streamSourceAdapter";
import type { StreamSource } from "../src/workerProtocol";

async function fixtureBytes(dir: string): Promise<Uint8Array<ArrayBuffer>> {
  const file = await readFile(
    fileURLToPath(
      new URL(
        `../../navara-cityparquet/tests/fixtures/${dir}/building.parquet`,
        import.meta.url,
      ),
    ),
  );
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file);
  return bytes;
}

const MULTIGROUP = "multigroup-cityparquet";

async function blobOf(dir: string): Promise<Blob> {
  return new Blob([await fixtureBytes(dir)]);
}

function openReq(source: StreamSource): OpenRequest {
  return { type: "open", id: 0, source };
}

/** Tight around copy 9 (x 85450..85485); copies 8 and 10 are 15 m away. */
const COPY_9_BOX = [85449, 445999, 85486, 446013] as const;
const WHOLE_BOX = [84000, 445000, 87000, 447000] as const;

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** A Blob that counts the slices read from it. */
class CountingBlob extends Blob {
  slices = 0;
  override slice(...args: Parameters<Blob["slice"]>): Blob {
    this.slices++;
    return super.slice(...args);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createCityParquetSourceAdapter — open", () => {
  it("maps the stream header: EPSG, object count, LoDs and extent", async () => {
    const adapter = createCityParquetSourceAdapter();
    const opened = await adapter.open(
      openReq({ blob: await blobOf(MULTIGROUP) }),
    );
    expect(opened.admission).toBeNull();
    expect(opened.header).toEqual({
      version: expect.any(String),
      featuresCount: 60,
      objectsCount: 60,
      extent: [85000, 446000, 0, 85985, 446012, 12.1],
      referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/7415",
      epsg: 7415,
      lods: ["0", "2.2"],
      invalidBBoxRows: 0,
    });
  });

  it("carries the index's unplaceable-row count onto the posted header", async () => {
    // Codex milestone review (Minor): `invalidBBoxRows` was computed by the
    // family index and then dropped at the worker boundary, so a source whose
    // rows cannot all be placed showed "N of M loaded" with no way to learn
    // why the remainder never arrives.
    const blob = await blobOf(MULTIGROUP);
    const direct = await openCityParquetStream([asyncBufferFromBlob(blob)]);
    const adapter = createCityParquetSourceAdapter();
    const opened = await adapter.open(openReq({ blob }));
    expect(opened.header.invalidBBoxRows).toBe(direct.header.invalidBBoxRows);
    expect(opened.header.invalidBBoxRows).not.toBeUndefined();
  });

  it("buckets by feature and carries no appearance", async () => {
    const adapter = createCityParquetSourceAdapter();
    expect(adapter.ownership).toBe("feature");
    await adapter.open(openReq({ blob: await blobOf(MULTIGROUP) }));
    expect(adapter.appearance()).toBeUndefined();
  });

  it("opens a url list through ranged HTTP reads", async () => {
    const bytes = await fixtureBytes(MULTIGROUP);
    const ranges: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "Content-Length": String(bytes.byteLength) },
          });
        }
        const range = new Headers(init?.headers).get("Range")!;
        ranges.push(range);
        const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), bytes.byteLength - 1);
        return new Response(bytes.slice(start, end + 1), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
          },
        });
      },
    );
    const adapter = createCityParquetSourceAdapter();
    const opened = await adapter.open(
      openReq({ urls: ["https://host/building.parquet"] }),
    );
    expect(opened.admission).toBeNull();
    expect(opened.header.objectsCount).toBe(60);
    expect(ranges.length).toBeGreaterThan(0);
  });

  it("refuses a server that will not answer ranges as 'no-range'", async () => {
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        (init?.method ?? "GET") === "HEAD"
          ? new Response(null, { status: 200 }) // no Content-Length
          : new Response(new Uint8Array(8), { status: 200 }), // ignores Range
    );
    const adapter = createCityParquetSourceAdapter();
    const opened = await adapter.open(
      openReq({ url: "https://host/building.parquet" }),
    );
    expect(opened.admission?.code).toBe("no-range");
    expect(opened.admission?.message).toMatch(/host\/building\.parquet/);
    expect(opened.header.extent).toBeUndefined();
    expect(opened.header.epsg).toBeNull();
  });

  it("refuses tables with different CRSs as 'mixed-crs'", async () => {
    const adapter = createCityParquetSourceAdapter();
    const opened = await adapter.open(
      openReq({
        blobs: [
          await blobOf("two-buildings-cityparquet"),
          await blobOf("two-buildings-cityparquet-28992"),
        ],
      }),
    );
    expect(opened.admission?.code).toBe("mixed-crs");
    expect(opened.header.extent).toBeUndefined();
  });

  it("rethrows a read failure that is not a refusal", async () => {
    const adapter = createCityParquetSourceAdapter();
    await expect(
      adapter.open(openReq({ blob: new Blob([new Uint8Array(64)]) })),
    ).rejects.toThrow();
  });

  it("close drops the stream: probe and select then have no file", async () => {
    const adapter = createCityParquetSourceAdapter();
    await adapter.open(openReq({ blob: await blobOf(MULTIGROUP) }));
    adapter.close();
    await expect(
      adapter.probe(COPY_9_BOX, new AbortController().signal),
    ).rejects.toThrow("no file open");
    await expect(
      collect(
        adapter.select(COPY_9_BOX, {
          lod: null,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toThrow("no file open");
  });

  it("an open closed while it reads never installs its stream", async () => {
    const adapter = createCityParquetSourceAdapter();
    const pending = adapter.open(openReq({ blob: await blobOf(MULTIGROUP) }));
    adapter.close();
    await expect(pending).rejects.toThrow();
    await expect(
      adapter.probe(COPY_9_BOX, new AbortController().signal),
    ).rejects.toThrow("no file open");
  });
});

describe("createCityParquetSourceAdapter — probe", () => {
  it("answers the family index's read cost for the box", async () => {
    const blob = await blobOf(MULTIGROUP);
    const reference = await openCityParquetStream([asyncBufferFromBlob(blob)]);
    const adapter = createCityParquetSourceAdapter();
    await adapter.open(openReq({ blob }));
    const signal = new AbortController().signal;
    for (const box of [COPY_9_BOX, WHOLE_BOX, [0, 0, 1, 1] as const]) {
      expect(await adapter.probe(box, signal)).toBe(
        reference.index.readCost(box),
      );
    }
    expect(await adapter.probe(COPY_9_BOX, signal)).toBe(3);
  });
});

describe("createCityParquetSourceAdapter — select", () => {
  it("yields one cityparquet model per family, parts with their root, the bbox their union", async () => {
    const adapter = createCityParquetSourceAdapter();
    await adapter.open(openReq({ blob: await blobOf(MULTIGROUP) }));
    const models = await collect(
      adapter.select(COPY_9_BOX, {
        lod: "2.2",
        signal: new AbortController().signal,
      }),
    );
    const families = models.map((m) => Object.keys(m.objects).sort());
    expect(families).toEqual([
      ["NL.IMBAG.Pand.0001-part1_9", "NL.IMBAG.Pand.0001_9"],
      ["NL.IMBAG.Pand.0002_9"],
    ]);
    for (const m of models) {
      expect(m.sourceEncoding).toBe("cityparquet");
      // The stream's CRS rides on every cell model, as it does on the stub.
      expect(m.metadata).toEqual({
        referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/7415",
      });
    }
    expect(models[0]!.bbox).toEqual([85450, 446000, 0, 85466, 446008, 8.4]);
    expect(models[1]!.bbox).toEqual([85470, 446000, 0, 85485, 446012, 12.1]);
    expect(models[0]!.vertexCount).toBeGreaterThan(0);
  });

  it("reads geometry up to the requested LoD only", async () => {
    const adapter = createCityParquetSourceAdapter();
    await adapter.open(openReq({ blob: await blobOf(MULTIGROUP) }));
    const models = await collect(
      adapter.select(COPY_9_BOX, {
        lod: "0",
        signal: new AbortController().signal,
      }),
    );
    const lods = new Set(
      models.flatMap((m) =>
        Object.values(m.objects).flatMap((o) =>
          (o?.surfaces ?? []).map((s) => s.lod),
        ),
      ),
    );
    expect(lods).toEqual(new Set(["0"]));
  });

  it("refuses a query whose read cost exceeds the budget before reading anything", async () => {
    expect(MAX_FETCH_READ_ROWS).toBe(60_000);
    const blob = new CountingBlob([await fixtureBytes(MULTIGROUP)]);
    const adapter = createCityParquetSourceAdapter({ maxFetchReadRows: 10 });
    await adapter.open(openReq({ blob }));
    const before = blob.slices;
    const error: unknown = await collect(
      adapter.select(WHOLE_BOX, {
        lod: null,
        signal: new AbortController().signal,
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { code?: string }).code).toBe("budget");
    expect((error as Error).message).toMatch(/60 rows/);
    expect((error as Error).message).toMatch(/10/);
    expect(blob.slices).toBe(before);
    // Within the budget the same adapter reads.
    const within = await collect(
      adapter.select(COPY_9_BOX, {
        lod: null,
        signal: new AbortController().signal,
      }),
    );
    expect(within).toHaveLength(2);
    expect(blob.slices).toBeGreaterThan(before);
  });

  it("an aborted signal stops the read", async () => {
    const adapter = createCityParquetSourceAdapter();
    await adapter.open(openReq({ blob: await blobOf(MULTIGROUP) }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(
        adapter.select(COPY_9_BOX, { lod: null, signal: controller.signal }),
      ),
    ).rejects.toThrow();
  });
});

describe("package index", () => {
  it("exports the adapter and its per-fetch row budget", async () => {
    const index = await import("../src/index");
    expect(index.createCityParquetSourceAdapter).toBe(
      createCityParquetSourceAdapter,
    );
    expect(index.MAX_FETCH_READ_ROWS).toBe(MAX_FETCH_READ_ROWS);
  });
});

describe("familyModels", () => {
  function object(id: string, bbox: CityObject["bbox"]): CityObject {
    return {
      id,
      objectType: "Building",
      attributes: {},
      surfaces: [],
      bbox,
    } as unknown as CityObject;
  }

  it("keeps only the families whose union intersects the query box", () => {
    const batch: ReadBatch = {
      objects: {
        a: object("a", [0, 0, 0, 10, 10, 5]),
        "a-part": object("a-part", [12, 0, 0, 20, 5, 3]),
        gap: object("gap", [500, 500, 0, 510, 510, 5]),
        noBox: object("noBox", null),
        b: object("b", [30, 0, 0, 40, 10, 5]),
      },
      rows: new Map([
        ["a", { table: 0, row: 0, familyRoot: "a" }],
        ["a-part", { table: 0, row: 1, familyRoot: "a" }],
        ["gap", { table: 0, row: 2, familyRoot: "gap" }],
        ["noBox", { table: 0, row: 3, familyRoot: "noBox" }],
        ["b", { table: 0, row: 4, familyRoot: "b" }],
      ]),
    };
    // x 15..35 touches only a's PART and b: a still comes back whole.
    const models = familyModels(batch, [15, 0, 35, 10]);
    expect(models.map((m) => Object.keys(m.objects))).toEqual([
      ["a", "a-part"],
      ["b"],
    ]);
    expect(models[0]!.bbox).toEqual([0, 0, 0, 20, 10, 5]);
  });
});

describe("bakeLod", () => {
  it("bakes every known LoD at or below the rung, highest first", () => {
    const adapter = createCityParquetSourceAdapter();
    const seen = ["0", "1", "2", "3"];
    expect(adapter.bakeLod("2", seen)).toEqual(["2", "1", "0"]);
    expect(adapter.bakeLod(null, seen)).toEqual(["3", "2", "1", "0"]);
  });

  it("uses the header's LoDs once a source is open", async () => {
    const adapter = createCityParquetSourceAdapter();
    await adapter.open(openReq({ blob: await blobOf(MULTIGROUP) }));
    expect(adapter.bakeLod("2", [])).toEqual(["0"]);
    expect(adapter.bakeLod("2.2", [])).toEqual(["2.2", "0"]);
    expect(adapter.bakeLod(null, [])).toEqual(["2.2", "0"]);
  });
});
