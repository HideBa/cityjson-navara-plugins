/**
 * Scene-theme presentation for a city mesh: the flat/tinted fill and the
 * structural edge lines a cartoon, cyber or wireframe look draws.
 *
 * One implementation, two mesh classes. `CityModelMesh` and
 * `CityMeshArraysMesh` are already twins in the parts that must not drift
 * (one lit, double-sided, vertex-coloured material — see `cityMaterial.ts`),
 * and a theme has to look identical whether a building arrived as a file or as
 * a stream, so the behaviour lives here and both classes delegate to it.
 *
 * Engine-free: `three` only, never `@navaramap/*` (Global Constraints ->
 * Testing conventions). A theme is PRESENTATION — it never touches vertex
 * colours, so rules, highlights and picking are unaffected by it.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  LineBasicMaterial,
  LineSegments,
  type Mesh,
  type MeshLambertMaterial,
} from "three";
import { buildCityEdgeSegments } from "@cityjson/navara-core";

/** The edge half of a {@link ThemeStyle}. */
export interface ThemeEdgeStyle {
  /** Plain 0xRRGGBB, read as sRGB (the cartoon ink case). */
  readonly color: number;
  /** Linear RGB, unclamped — the neon cases, which are genuinely > 1 under
   *  the exposure-10 AgX pipeline. Wins over {@link color} when present. */
  readonly hdr?: readonly [number, number, number];
}

export interface ThemeStyle {
  readonly fill: "vertex" | "tint"; // vertex = today's colours
  readonly tintRGB?: readonly [number, number, number]; // linear, unclamped, only for "tint"
  readonly edges: ThemeEdgeStyle | null;
}

/** Photoreal: vertex colours, no edges. The theme system is a no-op here, and
 *  every mesh starts in this state. */
export const DEFAULT_THEME_STYLE: ThemeStyle = { fill: "vertex", edges: null };

