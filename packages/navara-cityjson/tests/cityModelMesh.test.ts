import { describe, it, expect } from "vitest";
import { DoubleSide, LineSegments, Matrix4, Vector3 } from "three";
import type { CityModel } from "@cityjson/navara-core";
import { CityModelMesh } from "../src/cityModelMesh";
import type { ThemeStyle } from "../src/themeStyle";
import { DEFAULT_PICK_STRATEGY } from "../src/pickStrategy";
import { NonMetricCrsError } from "../src/enuPlacement";

function quad(z: number, lod: string) {
  return {
    type: "RoofSurface" as const,
    rings: [
      [
        [85000, 446000, z],
        [85010, 446000, z],
        [85010, 446010, z],
        [85000, 446010, z],
      ],
    ] as const,
    attributes: {},
    lod,
  };
}

/** {@link quad}, translated 20 m east so the two share no edge. */
function farQuad(z: number, lod: string) {
  return {
    type: "RoofSurface" as const,
    rings: [
      [
        [85020, 446000, z],
        [85030, 446000, z],
        [85030, 446010, z],
        [85020, 446010, z],
      ],
    ] as const,
    attributes: {},
    lod,
  };
}

const model: CityModel = {
  sourceEncoding: "cityjson",
  metadata: { referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/7415" },
  bbox: [85000, 446000, 0, 85010, 446010, 6],
  objects: {
    B1: {
      id: "B1",
      objectType: "Building",
      attributes: { fn: "house" },
      surfaces: [quad(6, "2"), quad(3, "1")],
      bbox: [85000, 446000, 0, 85010, 446010, 6],
      children: [],
      parents: [],
      lod: "2",
    },
  },
  vertexCount: 8,
};

const opts = {
  id: "L1",
  model,
  crs: "https://www.opengis.net/def/crs/EPSG/0/7415",
  makePlacementMatrix: () => new Matrix4().makeTranslation(1, 2, 3),
};

describe("CityModelMesh", () => {
  // The STATIC counterpart of the same rule on `CityMeshArraysMesh`: real
  // CityJSON winding is inconsistent, and `orientExteriorRing` mis-orients
  // concave shapes (a face in an L-shaped building's notch legitimately points
  // at the object's own centroid), so front-face culling deletes real walls.
  // Both mesh classes must agree, or the same building renders differently
  // depending on whether it arrived as a file or as a stream.
  it("renders double-sided, so a mis-wound face is not culled away", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    expect((m.object3d.material as { side: number }).side).toBe(DoubleSide);
    m.dispose();
  });

  it("builds a mesh placed by the injected ENU matrix", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    expect(m.object3d.matrixAutoUpdate).toBe(false);
    expect(m.object3d.matrix.elements[12]).toBe(1);
    expect(m.triangleCount()).toBe(2); // one quad -> 2 triangles at LoD 2
    m.dispose();
  });

  it("setLod rebuilds geometry with only that LoD's surfaces", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    const before = m.object3d.geometry;
    m.setLod("1");
    expect(m.object3d.geometry).not.toBe(before);
    expect(m.triangleCount()).toBe(2);
    // ...and it is the OTHER surface: LoD 1 is surface index 1.
    expect(m.resolveVertex(0)).toEqual({
      kind: "surface",
      layerId: "L1",
      objectId: "B1",
      surfaceIndex: 1,
    });
    m.dispose();
  });

  it("setStyle recolors matching surfaces and setStyle(null) restores base", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    const colors = m.object3d.geometry.getAttribute("color");
    const before = colors.getX(0);
    m.setStyle(() => [0, 1, 0]);
    expect(colors.getX(0)).not.toBe(before);
    expect(colors.getY(0)).toBeGreaterThan(0.9);
    m.setStyle(null);
    expect(colors.getX(0)).toBe(before);
    m.dispose();
  });

  it("setHighlight layers over the style colors, not the base colors", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    const colors = m.object3d.geometry.getAttribute("color");
    m.setStyle(() => [0, 1, 0]);
    m.setHighlight([{ kind: "object", layerId: "L1", objectId: "B1" }], null);
    expect(colors.getX(0)).toBeGreaterThan(0.5); // highlight orange has red
    m.setHighlight([], null);
    expect(colors.getY(0)).toBeGreaterThan(0.9); // back to the style green
    m.dispose();
  });

  // Task B5 carry-forward: `paintLayers` cannot check `Selection.layerId`
  // (vertices carry no layer id), so filtering to this mesh's own layer is the
  // caller's job — and CityModelMesh IS that caller.
  it("ignores selections and hovers belonging to another layer", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    const colors = m.object3d.geometry.getAttribute("color");
    const base = colors.getX(0);
    m.setHighlight(
      [{ kind: "object", layerId: "OTHER", objectId: "B1" }],
      { kind: "object", layerId: "OTHER", objectId: "B1" },
    );
    expect(colors.getX(0)).toBe(base);

    // The same object id under THIS layer does paint, proving the filter is
    // on layerId and not on the object being unknown.
    m.setHighlight([{ kind: "object", layerId: "L1", objectId: "B1" }], null);
    expect(colors.getX(0)).not.toBe(base);
    m.dispose();
  });

  it("keeps style and highlight across a geometry rebuild", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    m.setStyle(() => [0, 1, 0]);
    m.setHighlight([
      { kind: "surface", layerId: "L1", objectId: "B1", surfaceIndex: 1 },
    ]);
    // Surface 1 is the LoD-1 quad: invisible at LoD 2, highlighted at LoD 1.
    expect(m.object3d.geometry.getAttribute("color").getY(0)).toBeGreaterThan(
      0.9,
    );
    m.setLod("1");
    const after = m.object3d.geometry.getAttribute("color");
    expect(after.getX(0)).toBeGreaterThan(0.5); // highlight orange survived
    m.setHighlight([]);
    expect(after.getY(0)).toBeGreaterThan(0.9); // ...over the surviving style
    m.dispose();
  });

  it("resolveVertex maps a vertex index to a surface selection", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    expect(m.resolveVertex(0)).toEqual({
      kind: "surface",
      layerId: "L1",
      objectId: "B1",
      surfaceIndex: 0,
    });
    expect(m.resolveVertex(9999)).toBeNull();
    m.dispose();
  });

  it("reports geodetic bounds around Delft", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    const b = m.getBoundsGeodetic();
    expect(b.west).toBeGreaterThan(4.3);
    expect(b.east).toBeLessThan(4.4);
    expect(b.south).toBeGreaterThan(51.9);
    expect(b.maxHeight).toBe(6);
    m.dispose();
  });

  it("reports bounds at the height the mesh is actually placed at", () => {
    const m = new CityModelMesh({ ...opts, lod: "2", heightOffset: 43 });
    const b = m.getBoundsGeodetic();
    expect(b.minHeight).toBe(43);
    expect(b.maxHeight).toBe(49);
    m.dispose();
  });

  it("throws CrsUnresolvedError when the model has no usable CRS", () => {
    expect(
      () =>
        new CityModelMesh({
          ...opts,
          crs: undefined,
          model: { ...model, metadata: {} },
        }),
    ).toThrow(/Cannot georeference/);
  });

  // Carry-forward from Task B4's review: the app refuses non-metric CRS at
  // FlatCityBuf admission (`checkAdmission`), and the static load path must
  // not be the hole in that policy.
  it("refuses a registered but non-metre CRS (z would be scaled wrong)", () => {
    expect(
      () =>
        new CityModelMesh({
          ...opts,
          crs: 4326, // built into proj4, units: degrees
        }),
    ).toThrow(NonMetricCrsError);
  });

  it("dispose releases the geometry and the material", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    let disposedGeometry = 0;
    let disposedMaterial = 0;
    m.object3d.geometry.addEventListener("dispose", () => {
      disposedGeometry++;
    });
    const material = m.object3d.material;
    if (!Array.isArray(material)) {
      material.addEventListener("dispose", () => {
        disposedMaterial++;
      });
    }
    m.dispose();
    expect(disposedGeometry).toBe(1);
    expect(disposedMaterial).toBe(1);
  });
});

