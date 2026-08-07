/**
 * Hand-written types for the vendored hyparquet copy — see VENDORED.md.
 *
 * Upstream ships its own `types/index.d.ts`, but that surface is far wider than
 * anything this package uses and drags in a `types.d.ts` we would then have to
 * vendor too. This declares exactly the three entry points we call, plus the
 * shapes we read off their results.
 */

export interface AsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer>;
}

export interface KeyValue {
  key?: string | null;
  value?: string | null;
}

export interface FileMetaData {
  num_rows: bigint;
  key_value_metadata?: KeyValue[];
}

export interface SchemaTree {
  children: SchemaTree[];
  element: { name: string };
}

export function parquetMetadataAsync(file: AsyncBuffer): Promise<FileMetaData>;

export function parquetSchema(metadata: FileMetaData): SchemaTree;

export function parquetReadObjects(options: {
  file: AsyncBuffer;
  metadata?: FileMetaData;
  columns?: string[];
  rowStart?: number;
  rowEnd?: number;
  utf8?: boolean;
  compressors?: Record<string, unknown>;
}): Promise<Record<string, unknown>[]>;
