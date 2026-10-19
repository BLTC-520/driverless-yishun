"""Build the explorer's vehicle models in Blender and export them as glTF binaries.

Writes web/public/models/{robotaxi,robovan,bus,skytruck}.glb (and, with --render, preview
PNGs into docs/img/models/). Everything is generated from code, so the models can be
rebuilt or restyled without hand-editing a .blend file. Low poly on purpose: hundreds of
these are drawn at once in the browser.

Conventions: metres, Blender Z up, vehicles face +X with the origin on the ground at the
centre of the footprint. The glTF exporter converts to Y up; the page rotates back.

Run on a Mac with Blender 4.2+ installed:
    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/blender/build_models.py
    ... -- --render            # also render preview images (Cycles, CPU)
Or with the `bpy` module from PyPI (pip install bpy):
    python tools/blender/build_models.py [--render]
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy  # first: with the PyPI bpy module, bmesh and mathutils exist only after it
import bmesh
from mathutils import Matrix

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "web" / "public" / "models"
PREVIEW = ROOT / "docs" / "img" / "models"

# The page's palette (web/src/index.html :root), so models and charts read as one system.
SODIUM = "#f2a53a"   # shuttles
BUS = "#52b6c7"      # buses
NSL = "#d9473a"      # MRT red, used for tail lights
CHALK = "#e9e6de"
CHAMPAGNE = "#cfae7c"  # satin gold body paint (robotaxi, robovan)
STEEL = "#b9bec6"      # brushed stainless (sky truck)
ION = "#7cc8ff"        # thruster glow
NIGHT = "#0c111b"


def srgb(h: str, a: float = 1.0) -> tuple[float, float, float, float]:
    """Hex sRGB -> linear RGBA, which is what Principled BSDF colour inputs expect."""
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return (*lin, a)


# ------------------------------------------------------------------ scene helpers
def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


_mats: dict[str, bpy.types.Material] = {}


def mat(name: str, color: str, metal: float = 0.0, rough: float = 0.5, emit: float = 0.0,
        alpha: float = 1.0) -> bpy.types.Material:
    """One Principled BSDF material; emit > 0 makes it glow (exported as glTF emissive),
    alpha < 1 makes it see-through (exported as glTF alpha blending)."""
    if name in _mats and _mats[name].name in bpy.data.materials:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = srgb(color)
    p.inputs["Metallic"].default_value = metal
    p.inputs["Roughness"].default_value = rough
    if emit:
        p.inputs["Emission Color"].default_value = srgb(color)
        p.inputs["Emission Strength"].default_value = emit
    if alpha < 1:
        p.inputs["Alpha"].default_value = alpha
        if hasattr(m, "surface_render_method"):  # Blender 4.2+
            m.surface_render_method = "BLENDED"
        else:
            m.blend_method = "BLEND"
    _mats[name] = m
    return m


def palette() -> dict[str, bpy.types.Material]:
    _mats.clear()
    return {
        "paint": mat("paint", CHAMPAGNE, metal=0.45, rough=0.3),
        "cream": mat("cream", "#e4d6bb", metal=0.2, rough=0.3),
        "white": mat("white", CHALK, metal=0.15, rough=0.32),
        "dark": mat("trim", "#1b2130", metal=0.3, rough=0.55),
        "glass": mat("glass", "#16243a", metal=0.6, rough=0.08),
        "tyre": mat("tyre", "#111318", rough=0.85),
        "rim": mat("rim", "#9aa3b2", metal=0.9, rough=0.3),
        "sodium": mat("sodium_led", SODIUM, emit=6.0),
        "teal": mat("teal_paint", BUS, metal=0.1, rough=0.4),
        "teal_led": mat("teal_led", BUS, emit=5.0),
        "head": mat("headlight", "#fff4dc", emit=8.0),
        "tail": mat("taillight", NSL, emit=5.0),
        "sensor": mat("sensor", "#0d1017", metal=0.5, rough=0.2),
        "cover": mat("cover", CHAMPAGNE, metal=0.45, rough=0.35),
        "steel": mat("steel", STEEL, metal=0.6, rough=0.4),
        "ion": mat("ion", ION, emit=10.0),
        "plume": mat("plume", ION, emit=6.0, alpha=0.42),
        "core": mat("plume_core", "#eef8ff", emit=12.0, alpha=0.8),
    }


def link(ob: bpy.types.Object) -> bpy.types.Object:
    bpy.context.collection.objects.link(ob)
    return ob


def box(name, size, loc, material, bevel=0.0, segments=3) -> bpy.types.Object:
    """Axis-aligned box of `size` (x, y, z) centred at `loc`, optionally with rounded edges."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    bmesh.ops.translate(bm, vec=loc, verts=bm.verts)
    if bevel:
        bmesh.ops.bevel(bm, geom=bm.edges[:] + bm.verts[:], offset=min(bevel, min(size) * 0.49),
                        segments=segments, affect="EDGES", profile=0.5)
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    me.materials.append(material)
    smooth(ob)
    return ob


