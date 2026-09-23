"""Generates the EPSG:6697 (PLATEAU-shaped) CityParquet fixture.

Run from anywhere (paths are relative to this file):

    uv run --with pyarrow --with pyproj python make_fixture.py

Writes `plateau-6697-cityparquet/` next to this script: `building.parquet` plus
a STAC `metadata.json`. The rows are 6 copies (k = 0..5) of
`two-buildings-cityparquet/building.parquet`'s 3 rows, reprojected to JGD2011
geographic coordinates and RELOCATED to Tokyo Bay, copy k a further 250 m east,
so the fixture spans ~1.25 km and covers several 100 m stream cells.

It is SYNTHETIC, in two named ways (the fixtures README says so too):

- **Horizontal**: `EPSG:28992 -> EPSG:6668`, the horizontal components of the
  source's EPSG:7415 and of EPSG:6697. A real datum transform of the source
  coordinates — but the result is then relocated to Japan by the degree-space
  affine below, so the coordinates are NOT where these Dutch buildings are.
  The affine divides longitude deltas by `cos(lat)`'s ratio, so a building
  keeps its metric width instead of stretching by a factor of 1.32.
- **Vertical**: heights are copied byte for byte. NAP heights are RELABELLED as
  JGD2011 gravity-related heights, never transformed (that needs a geoid model
  for each datum, and this milestone deliberately does not touch the vertical
  path).

The compound transform `7415 -> 6697` is avoided on purpose: pyproj would look
for a vertical transformation and could silently move the heights.
"""

import hashlib
import json
import math
import struct
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from pyproj import CRS, Transformer

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent
SOURCE = FIXTURES / "two-buildings-cityparquet"
OUT_DIR = HERE

TARGET_EPSG = 6697
COPIES = 6
STEP_M = 250.0
GEOMETRY_COLUMNS = ("geometry_lod0_0", "geometry_lod2_2")

# Where the fixture is placed: inside EPSG:6697's area of use, and the centre
# the plan's worked numbers use.
LNG0 = 139.6
LAT0 = 35.5

# The plan's pinned bucket scale at LAT0 — used here only to turn the copies'
# metre step into a longitude step (and asserted against the same formula
# `navara-core/src/geo/localMetricFrame.ts` implements).
WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)


def metres_per_degree_lng(lat_deg: float) -> float:
    phi = math.radians(lat_deg)
    s = math.sin(phi)
    n = WGS84_A / math.sqrt(1 - WGS84_E2 * s * s)
    return math.radians(1.0) * n * math.cos(phi)


STEP_DEG = STEP_M / metres_per_degree_lng(LAT0)


# --- The point transform ----------------------------------------------------


class Relocate:
    """`(x, y)` in EPSG:28992 -> `(lon, lat)` in JGD2011, placed at LNG0/LAT0.

    Horizontal reprojection first, then a degree-space affine about the source
    extent's centre that preserves local metric size (see the module docstring).
    """

    def __init__(self, centre_xy: tuple[float, float]):
        self.to_jgd = Transformer.from_crs("EPSG:28992", "EPSG:6668", always_xy=True)
        self.lon_c, self.lat_c = self.to_jgd.transform(*centre_xy)
        self.lon_scale = math.cos(math.radians(self.lat_c)) / math.cos(math.radians(LAT0))

    def __call__(self, x: float, y: float, dlon: float = 0.0) -> tuple[float, float]:
        lon, lat = self.to_jgd.transform(x, y)
        return (
            LNG0 + (lon - self.lon_c) * self.lon_scale + dlon,
            LAT0 + (lat - self.lat_c),
        )


# --- WKB rewriting ----------------------------------------------------------
#
# Byte-level, not shapely: GEOS has no PolyhedralSurface (WKB 1015, which
# geometry_lod2_2 carries), and re-serialising would change the encoding. Only
# the X and Y doubles of each point are rewritten; Z (and any M) is never
# touched, which is what makes "heights unchanged" structural rather than
# merely intended. ISO WKB types: base = type % 1000, Z when type // 1000 is
# 1 or 3.

_POINT, _LINESTRING, _POLYGON = 1, 2, 3
_COLLECTIONS = {4, 5, 6, 7, 15, 16}  # Multi*, GeometryCollection, PolyhedralSurface, TIN
_TRIANGLE = 17


