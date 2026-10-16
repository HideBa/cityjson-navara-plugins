/**
 * Attribute columns in Arrow's memory layout, without the Arrow library.
 *
 * Every column is plain typed arrays: fixed-width values, `Int32` offsets into
 * one UTF-8 byte buffer for strings, `Int32` indices into a dictionary for
 * categories, and an LSB-first validity bitmap (bit set = valid; `null` = every
 * row valid), exactly as Arrow lays them out. That buys three things: the
 * columns cross `postMessage` with a transfer list, their `byteLength` is
 * exact, and wrapping them as Arrow `Data` at the DuckDB boundary needs no
 * conversion. Engine-free and DOM-free, so it runs in a worker and under Node.
 */

/** LSB-first validity bitmap: bit `r` set means row `r` holds a value. */
export type Validity = Uint8Array | null;

export interface Utf8Column {
  readonly kind: "utf8";
  readonly length: number;
  /** `length + 1` offsets into {@link data}; row `r` is
   *  `data[offsets[r] .. offsets[r + 1])`. */
  readonly offsets: Int32Array;
  readonly data: Uint8Array;
  readonly validity: Validity;
}

export interface Float64Column {
  readonly kind: "float64";
  readonly length: number;
  readonly values: Float64Array;
  readonly validity: Validity;
}

export interface BoolColumn {
  readonly kind: "bool";
  readonly length: number;
  /** Bit-packed, LSB first, like the validity bitmap. */
  readonly values: Uint8Array;
  readonly validity: Validity;
}

/** A category column: one dictionary index per row. A null row's index is 0
 *  and its validity bit is clear. */
export interface DictColumn {
  readonly kind: "dict";
  readonly length: number;
  readonly indices: Int32Array;
  readonly dictionary: Utf8Column;
  readonly validity: Validity;
}

/** Values no fixed-width type holds (mixed types, arrays, objects, integers
 *  beyond 2^53), as one JSON text per row, parsed on read. */
export interface JsonColumn {
  readonly kind: "json";
  readonly length: number;
  readonly text: Utf8Column;
  readonly validity: Validity;
}

export type AttrColumn =
  | Float64Column
  | BoolColumn
  | Utf8Column
  | DictColumn
  | JsonColumn;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isValid(validity: Validity, row: number): boolean {
  return validity === null || (validity[row >> 3]! & (1 << (row & 7))) !== 0;
}

function setBit(bits: Uint8Array, row: number): void {
  bits[row >> 3]! |= 1 << (row & 7);
}

function bitmapBytes(length: number): number {
  return (length + 7) >> 3;
}

/** A validity bitmap for `present`, or `null` when every row is present. */
function validityOf(
  length: number,
  present: (row: number) => boolean,
): Validity {
  let all = true;
  for (let r = 0; r < length && all; r++) all = present(r);
  if (all) return null;
  const bits = new Uint8Array(bitmapBytes(length));
  for (let r = 0; r < length; r++) if (present(r)) setBit(bits, r);
  return bits;
}

export function buildUtf8Column(
  values: ReadonlyArray<string | null>,
): Utf8Column {
  const length = values.length;
  const encoded: (Uint8Array | null)[] = Array.from({ length });
  let total = 0;
  for (let r = 0; r < length; r++) {
    const v = values[r];
    if (v === null || v === undefined) {
      encoded[r] = null;
      continue;
    }
    const bytes = encoder.encode(v);
    encoded[r] = bytes;
    total += bytes.byteLength;
  }
  const offsets = new Int32Array(length + 1);
  const data = new Uint8Array(total);
  let at = 0;
  for (let r = 0; r < length; r++) {
    const bytes = encoded[r];
    if (bytes) {
      data.set(bytes, at);
      at += bytes.byteLength;
    }
    offsets[r + 1] = at;
  }
  return {
    kind: "utf8",
    length,
    offsets,
    data,
    validity: validityOf(length, (r) => encoded[r] !== null),
  };
}

export function utf8Value(col: Utf8Column, row: number): string | null {
  if (!isValid(col.validity, row)) return null;
  return decoder.decode(
    col.data.subarray(col.offsets[row]!, col.offsets[row + 1]!),
  );
}

/** Every string of a UTF-8 column, decoded once and cached per column. */
const decodedStrings = new WeakMap<Utf8Column, ReadonlyArray<string | null>>();