def profile_body(name, pts_xz, width, material, bevel=0.0, y0=0.0) -> bpy.types.Object:
    """Extrude a closed side profile (x, z points, counter-clockwise) across the width."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    left = [bm.verts.new((x, y0 - width / 2, z)) for x, z in pts_xz]
    right = [bm.verts.new((x, y0 + width / 2, z)) for x, z in pts_xz]
    n = len(pts_xz)
    bm.faces.new(list(reversed(left)))
    bm.faces.new(right)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((left[i], left[j], right[j], right[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=3, affect="EDGES", profile=0.5)
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    me.materials.append(material)
    smooth(ob)
    return ob


def cylinder(name, radius, depth, loc, material, axis="Y", verts=20) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=radius, radius2=radius, depth=depth)
    rot = {"X": ("Y", math.pi / 2), "Y": ("X", math.pi / 2), "Z": ("Z", 0.0)}[axis]
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(rot[1], 3, rot[0]))
    bmesh.ops.translate(bm, vec=loc, verts=bm.verts)
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    me.materials.append(material)
    smooth(ob, angle=40)
    ax = "XYZ".index(axis)
    for p in me.polygons:      # flat caps: smoothing an n-gon cap shades it like a gear
        if abs(p.normal[ax]) > 0.9:
            p.use_smooth = False
    return ob


def torus(name, major, minor, loc, material, seg=28, ring=10) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    vs = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        row = []
        for j in range(ring):
            b = 2 * math.pi * j / ring
            r = major + minor * math.cos(b)
            row.append(bm.verts.new((loc[0] + r * math.cos(a), loc[1] + r * math.sin(a), loc[2] + minor * math.sin(b))))
        vs.append(row)
    for i in range(seg):
        for j in range(ring):
            bm.faces.new((vs[i][j], vs[(i + 1) % seg][j], vs[(i + 1) % seg][(j + 1) % ring], vs[i][(j + 1) % ring]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    me.materials.append(material)
    smooth(ob, angle=60)
    return ob


def smooth(ob: bpy.types.Object, angle: float = 35) -> None:
    """Smooth shading with hard edges kept above `angle` degrees (Blender 4.1+ API)."""
    for p in ob.data.polygons:
        p.use_smooth = True
    if hasattr(ob.data, "set_sharp_from_angle"):
        ob.data.set_sharp_from_angle(angle=math.radians(angle))


def wheels(xs, half_track, r, w, M) -> None:
    for i, x in enumerate(xs):
        for side in (-1, 1):
            cylinder(f"tyre_{i}_{side}", r, w, (x, side * half_track, r), M["tyre"])
            cylinder(f"hub_{i}_{side}", r * 0.55, w + 0.02, (x, side * half_track, r), M["rim"], verts=12)


def join_static(name: str, keep: tuple[bpy.types.Object, ...] = ()) -> bpy.types.Object:
    """Join every object except `keep` (animated parts) into one mesh: fewer draw calls."""
    obs = [o for o in bpy.context.scene.objects if o.type == "MESH" and o not in keep]
    bpy.ops.object.select_all(action="DESELECT")
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    body.name = name
    return body


# ------------------------------------------------------------------ shape helpers
def resample(stations, step):
    """Linearly interpolate stations every `step` metres, so face-painted edges come out fine."""
    out = [stations[0]]
    for a, b in zip(stations, stations[1:]):
        k = max(1, round(abs(a[0] - b[0]) / step))
        out += [tuple(u + (v - u) * i / k for u, v in zip(a, b)) for i in range(1, k + 1)]
    return out


def loft(name, stations, M, pick=None, ring=28, n=3.0, subdiv=1) -> bpy.types.Object:
    """A smooth body skinned over cross-sections, front (+x) to back.

    Each station is (x, z_bottom, z_top, half_width, half_width_at_top): a superellipse of
    exponent `n` (2 = ellipse, larger = boxier) that narrows towards the top, like a car's
    tumblehome. `pick(centre, normal) -> material key` paints faces by where they sit
    (glass band, dark sills); a subdivision modifier rounds it on export."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for x, zb, zt, w, wt in stations:
        zc, hz = (zb + zt) / 2, (zt - zb) / 2
        row = []
        for j in range(ring):
            a = 2 * math.pi * j / ring
            c, s = math.cos(a), math.sin(a)
            ey = math.copysign(abs(c) ** (2 / n), c)
            ez = math.copysign(abs(s) ** (2 / n), s)
            half = w + (wt - w) * max(s, 0.0)
            row.append(bm.verts.new((x, ey * half, zc + ez * hz)))
        rings.append(row)
    for a, b in zip(rings, rings[1:]):
        for j in range(ring):
            k = (j + 1) % ring
            bm.faces.new((a[j], a[k], b[k], b[j]))
    for row, x in ((rings[0], stations[0][0]), (rings[-1], stations[-1][0])):
        zc = (stations[0][1] + stations[0][2]) / 2 if row is rings[0] else (stations[-1][1] + stations[-1][2]) / 2
        hub = bm.verts.new((x, 0, zc))
        for j in range(ring):
            bm.faces.new((row[j], row[(j + 1) % ring], hub))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    keys = []
    for f in bm.faces:
        key = pick(f.calc_center_median(), f.normal) if pick else "paint"
        if key not in keys:
            keys.append(key)
        f.material_index = keys.index(key)
    bm.to_mesh(me)
    bm.free()
    for key in keys:
        me.materials.append(M[key])
    ob = link(bpy.data.objects.new(name, me))
    for p in me.polygons:
        p.use_smooth = True
    if subdiv:
        mod = ob.modifiers.new("round", "SUBSURF")
        mod.levels = mod.render_levels = subdiv
    return ob


