"""Generates the multi-row-group CityParquet fixtures from two-buildings.

Run from anywhere (paths are relative to this file):

    uv run --with pyarrow --with pyproj python make_fixture.py

Writes two packages next to each other:

- `multigroup-cityparquet/`         — page index written (offset + column index)
- `multigroup-noindex-cityparquet/` — the same rows, no page index

Each is `building.parquet` + a STAC `metadata.json`. The rows are 20 copies
(k = 0..19) of `two-buildings-cityparquet/building.parquet`'s 3 rows, copy k
translated k * 50 m east. See the fixtures README for why each write option is
what it is.
"""

import hashlib
import json
import struct
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from pyproj import Transformer

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent
SOURCE = FIXTURES / "two-buildings-cityparquet"
COPIES = 20
STEP_M = 50.0
GEOMETRY_COLUMNS = ("geometry_lod0_0", "geometry_lod2_2")

# --- WKB translation -------------------------------------------------------
#
# Byte-level, not shapely: GEOS has no PolyhedralSurface (WKB 1015, which
# geometry_lod2_2 carries), and re-serialising would change the encoding. Only
# the X doubles change; every other byte stays as the reference writer wrote
# it. ISO WKB types: base = type % 1000, Z when type // 1000 is 1 or 3.

_POINT, _LINESTRING, _POLYGON = 1, 2, 3
_COLLECTIONS = {4, 5, 6, 7, 15, 16}  # Multi*, GeometryCollection, PolyhedralSurface, TIN
_TRIANGLE = 17


def _translate_geom(buf: bytearray, off: int, dx: float) -> int:
    bo = "<" if buf[off] == 1 else ">"
    (typ,) = struct.unpack_from(bo + "I", buf, off + 1)
    off += 5
    base, dim = typ % 1000, typ // 1000
    ncoord = {0: 2, 1: 3, 2: 3, 3: 4}[dim]

    def points(off: int, n: int) -> int:
        for _ in range(n):
            (x,) = struct.unpack_from(bo + "d", buf, off)
            struct.pack_into(bo + "d", buf, off, x + dx)
            off += 8 * ncoord
        return off

    def count(off: int) -> tuple[int, int]:
        return struct.unpack_from(bo + "I", buf, off)[0], off + 4

    if base == _POINT:
        return points(off, 1)
    if base == _LINESTRING:
        n, off = count(off)
        return points(off, n)
    if base in (_POLYGON, _TRIANGLE):
        rings, off = count(off)
        for _ in range(rings):
            n, off = count(off)
            off = points(off, n)
        return off
    if base in _COLLECTIONS:
        members, off = count(off)
        for _ in range(members):
            off = _translate_geom(buf, off, dx)
        return off
    raise ValueError(f"unsupported WKB type {typ}")


def translate_wkb(blob: bytes | None, dx: float) -> bytes | None:
    if blob is None or dx == 0:
        return blob
    buf = bytearray(blob)
    end = _translate_geom(buf, 0, dx)
    assert end == len(buf), f"WKB length mismatch: parsed {end} of {len(buf)}"
    return bytes(buf)


# --- Table -----------------------------------------------------------------


def suffixed(value: str | None, k: int) -> str | None:
    return None if value is None else f"{value}_{k}"