/**
 * Hiding is a GEOMETRY rebuild, not a style: a style evaluator paints RGB into
 * an opaque material, so a "hidden" object would still occlude and still pick.
 * Grouping is by first-level type, so the BuildingPart below disappears with
 * its parent even though nothing is typed "Building".
 */
describe("CityModelMesh hidden types", () => {
  const partModel: CityModel = {
    ...model,
    objects: {
      ...model.objects,
      B1P: {
        id: "B1P",
        objectType: "BuildingPart",
        attributes: {},
        surfaces: [quad(5, "2")],
        bbox: [85000, 446000, 0, 85010, 446010, 6],
        children: [],
        parents: ["B1"],
        lod: "2",
      },
      T1: {
        id: "T1",
        objectType: "SolitaryVegetationObject",
        attributes: {},
        surfaces: [quad(4, "2")],
        bbox: [85000, 446000, 0, 85010, 446010, 6],
        children: [],
        parents: [],
        lod: "2",
      },
    },
  };
  const partOpts = { ...opts, model: partModel, lod: "2" };

  it("setHiddenTypes rebuilds without the hidden group's triangles", () => {
    const m = new CityModelMesh(partOpts);
    expect(m.triangleCount()).toBe(6); // three quads at LoD 2
    const before = m.object3d.geometry;

    m.setHiddenTypes(["Building"]);
    expect(m.object3d.geometry).not.toBe(before);
    // Both the Building and its BuildingPart are gone; the tree remains.
    expect(m.triangleCount()).toBe(2);

    m.setHiddenTypes([]);
    expect(m.triangleCount()).toBe(6);
    m.dispose();
  });

  it("builds filtered from the constructor option", () => {
    const m = new CityModelMesh({ ...partOpts, hiddenTypes: ["Building"] });
    expect(m.triangleCount()).toBe(2);
    m.dispose();
  });

  it("drops a no-op setHiddenTypes instead of rebuilding the geometry", () => {
    const m = new CityModelMesh({ ...partOpts, hiddenTypes: ["Building"] });
    const geometry = m.object3d.geometry;
    m.setHiddenTypes(["Building"]);
    expect(m.object3d.geometry).toBe(geometry);
    m.setHiddenTypes([]);
    expect(m.object3d.geometry).not.toBe(geometry);
    m.dispose();
  });

  it("keeps style and highlight across the rebuild", () => {
    const m = new CityModelMesh(partOpts);
    m.setStyle((_surface, object) =>
      object.objectId === "T1" ? [0, 1, 0] : null,
    );
    m.setHiddenTypes(["Building"]);
    // Only the tree survives, so vertex 0 is its — and it is still styled.
    const colors = m.object3d.geometry.getAttribute("color");
    expect(colors.getY(0)).toBeGreaterThan(0.9);
    expect(m.resolveVertex(0)?.objectId).toBe("T1");
    m.dispose();
  });
});

