import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  computeArea,
  computeRoofMetrics,
  parseCityJSON,
  type BBox3,
  type CityJSONRoot,
  type CityModel,
} from "@cityjson/navara-core";
import { toObjectRecords } from "../src/objectRecords";

// Read from navara-core's fixture rather than keeping a third copy of it:
// the workspace has one canonical two-buildings model, and a duplicate here
// would silently drift from the parser tests that define its meaning.
const model = parseCityJSON(
  JSON.parse(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname!,
        "../../navara-core/fixtures/two-buildings.city.json",
      ),
      "utf-8",
    ),
  ) as CityJSONRoot,
);

// The exact field set of ResidentObjectRecord (workerProtocol.ts). Kept here,
// rather than relying on a string search for "rings", so a rename or an
// accidental extra field is caught structurally instead of by substring
// matching (see "carries no ring geometry" below).
const RESIDENT_OBJECT_RECORD_KEYS = [
  "id",
  "objectType",
  "attributes",
  "bbox",
  "lod",
  "surfaceCount",
  "roofMetrics",
  "geometryLods",
  "footprintAreaSqM",
  "volumeCuM",
  "parents",
  "children",
].sort();

describe("toObjectRecords", () => {
  it("emits one record per object with a surface count", () => {
    const { records } = toObjectRecords(model);
    expect(records.length).toBe(Object.keys(model.objects).length);
    for (const r of records) {
      expect(r.surfaceCount).toBe(model.objects[r.id]!.surfaces.length);
    }
  });

  it("precomputes roof metrics for every RoofSurface, matching computeRoofMetrics", () => {
    const { records } = toObjectRecords(model);
    for (const r of records) {
      const roofs = model.objects[r.id]!.surfaces.filter(
        (s) => s.type === "RoofSurface",
      );
      expect(r.roofMetrics.length).toBe(roofs.length);
      // Not just the count — the values themselves, in surface order, must
      // match what computeRoofMetrics produces directly from the surface.
      expect(r.roofMetrics).toEqual(
        roofs.map((s) => ({ ...computeRoofMetrics(s), lod: s.lod })),
      );
    }
  });

  it("carries only the documented ResidentObjectRecord fields — no ring geometry", () => {
    // A JSON.stringify(...).not.toContain("rings") string search is weak:
    // it passes if the field is merely renamed, and it would false-positive
    // on any attribute value that happens to contain the substring "rings".
    // Asserting the exact key set is a structural check that catches both:
    // a renamed/relocated ring field would still show up as an unexpected
    // key (or a missing documented one), and no string content matters.
    const { records } = toObjectRecords(model);
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(Object.keys(r).sort()).toEqual(RESIDENT_OBJECT_RECORD_KEYS);
      for (const rm of r.roofMetrics) {
        expect(Object.keys(rm).sort()).toEqual(
          [
            "areaSqM",
            "azimuthDeg",
            "elevationM",
            "inclinationDeg",
            "lod",
          ].sort(),
        );
      }
    }
  });

  it("computes footprintAreaSqM as the summed area of GroundSurface exterior rings", () => {
    const { records } = toObjectRecords(model);
    for (const r of records) {
      const grounds = model.objects[r.id]!.surfaces.filter(
        (s) => s.type === "GroundSurface",
      );
      const expected = grounds.reduce(
        (sum, s) => sum + computeArea(s.rings[0] ?? []),
        0,
      );
      expect(r.footprintAreaSqM).toBeCloseTo(expected, 6);
    }
  });

  it("computes volumeCuM as footprint x measuredHeight when that attribute is numeric", () => {
    const { records } = toObjectRecords(model);
    // The fixture gives every object a numeric measuredHeight, so this
    // exercises the "numeric" branch; the "else null" branch is exercised
    // by the synthetic-model test below.
    for (const r of records) {
      const h = model.objects[r.id]!.attributes.measuredHeight;
      expect(typeof h).toBe("number");
      expect(r.volumeCuM).toBeCloseTo(r.footprintAreaSqM * (h as number), 6);
    }
  });

  it("reports volumeCuM as null when measuredHeight is absent or non-numeric", () => {
    const synthetic: CityModel = {
      sourceEncoding: "cityjson",
      metadata: {},
      bbox: [0, 0, 0, 10, 10, 5],
      objects: {
        noHeight: {
          id: "noHeight",
          objectType: "Building",
          attributes: { roofType: "flat" }, // no measuredHeight
          bbox: [0, 0, 0, 10, 10, 5],
          children: [],
          parents: [],
          lod: "2.2",
          surfaces: [
            {
              type: "GroundSurface",
              rings: [
                [
                  [0, 0, 0],
                  [10, 0, 0],
                  [10, 10, 0],
                  [0, 10, 0],
                ],
              ],
              attributes: {},
              lod: "2.2",
            },
          ],
        },
      },
      vertexCount: 4,
    };

    const { records } = toObjectRecords(synthetic);
    expect(records).toHaveLength(1);
    expect(records[0]!.footprintAreaSqM).toBeCloseTo(100, 6);
    expect(records[0]!.volumeCuM).toBeNull();
  });

  it("skips an object with no geometry (bbox: null) instead of fabricating one", () => {
    // CityObject.bbox is nullable (an object with no `geometry` at all, e.g.
    // a parent Building that only aggregates BuildingParts, parses to
    // bbox: null — see parseCityObject in parseHelpers.ts). Every real
    // streamed cell model already excludes such objects before
    // toObjectRecords ever sees them (bucketFeatures.ts skips
    // `if (!obj?.bbox) continue`), but ResidentObjectRecord.bbox is
    // non-nullable, so toObjectRecords must not blindly forward one that
    // slips through — e.g. if it is ever called on a whole (non-bucketed)
    // model instead of a per-cell one.
    const synthetic: CityModel = {
      sourceEncoding: "cityjson",
      metadata: {},
      bbox: null,
      objects: {
        parentOnly: {
          id: "parentOnly",
          objectType: "Building",
          attributes: {},
          bbox: null,
          children: ["child"],
          parents: [],
          lod: null,
          surfaces: [],
        },
        child: {
          id: "child",
          objectType: "BuildingPart",
          attributes: { measuredHeight: 5 },
          bbox: [0, 0, 0, 10, 10, 5],
          children: [],
          parents: ["parentOnly"],
          lod: "2.2",
          surfaces: [
            {
              type: "GroundSurface",
              rings: [
                [
                  [0, 0, 0],
                  [10, 0, 0],
                  [10, 10, 0],
                  [0, 10, 0],
                ],
              ],
              attributes: {},
              lod: "2.2",
            },
          ],
        },
      },
      vertexCount: 4,
    };

    const { records } = toObjectRecords(synthetic);
    expect(records.map((r) => r.id)).toEqual(["child"]);
  });

  /**
   * The fix-round review's N4. Reverting the strict lookup in
   * `objectRecords.ts` to `?? obj.bbox` left all 439 flatcitybuf tests green,
   * because the stream worker now derives a box for every object and so never
   * hands over a partial map. The invariant still has to be guarded: a future
   * caller with a partial map would republish the missing object's OWN bbox,
   * which for a streamed geographic cell is the CELL's ENU metres, as if it
   * were an index coordinate — a plausible number hundreds of metres out, with
   * nothing downstream able to tell.
   */
  it("drops an object the override map does not name, never falling back to its own box", () => {
    const boxed = Object.values(model.objects).filter((o) => o.bbox !== null);
    expect(boxed.length).toBeGreaterThan(1);
    const [missing, ...named] = boxed;
    const override: BBox3 = [1000, 2000, 0, 1010, 2010, 9];
    const partial = new Map(named.map((o) => [o.id, override]));

    const { records } = toObjectRecords(model, partial);

    expect(records.map((r) => r.id).sort()).toEqual(
      named.map((o) => o.id).sort(),
    );
    // The drop is the lookup's decision, not an absent bbox: the missing
    // object has a perfectly good box, in the wrong space.
    expect(missing!.bbox).not.toBeNull();
    // And every record that IS published carries the map's box, not its own.
    for (const record of records) expect(record.bbox).toEqual(override);
  });

  it("carries parents and children through unchanged", () => {
    const { records } = toObjectRecords(model);
    const byId = new Map(records.map((r) => [r.id, r]));
    expect(byId.get("NL.IMBAG.Pand.0001")!.children).toEqual([
      "NL.IMBAG.Pand.0001-part1",
    ]);
    expect(byId.get("NL.IMBAG.Pand.0001-part1")!.parents).toEqual([
      "NL.IMBAG.Pand.0001",
    ]);
  });

  it("collects the union of surface attribute keys", () => {
    const { surfaceAttrKeys } = toObjectRecords(model);
    expect(Array.isArray(surfaceAttrKeys)).toBe(true);
    // Only the semantic "slope" attribute appears anywhere in the fixture's
    // surfaces (GroundSurface/WallSurface carry no extra keys beyond "type",
    // which extractSemanticAttributes already strips).
    expect([...surfaceAttrKeys].sort()).toEqual(["slope"]);
  });
});