def faceted(name, pts_xz, width, material, taper=lambda z: 1.0, grow=0.0) -> bpy.types.Object:
    """Flat-panelled body: a side profile extruded across the width, with the half-width
    scaled by `taper(z)` so the upper panels lean inwards. `grow` pads the half-width
    (used to sit glass a hair proud of the body)."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    left = [bm.verts.new((x, -(width / 2 * taper(z) + grow), z)) for x, z in pts_xz]
    right = [bm.verts.new((x, width / 2 * taper(z) + grow, z)) for x, z in pts_xz]
    bm.faces.new(list(reversed(left)))
    bm.faces.new(right)
    for i in range(len(pts_xz)):
        j = (i + 1) % len(pts_xz)
        bm.faces.new((left[i], left[j], right[j], right[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    me.materials.append(material)
    return ob  # flat shaded on purpose: the facets are the look


def cone(name, r_top, r_bottom, length, loc, material, axis="-Z", verts=16) -> bpy.types.Object:
    """A cone whose wide or narrow end sits at the object origin `loc` and extends `length`
    along `axis` (-Z down, -X backwards), so scaling it grows it away from the nozzle."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=r_bottom, radius2=r_top, depth=length)
    bmesh.ops.translate(bm, vec=(0, 0, -length / 2), verts=bm.verts)
    if axis == "-X":
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(-math.pi / 2, 3, "Y"))
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    ob.location = loc
    me.materials.append(material)
    for p in me.polygons:
        p.use_smooth = True
    return ob


def aero_wheels(xs, y_out, r, M, cover="cover") -> None:
    """Wheels for bodies that cover them: the tyre and a flat aero cover stand just proud of
    the body side, so they read as wheels without cutting arches."""
    for i, x in enumerate(xs):
        for side in (-1, 1):
            y = side * y_out
            cylinder(f"tyre_{i}_{side}", r, 0.2, (x, y + side * 0.03, r), M["tyre"], verts=32)
            cylinder(f"cover_{i}_{side}", r * 0.84, 0.02, (x, y + side * 0.135, r), M[cover], verts=32)


def loop_keys(ob, path, values, frames) -> None:
    """Keyframe `path` through `values` at `frames` (first == last for a seamless loop)."""
    for v, f in zip(values, frames):
        setattr(ob, path, v)
        ob.keyframe_insert(path, frame=f)
    linear(ob)
    bpy.context.scene.frame_start, bpy.context.scene.frame_end = frames[0], frames[-1]