describe("pick strategy capability", () => {
  it("exposes the configured strategy and defaults to the spike's verdict", () => {
    const wrapper = new CityModelMesh({
      ...opts,
      lod: "2",
      pickStrategy: "pickable-wrapper",
    });
    const raycast = new CityModelMesh({
      ...opts,
      lod: "2",
      pickStrategy: "own-raycast",
    });
    expect(wrapper.pickStrategy).toBe("pickable-wrapper");
    expect(raycast.pickStrategy).toBe("own-raycast");
    expect(new CityModelMesh({ ...opts, lod: "2" }).pickStrategy).toBe(
      DEFAULT_PICK_STRATEGY,
    );
    wrapper.dispose();
    raycast.dispose();
  });

  // `heightOffset` is added to BOTH the vertex's geodetic height and the
  // frame's origin height (`ellipsoidal = orthometric + N`), so the two
  // cancel in local coordinates: the whole frame slides outward along the
  // ellipsoid normal and the vertices keep their positions within it. Assert
  // that, not a local-Z shift — a local-Z shift would mean the frame had NOT
  // moved, i.e. the model would still be sunk.
  //
  // These two cases use the REAL placement matrix, so `opts`'s injected
  // `makePlacementMatrix` is dropped.
  const geoOpts = { id: opts.id, model: opts.model, crs: opts.crs };

  it("setHeightOffset moves the frame origin ~+43 m along the ellipsoid normal", () => {
    const m = new CityModelMesh({ ...geoOpts, lod: "2" });
    const before = new Vector3().setFromMatrixPosition(m.object3d.matrix);
    m.setHeightOffset(43);
    const after = new Vector3().setFromMatrixPosition(m.object3d.matrix);

    // The translation column IS the frame origin in ECEF.
    expect(after.distanceTo(before)).toBeCloseTo(43, 2);
    // ...and it moved OUTWARD (away from the geocentre), not sideways or in.
    expect(after.length() - before.length()).toBeCloseTo(43, 2);
    m.dispose();
  });

  it("leaves LOCAL vertex coordinates unchanged, while the vertex's ECEF position rises by ~43 m", () => {
    const m = new CityModelMesh({ ...geoOpts, lod: "2" });
    const beforeLocal = Float32Array.from(
      m.object3d.geometry.getAttribute("position").array as Float32Array,
    );
    const beforeEcef = new Vector3(
      beforeLocal[0]!,
      beforeLocal[1]!,
      beforeLocal[2]!,
    ).applyMatrix4(m.object3d.matrix);

    m.setHeightOffset(43);

    const afterLocal = m.object3d.geometry.getAttribute("position")
      .array as Float32Array;
    expect(afterLocal.length).toBe(beforeLocal.length);
    // Local coordinates are invariant to within the float32 noise of a
    // re-projection (the ellipsoid normal at the vertex and at the origin are
    // not exactly parallel, which is millimetres over a 10 m fixture).
    for (let i = 0; i < afterLocal.length; i++) {
      expect(afterLocal[i]!).toBeCloseTo(beforeLocal[i]!, 2);
    }

    // The visible effect is entirely in world space: the building RISES.
    const afterEcef = new Vector3(
      afterLocal[0]!,
      afterLocal[1]!,
      afterLocal[2]!,
    ).applyMatrix4(m.object3d.matrix);
    expect(afterEcef.distanceTo(beforeEcef)).toBeCloseTo(43, 2);
    expect(afterEcef.length() - beforeEcef.length()).toBeCloseTo(43, 2);
    m.dispose();
  });

  it("setHeightOffset with the current value is a no-op (no geometry churn)", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    const geometry = m.object3d.geometry;
    m.setHeightOffset(0);
    expect(m.object3d.geometry).toBe(geometry);
    m.dispose();
  });

  it("publishes a batchId map under the wrapper strategy so a batchId round-trips to a surface", () => {
    const m = new CityModelMesh({
      ...opts,
      lod: "2",
      pickStrategy: "pickable-wrapper",
    });
    const map = m.batchIdMap();
    // One quad at LoD 2 -> 2 triangles -> 2 batch ids, both on surface 0.
    expect(map).toHaveLength(2);
    expect(
      m.resolveVertexIndices(map[0]!.objectIndex, map[0]!.surfaceIndex),
    ).toEqual({
      kind: "surface",
      layerId: "L1",
      objectId: "B1",
      surfaceIndex: 0,
    });
    m.dispose();
  });

  it("publishes no batchId map under the own-raycast strategy", () => {
    const m = new CityModelMesh({
      ...opts,
      lod: "2",
      pickStrategy: "own-raycast",
    });
    expect(m.batchIdMap()).toEqual([]);
    m.dispose();
  });
});

