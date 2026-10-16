/**
 * The attributes a city object carries once its parents' are taken into
 * account.
 *
 * CityJSON puts an object's attributes where they are true, and a
 * `BuildingPart` rarely repeats its `Building`'s: in 3DBAG every `b3_*`
 * attribute sits on the Building while the roof surfaces sit on its part. A
 * rule written against a building attribute therefore has to see the
 * ancestors' attributes on the part's surfaces.
 *
 * The nearer object wins a name both carry; between several parents the
 * first listed wins. A parent the model does not hold contributes nothing,
 * and a parent cycle stops at the first object seen twice.
 */
import type { CityObject } from "./types";

type Attributes = Readonly<Record<string, unknown>>;

export function inheritedAttributes(
  object: CityObject,
  lookup: (objectId: string) => CityObject | undefined,
): Attributes {
  if (object.parents.length === 0) return object.attributes;
  // Nearest first, so a name is set by the first object that carries it.
  const merged: Record<string, unknown> = {};
  const seen = new Set<string>([object.id]);
  const queue: CityObject[] = [object];
  let inherited = false;
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    for (const [name, value] of Object.entries(current.attributes)) {
      if (!(name in merged)) {
        merged[name] = value;
        if (i > 0) inherited = true;
      }
    }
    for (const parentId of current.parents) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      const parent = lookup(parentId);
      if (parent) queue.push(parent);
    }
  }
  return inherited ? merged : object.attributes;
}