def linear(ob) -> None:
    act = ob.animation_data.action
    fcurves = list(act.fcurves) if hasattr(act, "fcurves") else [  # Blender < 4.4 / layered actions
        fc for layer in act.layers for strip in layer.strips for bag in strip.channelbags for fc in bag.fcurves]
    for fc in fcurves:
        for k in fc.keyframe_points:
            k.interpolation = "LINEAR"


# ------------------------------------------------------------------ vehicles
def robotaxi() -> None:
    """Two-seat robotaxi coupe (4-seat scenario): a smooth champagne fastback with a glass
    windscreen and side glass, full-width light blade and flat aero wheel covers."""
    M = palette()
    body = [  # x, z bottom, z top, half-width, half-width at the top
        (2.30, 0.32, 0.60, 0.50, 0.42), (2.18, 0.24, 0.72, 0.84, 0.76), (1.85, 0.20, 0.80, 0.95, 0.88),
        (1.20, 0.20, 0.85, 0.98, 0.92), (0.00, 0.20, 0.88, 0.99, 0.93), (-1.20, 0.20, 0.92, 0.99, 0.93),
        (-1.85, 0.22, 0.94, 0.96, 0.90), (-2.15, 0.28, 0.92, 0.86, 0.80), (-2.30, 0.36, 0.86, 0.58, 0.52)]
    loft("body", resample(body, 0.2), M, n=3.4, ring=32, subdiv=0, pick=lambda c, nrm: "dark" if c.z < 0.3 else "paint")
    house = [
        (1.50, 0.70, 0.86, 0.86, 0.80), (1.00, 0.70, 1.06, 0.87, 0.72), (0.45, 0.72, 1.30, 0.87, 0.62),
        (-0.20, 0.74, 1.40, 0.87, 0.58), (-0.90, 0.76, 1.38, 0.87, 0.56), (-1.50, 0.78, 1.24, 0.85, 0.56),
        (-1.95, 0.80, 1.06, 0.80, 0.60), (-2.20, 0.82, 0.95, 0.68, 0.55)]

    def glass(c, nrm):
        if c.x > 0.3 and c.z > 0.86:
            return "glass"            # windscreen
        if -1.5 < c.x <= 0.3 and abs(c.y) > 0.5 and c.z > 0.9:
            return "glass"            # side windows
        return "paint"                # painted roof and fastback
    loft("greenhouse", resample(house, 0.2), M, n=2.4, ring=32, subdiv=0, pick=glass)
    box("blade", (0.16, 1.45, 0.03), (2.19, 0, 0.66), M["head"], bevel=0.012)
    box("tailblade", (0.12, 1.5, 0.035), (-2.22, 0, 0.8), M["tail"], bevel=0.012)
    aero_wheels((-1.45, 1.45), 0.9, 0.4, M)
    join_static("robotaxi")


def robovan() -> None:
    """20-seat robovan (10-seat shuttle scenario): a long cream capsule with a wraparound
    black glass band, light lines on the nose and a dark skirt; drives either way."""
    M = palette()
    hs = [(3.30, 0.95), (3.18, 1.55), (2.95, 1.95), (2.60, 2.22), (2.00, 2.35), (0.0, 2.38)]
    stations = [(x, 0.4 if abs(x) > 3.25 else 0.26, zt, 0.85 if abs(x) > 3.25 else 1.13,
                 0.8 if abs(x) > 3.25 else 1.04) for x, zt in hs]
    stations += [(-x, zb, zt, w, wt) for x, zb, zt, w, wt in reversed(stations[:-1])]

    def pick(c, nrm):
        if c.z < 0.5:
            return "dark"
        if 1.25 < c.z < 2.05 and abs(c.x) < 2.7:
            return "glass"            # side band
        if 1.05 < c.z < 2.1 and abs(c.x) >= 2.7:
            return "glass"            # wraparound front and rear
        return "cream"
    loft("body", resample(stations, 0.18), M, n=4.0, pick=pick, ring=40, subdiv=0)
    for s in (-1, 1):                 # light lines on both noses (front and sides), skirt LEDs, doors
        for k in range(4):
            z = 1.0 + 0.06 * k
            box(f"line_{s}_{k}", (0.03, 1.5 - 0.12 * k, 0.016), (s * 3.235, 0, z), M["head"], bevel=0.005, segments=1)
            for side in (-1, 1):
                box(f"sline_{s}_{k}_{side}", (0.9 - 0.12 * k, 0.02, 0.016), (s * (2.55 + 0.06 * k), side * 1.135, z),
                    M["head"], bevel=0.005, segments=1)
        box(f"skirt_led_{s}", (0.04, 1.5, 0.035), (s * 3.29, 0, 0.62), M["sodium"], bevel=0.012)
        box(f"door_{s}", (1.6, 0.025, 1.55), (0, s * 1.135, 1.28), M["glass"], bevel=0.04)
    aero_wheels((-2.2, 2.2), 1.02, 0.36, M, cover="dark")
    join_static("robovan")


