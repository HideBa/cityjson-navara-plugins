/**
 * Cuts a static layer's build into grid cells, so a renderer can draw (and
 * frustum-cull, and raycast) a city one square at a time instead of as one
 * mesh.
 *
 * Nothing is rebuilt: the same vertices and triangles are reordered so that
 * each cell is one contiguous vertex range and one contiguous index range,
 * and a renderer draws a cell as a range of the layer's shared buffers.
 * Identity does not move — slot ids, the slot tables and the object keys are
 * the build's own — so the style texture, picking and hiding work unchanged.
 *
 * An object lies wholly in the cell of its centre, so an object never splits
 * across two draws. Engine-free.
 */
import type { CityMeshArrays, TextureGroup } from "./buildCityMeshArrays";
import { MAX_UINT16_VERTICES } from "./buildCityMeshArrays";

/** One cell: its ranges into the reordered arrays. Under a texture theme its
 *  draw groups are `textureGroups[groupStart, groupStart + groupCount)`;
 *  untextured, `groupCount` is 0 and the index range is drawn whole. */
export interface MeshCell {
  readonly vertexStart: number;
  readonly vertexCount: number;
  readonly indexStart: number;
  readonly indexCount: number;
  readonly groupStart: number;
  readonly groupCount: number;
}

export interface PartitionedArrays {
  readonly arrays: CityMeshArrays;
  readonly cells: readonly MeshCell[];
}

/**
 * @param arrays a build whose positions are in metres (after the ENU
 *   projection), so `cellSize` is a ground distance.
 * @param cellSize the side of a grid square, in metres.
 */
export function partitionCells(
  arrays: CityMeshArrays,
  cellSize: number,
): PartitionedArrays {
  const { positions, indices, slots, slotObjects, slotTextures } = arrays;
  const slotCount = slotObjects.length;
  const vertexCount = positions.length / 3;

  // Each slot's vertex and index ranges: a build writes a surface's vertices
  // and its triangles contiguously.
  const vStart = new Int32Array(slotCount).fill(-1);
  const vCount = new Int32Array(slotCount);
  for (let v = 0; v < vertexCount; v++) {
    const s = slots[v]!;
    if (vStart[s] === -1) vStart[s] = v;
    vCount[s]!++;
  }
  const iStart = new Int32Array(slotCount).fill(-1);
  const iCount = new Int32Array(slotCount);
  for (let i = 0; i < indices.length; i += 3) {
    const s = slots[indices[i]!]!;
    if (iStart[s] === -1) iStart[s] = i;
    iCount[s]! += 3;
  }

  // Each object's cell, from the centre of its vertices' footprint. The
  // grid starts at the layer's own south-west corner: positions are centred
  // on the layer, and a grid anchored at 0 would cut a small layer in four.
  const objectCount = arrays.objectKeys.length;
  const min = new Float64Array(objectCount * 2).fill(Infinity);
  const max = new Float64Array(objectCount * 2).fill(-Infinity);
  let originX = Infinity;
  let originY = Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const o = slotObjects[slots[v]!]! * 2;
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    if (x < min[o]!) min[o] = x;
    if (y < min[o + 1]!) min[o + 1] = y;
    if (x > max[o]!) max[o] = x;
    if (y > max[o + 1]!) max[o + 1] = y;
    if (x < originX) originX = x;
    if (y < originY) originY = y;
  }
  const cellKeys = new Map<string, number>();
  const cellOfObject = new Int32Array(objectCount);
  for (let o = 0; o < objectCount; o++) {
    if (min[o * 2] === Infinity) continue; // draws nothing
    const centreX = (min[o * 2]! + max[o * 2]!) / 2 - originX;
    const centreY = (min[o * 2 + 1]! + max[o * 2 + 1]!) / 2 - originY;
    const cx = Math.floor(centreX / cellSize);
    const cy = Math.floor(centreY / cellSize);
    const key = `${cx},${cy}`;
    let cell = cellKeys.get(key);
    if (cell === undefined) {
      cell = cellKeys.size;
      cellKeys.set(key, cell);
    }
    cellOfObject[o] = cell;
  }

  // Cell first, then image (so each cell's images are runs), then the
  // build's own order.
  const textured = arrays.textureGroups != null;
  const order = Array.from({ length: slotCount }, (_, s) => s).filter(
    (s) => vCount[s]! > 0,
  );
  order.sort(
    (a, b) =>
      cellOfObject[slotObjects[a]!]! - cellOfObject[slotObjects[b]!]! ||
      (textured ? slotTextures[a]! - slotTextures[b]! : 0) ||
      a - b,
  );

  const outPositions = new Float32Array(positions.length);
  const outNormals = new Float32Array(arrays.normals.length);
  const outUvs = arrays.uvs ? new Float32Array(arrays.uvs.length) : null;
  const outSlots = new Uint32Array(slots.length);
  const outIndices =
    vertexCount <= MAX_UINT16_VERTICES
      ? new Uint16Array(indices.length)
      : new Uint32Array(indices.length);
  const groups: TextureGroup[] | null = textured ? [] : null;
  const cells: MeshCell[] = [];

  let vertexAt = 0;
  let indexAt = 0;
  let current = -1;
  const closeCell = () => {
    const last = cells[cells.length - 1];
    if (!last) return;
    cells[cells.length - 1] = {
      ...last,
      vertexCount: vertexAt - last.vertexStart,
      indexCount: indexAt - last.indexStart,
      groupCount: (groups?.length ?? 0) - last.groupStart,
    };
  };
  for (const s of order) {
    const cell = cellOfObject[slotObjects[s]!]!;
    if (cell !== current) {
      closeCell();
      current = cell;
      cells.push({
        vertexStart: vertexAt,
        vertexCount: 0,
        indexStart: indexAt,
        indexCount: 0,
        groupStart: groups?.length ?? 0,
        groupCount: 0,
      });
    }
    const from = vStart[s]!;
    const n = vCount[s]!;
    outPositions.set(
      positions.subarray(from * 3, (from + n) * 3),
      vertexAt * 3,
    );
    outNormals.set(
      arrays.normals.subarray(from * 3, (from + n) * 3),
      vertexAt * 3,
    );
    if (outUvs && arrays.uvs) {
      outUvs.set(arrays.uvs.subarray(from * 2, (from + n) * 2), vertexAt * 2);
    }
    outSlots.fill(s, vertexAt, vertexAt + n);
    const shift = vertexAt - from;
    const i0 = iStart[s]!;
    const ni = iCount[s]!;
    for (let i = 0; i < ni; i++) {
      outIndices[indexAt + i] = indices[i0 + i]! + shift;
    }
    if (groups) {
      const last = groups[groups.length - 1];
      const own = cells[cells.length - 1]!;
      if (
        last &&
        groups.length > own.groupStart &&
        last.textureIndex === slotTextures[s]
      ) {
        groups[groups.length - 1] = { ...last, count: last.count + ni };
      } else {
        groups.push({
          start: indexAt,
          count: ni,
          textureIndex: slotTextures[s]!,
        });
      }
    }
    vertexAt += n;
    indexAt += ni;
  }
  closeCell();

  return {
    arrays: {
      ...arrays,
      positions: outPositions,
      normals: outNormals,
      indices: outIndices,
      slots: outSlots,
      uvs: outUvs,
      textureGroups: groups,
    },
    cells,
  };
}
