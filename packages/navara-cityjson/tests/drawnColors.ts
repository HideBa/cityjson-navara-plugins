/**
 * What a static mesh draws, read per vertex — the shape the suites used to
 * read off the `color` attribute, now answered by the style texture
 * (`CityModelMesh.drawnColorAt`). Live: every read reflects the mesh now.
 */
import type { CityModelMesh } from "../src/cityModelMesh";

export function drawnColors(m: CityModelMesh) {
  return {
    getX: (v: number) => m.drawnColorAt(v)[0],
    getY: (v: number) => m.drawnColorAt(v)[1],
    getZ: (v: number) => m.drawnColorAt(v)[2],
  };
}
