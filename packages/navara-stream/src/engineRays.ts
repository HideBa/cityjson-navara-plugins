/**
 * ENGINE BINDING MODULE — one of only two files in this package that import
 * `@navaramap/*` (the other is `./plugin`, Task C11). Node crashes on a
 * module-scope import of the engine (Task B1's `NODE_IMPORT_SAFE = false`), so
 * nothing here may be reached from the package barrel or from a unit test.
 * Everything testable lives in `./navaraRays`.
 */
import { getPickRay } from "@navaramap/three";
import { Vector2 } from "three";
import {
  type PickRaySource,
  viewRaySource,
  type ViewportSize,
} from "./navaraRays";

/**
 * The slice of `ThreeView` this binding reads. Structural rather than the
 * imported `ThreeView` type on purpose: the engine bundles its own copy of
 * three (B1), so the fewer engine types that cross this seam the better.
 */
interface RayView {
  readonly pixelRatio: number;
  readonly camera: { readonly raw: unknown };
}

type WindowLike = Parameters<typeof getPickRay>[0];
type RawCamera = Parameters<typeof getPickRay>[1];

/**
 * Binds Navara's `getPickRay` to a {@link PickRaySource}.
 *
 * `getPickRay(windowLike, camera, screenPos)` (B1 finding 5) takes a
 * `{ width, height, pixelRatio }` window-like in CSS pixels — it applies the
 * pixel ratio itself — the raw three camera off `view.camera.raw`, and a
 * `Vector2` of CSS pixels measured from the canvas' top-left. It returns a
 * three `Ray` in ECEF, which `toRay` normalises.
 *
 * The viewport measurement arrives through `getSize` rather than off the view:
 * `canvas` is a `ThreeView` CONSTRUCTOR option, not a readable property, so the
 * component that owns the container element and its `ResizeObserver` supplies
 * it (Task C13). It is re-read per ray from the same provider the corner
 * coordinates come from, so a resize is never served a stale window-like.
 *
 * `pixelRatio` is deliberately NOT defaulted: if the view ever stops exposing
 * it, the resulting non-finite ray is caught by `toRay` with the offending
 * payload in the message, rather than silently mis-picking on a retina display.
 */
export function navaraViewRaySource(
  view: unknown,
  getSize: () => ViewportSize,
): PickRaySource {
  const v = view as RayView;
  return viewRaySource({
    getPickRay: (x, y) => {
      const { width, height } = getSize();
      return getPickRay(
        {
          width,
          height,
          pixelRatio: v.pixelRatio,
        } as unknown as WindowLike,
        v.camera.raw as RawCamera,
        new Vector2(x, y),
      );
    },
    getSize,
  });
}
