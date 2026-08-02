import { describe, expect, it, vi } from "vitest";
import {
  cornerRays,
  type PickRaySource,
  toRay,
  viewRaySource,
} from "../src/navaraRays";

function src(calls: Array<[number, number]>): PickRaySource {
  return {
    width: 800,
    height: 600,
    getPickRay(x, y) {
      calls.push([x, y]);
      return { origin: [x, y, 100], direction: [0, 0, -1] };
    },
  };
}

describe("toRay", () => {
  it("accepts {origin,direction} object vectors as well as array vectors", () => {
    const r = toRay({
      origin: { x: 1, y: 2, z: 3 },
      direction: { x: 0, y: 0, z: -1 },
    });
    expect(r.origin).toEqual([1, 2, 3]);
    expect(r.direction).toEqual([0, 0, -1]);
  });

  it("throws a diagnosable error for an unexpected payload shape instead of yielding NaNs downstream", () => {
    expect(() => toRay({ foo: 1 })).toThrow(/pick ray/i);
  });
});

describe("cornerRays", () => {
  it("samples the four viewport corners in the same order the footprint expects", () => {
    const calls: Array<[number, number]> = [];
    const rays = cornerRays(src(calls));
    expect(calls).toEqual([
      [0, 0],
      [800, 0],
      [800, 600],
      [0, 600],
    ]);
    expect(rays).toHaveLength(4);
    expect(rays[1].origin[0]).toBe(800);
  });
});

describe("viewRaySource", () => {
  it("reads its dimensions from the injected size provider on EVERY access, so a resize is picked up", () => {
    let size = { width: 800, height: 600 };
    const source = viewRaySource({
      getPickRay: () => ({ origin: [0, 0, 0], direction: [0, 0, -1] }),
      getSize: () => size,
    });
    expect([source.width, source.height]).toEqual([800, 600]);
    size = { width: 1024, height: 768 };
    expect([source.width, source.height]).toEqual([1024, 768]);
  });

  it("forwards screen coordinates to the injected getPickRay untouched", () => {
    const getPickRay = vi.fn(() => ({
      origin: [0, 0, 0],
      direction: [0, 0, -1],
    }));
    const source = viewRaySource({
      getPickRay,
      getSize: () => ({ width: 800, height: 600 }),
    });
    cornerRays(source);
    expect(getPickRay.mock.calls).toEqual([
      [0, 0],
      [800, 0],
      [800, 600],
      [0, 600],
    ]);
  });
});
