import { describe, expect, it } from "vitest";
import {
  CityParquetError,
  lodFromColumnName,
  parseCityFooter,
  propsColumnFor,
} from "../src/footer";

const CITY = {
  version: "0.1.0-draft",
  source_format: "CityJSONSeq",
  crs: { type: "CompoundCRS", id: { authority: "EPSG", code: 7415 } },
  primary_column: "geometry_lod2_2",
  columns: [
    {
      name: "geometry_lod2_2",
      encoding: "WKB",
      geometry_types: ["PolyhedralSurface Z"],
      orientation_3d: "right-handed",
    },
  ],
  attributes: ["b3_h_maaiveld"],
};

describe("parseCityFooter", () => {
  it("parses the city key", () => {
    const f = parseCityFooter([
      { key: "city", value: JSON.stringify(CITY) },
      { key: "geo", value: "{}" },
    ]);
    expect(f.version).toBe("0.1.0-draft");
    expect(f.epsg).toBe(7415);
    expect(f.primaryColumn).toBe("geometry_lod2_2");
    expect(f.geometryColumns[0]).toEqual({
      name: "geometry_lod2_2",
      encoding: "WKB",
      geometryTypes: ["PolyhedralSurface Z"],
      orientation3d: "right-handed",
    });
    expect(f.attributes).toEqual(["b3_h_maaiveld"]);
  });
  it("throws a friendly error when the city key is missing", () => {
    expect(() => parseCityFooter([{ key: "geo", value: "{}" }])).toThrow(
      CityParquetError,
    );
    expect(() => parseCityFooter([])).toThrow(/not a CityParquet file/i);
  });
  it("returns epsg null for a non-EPSG or absent crs", () => {
    expect(
      parseCityFooter([
        { key: "city", value: JSON.stringify({ ...CITY, crs: undefined }) },
      ]).epsg,
    ).toBeNull();
    expect(
      parseCityFooter([
        {
          key: "city",
          value: JSON.stringify({
            ...CITY,
            crs: { id: { authority: "ESRI", code: 1 } },
          }),
        },
      ]).epsg,
    ).toBeNull();
  });
  it("tolerates absent optional fields", () => {
    const f = parseCityFooter([
      { key: "city", value: JSON.stringify({ version: "0.1.0-draft" }) },
    ]);
    expect(f.attributes).toEqual([]);
    expect(f.geometryColumns).toEqual([]);
    expect(f.primaryColumn).toBeNull();
  });
});

describe("lodFromColumnName / propsColumnFor", () => {
  it("parses LoD suffixes", () => {
    expect(lodFromColumnName("geometry_lod2_2")).toEqual({ lod: "2.2" });
    expect(lodFromColumnName("geometry_lod0_0")).toEqual({ lod: "0" });
    expect(lodFromColumnName("geometry")).toEqual({ lod: null });
    expect(lodFromColumnName("geometry_vertices_lod2_2")).toBeNull();
    expect(lodFromColumnName("b3_volume_lod2")).toBeNull();
  });
  it("maps props columns", () => {
    expect(propsColumnFor("geometry_lod2_2")).toBe(
      "geometry_properties_lod2_2",
    );
    expect(propsColumnFor("geometry")).toBe("geometry_properties");
  });
});

// ---------------------------------------------------------------------------
// Cases beyond the brief's literal set, pinning the behaviours later tasks
// depend on.
// ---------------------------------------------------------------------------

describe("parseCityFooter (further shapes)", () => {
  it("reads sourceFormat and a null-valued optional as null", () => {
    const f = parseCityFooter([{ key: "city", value: JSON.stringify(CITY) }]);
    expect(f.sourceFormat).toBe("CityJSONSeq");
    expect(
      parseCityFooter([
        {
          key: "city",
          value: JSON.stringify({ version: "0.1.0-draft" }),
        },
      ]).sourceFormat,
    ).toBeNull();
  });

  it("defaults a column's absent optional fields", () => {
    const f = parseCityFooter([
      {
        key: "city",
        value: JSON.stringify({
          version: "0.1.0-draft",
          columns: [{ name: "geometry_lod1_2", encoding: "WKB" }],
        }),
      },
    ]);
    expect(f.geometryColumns[0]).toEqual({
      name: "geometry_lod1_2",
      encoding: "WKB",
      geometryTypes: [],
      orientation3d: null,
    });
  });

  it("rejects a value that is not JSON, or not a JSON object", () => {
    expect(() => parseCityFooter([{ key: "city", value: "{oops" }])).toThrow(
      /not a CityParquet file/i,
    );
    expect(() => parseCityFooter([{ key: "city", value: "[]" }])).toThrow(
      CityParquetError,
    );
    expect(() => parseCityFooter([{ key: "city", value: null }])).toThrow(
      CityParquetError,
    );
  });

  it("rejects a city object with no version", () => {
    expect(() =>
      parseCityFooter([{ key: "city", value: JSON.stringify({ columns: [] }) }]),
    ).toThrow(CityParquetError);
  });

  it("rejects a malformed columns entry rather than dropping it", () => {
    expect(() =>
      parseCityFooter([
        {
          key: "city",
          value: JSON.stringify({
            version: "0.1.0-draft",
            columns: [{ encoding: "WKB" }],
          }),
        },
      ]),
    ).toThrow(CityParquetError);
  });
});

describe("lodFromColumnName (further shapes)", () => {
  it("strips a .0 minor so the display string matches parseCityJSON's", () => {
    expect(lodFromColumnName("geometry_lod1_0")).toEqual({ lod: "1" });
    expect(lodFromColumnName("geometry_lod1_2")).toEqual({ lod: "1.2" });
  });

  it("rejects shapes the column grammar never produces", () => {
    expect(lodFromColumnName("geometry_lod1")).toBeNull();
    expect(lodFromColumnName("geometry_lod")).toBeNull();
    expect(lodFromColumnName("geometry_lodx_2")).toBeNull();
    expect(lodFromColumnName("geometry_lod2_2_2")).toBeNull();
    expect(lodFromColumnName("geometry_properties_lod2_2")).toBeNull();
    expect(lodFromColumnName("geometry_lod999_0")).toBeNull();
    expect(lodFromColumnName("")).toBeNull();
  });
});

describe("propsColumnFor (further shapes)", () => {
  it("refuses a name that is not a geometry column", () => {
    expect(() => propsColumnFor("b3_volume_lod2")).toThrow(CityParquetError);
  });
});