// The own-raycast pick path (the Task B1 spike's PICK_PATH verdict). The
// injected placement matrix is a plain translation, so the fixture's roof sits
// at world z = 3 + (roof height above the frame origin) and a ray straight down
// the world -Z axis must hit it.
describe("own-raycast pick path", () => {
  const down = {
    origin: { x: 1, y: 2, z: 1000 },
    direction: { x: 0, y: 0, z: -1 },
  };

  it("raycast reports the hit surface AND its ray distance", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    const hit = m.raycast(down);
    expect(hit).not.toBeNull();
    expect(hit!.objectIndex).toBe(0);
    expect(hit!.surfaceIndex).toBe(0);
    // Frame origin height is the bbox centre's z (3); the roof is at z = 6,
    // i.e. 3 m up in ENU, plus the matrix's own +3 translation -> world z 6.
    expect(hit!.distance).toBeCloseTo(994, 1);
    m.dispose();
  });

  it("resolveRaycastSelection turns that hit into a surface selection", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    expect(m.resolveRaycastSelection(down)).toEqual({
      kind: "surface",
      layerId: "L1",
      objectId: "B1",
      surfaceIndex: 0,
    });
    m.dispose();
  });

  it("misses return null, and a hidden mesh is never picked", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    expect(
      m.raycast({
        origin: { x: 1, y: 2, z: 1000 },
        direction: { x: 0, y: 0, z: 1 },
      }),
    ).toBeNull();
    m.setVisible(false);
    expect(m.raycast(down)).toBeNull();
    expect(m.resolveRaycastSelection(down)).toBeNull();
    m.setVisible(true);
    expect(m.raycast(down)).not.toBeNull();
    m.dispose();
  });

  it("resolveVertexIndices rejects an object index outside the mesh", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    expect(m.resolveVertexIndices(7, 0)).toBeNull();
    m.dispose();
  });
});