def _rewrite_geom(buf: bytearray, off: int, fn) -> int:
    bo = "<" if buf[off] == 1 else ">"
    (typ,) = struct.unpack_from(bo + "I", buf, off + 1)
    off += 5
    base, dim = typ % 1000, typ // 1000
    ncoord = {0: 2, 1: 3, 2: 3, 3: 4}[dim]

    def points(off: int, n: int) -> int:
        for _ in range(n):
            x, y = struct.unpack_from(bo + "dd", buf, off)
            nx, ny = fn(x, y)
            struct.pack_into(bo + "dd", buf, off, nx, ny)
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
            off = _rewrite_geom(buf, off, fn)
        return off
    raise ValueError(f"unsupported WKB type {typ}")


def rewrite_wkb(blob: bytes | None, fn) -> bytes | None:
    if blob is None:
        return blob
    buf = bytearray(blob)
    end = _rewrite_geom(buf, 0, fn)
    assert end == len(buf), f"WKB length mismatch: parsed {end} of {len(buf)}"
    assert len(buf) == len(blob), "a rewrite must not change a WKB's length"
    return bytes(buf)


def zs_of(blob: bytes | None) -> list[float]:
    """Every Z double of a WKB, in order, for the heights-unchanged assertion."""
    out: list[float] = []
    if blob is None:
        return out
    buf = bytearray(blob)

    def _walk(off: int) -> int:
        bo = "<" if buf[off] == 1 else ">"
        (typ,) = struct.unpack_from(bo + "I", buf, off + 1)
        off += 5
        base, dim = typ % 1000, typ // 1000
        ncoord = {0: 2, 1: 3, 2: 3, 3: 4}[dim]
        has_z = dim in (1, 3)

        def points(off: int, n: int) -> int:
            for _ in range(n):
                if has_z:
                    out.append(struct.unpack_from(bo + "d", buf, off + 16)[0])
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
                off = _walk(off)
            return off
        raise ValueError(f"unsupported WKB type {typ}")

    _walk(0)
    return out


# --- Table ------------------------------------------------------------------


def suffixed(value: str | None, k: int) -> str | None:
    return None if value is None else f"{value}_{k}"


def source_centre(source: pa.Table) -> tuple[float, float]:
    boxes = [b for b in source.column("bbox").to_pylist() if b is not None]
    return (
        (min(b["xmin"] for b in boxes) + max(b["xmax"] for b in boxes)) / 2,
        (min(b["ymin"] for b in boxes) + max(b["ymax"] for b in boxes)) / 2,
    )


def build_table(source: pa.Table, relocate: Relocate) -> pa.Table:
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

    def move_bbox(b, k):
        if b is None:
            return None
        dlon = k * STEP_DEG
        # A reprojected rectangle is not axis-aligned: box all four corners.
        corners = [
            relocate(x, y, dlon)
            for x in (b["xmin"], b["xmax"])
            for y in (b["ymin"], b["ymax"])
        ]
        return {
            **b,
            "xmin": min(c[0] for c in corners),
            "ymin": min(c[1] for c in corners),
            "xmax": max(c[0] for c in corners),
            "ymax": max(c[1] for c in corners),
        }

    rewrite("bbox", move_bbox)
    for name in GEOMETRY_COLUMNS:
        rewrite(
            name,
            lambda v, k: rewrite_wkb(
                v, lambda x, y, dlon=k * STEP_DEG: relocate(x, y, dlon)
            ),
        )
    return table


def footer_metadata(source_file: pq.ParquetFile) -> dict[bytes, bytes]:
    """The source footer's `city` and `geo` keys with EPSG:6697's PROJJSON.

    Everything else is carried verbatim: `version`, `source_format`,
    `primary_column`, `columns` (with their encodings and geometry types),
    `attributes`, `other`, and GeoParquet's `edges`. Only the CRS objects
    change, in both keys — a file whose two footers disagreed would be a
    different test than this one. `ARROW:schema` is dropped; pyarrow
    regenerates it for the table it writes.
    """
    projjson = CRS.from_epsg(TARGET_EPSG).to_json_dict()
    assert projjson["id"] == {"authority": "EPSG", "code": TARGET_EPSG}

    kv = dict(source_file.metadata.metadata)
    city = json.loads(kv[b"city"])
    city["crs"] = projjson
    geo = json.loads(kv[b"geo"])
    for column in geo.get("columns", {}).values():
        column["crs"] = projjson
        assert "bbox" not in column, "a GeoParquet column bbox would need moving too"
    return {
        b"city": json.dumps(city, separators=(",", ":")).encode(),
        b"geo": json.dumps(geo, separators=(",", ":")).encode(),
    }


