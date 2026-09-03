/**
 * Merge the appearance tables of several already-parsed models into one,
 * rewriting every surface's material/texture indices to the merged table.
 *
 * For the loaders that build a model from several independently parsed
 * units — a ZIP of CityGML files, a CityParquet package of several object
 * tables — each unit parsed its own appearance with its own indices. This
 * folds them through `AppearanceMerger` (so a shared image deduplicates) and
 * returns objects whose surfaces index the merged table. Units without
 * appearance pass through untouched; the result has no `appearance` when no
 * unit had one.
 */
import { AppearanceMerger } from "./cityjson/appearance";
import type {
  CityAppearance,
  CityObject,
  Surface,
  SurfaceTexture,
} from "./types";

export interface AppearanceUnit {
  readonly objects: Readonly<Record<string, CityObject>>;
  readonly appearance?: CityAppearance;
}

export interface MergedAppearance {
  /** One object map per input unit, in order, with rewritten indices. */
  readonly units: ReadonlyArray<Readonly<Record<string, CityObject>>>;
  readonly appearance: CityAppearance | undefined;
}

function remapSurface(
  surface: Surface,
  textureRemap: ReadonlyArray<number>,
  materialRemap: ReadonlyArray<number>,
): Surface {
  if (!surface.texture && !surface.material) return surface;
  let texture: Record<string, SurfaceTexture> | undefined;
  for (const [theme, entry] of Object.entries(surface.texture ?? {})) {
    const index = textureRemap[entry.textureIndex];
    if (index === undefined || index < 0) continue;
    (texture ??= {})[theme] = { ...entry, textureIndex: index };
  }
  let material: Record<string, number> | undefined;
  for (const [theme, local] of Object.entries(surface.material ?? {})) {
    const index = materialRemap[local];
    if (index === undefined || index < 0) continue;
    (material ??= {})[theme] = index;
  }
  const out: {
    -readonly [K in keyof Surface]: Surface[K];
  } = { ...surface };
  delete out.texture;
  delete out.material;
  if (texture) out.texture = texture;
  if (material) out.material = material;
  return out;
}

export function mergeModelAppearances(
  units: ReadonlyArray<AppearanceUnit>,
): MergedAppearance {
  if (!units.some((u) => u.appearance)) {
    return { units: units.map((u) => u.objects), appearance: undefined };
  }
  const merger = new AppearanceMerger();
  const out: Array<Readonly<Record<string, CityObject>>> = [];
  for (const unit of units) {
    const appearance = unit.appearance;
    if (!appearance) {
      out.push(unit.objects);
      continue;
    }
    const ctx = merger.register({
      textures: appearance.textures,
      materials: appearance.materials,
      "default-theme-texture": appearance.defaultTextureTheme ?? undefined,
      "default-theme-material": appearance.defaultMaterialTheme ?? undefined,
    });
    for (const theme of appearance.textureThemes) ctx.textureThemes.add(theme);
    for (const theme of appearance.materialThemes) {
      ctx.materialThemes.add(theme);
    }
    const objects: Record<string, CityObject> = {};
    for (const [id, object] of Object.entries(unit.objects)) {
      objects[id] = {
        ...object,
        surfaces: object.surfaces.map((s) =>
          remapSurface(s, ctx.textureRemap, ctx.materialRemap),
        ),
      };
    }
    out.push(objects);
  }
  return { units: out, appearance: merger.build() };
}