export function utf8Values(col: Utf8Column): ReadonlyArray<string | null> {
  let values = decodedStrings.get(col);
  if (!values) {
    values = Array.from({ length: col.length }, (_, r) => utf8Value(col, r));
    decodedStrings.set(col, values);
  }
  return values;
}

/** The dictionary's strings, decoded once. */
export function dictionaryValues(col: DictColumn): ReadonlyArray<string> {
  return utf8Values(col.dictionary) as ReadonlyArray<string>;
}

export function buildDictColumn(
  values: ReadonlyArray<string | null>,
): DictColumn {
  const length = values.length;
  const indexOf = new Map<string, number>();
  const dictionary: string[] = [];
  const indices = new Int32Array(length);
  for (let r = 0; r < length; r++) {
    const v = values[r];
    if (v === null || v === undefined) continue;
    let index = indexOf.get(v);
    if (index === undefined) {
      index = dictionary.length;
      dictionary.push(v);
      indexOf.set(v, index);
    }
    indices[r] = index;
  }
  return {
    kind: "dict",
    length,
    indices,
    dictionary: buildUtf8Column(dictionary),
    validity: validityOf(
      length,
      (r) => values[r] !== null && values[r] !== undefined,
    ),
  };
}

export function dictValue(col: DictColumn, row: number): string | null {
  if (!isValid(col.validity, row)) return null;
  return dictionaryValues(col)[col.indices[row]!] ?? null;
}

function isNullish(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

function isSafeBigInt(v: bigint): boolean {
  return (
    v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
  );
}

/**
 * One attribute's values across every row, as the narrowest column that
 * holds them exactly: all numbers (and safe bigints) → `float64`, all
 * strings → `dict`, all booleans → `bool`, anything else → `json`. Absent
 * (`undefined`) and `null` are both a cleared validity bit.
 */
export function buildAttrColumn(values: ReadonlyArray<unknown>): AttrColumn {
  const length = values.length;
  let kind: "float64" | "dict" | "bool" | "json" | null = null;
  for (const v of values) {
    if (isNullish(v)) continue;
    const k =
      typeof v === "number" || (typeof v === "bigint" && isSafeBigInt(v))
        ? "float64"
        : typeof v === "string"
          ? "dict"
          : typeof v === "boolean"
            ? "bool"
            : "json";
    if (kind === null) kind = k;
    else if (kind !== k) {
      kind = "json";
      break;
    }
  }
  const validity = validityOf(length, (r) => !isNullish(values[r]));
  if (kind === "float64") {
    const out = new Float64Array(length);
    for (let r = 0; r < length; r++) {
      const v = values[r];
      if (!isNullish(v)) out[r] = Number(v);
    }
    return { kind, length, values: out, validity };
  }
  if (kind === "dict") {
    return buildDictColumn(values as ReadonlyArray<string | null>);
  }
  if (kind === "bool") {
    const bits = new Uint8Array(bitmapBytes(length));
    for (let r = 0; r < length; r++) if (values[r] === true) setBit(bits, r);
    return { kind, length, values: bits, validity };
  }
  const text = buildUtf8Column(
    values.map((v) =>
      isNullish(v)
        ? null
        : typeof v === "bigint"
          ? JSON.stringify(v.toString())
          : JSON.stringify(v),
    ),
  );
  return { kind: "json", length, text, validity };
}

/** Row `row` of `col` as a plain JS value; `null` when the row is not set. */
export function columnValue(col: AttrColumn, row: number): unknown {
  if (!isValid(col.validity, row)) return null;
  switch (col.kind) {
    case "float64":
      return col.values[row]!;
    case "bool":
      return (col.values[row >> 3]! & (1 << (row & 7))) !== 0;
    case "utf8":
      return utf8Value(col, row);
    case "dict":
      return dictValue(col, row);
    case "json": {
      const text = utf8Value(col.text, row);
      return text === null ? null : (JSON.parse(text) as unknown);
    }
  }
}

/** Every buffer a column owns, for byte counts and transfer lists. */
export function columnBuffers(col: AttrColumn): ArrayBufferView[] {
  const own: ArrayBufferView[] = col.validity ? [col.validity] : [];
  switch (col.kind) {
    case "float64":
    case "bool":
      return [...own, col.values];
    case "utf8":
      return [...own, col.offsets, col.data];
    case "dict":
      return [...own, col.indices, ...columnBuffers(col.dictionary)];
    case "json":
      return [...own, ...columnBuffers(col.text)];
  }
}
