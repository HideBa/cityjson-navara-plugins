/**
 * Implicit geometry, placed. A template's surfaces are copied to each object
 * that instances it, in world coordinates, and become part of that object's
 * `surfaces`: every reader of surfaces (drawing, picking, styling, statistics,
 * LoD selection) then sees a tree like any other object, at the cost of one
 * copy of the template's vertices per instance.
 */
import type {
  BBox3,
  CityModel,
  CityObject,
  ImplicitGeometryRef,
  ImplicitTemplate,
  Surface,
  Vec3,
} from "./types";

/** `M · (v, 1) + (p, 0)` for row-major `M`. */
function place(v: Vec3, m: ReadonlyArray<number>, p: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2] + m[3]! + p[0],
    m[4]! * v[0] + m[5]! * v[1] + m[6]! * v[2] + m[7]! + p[1],
    m[8]! * v[0] + m[9]! * v[1] + m[10]! * v[2] + m[11]! + p[2],
  ];
}

/** The template's surfaces at `ref`: rings placed, everything else as the
 *  template has it (type, attributes, LoD, appearance, UVs). */
export function placeImplicitSurfaces(
  template: ImplicitTemplate,
  ref: ImplicitGeometryRef,
): Surface[] {
  const m = ref.transformationMatrix;
  const p = ref.referencePoint;
  return template.surfaces.map((surface) => ({
    ...surface,
    rings: surface.rings.map((ring) => ring.map((v) => place(v, m, p))),
  }));
}

/** The highest of two LoD labels, by number, as `parseCityObject` ranks them. */
export function higherLod(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return parseFloat(b) > parseFloat(a) ? b : a;
}

/** The bbox of `surfaces`, merged into `bbox`. */
export function surfacesBBox(
  bbox: BBox3 | null,
  surfaces: ReadonlyArray<Surface>,
): BBox3 | null {
  let b: number[] | null = bbox ? [...bbox] : null;
  for (const surface of surfaces) {
    for (const ring of surface.rings) {
      for (const v of ring) {
        if (!b) b = [v[0], v[1], v[2], v[0], v[1], v[2]];
        for (let k = 0; k < 3; k++) {
          if (v[k]! < b[k]!) b[k] = v[k]!;
          if (v[k]! > b[k + 3]!) b[k + 3] = v[k]!;
        }
      }
    }
  }
  return b as BBox3 | null;
}

/**
 * A model whose objects reference templates (`implicitGeometry`, as a
 * CityParquet package stores them), with each object's placed template
 * appended to its surfaces and its bbox, LoD and the model's bbox grown to
 * match. An object whose template is missing is left as it is.
 */
export function withImplicitSurfaces(model: CityModel): CityModel {
  const templates = model.implicitTemplates;
  if (!templates || templates.size === 0) return model;
  let bbox = model.bbox;
  let changed = false;
  const objects: Record<string, CityObject> = Object.create(null) as Record<
    string,
    CityObject
  >;
  for (const [id, object] of Object.entries(model.objects)) {
    const ref = object.implicitGeometry;
    const template = ref ? templates.get(ref.templateId) : undefined;
    if (!ref || !template) {
      objects[id] = object;
      continue;
    }
    const placed = placeImplicitSurfaces(template, ref);
    const objectBBox = surfacesBBox(object.bbox, placed);
    objects[id] = {
      ...object,
      surfaces: [...object.surfaces, ...placed],
      bbox: objectBBox,
      lod: higherLod(object.lod, template.lod),
    };
    if (objectBBox) {
      bbox = bbox
        ? (bbox.map((c, k) =>
            k < 3 ? Math.min(c, objectBBox[k]!) : Math.max(c, objectBBox[k]!),
          ) as unknown as BBox3)
        : objectBBox;
    }
    changed = true;
  }
  return changed ? { ...model, objects, bbox } : model;
}
