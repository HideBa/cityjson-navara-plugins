import { describe, it, expect } from "vitest";
import {
  buildAttrColumn,
  buildUtf8Column,
  columnValue,
  dictionaryValues,
  isValid,
  utf8Value,
} from "../../src/columnar/columns";

describe("buildUtf8Column", () => {
  it("lays strings out as offsets into one byte buffer, Arrow style", () => {
    const col = buildUtf8Column(["ab", null, "", "é"]);
    expect(col.length).toBe(4);
    expect(Array.from(col.offsets)).toEqual([0, 2, 2, 2, 4]);
    expect(col.data.byteLength).toBe(4);
    expect(utf8Value(col, 0)).toBe("ab");
    expect(utf8Value(col, 1)).toBeNull();
    expect(utf8Value(col, 2)).toBe("");
    expect(utf8Value(col, 3)).toBe("é");
    expect(isValid(col.validity, 1)).toBe(false);
    expect(isValid(col.validity, 2)).toBe(true);
  });

  it("has no validity bitmap when every row is set", () => {
    expect(buildUtf8Column(["a", "b"]).validity).toBeNull();
  });
});

describe("buildAttrColumn", () => {
  it("makes numbers a float64 column with a validity bitmap", () => {
    const col = buildAttrColumn([1.5, undefined, 3, null]);
    expect(col.kind).toBe("float64");
    if (col.kind !== "float64") return;
    expect(Array.from(col.values.subarray(0, 1))).toEqual([1.5]);
    expect(col.validity).not.toBeNull();
    // LSB-first, one bit per row: rows 0 and 2 set.
    expect(col.validity![0]).toBe(0b0101);
    expect([0, 1, 2, 3].map((r) => columnValue(col, r))).toEqual([
      1.5,
      null,
      3,
      null,
    ]);
  });

  it("dictionary-encodes strings, so a category is one index per row", () => {
    const col = buildAttrColumn(["roof", "wall", "roof", null]);
    expect(col.kind).toBe("dict");
    if (col.kind !== "dict") return;
    expect(dictionaryValues(col)).toEqual(["roof", "wall"]);
    expect(Array.from(col.indices)).toEqual([0, 1, 0, 0]);
    expect([0, 1, 2, 3].map((r) => columnValue(col, r))).toEqual([
      "roof",
      "wall",
      "roof",
      null,
    ]);
  });

  it("bit-packs booleans", () => {
    const col = buildAttrColumn([true, false, true]);
    expect(col.kind).toBe("bool");
    if (col.kind !== "bool") return;
    expect(col.values[0]).toBe(0b101);
    expect([0, 1, 2].map((r) => columnValue(col, r))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("keeps mixed and nested values as JSON text, decoded on read", () => {
    const col = buildAttrColumn([1, "a", { b: [2] }, null]);
    expect(col.kind).toBe("json");
    expect([0, 1, 2, 3].map((r) => columnValue(col, r))).toEqual([
      1,
      "a",
      { b: [2] },
      null,
    ]);
  });

  it("keeps an integer too large for a double exactly, as JSON", () => {
    const big = 2n ** 60n + 1n;
    const col = buildAttrColumn([big, 2n]);
    expect(col.kind).toBe("json");
    expect(columnValue(col, 0)).toBe(big.toString());
  });

  it("stores safe bigints as numbers", () => {
    const col = buildAttrColumn([2n, 3]);
    expect(col.kind).toBe("float64");
    expect(columnValue(col, 0)).toBe(2);
  });

  it("makes an all-null column JSON with nothing valid", () => {
    const col = buildAttrColumn([null, undefined]);
    expect(col.kind).toBe("json");
    expect(columnValue(col, 0)).toBeNull();
    expect(columnValue(col, 1)).toBeNull();
  });
});