def build_table(source: pa.Table) -> pa.Table:
    table = pa.concat_tables([source] * COPIES).combine_chunks()
    n = source.num_rows
    ks = [i // n for i in range(table.num_rows)]

    def rewrite(name: str, fn) -> None:
        nonlocal table
        idx = table.schema.get_field_index(name)
        field = table.schema.field(idx)
        values = [fn(v, k) for v, k in zip(table.column(name).to_pylist(), ks)]
        table = table.set_column(idx, field, pa.array(values, type=field.type))

    rewrite("id", suffixed)
    rewrite("feature_id", suffixed)
    for name in ("parents", "children"):
        rewrite(name, lambda v, k: None if v is None else [suffixed(x, k) for x in v])
    rewrite(
        "bbox",
        lambda b, k: None
        if b is None
        else {**b, "xmin": b["xmin"] + k * STEP_M, "xmax": b["xmax"] + k * STEP_M},
    )
    for name in GEOMETRY_COLUMNS:
        rewrite(name, lambda v, k: translate_wkb(v, k * STEP_M))
    return table


def footer_metadata(source_file: pq.ParquetFile, dx_max: float) -> dict[bytes, bytes]:
    """The source footer's `city` and `geo` keys, verbatim except for extents.

    Neither key carries a DATA extent today (`crs.bbox` is the CRS's area of
    use, which must stay); a GeoParquet per-column `bbox`, if a future source
    has one, is widened here. `ARROW:schema` is dropped: pyarrow regenerates
    it for the table it writes.
    """
    kv = dict(source_file.metadata.metadata)
    out = {b"city": kv[b"city"]}
    geo = json.loads(kv[b"geo"])
    for column in geo.get("columns", {}).values():
        if "bbox" in column:
            column["bbox"][2] += dx_max  # [xmin, ymin, xmax, ymax]
    out[b"geo"] = json.dumps(geo, separators=(",", ":")).encode()
    return out


# --- Assertions ------------------------------------------------------------


def _varint(buf: bytes, off: int) -> tuple[int, int]:
    shift = result = 0
    while True:
        b = buf[off]
        off += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, off
        shift += 7


def offset_index_page_count(path: Path, offset: int) -> int:
    """Pages listed by an OffsetIndex (thrift compact): field 1, a list."""
    with open(path, "rb") as f:
        f.seek(offset)
        buf = f.read(16)
    header = buf[0]
    assert header & 0x0F == 9 and header >> 4 == 1, "OffsetIndex field 1 is not a list"
    size_type = buf[1]
    size = size_type >> 4
    if size == 15:
        size, _ = _varint(buf, 2)
    return size


PAGE_COUNTS: list[int] = []


def check(path: Path, with_index: bool) -> None:
    meta = pq.ParquetFile(path).metadata
    assert meta.num_rows == COPIES * 3
    assert meta.num_row_groups >= 5, meta.num_row_groups
    names = [meta.schema.column(i).path for i in range(meta.num_columns)]
    # pyarrow does not expose OffsetIndex locations; read them from the raw
    # thrift footer.
    raw = pq.read_metadata(path)
    for g in range(raw.num_row_groups):
        rg = raw.row_group(g)
        for c in range(rg.num_columns):
            col = rg.column(c)
            assert col.has_offset_index == with_index, (g, names[c])
            if with_index and col.path_in_schema in GEOMETRY_COLUMNS:
                loc = _offset_index_location(path, g, c)
                pages = offset_index_page_count(path, loc)
                assert pages >= 2, (g, col.path_in_schema, pages)
                PAGE_COUNTS.append(pages)


def _offset_index_location(path: Path, group: int, column: int) -> int:
    """The OffsetIndex file offset of one column chunk.

    pyarrow's ColumnChunkMetaData does not surface `offset_index_offset` (nor
    does `to_dict()`), so it is parsed out of the raw thrift footer below.
    """
    return _footer_offsets(path)[group][column]


_OFFSETS_CACHE: dict[Path, list[list[int]]] = {}


def _footer_offsets(path: Path) -> list[list[int]]:
    if path in _OFFSETS_CACHE:
        return _OFFSETS_CACHE[path]
    data = path.read_bytes()
    (flen,) = struct.unpack_from("<I", data, len(data) - 8)
    footer = data[len(data) - 8 - flen : len(data) - 8]
    reader = _Thrift(footer)
    offsets = reader.file_metadata_offset_index_offsets()
    _OFFSETS_CACHE[path] = offsets
    return offsets


class _Thrift:
    """Just enough thrift-compact to pull RowGroup.columns[*].offset_index_offset."""

    def __init__(self, buf: bytes):
        self.buf = buf
        self.off = 0

    def byte(self) -> int:
        b = self.buf[self.off]
        self.off += 1
        return b

    def varint(self) -> int:
        v, self.off = _varint(self.buf, self.off)
        return v

    def zigzag(self) -> int:
        v = self.varint()
        return (v >> 1) ^ -(v & 1)

    def list_header(self) -> tuple[int, int]:
        h = self.byte()
        size, etype = h >> 4, h & 0x0F
        if size == 15:
            size = self.varint()
        return size, etype

    def skip(self, t: int) -> None:
        if t in (1, 2):  # bool true/false (inline)
            return
        if t == 3:
            self.off += 1
        elif t in (4, 5, 6):
            self.varint()
        elif t == 7:
            self.off += 8
        elif t == 8:
            length = self.varint()  # read first: `off +=` would load off early
            self.off += length
        elif t in (9, 10):
            size, et = self.list_header()
            for _ in range(size):
                self.skip_elem(et)
        elif t == 11:
            size = self.varint()
            if size:
                kv = self.byte()
                for _ in range(size):
                    self.skip_elem(kv >> 4)
                    self.skip_elem(kv & 0x0F)
        elif t == 12:
            self.struct(lambda fid, ft: False)
        else:
            raise ValueError(f"thrift type {t}")

    def skip_elem(self, t: int) -> None:
        if t in (1, 2):
            self.off += 1  # bools in containers take a byte
        else:
            self.skip(t)

    def struct(self, on_field) -> None:
        last = 0
        while True:
            h = self.byte()
            if h == 0:
                return
            delta, ftype = h >> 4, h & 0x0F
            fid = last + delta if delta else self.zigzag()
            last = fid
            if not on_field(fid, ftype):
                self.skip(ftype)

    def file_metadata_offset_index_offsets(self) -> list[list[int]]:
        groups: list[list[int]] = []

        def column_chunk(out: list[int]):
            found = [-1]

            def f(fid, ft):
                if fid == 4:  # offset_index_offset (i64)
                    found[0] = self.zigzag()
                    return True
                return False

            self.struct(f)
            out.append(found[0])

        def row_group(fid, ft):
            if fid == 1:  # columns
                size, _ = self.list_header()
                cols: list[int] = []
                for _ in range(size):
                    column_chunk(cols)
                groups.append(cols)
                return True
            return False

        def file_meta(fid, ft):
            if fid == 4:  # row_groups
                size, _ = self.list_header()
                for _ in range(size):
                    self.struct(row_group)
                return True
            return False

        self.struct(file_meta)
        return groups


# --- STAC manifest ---------------------------------------------------------


def write_stac(out_dir: Path, table: pa.Table) -> None:
    stac = json.loads((SOURCE / "metadata.json").read_text())
    bboxes = [b for b in table.column("bbox").to_pylist() if b is not None]
    xmin = min(b["xmin"] for b in bboxes)
    ymin = min(b["ymin"] for b in bboxes)
    zmin = min(b["zmin"] for b in bboxes)
    xmax = max(b["xmax"] for b in bboxes)
    ymax = max(b["ymax"] for b in bboxes)
    zmax = max(b["zmax"] for b in bboxes)
    to_wgs84 = Transformer.from_crs("EPSG:28992", "EPSG:4326", always_xy=True)
    corners = [to_wgs84.transform(x, y) for x in (xmin, xmax) for y in (ymin, ymax)]
    lon0 = min(c[0] for c in corners)
    lon1 = max(c[0] for c in corners)
    lat0 = min(c[1] for c in corners)
    lat1 = max(c[1] for c in corners)
    stac["id"] = out_dir.name
    stac["bbox"] = [lon0, lat0, zmin, lon1, lat1, zmax]
    stac["geometry"] = {
        "type": "Polygon",
        "coordinates": [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]],
    }
    stac["properties"]["city3d:city_objects"] = table.num_rows
    data = (out_dir / "building.parquet").read_bytes()
    checksum = "1220" + hashlib.sha256(data).hexdigest()
    for asset in stac["assets"].values():
        asset["file:size"] = len(data)
        asset["file:checksum"] = checksum
    (out_dir / "metadata.json").write_text(json.dumps(stac, indent=2) + "\n")