# --- Assertions -------------------------------------------------------------


def check(path: Path, source: pa.Table, table: pa.Table) -> None:
    file = pq.ParquetFile(path)
    assert file.metadata.num_rows == COPIES * source.num_rows, file.metadata.num_rows

    kv = dict(file.metadata.metadata)
    city = json.loads(kv[b"city"])
    assert city["crs"]["id"]["code"] == TARGET_EPSG, city["crs"]["id"]
    for column in json.loads(kv[b"geo"])["columns"].values():
        assert column["crs"]["id"]["code"] == TARGET_EPSG

    # Coordinates look like lon/lat, in EPSG:6697's area of use.
    written = file.read()
    for b in written.column("bbox").to_pylist():
        assert 139.0 < b["xmin"] <= b["xmax"] < 140.0, b
        assert 35.0 < b["ymin"] <= b["ymax"] < 36.0, b

    # Heights unchanged, per WKB, per Z double.
    for name in GEOMETRY_COLUMNS:
        src = source.column(name).to_pylist()
        out = written.column(name).to_pylist()
        for i, blob in enumerate(out):
            assert zs_of(blob) == zs_of(src[i % source.num_rows]), (name, i)
    for i, b in enumerate(written.column("bbox").to_pylist()):
        s = source.column("bbox").to_pylist()[i % source.num_rows]
        assert (b["zmin"], b["zmax"]) == (s["zmin"], s["zmax"]), i

    # The copies really are STEP_M apart, east, at this latitude.
    boxes = written.column("bbox").to_pylist()
    first, last = boxes[0], boxes[(COPIES - 1) * source.num_rows]
    east_m = (last["xmin"] - first["xmin"]) * metres_per_degree_lng(LAT0)
    assert abs(east_m - (COPIES - 1) * STEP_M) < 1.0, east_m

    del table  # only the written file is authoritative


# --- STAC manifest ----------------------------------------------------------


def write_stac(out_dir: Path, table: pa.Table) -> None:
    stac = json.loads((SOURCE / "metadata.json").read_text())
    boxes = [b for b in table.column("bbox").to_pylist() if b is not None]
    # The coordinates ARE lon/lat now, so the STAC extent needs no transform.
    lon0 = min(b["xmin"] for b in boxes)
    lat0 = min(b["ymin"] for b in boxes)
    lon1 = max(b["xmax"] for b in boxes)
    lat1 = max(b["ymax"] for b in boxes)
    zmin = min(b["zmin"] for b in boxes)
    zmax = max(b["zmax"] for b in boxes)
    stac["id"] = out_dir.name
    stac["bbox"] = [lon0, lat0, zmin, lon1, lat1, zmax]
    stac["geometry"] = {
        "type": "Polygon",
        "coordinates": [
            [
                [lon0, lat0],
                [lon1, lat0],
                [lon1, lat1],
                [lon0, lat1],
                [lon0, lat0],
            ]
        ],
    }
    stac["properties"]["city3d:city_objects"] = table.num_rows
    stac["properties"]["proj:code"] = f"EPSG:{TARGET_EPSG}"
    data = (out_dir / "building.parquet").read_bytes()
    checksum = "1220" + hashlib.sha256(data).hexdigest()
    for asset in stac["assets"].values():
        asset["file:size"] = len(data)
        asset["file:checksum"] = checksum
    (out_dir / "metadata.json").write_text(json.dumps(stac, indent=2) + "\n")


# --- Main -------------------------------------------------------------------


def main() -> None:
    source_file = pq.ParquetFile(SOURCE / "building.parquet")
    source = source_file.read()
    relocate = Relocate(source_centre(source))
    table = build_table(source, relocate)
    table = table.replace_schema_metadata(footer_metadata(source_file))

    OUT_DIR.mkdir(exist_ok=True)
    path = OUT_DIR / "building.parquet"
    pq.write_table(table, path, compression="zstd", store_schema=True)
    check(path, source, table)
    write_stac(OUT_DIR, table)
    boxes = pq.ParquetFile(path).read().column("bbox").to_pylist()
    print(
        f"{OUT_DIR.name}: {path.stat().st_size} B, {table.num_rows} rows, "
        f"lon {min(b['xmin'] for b in boxes):.6f}..{max(b['xmax'] for b in boxes):.6f}, "
        f"lat {min(b['ymin'] for b in boxes):.6f}..{max(b['ymax'] for b in boxes):.6f}"
    )


if __name__ == "__main__":
    main()
