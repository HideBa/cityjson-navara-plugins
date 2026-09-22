/**
 * The FlatCityBuf source behind the stream worker core: opens a `.fcb` over
 * HTTP ranges or a local Blob, counts and selects features through its
 * R-tree, and decodes each feature into a `CityModel`.
 *
 * The runtime imports from `./fcbSource` and `@cityjson/flatcitybuf` are
 * exactly what the worker tests replace with `vi.doMock` factories; keep
 * them to `openFcb`/`checkAdmission`/`headerModel` and `toCityJSONMetadata`.
 */
import { toCityJSONMetadata, type FcbReader } from "@cityjson/flatcitybuf";
import {
  AppearanceMerger,
  dequantizeAll,
  IDENTITY_TRANSFORM,
  mapMetadata,
  mergeBBox,
  parseCityObject,
  type BBox3,
  type CityJSONFeature,
  type CityJSONObject,
  type CityJSONRoot,
  type CityModel,
  type CityObject,
} from "@cityjson/navara-core";
import { checkAdmission, headerModel, openFcb } from "./fcbSource";
import type {
  OpenedSource,
  OpenRequest,
  StreamSourceAdapter,
} from "./streamSourceAdapter";

/** A mutable copy of a readonly bbox, for the reader's query type. */
function tuple(
  b: readonly [number, number, number, number],
): [number, number, number, number] {
  return [b[0], b[1], b[2], b[3]];
}

export function createFcbSourceAdapter(): StreamSourceAdapter {
  let reader: FcbReader | undefined;
  /**
   * The open file's appearance tables, merged across every feature decoded
   * so far. A FlatCityBuf feature carries its OWN appearance (local indices,
   * like a CityJSONSeq feature), so the merger rewrites them to LAYER-wide
   * indices that stay stable for the life of the open — which is what lets
   * the main thread share one image cache across cells and across commits.
   */
  let appearance = new AppearanceMerger();

  const openReader = (): FcbReader => {
    if (!reader) throw new Error("no file open");
    return reader;
  };

  return {
    async open(req: OpenRequest): Promise<OpenedSource> {
      reader = await openFcb(
        "url" in req ? { url: req.url } : { blob: req.blob },
      );
      appearance = new AppearanceMerger();
      return {
        header: headerModel(reader.header),
        admission: checkAdmission(reader.header),
      };
    },

    async probe(bbox, signal): Promise<number> {
      // limit 0 yields an empty page but preserves the total hit count.
      // The cursor is NOT iterated, so no feature bodies are read.
      const cursor = await openReader().select({
        spatial: { kind: "bbox", value: tuple(bbox) },
        limit: 0,
        signal,
      });
      return cursor.featuresCount ?? 0;
    },

    async *select(bbox, { signal }): AsyncIterable<CityModel> {
      const r = openReader();
      const cursor = await r.select({
        spatial: { kind: "bbox", value: tuple(bbox) },
        signal,
      });
      // The metadata line's transform is shared by every feature in the
      // file (CityJSONSeq semantics — same pattern as parseCityJSONSeq.ts:
      // one shared header, each feature carrying its own local vertices).
      // `toCityJSONMetadata`/`Feature.toCityJSON` return plain, JSON-shaped
      // data (no methods), so casting them into our own domain CityJSON
      // types is the same move parseCityJSONSeq makes on `JSON.parse`
      // output — not a type-unsafe escape hatch like `as never`.
      const cjHeader = toCityJSONMetadata(
        r.header,
      ) as unknown as CityJSONRoot;
      const metadata = mapMetadata(cjHeader.metadata);
      for await (const f of cursor) {
        const cjFeature = f.toCityJSON(
          r.header,
        ) as unknown as CityJSONFeature;
        const realVertices = dequantizeAll(
          cjFeature.vertices,
          // FlatCityBuf always carries a transform; the fallback exists
          // because `CityJSONRoot.transform` is optional for v1.0 files.
          cjHeader.transform ?? IDENTITY_TRANSFORM,
        );
        // Feature-local appearance -> layer-wide indices (see `appearance`).
        const appearanceCtx = appearance.register(cjFeature.appearance);
        const objects: Record<string, CityObject> = {};
        let modelBBox: BBox3 | null = null;
        for (const [id, rawObj] of Object.entries(cjFeature.CityObjects) as [
          string,
          CityJSONObject,
        ][]) {
          const obj = parseCityObject(id, rawObj, realVertices, appearanceCtx);
          objects[id] = obj;
          modelBBox = mergeBBox(modelBBox, obj.bbox);
        }
        yield {
          sourceEncoding: "flatcitybuf",
          metadata,
          bbox: modelBBox,
          objects,
          vertexCount: cjFeature.vertices.length,
        };
      }
    },

    appearance: () => appearance.build(),

    // FlatCityBuf bakes exactly the requested LoD (or all, for `null`).
    bakeLod: (lod) => lod,

    close(): void {
      reader = undefined;
      appearance = new AppearanceMerger();
    },
  };
}
