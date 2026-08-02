# @cityjson/navara-core

Format-agnostic CityJSON domain code: `CityModel` types, CityJSON/CityJSONSeq parsers,
`buildCityMeshArrays` geometry building, surface color map, picking-index types, CRS proj4
definitions, and the per-surface `SurfaceStyleEvaluator` styling hook.

Engine-free: no `@navaramap/*` dependency. `three` is a peer dependency, used only for its
pure-math `ShapeUtils`/`Vector2` polygon triangulation helpers.