# --- Main ------------------------------------------------------------------


def main() -> None:
    source_file = pq.ParquetFile(SOURCE / "building.parquet")
    source = source_file.read()
    table = build_table(source)
    table = table.replace_schema_metadata(
        footer_metadata(source_file, (COPIES - 1) * STEP_M)
    )
    for name, with_index in (
        ("multigroup-cityparquet", True),
        ("multigroup-noindex-cityparquet", False),
    ):
        out_dir = FIXTURES / name
        out_dir.mkdir(exist_ok=True)
        path = out_dir / "building.parquet"
        pq.write_table(
            table,
            path,
            row_group_size=8,
            data_page_size=256,
            write_page_index=with_index,
            # Without these two, every chunk is ONE page: Arrow checks the
            # page size only after each write batch (default 1024 values), and
            # a dictionary-encoded data page holds only tiny indices.
            write_batch_size=1,
            use_dictionary=False,
            compression="zstd",
            store_schema=True,
        )
        check(path, with_index)
        write_stac(out_dir, table)
        pages = f", geometry pages per chunk {min(PAGE_COUNTS)}..{max(PAGE_COUNTS)}" if with_index else ""
        print(f"{name}: {path.stat().st_size} B, {pq.ParquetFile(path).metadata.num_row_groups} row groups{pages}")


if __name__ == "__main__":
    main()
