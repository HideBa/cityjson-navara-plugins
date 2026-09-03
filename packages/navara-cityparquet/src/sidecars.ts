/**
 * The format's appearance sidecars — `materials.parquet` and
 * `textures.parquet` — read into the domain's tables, plus the per-package
 * appearance context every object table decodes against.
 *
 * An object table references appearance by the sidecar's `id` column
 * (dataset-global, not a row position), so a package registers its sidecars
 * ONCE into core's `AppearanceMerger` and keeps an id -> local-index map; a
 * face's `[textureId, [u, v], …]` then resolves through that map and the
 * merger's remap. UV pairs are inline in the object table (the format has no
 * UV pool), and a sidecar without a package (a lone table beside them) is a
 * caller's problem: the loader hands whatever it found.
 */
import {
  AppearanceMerger,
  type AppearanceContext,
  type CityAppearance,
  type CityMaterial,
  type CityTexture,
  type TextureWrapMode,
} from "@cityjson/navara-core";
import { compressors } from "hyparquet-compressors";
import { CityParquetError } from "./footer";
import {
  parquetMetadataAsync,
  parquetReadObjects,
} from "./vendor/hyparquet/index.js";
import type { AsyncBuffer } from "./vendor/hyparquet/index.js";

export interface CityParquetSidecars {
  readonly textures?: Uint8Array;
  readonly materials?: Uint8Array;
}

/** What a package's object tables decode their appearance columns against. */
export interface PackageAppearance {
  readonly ctx: AppearanceContext;
  /** Sidecar `id` -> local index in the registered texture table. */
  readonly textureLocalById: ReadonlyMap<number, number>;
  readonly materialLocalById: ReadonlyMap<number, number>;
  readonly merger: AppearanceMerger;
}

function asyncBufferOf(bytes: Uint8Array): AsyncBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return {
    byteLength: buf.byteLength,
    slice: (start: number, end?: number) => buf.slice(start, end),
  };
}

/**
 * A sidecar that cannot be read costs the package its appearance, never its
 * geometry: appearance is tolerant by rule (see the CityJSON reader), so the
 * failure is one warning and an empty table.
 */
async function readRows(
  bytes: Uint8Array,
  what: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const file = asyncBufferOf(bytes);
    const metadata = await parquetMetadataAsync(file);
    return (await parquetReadObjects({
      file,
      metadata,
      compressors,
    })) as Array<Record<string, unknown>>;
  } catch (cause) {
    console.warn(
      new CityParquetError(
        `This CityParquet package's ${what} could not be read as Parquet; its appearance is skipped.`,
        { cause },
      ).message,
    );
    return [];
  }
}

function idOf(value: unknown): number | null {
  const n = typeof value === "bigint" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

function numbers(value: unknown, count: number): number[] | null {
  if (!Array.isArray(value) || value.length < count) return null;
  const out = value.slice(0, count).map((v) => Number(v));
  return out.every((v) => Number.isFinite(v)) ? out : null;
}

const WRAP_MODES: ReadonlySet<string> = new Set([
  "none",
  "wrap",
  "mirror",
  "clamp",
  "border",
]);

function textureFromRow(row: Record<string, unknown>): CityTexture | null {
  const image = row.image_uri;
  if (typeof image !== "string" || image === "") return null;
  const type = row.image_type === "PNG" ? "PNG" : "JPG";
  const wrap = row.wrapMode;
  const border = numbers(row.borderColor, 4);
  return {
    image,
    type,
    ...(typeof wrap === "string" && WRAP_MODES.has(wrap)
      ? { wrapMode: wrap as TextureWrapMode }
      : {}),
    ...(border
      ? { borderColor: [border[0]!, border[1]!, border[2]!, border[3]!] as const }
      : {}),
  };
}

function materialFromRow(
  row: Record<string, unknown>,
  index: number,
): CityMaterial {
  const diffuse = numbers(row.diffuseColor, 3);
  const emissive = numbers(row.emissiveColor, 3);
  const specular = numbers(row.specularColor, 3);
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return {
    name: typeof row.name === "string" ? row.name : `material-${index}`,
    ...(diffuse ? { diffuseColor: [diffuse[0]!, diffuse[1]!, diffuse[2]!] as const } : {}),
    ...(emissive ? { emissiveColor: [emissive[0]!, emissive[1]!, emissive[2]!] as const } : {}),
    ...(specular ? { specularColor: [specular[0]!, specular[1]!, specular[2]!] as const } : {}),
    ...(num(row.ambientIntensity) !== undefined
      ? { ambientIntensity: num(row.ambientIntensity) }
      : {}),
    ...(num(row.shininess) !== undefined ? { shininess: num(row.shininess) } : {}),
    ...(num(row.transparency) !== undefined
      ? { transparency: num(row.transparency) }
      : {}),
    ...(typeof row.isSmooth === "boolean" ? { isSmooth: row.isSmooth } : {}),
  };
}

/**
 * Read the sidecars a package shipped and register them for its tables.
 * Returns `null` when neither sidecar is present — the tables then decode
 * without appearance, exactly as before.
 */
export async function readPackageAppearance(
  sidecars: CityParquetSidecars | undefined,
  defaults?: { textureTheme: string | null; materialTheme: string | null },
): Promise<PackageAppearance | null> {
  if (!sidecars?.textures && !sidecars?.materials) return null;
  const textures: CityTexture[] = [];
  const textureLocalById = new Map<number, number>();
  if (sidecars.textures) {
    for (const row of await readRows(sidecars.textures, "textures.parquet")) {
      const id = idOf(row.id);
      const texture = textureFromRow(row);
      if (id === null || texture === null) continue;
      textureLocalById.set(id, textures.length);
      textures.push(texture);
    }
  }
  const materials: CityMaterial[] = [];
  const materialLocalById = new Map<number, number>();
  if (sidecars.materials) {
    for (const row of await readRows(
      sidecars.materials,
      "materials.parquet",
    )) {
      const id = idOf(row.id);
      if (id === null) continue;
      materialLocalById.set(id, materials.length);
      materials.push(materialFromRow(row, materials.length));
    }
  }
  const merger = new AppearanceMerger();
  const ctx = merger.register({
    textures,
    materials,
    ...(defaults?.textureTheme
      ? { "default-theme-texture": defaults.textureTheme }
      : {}),
    ...(defaults?.materialTheme
      ? { "default-theme-material": defaults.materialTheme }
      : {}),
  });
  return { ctx, textureLocalById, materialLocalById, merger };
}

export function buildPackageAppearance(
  appearance: PackageAppearance | null,
): CityAppearance | undefined {
  return appearance?.merger.build();
}
