# Vendored: hyparquet 1.28.1

- **Upstream**: https://github.com/hyparam/hyparquet — `hyparquet@1.28.1`
- **License**: MIT (`LICENSE` in this directory is the upstream copy, kept verbatim).
- **Contents**: every file from the tarball's `package/src/*.js` **except `node.js`**
  (the Node-only entry point; it imports `fs` and re-imports the `hyparquet`
  package by name, which would not resolve from here and which we never use).
  Upstream's `types/` is not vendored — see `index.d.ts`, hand-written for the
  three entry points this package calls, and `convert.d.ts`, hand-written for
  the one internal export we import (`DEFAULT_PARSERS`). Both are `.d.ts` files
  and the re-vendoring step below only copies `.js`, so an upgrade leaves them
  in place.

## Why vendored rather than a dependency

We need a **patched** reader (below), and this repo spans an npm/pnpm split: the
app installs with npm from the repo root, the plugin workspace with pnpm from
the submodule. A patch applied via a package-manager patch mechanism would have
to be declared, kept in sync and re-verified on both sides, and a stale one
fails as a runtime decode error rather than an install error. A single vendored
copy is the same bytes for every consumer, with no install-time machinery.

## The patch

`datapage.js` — upstream implements `DELTA_BYTE_ARRAY` only in the **V2** data
page reader. `cityparquet-rs` writes its Parquet through arrow-rs, which emits
**V1** pages with `DELTA_BYTE_ARRAY`-encoded string columns (`id`,
`object_type`, ...), so an unpatched hyparquet throws
`parquet unsupported encoding: DELTA_BYTE_ARRAY`. The V1 reader gains the branch
the V2 reader already has; `deltaByteArray` is already imported at the top of
the file for the V2 path, so this is the only change:

```diff
   } else if (daph.encoding === 'DELTA_LENGTH_BYTE_ARRAY') {
     dataPage = new Array(nValues)
     deltaLengthByteArray(reader, nValues, dataPage)
+  } else if (daph.encoding === 'DELTA_BYTE_ARRAY') {
+    dataPage = new Array(nValues)
+    deltaByteArray(reader, nValues, dataPage)
   } else {
```

That is the **entire** diff against upstream 1.28.1. Nothing else was edited.

## Upstream quirks worked around from the OUTSIDE (no edit here)

- **A partial `parsers` option silently loses the parsers it does not name.**
  `rowgroup.js`'s `readRowGroup` builds its column decoder as
  `{ parsers: { ...DEFAULT_PARSERS, ...options.parsers }, ...options }` — the
  trailing `...options` puts the caller's raw `parsers` object straight back on
  top of the merge it just did, so overriding one parser drops all the others
  and the first STRING column throws `parsers.stringFromBytes is not a
  function`. `tableReader.ts` therefore spreads `DEFAULT_PARSERS` itself and
  passes a complete object (which also stays correct if upstream fixes the
  ordering). This is why `convert.d.ts` exists.
- **A GeoParquet-declared column comes back as GeoJSON, not WKB.**
  `geoparquet.js`'s `markGeoColumns` stamps every column named in the footer's
  `geo` metadata with a `GEOMETRY` logical type, and `convert.js` then runs it
  through `wkbToGeojson`. The CityParquet writer declares its LoD0 footprint
  column there, so exactly one geometry column per file would arrive as an
  object; the identity parsers above turn that off.

## Un-vendor condition

Drop this directory and depend on `hyparquet` from npm as soon as upstream
supports `DELTA_BYTE_ARRAY` in the **V1** data page reader (`readDataPage` in
`src/datapage.js`). At that point the only remaining local artifact worth
keeping is `index.d.ts`, and even that can go if upstream's published types are
comfortable to consume.

## Re-vendoring procedure

```bash
npm pack hyparquet@<version> && tar xf hyparquet-<version>.tgz
cp package/src/*.js <this dir>/            # then delete node.js
cp package/LICENSE  <this dir>/
```

Re-apply the patch above, then run
`pnpm vitest run packages/navara-cityparquet` from the submodule root — the
vendor test reads a real `cityparquet` package and covers exactly the decode
path the patch exists for.