def skytruck() -> None:
    """Decorative flying pickup: a faceted stainless body on four downward thrusters and a
    rear booster. The plumes are separate objects with a looping flicker animation."""
    M = palette()
    W = 2.02
    taper = lambda z: 1.0 if z < 1.0 else 1.0 - 0.16 * (z - 1.0) / 0.9   # sides lean in
    faceted("body", [(2.75, 0.42), (2.92, 0.62), (2.95, 0.98), (0.25, 1.90), (-2.85, 1.28),
                     (-2.92, 0.58), (-2.75, 0.42)], W, M["steel"], taper)
    faceted("glass", [(1.90, 1.30), (1.90, 1.353), (0.25, 1.918), (-1.10, 1.648), (-1.10, 1.30)],
            W, M["glass"], taper, grow=0.012)
    faceted("cladding", [(2.9, 0.40), (2.93, 0.62), (-2.93, 0.62), (-2.9, 0.40)], W, M["dark"], grow=0.015)
    box("lightbar", (0.04, 1.95, 0.035), (2.945, 0, 0.965), M["head"], bevel=0.01)
    box("taillight", (0.04, 1.95, 0.05), (-2.855, 0, 1.24), M["tail"], bevel=0.01)
    aero_wheels((-1.9, 1.9), 0.92, 0.44, M, cover="steel")
    plumes = []
    for i, (x, y) in enumerate([(1.95, 0.55), (1.95, -0.55), (-1.95, 0.55), (-1.95, -0.55)]):
        cone(f"nozzle_{i}", 0.24, 0.17, 0.28, (x, y, 0.42), M["dark"])
        cylinder(f"throat_{i}", 0.15, 0.02, (x, y, 0.13), M["ion"], axis="Z", verts=16)
        plumes.append(cone(f"plume_{i}", 0.16, 0.5, 2.8, (x, y, 0.13), M["plume"]))
        plumes.append(cone(f"core_{i}", 0.11, 0.06, 1.1, (x, y, 0.13), M["core"]))
    cone("booster", 0.3, 0.24, 0.3, (-2.9, 0, 0.85), M["dark"], axis="-X")
    plumes.append(cone("booster_plume", 0.22, 0.55, 2.4, (-3.2, 0, 0.85), M["plume"], axis="-X"))
    plumes.append(cone("booster_core", 0.16, 0.05, 1.0, (-3.2, 0, 0.85), M["core"], axis="-X"))
    for i, p in enumerate(plumes):    # flicker, out of phase per thruster
        a, b = (1.0, 1.0, 1.0), [(1.06, 1.06, 0.86), (0.95, 0.95, 1.12), (1.03, 1.03, 0.94)]
        seq = [a] + b[i % 3:] + b[:i % 3] + [a]
        loop_keys(p, "scale", seq, [1, 4, 7, 10, 13])
    join_static("skytruck", keep=tuple(plumes))


def bus() -> None:
    """12 m single-deck feeder bus in a neutral livery with the page's bus teal."""
    M = palette()
    L, W, H = 12.0, 2.5, 3.15
    box("body", (L, W, H - 0.38), (0, 0, 0.38 + (H - 0.38) / 2), M["white"], bevel=0.2)
    box("windows", (L - 1.6, W + 0.03, 1.05), (-0.45, 0, 2.05), M["glass"], bevel=0.08)
    box("windscreen", (0.08, W - 0.18, 1.7), (L / 2 + 0.01, 0, 1.85), M["glass"], bevel=0.05)
    box("rear_glass", (0.06, W - 0.5, 0.7), (-L / 2 - 0.01, 0, 2.3), M["glass"], bevel=0.04)
    box("band", (L + 0.02, W + 0.04, 0.42), (0, 0, 0.82), M["teal"], bevel=0.06)
    box("roofpod", (3.4, 1.8, 0.28), (-2.5, 0, H + 0.12), M["white"], bevel=0.1)
    box("sign", (0.06, 1.7, 0.26), (L / 2 + 0.03, 0, 2.86), M["sodium"], bevel=0.02)
    for s in (-1, 1):
        box(f"head_{s}", (0.05, 0.42, 0.14), (L / 2 + 0.02, s * 0.85, 0.85), M["head"], bevel=0.03)
        box(f"tail_{s}", (0.05, 0.28, 0.5), (-L / 2 - 0.02, s * 1.0, 1.0), M["tail"], bevel=0.03)
        box(f"door_{s}", (1.25, 0.04, 2.25), (4.4 if s > 0 else 0.4, -W / 2 - 0.01, 1.55), M["dark"], bevel=0.04)
    wheels((-3.0, 3.6), W / 2 - 0.22, 0.5, 0.34, M)
    join_static("bus")