// Task B4 carry-forward: frame and placement matrix are produced together by
// `buildPlacement`, so a call site cannot wire one height into the frame and a
// different one into the vertices.
describe("placement bundle", () => {
  it("exposes a frame whose origin height carries the height offset", () => {
    const m = new CityModelMesh({ id: "L1", model, crs: 7415, lod: "2" });
    expect(m.getPlacement().heightOffset).toBe(0);
    expect(m.getPlacement().frame.heightM).toBeCloseTo(3, 6);
    m.setHeightOffset(43);
    expect(m.getPlacement().heightOffset).toBe(43);
    expect(m.getPlacement().frame.heightM).toBeCloseTo(46, 6);
    // The matrix the engine gets is the frame's own matrix, not a second one.
    expect(m.getPlacement().matrixWorld.elements[12]).toBeCloseTo(
      m.getPlacement().frame.originEcef[0],
      6,
    );
    m.dispose();
  });
});

/**
 * Scene themes on the model-backed mesh. `themeStyle.ts` is shared with
 * `CityMeshArraysMesh` and is asserted in full there; what only this class can
 * break is the interaction with `rebuildGeometry()` — the edge child is
 * extracted from a geometry that LoD, hidden types and the geoid offset all
 * replace out from under it.
 */
describe("CityModelMesh.setThemeStyle", () => {
  const CARTOON: ThemeStyle = { fill: "vertex", edges: { color: 0x1a1a1a } };

  /** Two LoDs of DIFFERENT size, so a stale edge child shows up as a wrong
   *  vertex count and not merely as wrong coordinates. */
  const twoLodModel: CityModel = {
    ...model,
    objects: {
      B1: {
        ...model.objects.B1!,
        surfaces: [quad(6, "2"), quad(3, "1"), farQuad(3, "1")],
      },
    },
  };
  const twoLodOpts = { ...opts, model: twoLodModel };

  const edgeChild = (m: CityModelMesh) =>
    m.object3d.children[0] as LineSegments | undefined;
  const edgeVertices = (m: CityModelMesh) =>
    edgeChild(m)!.geometry.getAttribute("position").count;

  it("rebuilds the edges from the CURRENT geometry after a LoD change", () => {
    const m = new CityModelMesh({ ...twoLodOpts, lod: "2" });
    m.setThemeStyle(CARTOON);
    // One quad: 4 boundary edges (the split diagonal is coplanar), 2 endpoints
    // each.
    expect(edgeVertices(m)).toBe(8);

    m.setLod("1");
    // Two disjoint quads. Without the cache invalidation this would still read
    // 8 — the old LoD's outline, drawn over the new geometry.
    expect(edgeVertices(m)).toBe(16);
    m.dispose();
  });

  it("adds no edge child when a rebuild happens on an unthemed mesh", () => {
    const m = new CityModelMesh({ ...twoLodOpts, lod: "2" });
    m.setLod("1");
    expect(m.object3d.children).toHaveLength(0);
    m.dispose();
  });

  // The own-raycast strategy calls `intersectObject(mesh, false)`: the edge
  // child must not be descended into, or a line hit (which carries no `face`)
  // could answer for the surface under the cursor.
  it("does not break the own-raycast pick path", () => {
    const m = new CityModelMesh({ ...opts, lod: "2" });
    const down = {
      origin: { x: 1, y: 2, z: 1000 },
      direction: { x: 0, y: 0, z: -1 },
    };
    const before = m.raycast(down);
    m.setThemeStyle(CARTOON);
    expect(m.object3d.children).toHaveLength(1);
    expect(m.raycast(down)).toEqual(before);
    expect(m.resolveRaycastSelection(down)).toEqual({
      kind: "surface",
      layerId: "L1",
      objectId: "B1",
      surfaceIndex: 0,
    });
    m.dispose();
  });
});
