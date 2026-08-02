import { describe, it, expect, vi } from "vitest";
import { Color } from "three";
import { srgbHexToLinear } from "../../src/styling/srgb";

// Independent (not imported from production) duplicate of the sRGB->linear
// channel formula, used only to build a "what the buggy un-expanded parse
// would have produced" comparison value in the 3-digit regression test
// below. Its own correctness is separately locked down by the three.Color
// parity tests above.
function srgbChannelToLinearForTest(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// ---------------------------------------------------------------------------
// Colour-space parity.
//
// `new Color(hex)` (with ColorManagement on, three's default) converts
// sRGB -> Linear-sRGB; it is NOT hexChannel / 255. `srgbHexToLinear` must
// reproduce that conversion exactly, since streamed (worker-colored) cells
// and statically-colored geometry must render identically.
//
// The hex list below deliberately brackets the 0.04045 knee where the
// piecewise formula's two branches diverge most: 10/255 = 0.0392 (below,
// linear branch) and 11/255 = 0.0431 (the nearest 8-bit value above the
// knee, power branch), plus pure black/white (both branch endpoints) and a
// mid-grey (largest naive-vs-linear divergence).
// ---------------------------------------------------------------------------

describe("srgbHexToLinear parity with three.Color", () => {
  const hexes = [
    "#000000",
    "#ffffff",
    "#ff0000",
    "#3a7bd5",
    "#0a0a0a", // 10/255 = 0.0392..., just BELOW the 0.04045 knee
    "#0b0b0b", // 11/255 = 0.0431..., the nearest 8-bit value ABOVE the knee
    "#010101", // deep into the linear branch
    "#808080", // mid-grey: largest linear-vs-naive divergence
  ];

  for (const hex of hexes) {
    it(`matches three.Color for ${hex}`, () => {
      const expected = new Color(hex);
      const [r, g, b] = srgbHexToLinear(hex);
      expect(r).toBeCloseTo(expected.r, 6);
      expect(g).toBeCloseTo(expected.g, 6);
      expect(b).toBeCloseTo(expected.b, 6);
    });
  }

  it("is not the naive hex/255 conversion", () => {
    // 0x80 / 255 = 0.5019..., but linear-sRGB is ~0.2158
    const [r] = srgbHexToLinear("#808080");
    expect(r).not.toBeCloseTo(0.5019, 3);
  });

  it("uses the linear (c/12.92) branch strictly below the 0.04045 knee", () => {
    // 10/255 = 0.039215686... < 0.04045, so the expected value is the
    // SIMPLE division, not the power curve. A wrong branch selection
    // (e.g. always using the power formula) would fail this by a wide
    // margin: c/12.92 = 0.003035..., power-branch would give ~0.00743.
    const [r] = srgbHexToLinear("#0a0a0a");
    const naiveLinearBranch = 10 / 255 / 12.92;
    expect(r).toBeCloseTo(naiveLinearBranch, 6);
  });

  it("uses the power ((c+0.055)/1.055)^2.4 branch strictly above the 0.04045 knee", () => {
    // 11/255 = 0.043137... > 0.04045.
    const [r] = srgbHexToLinear("#0b0b0b");
    const c = 11 / 255;
    const powerBranch = ((c + 0.055) / 1.055) ** 2.4;
    expect(r).toBeCloseTo(powerBranch, 6);
  });
});

// ---------------------------------------------------------------------------
// 3-digit CSS hex shorthand support.
//
// three.Color's setStyle accepts BOTH 3-digit ("#abc") and 6-digit
// ("#aabbcc") hex. srgbHexToLinear previously only handled the 6-digit
// form (parseInt on the whole string), so e.g. "#fff" silently produced
// [0, 0.0048, 1] instead of white [1, 1, 1] — a real regression, since
// Rule.color accepts any non-empty string from imported rule configs
// (see RuleBuilderTab.tsx) with no validation forcing 6 digits.
// ---------------------------------------------------------------------------

describe("srgbHexToLinear 3-digit CSS hex shorthand", () => {
  const shorthand = ["#fff", "#abc", "#0f0"];

  for (const hex of shorthand) {
    it(`matches three.Color for 3-digit ${hex}`, () => {
      const expected = new Color(hex);
      const [r, g, b] = srgbHexToLinear(hex);
      expect(r).toBeCloseTo(expected.r, 6);
      expect(g).toBeCloseTo(expected.g, 6);
      expect(b).toBeCloseTo(expected.b, 6);
    });
  }

  it("does not match the un-expanded (wrong) 6-digit parse of a 3-digit string", () => {
    // Regression guard: parseInt("abc", 16) as if "abc" were 6 hex digits
    // gives a materially different (and wrong) color than the correct
    // expansion "aabbcc". Both sides must go through the SAME sRGB->linear
    // conversion for this to be a meaningful comparison (comparing linear
    // output against raw un-converted channels would pass regardless of
    // whether the expansion bug is present, since linear != raw either way).
    const [r, g, b] = srgbHexToLinear("#abc");
    const wrongViaRawParse = parseInt("abc", 16); // treats "abc" as if 6-digit
    const wrongLinear = [
      srgbChannelToLinearForTest(((wrongViaRawParse >> 16) & 255) / 255),
      srgbChannelToLinearForTest(((wrongViaRawParse >> 8) & 255) / 255),
      srgbChannelToLinearForTest((wrongViaRawParse & 255) / 255),
    ];
    expect([r, g, b]).not.toEqual(wrongLinear);
  });
});

// ---------------------------------------------------------------------------
// Malformed hex input.
//
// Rule.color's documented contract is "CSS hex color" only (3 or 6 hex
// digits) — CSS color names and rgb()/hsl() function syntax, which
// three.Color's setStyle also accepts, are intentionally out of scope.
// For anything outside that contract, srgbHexToLinear must fail visibly
// (a warning plus an obviously-wrong white) rather than silently produce a
// plausible-looking wrong color — matching what `new Color(...)` itself
// does for malformed/unrecognized color strings on a fresh instance.
// ---------------------------------------------------------------------------

describe("srgbHexToLinear malformed input", () => {
  it("falls back to white and warns for a non-hex string", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [r, g, b] = srgbHexToLinear("#xyz");
    expect([r, g, b]).toEqual([1, 1, 1]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("falls back to white and warns for the empty string", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [r, g, b] = srgbHexToLinear("");
    expect([r, g, b]).toEqual([1, 1, 1]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("falls back to white and warns for a wrong-length hex string (2 digits)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [r, g, b] = srgbHexToLinear("#ab");
    expect([r, g, b]).toEqual([1, 1, 1]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("falls back to white and warns for a wrong-length hex string (4 digits)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [r, g, b] = srgbHexToLinear("#abcd");
    expect([r, g, b]).toEqual([1, 1, 1]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
