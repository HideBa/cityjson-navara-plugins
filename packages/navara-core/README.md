# @cityjson/navara-core

Format-agnostic CityJSON domain code, engine-free (no `@navaramap/*` dependency).
`three` is a peer dependency, used only for its pure-math `ShapeUtils`/`Vector2`
polygon helpers; `proj4` is likewise a peer dependency, used for CRS registration.
Both are singleton registries — `proj4` keeps a module-global EPSG table and `three`
relies on `instanceof` — so the host must supply exactly one copy of each (the app
does this with `resolve.dedupe: ["proj4", "three"]`).

## API

| Area           | Exports                                                                                                                                                                         |
|----------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Domain types   | `CityModel`, `CityObject`, `Surface`, `BuildingSurfaceType`, `Vec3`, `BBox3`, `CityModelMetadata`, `CityModelEncoding`                                                          |
| Encodings      | `CITYMODEL_ENCODING_PRIORITY`, `isSupportedCityModelEncoding`, `getPreferredCityModelEncoding`                                                                                  |
| CityJSON       | `parseCityJSON`, `dequantizeAll`, `mergeBBox`, `parseCityObject`, `mapMetadata`, plus the raw `CityJSON*` wire types                                                            |
| CityJSONSeq    | `parseCityJSONSeq`, `CityJSONFeature`                                                                                                                                           |
| Geometry       | `buildCityMeshArrays`, `computeOriginOffset`, `CityMeshArrays`                                                                                                                  |
| Geo frames     | `EnuFrame`, `makeEnuFrame`, `geodeticToEcef`, `ecefToGeodetic`, `enuToEcef`, `ecefToEnu`                                                                                        |
| Placement      | `sourceToEnuPoint`, `projectPositionsToEnu`, `SourceToEnuOptions`, `ProjectPositionsOptions`                                                                                    |
| Vertical datum | `geoidHeightAt`, `GEOID_TILEJSON_URL`, `GEOID_ATTRIBUTION`, `RasterPixels`, `GeoidSampleDeps` (EGM2008 undulation from the Re:Earth Terrain service)                            |
| Roof metrics   | `RoofMetrics`, `computeRoofMetrics`, `computeArea`, `computeSurfaceNormal`, `computeInclination`, `computeAzimuth`, `computeElevation`, `computeFootprintArea`                  |
| Rules          | `Rule`, `Condition`, `ConditionOperator`, `LogicMode`, `evaluateCondition`, `evaluateRule`, `matchRule`                                                                         |
| Picking        | `PickingIndex`, `PickResult`                                                                                                                                                    |
| Styling        | `SURFACE_COLOR_VALUES`, `SURFACE_COLOR_HEX`, `SURFACE_COLORS_LINEAR`, `srgbHexToLinear`, `SurfaceInfo`, `CityObjectInfo`, `SurfaceStyleEvaluator`, `buildStyleColorsFromArrays` |
| CRS            | `ensureProjDef`, `parseEpsgCode`                                                                                                                                                |
| Misc           | `NAVARA_CORE_VERSION`, `RGB`, `LinearRGB`, `resetGeoidCacheForTest` (test-only)                                                                                                 |

## Development

```bash
pnpm --filter @cityjson/navara-core build
pnpm vitest run packages/navara-core
```