/** A unit square at height `z`, of `type`, tagged with `lod`. */
function taggedSurface(type: string, lod: string | null, z: number) {
  return {
    type,
    rings: [
      [
        [0, 0, z],
        [1, 0, z],
        [1, 1, z],
        [0, 1, z],
      ],
    ],
    attributes: {},
    lod,
  };
}

function modelWith(surfaces: ReadonlyArray<unknown>): CityModel {
  return {
    sourceEncoding: "flatcitybuf",
    metadata: {},
    bbox: [0, 0, 0, 1, 1, 9],
    vertexCount: 0,
    objects: {
      b1: {
        id: "b1",
        objectType: "Building",
        attributes: {},
        surfaces,
        bbox: [0, 0, 0, 1, 1, 9],
        children: [],
        parents: [],
        lod: "2.2",
      },
    },
  } as unknown as CityModel;
}

describe("toObjectRecords, per-LoD", () => {
  it("tags each roof metric with its OWN surface's LoD", () => {
    // `toObjectRecords` runs on the UNFILTERED cell model (`fcb.worker.ts` —
    // `msg.lod` filters the mesh, not the parse), so one object contributes
    // roof surfaces at every LoD it has, and `record.lod` (the OBJECT's)
    // cannot tell them apart.
    const { records } = toObjectRecords(
      modelWith([
        taggedSurface("RoofSurface", "1.2", 3),
        taggedSurface("RoofSurface", "2.2", 9),
      ]),
    );
    expect(records[0]!.roofMetrics.map((m) => m.lod)).toEqual(["1.2", "2.2"]);
    expect(records[0]!.roofMetrics[0]!.areaSqM).toBeCloseTo(1, 6);
  });

  it("reports the LoDs of EVERY surface, not only the roofs", () => {
    // The case §7's contributor rule turns on: geometry at 2.2 that is not a
    // roof still makes this object a contributor at 2.2.
    const { records } = toObjectRecords(
      modelWith([
        taggedSurface("WallSurface", "2.2", 9),
        taggedSurface("RoofSurface", "1.2", 3),
      ]),
    );
    expect([...records[0]!.geometryLods].sort()).toEqual(["1.2", "2.2"]);
    expect(records[0]!.roofMetrics.map((m) => m.lod)).toEqual(["1.2"]);
  });

  it("de-duplicates the LoD list and drops untagged surfaces", () => {
    const { records } = toObjectRecords(
      modelWith([
        taggedSurface("RoofSurface", "2.2", 9),
        taggedSurface("WallSurface", "2.2", 9),
        taggedSurface("WallSurface", null, 9),
      ]),
    );
    expect(records[0]!.geometryLods).toEqual(["2.2"]);
  });
});
