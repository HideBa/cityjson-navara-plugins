/**
 * Which objects a city mesh hides: the layer's hidden first-level types and
 * the table's attribute filter, as one byte per object (1 = hidden). The mesh
 * keeps every object's geometry and writes this into its style texture's
 * hidden flag, so neither toggle rebuilds anything.
 *
 * Engine-free.
 */

/**
 * @param objectKeys the build's object ids, by object index.
 * @param objectTypes the build's FIRST-LEVEL types, paired with `objectKeys`,
 *   so hiding "Building" hides its BuildingParts.
 * @param hiddenTypes first-level types to hide.
 * @param visibleIds the attribute filter: `null` is no filter, an EMPTY set
 *   matched nothing and hides everything. A raw id test: the caller expands a
 *   match to its whole feature.
 */
export function hiddenObjectMask(
  objectKeys: readonly string[],
  objectTypes: readonly string[],
  hiddenTypes: ReadonlySet<string>,
  visibleIds: ReadonlySet<string> | null,
): Uint8Array {
  const mask = new Uint8Array(objectKeys.length);
  for (let i = 0; i < objectKeys.length; i++) {
    const hidden =
      hiddenTypes.has(objectTypes[i]!) ||
      (visibleIds !== null && !visibleIds.has(objectKeys[i]!));
    if (hidden) mask[i] = 1;
  }
  return mask;
}

/** Triangles whose object `hidden` does not mark: what a mesh draws. */
export function drawnTriangleCount(
  slots: Uint32Array,
  slotObjects: Uint32Array,
  hidden: Uint8Array,
): number {
  let drawn = 0;
  for (let v = 0; v < slots.length; v += 3) {
    if (hidden[slotObjects[slots[v]!]!] !== 1) drawn++;
  }
  return drawn;
}