# ------------------------------------------------------------------ export + preview
def export(name: str) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.glb"
    animated = any(o.animation_data for o in bpy.context.scene.objects)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", export_yup=True, export_apply=True,
        export_animations=animated, export_cameras=False, export_lights=False,
        export_extras=False, export_materials="EXPORT",
    )
    tris = sum(len(o.data.loop_triangles) or (o.data.calc_loop_triangles() or len(o.data.loop_triangles))
               for o in bpy.context.scene.objects if o.type == "MESH")
    print(f"{name}: {path.relative_to(ROOT)} {path.stat().st_size / 1024:.0f} KB, {tris} triangles")
    return path


def render_preview(name: str, length: float, hover: float = 0.0) -> None:
    """Three-quarter studio shot on a night-blue ground, like the page. `hover` lifts
    flying vehicles off the ground so their plumes show."""
    sc = bpy.context.scene
    for o in sc.objects:
        o.location.z += hover
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = srgb("#131a27")
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6
    sc.world = world
    ground = box("ground", (80, 80, 0.02), (0, 0, -0.01), mat("ground", NIGHT, rough=0.6))
    ground.data.materials[0] = mat("ground", NIGHT, rough=0.6)
    key = bpy.data.lights.new("key", "AREA")
    key.energy, key.size = 900 * (length / 5) ** 2, length
    k = link(bpy.data.objects.new("key", key))
    k.location = (length * 0.6, -length * 0.9, length * 1.1)
    k.rotation_euler = (math.radians(50), 0, math.radians(35))
    rim = bpy.data.lights.new("rim", "AREA")
    rim.energy, rim.size = 500 * (length / 5) ** 2, length
    rim.color = srgb(SODIUM)[:3]
    r = link(bpy.data.objects.new("rim", rim))
    r.location = (-length * 0.9, length * 0.8, length * 0.7)
    r.rotation_euler = (math.radians(-60), 0, math.radians(215))
    cam = bpy.data.cameras.new("cam")
    cam.lens = 50
    c = link(bpy.data.objects.new("cam", cam))
    d = length * 1.9
    c.location = (d * 0.78, -d * 0.82, d * 0.42)
    target = link(bpy.data.objects.new("target", None))
    target.location = (0, 0, length * 0.13 + 0.4 + hover * 0.6)
    c.location.z += hover * 0.5
    con = c.constraints.new("TRACK_TO")
    con.target = target
    sc.camera = c
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 64
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 960, 600
    sc.render.film_transparent = False
    sc.view_settings.view_transform = "AgX" if "AgX" in [v.identifier for v in
                                                        sc.view_settings.bl_rna.properties["view_transform"].enum_items] else "Filmic"
    PREVIEW.mkdir(parents=True, exist_ok=True)
    sc.frame_set(4)
    sc.render.filepath = str(PREVIEW / f"{name}.png")
    bpy.ops.render.render(write_still=True)
    print(f"  preview: {(PREVIEW / f'{name}.png').relative_to(ROOT)}")


BUILDERS = {"robotaxi": (robotaxi, 4.6, 0.0), "robovan": (robovan, 6.6, 0.0), "bus": (bus, 12.0, 0.0),
            "skytruck": (skytruck, 5.9, 2.6)}


def main() -> None:
    # inside Blender, sys.argv holds Blender's own flags; ours come after "--"
    argv = (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv
            else sys.argv[1:] if sys.argv[0].endswith(".py") else [])
    want_render = "--render" in argv
    only = [a for a in argv if not a.startswith("--")] or list(BUILDERS)
    for name in only:
        build, length, hover = BUILDERS[name]
        reset()
        build()
        export(name)
        if want_render:
            render_preview(name, length, hover)


if __name__ == "__main__":
    main()
