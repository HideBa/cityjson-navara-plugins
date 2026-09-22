/**
 * Hand-written types for the vendored hyparquet copy — see VENDORED.md.
 *
 * Upstream ships its own `types/index.d.ts`, but that surface is far wider than
 * anything this package uses and drags in a `types.d.ts` we would then have to
 * vendor too. This declares exactly the entry points we call, plus the shapes
 * we read off their results.
 */

export interface AsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer>;
}

export interface KeyValue {
  key?: string | null;
  value?: string | null;
}

/** One column chunk of a row group, narrowed to what range planning reads. */
export interface ColumnChunk {
  meta_data?: { path_in_schema: string[]; statistics?: unknown };
  /** Where the chunk's OffsetIndex (page locations) lives, when written. */
  offset_index_offset?: bigint;
  offset_index_length?: number;
}

export interface RowGroup {
  num_rows: bigint | number;
  columns: ColumnChunk[];
}

export interface FileMetaData {
  num_rows: bigint;
  row_groups: RowGroup[];
  key_value_metadata?: KeyValue[];
}

export interface SchemaTree {
  children: SchemaTree[];
  element: { name: string };
}

export function parquetMetadataAsync(file: AsyncBuffer): Promise<FileMetaData>;

export function parquetSchema(metadata: FileMetaData): SchemaTree;

/**
 * Overrides for hyparquet's own logical-type parsers; anything omitted keeps
 * the library's default. Only the two we override are declared — the upstream
 * set is far wider (see `convert.js`'s `DEFAULT_PARSERS`).
 */
export interface ParquetParsers {
  geometryFromBytes?(bytes: Uint8Array | undefined): unknown;
  geographyFromBytes?(bytes: Uint8Array | undefined): unknown;
}

export function parquetReadObjects(options: {
  file: AsyncBuffer;
  metadata?: FileMetaData;
  columns?: string[];
  /** First row to read (inclusive, file-global). */
  rowStart?: number;
  /** Row to stop before (exclusive, file-global). */
  rowEnd?: number;
  /**
   * Read only the pages of each column chunk that cover `rowStart..rowEnd`,
   * via the chunk's OffsetIndex, when the range narrows a row group and the
   * file has one; a chunk without an offset index is read whole.
   */
  useOffsetIndex?: boolean;
  utf8?: boolean;
  parsers?: ParquetParsers;
  compressors?: Record<string, unknown>;
}): Promise<Record<string, unknown>[]>;

/**
 * Upstream's URL buffer. Declared for completeness only: this package uses its
 * own `asyncBufferFromHttp` (`rangeSource.ts`), because upstream answers a
 * `200` by downloading and retaining the whole file.
 */
export function asyncBufferFromUrl(options: {
  url: string;
  byteLength?: number;
  requestInit?: RequestInit;
  fetch?: typeof fetch;
}): Promise<AsyncBuffer>;
