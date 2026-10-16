"""Reduce a cityparquet export to its implicit geometries: per object the
template, the absolute reference point and the matrix; plus the templates."""
import json, sys
src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src))
scale, translate = d["transform"]["scale"], d["transform"]["translate"]
objects = {}
for oid, o in d["CityObjects"].items():
    for g in o.get("geometry", []):
        if g["type"] != "GeometryInstance":
            continue
        v = d["vertices"][g["boundaries"][0]]
        objects[oid] = {
            "template": g["template"],
            "point": [v[k] * scale[k] + translate[k] for k in range(3)],
            "transformationMatrix": g.get("transformationMatrix"),
        }
gt = d["geometry-templates"]
templates = [{"type": t["type"], "lod": t["lod"], "boundaries": t["boundaries"]} for t in gt["templates"]]
json.dump({"objects": objects, "templates": templates, "vertices-templates": gt["vertices-templates"]}, open(out, "w"), separators=(",", ":"))
