/**
 * The names a CityParquet column carries, turned back into the source names
 * the rest of the plugin uses (spec "Column naming and reservation rules").
 *
 * **The `_` escape.** A source attribute whose *base* (the name with every
 * leading `_` removed) collides with a reserved column name is stored with one
 * more leading `_` (`ID` → `_ID`, `_ID` → `__ID`). A reader removes exactly
 * one. An attribute column whose own name collides is invalid input.
 *
 * Engine-free: no `@navaramap/*` imports.
 */

import { CityParquetError } from "./footer";

/** The fixed reserved column names (spec "Reserved columns"). */
const FIXED_RESERVED_COLUMNS: ReadonlySet<string> = new Set([
  "id",
  "feature_id",
  "object_type",
  "parents",
  "children",
  "children_roles",
  "address",
  "bbox",
  "implicit_geometry",
  "other",
]);

/** The per-LoD reserved prefixes, longest first so `geometry_properties_…` is
 *  never read as `geometry_…`. */
const LOD_PREFIXES = [
  "geometry_properties_",
  "geometry_",
  "material_",
  "texture_",
] as const;

/** A suffix the LoD grammar generates: `lod<major>_<minor>`, both canonical
 *  decimal (no leading zero) and within a byte. */
const CANONICAL_LOD_SUFFIX = /^lod(0|[1-9]\d{0,2})_(0|[1-9]\d{0,2})$/;

function isCanonicalLodSuffix(suffix: string): boolean {
  const match = CANONICAL_LOD_SUFFIX.exec(suffix);
  if (match === null) return false;
  return Number(match[1]) <= 255 && Number(match[2]) <= 255;
}

/**
 * Whether `name` collides with a reserved column name, compared under ASCII
 * case folding: one of the fixed names, or a per-LoD form the suffix grammar
 * generates (`Geometry_LoD2_2`). `geometry_lod3` (no minor) and `geometry`
 * itself do not collide.
 */
export function isReservedColumnName(name: string): boolean {
  const folded = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (FIXED_RESERVED_COLUMNS.has(folded)) return true;
  return LOD_PREFIXES.some(
    (prefix) =>
      folded.startsWith(prefix) &&
      isCanonicalLodSuffix(folded.slice(prefix.length)),
  );
}

/** The name with every leading `_` removed. */
function baseName(name: string): string {
  return name.replace(/^_+/, "");
}

/**
 * The source name an attribute column stands for, with the `_` escape
 * reversed. Throws a `CityParquetError` for an attribute column whose own name
 * collides with a reserved name, which no conforming writer produces.
 */
export function restoreAttributeName(column: string): string {
  if (!isReservedColumnName(baseName(column))) return column;
  if (!column.startsWith("_")) {
    throw new CityParquetError(
      `This CityParquet file declares an attribute column '${column}', which collides with a reserved column name; a conforming writer stores such an attribute as '_${column}'.`,
    );
  }
  return column.slice(1);
}
