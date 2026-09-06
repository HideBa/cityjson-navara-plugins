/**
 * The ONE material a city surface is drawn with, and the seam through which
 * every instance of it reaches the engine's shadow registry. Both mesh
 * classes (`CityModelMesh` for a static layer, `CityMeshArraysMesh` for a
 * streaming cell) and the textured-group builder call `createCityMaterial`,
 * so a building renders the same whether it arrived as a file or as a stream.
 *
 * Engine-free: `three` only, so the Node suites cover it.
 */
import { DoubleSide, MeshLambertMaterial, type Material } from "three";

/**
 * Where a mesh hands the materials it draws with, and takes them back.
 *
 * Navara's cascaded shadow maps (`@navaramap/three-csm`, owned by the
 * `SunLightDesc` the default photoreal scene adds) patch a material's shader
 * with the cascade uniforms — a material the registry has never seen receives
 * no shadow, whatever `receiveShadow` says on its mesh. The registry is
 * `ViewContext.applyShadowMaterial` / `removeShadowMaterial`, which only the
 * engine-bound descriptors can reach, hence the seam: the descriptor fills
 * it, the mesh class calls it for every material it creates and, BEFORE
 * disposing, for every material it replaces or drops (a LoD swap or an
 * appearance switch rebuilds materials; a stream evicts cells all day), so
 * the registry never keeps a dead material alive.
 */
export interface ShadowMaterialHooks {
  register(material: Material): void;
  unregister(material: Material): void;
}

/** What a mesh built outside the engine (a unit test, a bare three scene)
 *  uses: nothing to register with. */
export const NO_SHADOW_MATERIALS: ShadowMaterialHooks = Object.freeze({
  register(): void {},
  unregister(): void {},
});

/**
 * A LIT, double-sided, vertex-coloured material.
 *
 * LIT — `MeshLambertMaterial`, not `MeshBasicMaterial` — because the scene
 * is forward-lit: the engine's `SunLightDesc` (direction and colour from
 * the atmosphere, cascaded shadow maps) and `SkyLightProbeDesc` shade every
 * surface, and a wall facing away from the sun, or under another building,
 * reads darker. A basic material has no lighting equation and no shadow-map
 * chunk, so it can neither be shaded by the sun nor receive a shadow, which
 * is what left every wall flat white (MultiRoofs/roofy#13). Lambert rather
 * than Standard: these are matte painted surfaces with no metalness or
 * roughness to speak of, and Lambert is the material the engine's own mesh
 * descriptors draw with.
 *
 * `vertexColors`: the semantic base colours, the rule colours and the
 * highlight are all baked per vertex; `material.color` stays a raw
 * multiplier the scene theme writes (see `ThemeStyleController`).
 *
 * DOUBLE-SIDED, and not as a convenience: front-face culling removes real
 * geometry from this data. CityJSON's spec asks for outward-facing exterior
 * shells, but real files vary — and `orientExteriorRing` (navara-core's
 * `buildCityMeshArrays`) makes it worse rather than better on the shapes
 * that matter, because it decides orientation by asking whether a face's
 * normal points away from the object's bbox CENTRE. That is right for a
 * convex block and wrong for every concave one: an L-shaped building's inner
 * walls, a courtyard's inward faces and anything under an overhang
 * legitimately face their own centroid, so the heuristic reverses them and
 * `FrontSide` then culls them. Measured on the Delft sample at a fixed
 * camera with the backdrop off: ~1.1% of the viewport was building pixels
 * that only appear double-sided (3400 px, against 56 the other way). Three
 * flips the normal of a back-facing fragment under `DoubleSide`, so a
 * mis-wound wall is still lit from the side the camera sees.
 *
 * The cost is bounded: these are opaque solids behind a depth test, so the
 * extra fragments are overdraw the z-buffer discards, on a model of ~10^5
 * triangles. Correct geometry is worth that. Fixing the winding properly
 * needs solid-orientation analysis (ray parity per shell), not a centroid
 * guess — worth doing, but it would still not make a viewer of third-party
 * data safe to cull.
 */
export function createCityMaterial(): MeshLambertMaterial {
  return new MeshLambertMaterial({
    vertexColors: true,
    side: DoubleSide,
  });
}
