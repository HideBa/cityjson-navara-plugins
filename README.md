# cityjson-navara-plugins

CityJSON plugins for the [Navara](https://navara-docs.netlify.app) map engine, plus the
format-agnostic CityJSON domain code they share.

| Package                        | Status                                                    |
| ------------------------------ | --------------------------------------------------------- |
| `@cityjson/navara-core`        | CityJSON types, parsers, geometry building, styling hooks |
| `@cityjson/navara-cityjson`    | Navara plugin for static CityJSON / CityJSONSeq layers    |
| `@cityjson/navara-stream`      | Navara plugin for camera-driven streaming, any format     |
| `@cityjson/navara-flatcitybuf` | FlatCityBuf stream source: admission, adapter, worker     |
| `@cityjson/navara-cityparquet` | CityParquet reader, plus its stream adapter and worker    |

## Development

```bash
corepack enable pnpm
pnpm install
pnpm build      # tsup: ESM + d.ts into each package's dist/
pnpm typecheck  # tsc -b (project references)
pnpm test       # vitest run
```

Only `@cityjson/navara-core` is engine-free. The plugin packages declare
`@navaramap/three` and `@navaramap/three-default-plugin` as **peer** dependencies
pinned to exact `0.0.5`, so the host app supplies a single engine instance.

## Consumption

[Roofy](https://github.com/MultiRoofs/roofy) consumes this repo as a git submodule at
`packages/cityjson-navara-plugins`, with `file:` dependencies onto the built packages
and a Vite alias onto `src/` for dev HMR.
