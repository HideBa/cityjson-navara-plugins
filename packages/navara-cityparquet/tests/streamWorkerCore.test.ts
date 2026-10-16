/**
 * The stream worker core over the CityParquet adapter: the shared conformance
 * scenario, and the family rules only a CityParquet source exercises.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BBox3 } from "@cityjson/navara-core";
import { keysCovering, makeGrid, ownerKey } from "@cityjson/navara-stream";
import {
  errorOf,
  fetchAt,
  fetchConformance,
  harness,
  ofType,
  openedExtent,
} from "../../navara-stream/tests/support/workerHarness";
import { createCityParquetSourceAdapter } from "../src/streamAdapter";

/** The multi-row-group CityParquet fixture (20 copies of two-buildings, 60
 *  objects in 40 families, EPSG:7415) as a Blob. */
async function cityParquetFixture(): Promise<Blob> {
  const file = await readFile(
    fileURLToPath(
      new URL(
        "./fixtures/multigroup-cityparquet/building.parquet",
        import.meta.url,
      ),
    ),
  );
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file);
  return new Blob([bytes]);
}


describe("streamWorkerCore — adapter conformance", () => {
  it("the CityParquet adapter on the multi-row-group fixture", async () => {
    const ids = Array.from({ length: 20 }, (_, k) => [
      `NL.IMBAG.Pand.0001_${k}`,
      `NL.IMBAG.Pand.0001-part1_${k}`,
      `NL.IMBAG.Pand.0002_${k}`,
    ]).flat();
    await fetchConformance(
      createCityParquetSourceAdapter(),
      { type: "open", id: 0, source: { blob: await cityParquetFixture() } },
      5,
      ids,
    );
  });
});

describe("streamWorkerCore — with the CityParquet adapter", () => {
  // The fixture's copies sit every 50 m from the grid origin, which is every
  // cell boundary of every in-range level (the smallest cell is 50 m), so no
  // family can straddle one there. Level 7 (12.5 m cells) splits copy 0's
  // family: the root (x 85000..85010) and its part (x 85012..85016) own
  // different cells, while the family union (x 85000..85016) is centred in
  // the root's. The core does not bound `level` by the grid's maxLevel.
  const LEVEL = 7;
  const ROOT = "NL.IMBAG.Pand.0001_0";
  const PART = "NL.IMBAG.Pand.0001-part1_0";

  it("a family whose parts straddle a cell boundary lands whole in one cell, and leaves with it", async () => {
    const { posted, send } = harness(createCityParquetSourceAdapter());
    await send({
      type: "open",
      id: 0,
      source: { blob: await cityParquetFixture() },
    });
    const extent = openedExtent(posted);
    const grid = makeGrid(extent);
    // Precondition: object-wise, root and part WOULD own different cells.
    const rootBox: BBox3 = [85000, 446000, 0, 85010, 446008, 8.4];
    const partBox: BBox3 = [85012, 446000, 0, 85016, 446005, 3.2];
    const rootKey = ownerKey(grid, rootBox, LEVEL);
    const partKey = ownerKey(grid, partBox, LEVEL);
    expect(rootKey).not.toBe(partKey);

    const box: [number, number, number, number] = [
      85000, 446000, 85040, 446012,
    ];
    const cells = keysCovering(grid, box, LEVEL);
    expect(cells).toContain(partKey);
    await send(fetchAt(1, LEVEL, cells, box));

    const holding = posted
      .filter(ofType("cell"))
      .filter((c) => c.objects.some((o) => o.id === ROOT || o.id === PART));
    expect(holding.map((c) => c.key)).toEqual([rootKey]);
    expect(holding[0]!.objects.map((o) => o.id)).toEqual(
      expect.arrayContaining([ROOT, PART]),
    );

    await send({ type: "evict", id: 2, cells: [rootKey!] });
    await send({ type: "surfaces", id: 3, objectId: ROOT });
    await send({ type: "surfaces", id: 4, objectId: PART });
    expect(posted.find(errorOf(3))?.code).toBe("not-found");
    expect(posted.find(errorOf(4))?.code).toBe("not-found");
  });

  it("a fetch refused by the read budget reports the 'budget' code", async () => {
    const { posted, send } = harness(
      createCityParquetSourceAdapter({ maxFetchReadRows: 10 }),
    );
    await send({
      type: "open",
      id: 0,
      source: { blob: await cityParquetFixture() },
    });
    const extent = openedExtent(posted);
    const grid = makeGrid(extent);
    const box: [number, number, number, number] = [
      extent[0],
      extent[1],
      extent[3],
      extent[4],
    ];
    await send(fetchAt(1, 5, keysCovering(grid, box, 5), box));
    expect(posted.filter(ofType("cell"))).toEqual([]);
    expect(posted.find(errorOf(1))).toMatchObject({
      code: "budget",
      aborted: false,
    });
  });
});
