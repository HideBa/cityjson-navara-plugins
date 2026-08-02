/**
 * sRGB → Linear-sRGB conversion for CSS hex colors.
 *
 * Matches `three.Color`'s conversion (ColorManagement on) so that colors
 * computed in a worker, in the geometry builder, and by a host application's
 * `three.Color` calls are numerically identical. Parity is locked by
 * tests/styling/srgbHexToLinear.test.ts.
 */

export type RGB = readonly [number, number, number];

function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Expands a 3-digit CSS hex shorthand ("abc" -> "aabbcc") to 6 digits, or
 * passes a valid 6-digit hex through unchanged. Returns null for anything
 * else (wrong length, non-hex characters).
 *
 * CSS color names and rgb()/hsl() function syntax — which three.Color's
 * `setStyle` also accepts — are intentionally NOT supported here: `Rule.color`
 * is documented as "CSS hex color" only (see ../rules/types.ts), so
 * hex is the entire contract this function needs to honor.
 */
function expandHex(h: string): string | null {
  if (/^[0-9a-fA-F]{6}$/.test(h)) return h;
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    return h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  }
  return null;
}

/**
 * Matches three.Color's sRGB → Linear-sRGB conversion (ColorManagement on).
 * NOT hex/255 — see the parity test in tests/styling/srgbHexToLinear.test.ts.
 * Accepts both 3-digit ("#abc") and 6-digit ("#aabbcc") CSS hex shorthand,
 * matching three.Color's `setStyle` hex-parsing branch (3-digit expansion is
 * digit-duplication, verified numerically identical to three's own
 * per-digit `/15` computation — see the parity tests).
 *
 * For anything that isn't a valid 3- or 6-digit hex string, logs a warning
 * and falls back to white ([1, 1, 1]) — the same fallback `new Color(...)`
 * itself produces for malformed/unrecognized color strings on a freshly
 * constructed instance. Silently producing a plausible-looking wrong color
 * is the failure mode this guards against: an invalid `rule.color` should
 * render as an obviously-wrong bright white, not a quietly-incorrect shade.
 */
export function srgbHexToLinear(hex: string): RGB {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const expanded = expandHex(h);
  if (expanded === null) {
    console.warn(
      `srgbHexToLinear: invalid hex color "${hex}" — expected 3 or 6 hex digits, falling back to white`,
    );
    return [1, 1, 1];
  }
  const n = parseInt(expanded, 16);
  return [
    srgbChannelToLinear(((n >> 16) & 255) / 255),
    srgbChannelToLinear(((n >> 8) & 255) / 255),
    srgbChannelToLinear((n & 255) / 255),
  ];
}
