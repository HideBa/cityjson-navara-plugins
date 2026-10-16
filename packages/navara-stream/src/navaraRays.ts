/**
 * The four viewport-corner pick rays that feed `viewportFootprint`.
 *
 * Engine-free by construction (Task B1's `NODE_IMPORT_SAFE = false` verdict):
 * this module never imports `@navaramap/*`. Both engine seams are injected —
 * the pick-ray function and the viewport measurement — so `viewRaySource`, the
 * real production constructor, is exercised by Node unit tests rather than by a
 * hand-written fake. The three-line binding that supplies Navara's actual
 * `getPickRay` lives in `./engineRays`.
 */
import type { Ray } from "./viewportFootprint";

export interface ViewportSize {
  /** Viewport width in CSS pixels. */
  readonly width: number;
  /** Viewport height in CSS pixels. */
  readonly height: number;
}

export interface PickRaySource {
  readonly width: number;
  readonly height: number;
  /** Screen coordinates in CSS pixels; returns the engine's own ray payload. */
  getPickRay(x: number, y: number): unknown;
}

/**
 * Reads a 3-vector out of either an array (`[x, y, z]`) or an object with
 * `x`/`y`/`z` (a Three `Vector3`). Returns null — never a NaN-bearing tuple —
 * for anything else, so the caller can throw with the offending payload.
 */
function vec(v: unknown): [number, number, number] | null {
  let out: [number, number, number] | null = null;
  if (Array.isArray(v) && v.length >= 3) {
    out = [Number(v[0]), Number(v[1]), Number(v[2])];
  } else if (v && typeof v === "object" && "x" in v && "y" in v && "z" in v) {
    const o = v as { x: unknown; y: unknown; z: unknown };
    out = [Number(o.x), Number(o.y), Number(o.z)];
  }
  if (!out) return null;
  // A non-finite component is as unusable as a missing one, and far harder to
  // trace once it has been through the footprint's plane intersection.
  return out.every(Number.isFinite) ? out : null;
}

/** Best-effort payload rendering for the error message; never throws itself. */
function preview(raw: unknown): string {
  try {
    return String(JSON.stringify(raw)).slice(0, 120);
  } catch {
    return Object.prototype.toString.call(raw);
  }
}

/**
 * Normalises whatever `getPickRay` returns into our own {@link Ray}, failing
 * loudly (rather than producing NaN coordinates deep inside the footprint
 * math) if the engine's payload shape ever changes.
 */
export function toRay(raw: unknown): Ray {
  const r = raw as
    | { origin?: unknown; direction?: unknown; dir?: unknown }
    | null
    | undefined;
  const origin = vec(r?.origin);
  const direction = vec(r?.direction ?? r?.dir);
  if (!origin || !direction) {
    throw new Error(`unsupported pick ray payload: ${preview(raw)}`);
  }
  return { origin, direction };
}

/**
 * The viewport's four corners, in the order `viewportFootprint` expects:
 * top-left, top-right, bottom-right, bottom-left (screen coordinates, so y
 * grows downward). The winding only has to be consistent — the footprint takes
 * an AABB over the four ground hits — but keeping it a ring keeps any future
 * polygon consumer honest.
 */
export function cornerRays(src: PickRaySource): readonly [Ray, Ray, Ray, Ray] {
  const { width: w, height: h } = src;
  return [
    toRay(src.getPickRay(0, 0)),
    toRay(src.getPickRay(w, 0)),
    toRay(src.getPickRay(w, h)),
    toRay(src.getPickRay(0, h)),
  ];
}

/**
 * The production `PickRaySource`.
 *
 * Both seams are injected: `getPickRay` (so this module never imports
 * `@navaramap/*`) and `getSize` — because `ThreeView` documents `canvas` as a
 * CONSTRUCTOR OPTION, not a readable property, so there is no supported way to
 * measure the viewport off the view. The viewport component owns the container
 * element and its `ResizeObserver` and passes the measurement in (Task C13).
 *
 * `width`/`height` are getters, so a resize between commits is picked up
 * without rebuilding the source.
 */
export function viewRaySource(deps: {
  getPickRay(x: number, y: number): unknown;
  getSize(): ViewportSize;
}): PickRaySource {
  return {
    get width() {
      return deps.getSize().width;
    },
    get height() {
      return deps.getSize().height;
    },
    getPickRay: (x, y) => deps.getPickRay(x, y),
  };
}
