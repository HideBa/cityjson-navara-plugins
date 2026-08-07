/**
 * Hand-written types for the one internal hyparquet module this package
 * imports beyond the entry points — see `VENDORED.md`. Upstream ships no
 * `.d.ts` for `src/*.js`, and re-vendoring only copies `.js`, so this file
 * survives an upgrade untouched.
 */

/**
 * hyparquet's built-in logical-type parsers, keyed by parser name
 * (`stringFromBytes`, `geometryFromBytes`, …).
 *
 * A caller that wants to override one MUST spread this first and pass the
 * result whole: `readRowGroup` builds its column decoder as
 * `{ parsers: {...DEFAULT_PARSERS, ...options.parsers}, ...options }`, and that
 * trailing `...options` puts the caller's raw (partial) `parsers` back on top
 * of the merge — so a partial override loses every parser it does not name.
 *
 * The values are left `unknown` deliberately: this package forwards the ones it
 * does not override rather than calling them, and modelling hyparquet's whole
 * parser surface here would be a second copy of it to keep in sync.
 */
export declare const DEFAULT_PARSERS: Readonly<Record<string, unknown>>;