function sameTriple(
  a: readonly [number, number, number] | undefined,
  b: readonly [number, number, number] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Deep, not identity: the app re-pushes layer state on every store sync, and
 *  a policy table free to hand out a fresh (but equal) object would otherwise
 *  re-extract every edge of every layer each time. Styles are three fields. */
export function themeStylesEqual(a: ThemeStyle, b: ThemeStyle): boolean {
  if (a === b) return true;
  if (a.fill !== b.fill) return false;
  if (!sameTriple(a.tintRGB, b.tintRGB)) return false;
  const ae = a.edges;
  const be = b.edges;
  if (ae === null || be === null) return ae === be;
  return ae.color === be.color && sameTriple(ae.hdr, be.hdr);
}

/**
 * Write an edge colour, respecting which colour space each field is in.
 *
 * `hdr` is LINEAR and may exceed 1, so it goes through `setRGB`, which stores
 * the working-space components verbatim. A plain `color` is an sRGB
 * `0xRRGGBB` and DOES want `.set`'s sRGB -> linear conversion.
 */
function writeEdgeColor(target: Color, edges: ThemeEdgeStyle): void {
  if (edges.hdr) target.setRGB(edges.hdr[0], edges.hdr[1], edges.hdr[2]);
  else target.set(edges.color);
}

/**
 * One mesh's theme state: the fill multiplier, and the lazily-built
 * `LineSegments` child that draws its structural edges.
 *
 * The edges are a CHILD of the mesh, not a sibling, so they inherit its
 * ENU->ECEF `matrixWorld` and its scene membership — nothing has to place,
 * show, hide or delete them separately. Picking is unaffected because both
 * classes raycast with `intersectObject(mesh, false)`.
 */
export class ThemeStyleController {
  private style: ThemeStyle = DEFAULT_THEME_STYLE;
  private edges: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;

  constructor(private readonly mesh: Mesh) {}

  /** The style currently applied — `DEFAULT_THEME_STYLE` until one is set. */
  get current(): ThemeStyle {
    return this.style;
  }

  apply(style: ThemeStyle): void {
    if (themeStylesEqual(style, this.style)) return;
    this.style = style;
    this.applyFill();
    this.applyEdges();
  }

  /**
   * The mesh swapped its `BufferGeometry` (a LoD change, a hidden-type change,
   * a geoid re-placement). The cached segments were extracted from the OLD
   * positions and are now an outline of geometry that is gone, so they are
   * dropped — and rebuilt at once when a theme with edges is live, because the
   * caller is mid-rebuild and there is no later "themed paint" to be lazy
   * until.
   */
  geometryReplaced(): void {
    this.dropEdges();
    if (this.style.edges) this.buildEdges(this.style.edges);
  }

  dispose(): void {
    this.dropEdges();
  }

  /** Both mesh classes draw with `createCityMaterial` (a lit Lambert, see
   *  `cityMaterial.ts`): one, or — under a texture theme — one per texture
   *  group. The tint applies to all of them alike; Lambert multiplies
   *  `material.color` into the diffuse term raw, exactly as basic did. */
  private get materials(): MeshLambertMaterial[] {
    const material = this.mesh.material;
    return (Array.isArray(material) ? material : [material]) as MeshLambertMaterial[];
  }

  /** The mesh swapped its material array (a texture-theme rebuild): re-apply
   *  the current fill to the new materials. */
  materialsReplaced(): void {
    this.applyFill();
  }

  private applyFill(): void {
    const tint = this.style.fill === "tint" ? this.style.tintRGB : undefined;
    // NEVER `setHex`/`set` here. `material.color` multiplies the vertex
    // colours RAW in three r183 (`diffuseColor *= vColor`, and
    // `uniforms.diffuse` is a plain copy), so a tint component above 1 is a
    // genuine HDR value under the exposure-10 AgX pipeline — while `set` reads
    // its argument as sRGB and clamps it to 1.
    for (const material of this.materials) {
      if (tint) material.color.setRGB(tint[0], tint[1], tint[2]);
      else material.color.setRGB(1, 1, 1);
    }
  }

  private applyEdges(): void {
    const edges = this.style.edges;
    if (!edges) {
      this.dropEdges();
      return;
    }
    // Recolour rather than rebuild: the segments depend only on the geometry,
    // and extracting them is O(triangles).
    if (this.edges) writeEdgeColor(this.edges.material.color, edges);
    else this.buildEdges(edges);
  }

  private buildEdges(edges: ThemeEdgeStyle): void {
    const position = this.mesh.geometry.getAttribute("position");
    // `geometryFromMeshArrays` wraps the build's own Float32Array, so this is
    // the projected, non-indexed soup `buildCityEdgeSegments` documents.
    const segments = buildCityEdgeSegments(position.array as Float32Array);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(segments, 3));

    const material = new LineBasicMaterial();
    writeEdgeColor(material.color, edges);

    const line = new LineSegments(geometry, material);
    line.name = `${this.mesh.name}:edges`;
    // The parent writes its own `matrixWorld` and keeps `matrixAutoUpdate`
    // off, because Navara copies a mesh's top-level matrix and never composes
    // one — so nothing guarantees this child is ever traversed. Copy the
    // parent's world matrix outright instead of relying on a scene-graph
    // update to produce it; the child's local matrix is identity, so a
    // traversal that DOES happen recomputes exactly the same value.
    line.matrixAutoUpdate = false;
    line.matrixWorld.copy(this.mesh.matrixWorld);
    line.matrixWorldNeedsUpdate = false;
    this.mesh.add(line);
    this.edges = line;
  }

  private dropEdges(): void {
    const line = this.edges;
    if (!line) return;
    this.edges = null;
    this.mesh.remove(line);
    // Both, not just the geometry: the material is created per edge child
    // here, so nothing else can free it.
    line.geometry.dispose();
    line.material.dispose();
  }
}
