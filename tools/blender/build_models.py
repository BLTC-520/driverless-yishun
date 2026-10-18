"""Build the explorer's vehicle models in Blender and export them as glTF binaries.

Writes web/public/models/{shuttle,robotaxi,bus,skycar}.glb (and, with --render, preview
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
CHALK = "#e9e6de"    # body paint
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


def mat(name: str, color: str, metal: float = 0.0, rough: float = 0.5, emit: float = 0.0) -> bpy.types.Material:
    """One Principled BSDF material; emit > 0 makes it glow (exported as glTF emissive)."""
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
    _mats[name] = m
    return m


def palette() -> dict[str, bpy.types.Material]:
    _mats.clear()
    return {
        "paint": mat("paint", CHALK, metal=0.15, rough=0.32),
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


# ------------------------------------------------------------------ vehicles
def shuttle() -> None:
    """10-seat autonomous shuttle pod: symmetric front and back, sodium light bars, roof lidar."""
    M = palette()
    L, W, H = 5.4, 2.15, 2.55
    box("lower", (L, W, 1.15), (0, 0, 0.42 + 0.575), M["paint"], bevel=0.24)
    box("glass", (L - 0.1, W - 0.06, 1.05), (0, 0, 1.55 + 0.42), M["glass"], bevel=0.22)
    box("roof", (L - 0.05, W - 0.02, 0.3), (0, 0, H - 0.15), M["paint"], bevel=0.14)
    box("skirt", (L - 0.5, W + 0.02, 0.22), (0, 0, 0.5), M["dark"], bevel=0.06)
    for s in (-1, 1):  # light bars wrap both ends: the pod drives either way
        box(f"bar_{s}", (0.06, W - 0.35, 0.09), (s * (L / 2 + 0.005), 0, 1.25), M["sodium"], bevel=0.03)
        box(f"waist_{s}", (L - 0.9, 0.04, 0.05), (0, s * (W / 2 + 0.005), 1.12), M["sodium"], bevel=0.02)
        box(f"door_{s}", (1.4, 0.03, 1.15), (0.25 * s, s * (W / 2 + 0.005), 1.0), M["glass"], bevel=0.05)
        box(f"seam_{s}", (0.03, 0.03, 1.15), (0.25 * s, s * (W / 2 + 0.01), 1.0), M["dark"])
    cylinder("lidar_base", 0.24, 0.12, (0, 0, H + 0.06), M["dark"], axis="Z")
    cylinder("lidar", 0.17, 0.2, (0, 0, H + 0.22), M["sensor"], axis="Z")
    cylinder("lidar_ring", 0.18, 0.04, (0, 0, H + 0.2), M["sodium"], axis="Z")
    for s in (-1, 1):
        box(f"cam_{s}", (0.18, 0.12, 0.12), (s * (L / 2 - 0.25), 0, H + 0.04), M["sensor"], bevel=0.04)
    wheels((-1.75, 1.75), W / 2 - 0.2, 0.38, 0.28, M)
    join_static("shuttle")


def robotaxi() -> None:
    """Two-seat-row robotaxi: a low wedge with a glass canopy and full-width light bars."""
    M = palette()
    W = 1.95
    body = [(-2.25, 0.32), (2.2, 0.32), (2.3, 0.62), (2.05, 0.82), (1.1, 0.95),
            (-1.7, 0.98), (-2.22, 0.88), (-2.3, 0.6)]
    profile_body("body", body, W, M["paint"], bevel=0.12)
    canopy = [(1.15, 0.9), (0.15, 1.42), (-0.9, 1.45), (-1.85, 0.98)]
    profile_body("canopy", canopy, W - 0.2, M["glass"], bevel=0.1)
    box("sill", (3.4, W + 0.02, 0.14), (0, 0, 0.38), M["dark"], bevel=0.05)
    box("headbar", (0.05, W - 0.25, 0.06), (2.27, 0, 0.66), M["head"], bevel=0.02)
    box("tailbar", (0.05, W - 0.25, 0.07), (-2.29, 0, 0.74), M["tail"], bevel=0.02)
    for s in (-1, 1):
        box(f"accent_{s}", (2.6, 0.03, 0.04), (0.1, s * (W / 2 + 0.005), 0.66), M["sodium"], bevel=0.015)
    cylinder("lidar", 0.12, 0.12, (-0.4, 0, 1.5), M["sensor"], axis="Z")
    wheels((-1.45, 1.45), W / 2 - 0.12, 0.36, 0.26, M)
    join_static("robotaxi")


def bus() -> None:
    """12 m single-deck feeder bus in a neutral livery with the page's bus teal."""
    M = palette()
    L, W, H = 12.0, 2.5, 3.15
    box("body", (L, W, H - 0.38), (0, 0, 0.38 + (H - 0.38) / 2), M["paint"], bevel=0.2)
    box("windows", (L - 1.6, W + 0.03, 1.05), (-0.45, 0, 2.05), M["glass"], bevel=0.08)
    box("windscreen", (0.08, W - 0.18, 1.7), (L / 2 + 0.01, 0, 1.85), M["glass"], bevel=0.05)
    box("rear_glass", (0.06, W - 0.5, 0.7), (-L / 2 - 0.01, 0, 2.3), M["glass"], bevel=0.04)
    box("band", (L + 0.02, W + 0.04, 0.42), (0, 0, 0.82), M["teal"], bevel=0.06)
    box("roofpod", (3.4, 1.8, 0.28), (-2.5, 0, H + 0.12), M["paint"], bevel=0.1)
    box("sign", (0.06, 1.7, 0.26), (L / 2 + 0.03, 0, 2.86), M["sodium"], bevel=0.02)
    for s in (-1, 1):
        box(f"head_{s}", (0.05, 0.42, 0.14), (L / 2 + 0.02, s * 0.85, 0.85), M["head"], bevel=0.03)
        box(f"tail_{s}", (0.05, 0.28, 0.5), (-L / 2 - 0.02, s * 1.0, 1.0), M["tail"], bevel=0.03)
        box(f"door_{s}", (1.25, 0.04, 2.25), (4.4 if s > 0 else 0.4, -W / 2 - 0.01, 1.55), M["dark"], bevel=0.04)
    wheels((-3.0, 3.6), W / 2 - 0.22, 0.5, 0.34, M)
    join_static("bus")


def skycar() -> None:
    """Decorative flying car: a sleek pod on four ducted fans with glowing rims.
    The rotors are separate objects with a looping spin animation exported in the glTF."""
    M = palette()
    W = 1.7
    body = [(-2.0, 0.55), (1.8, 0.5), (2.35, 0.78), (2.1, 1.0), (1.0, 1.1), (-1.6, 1.12), (-2.15, 0.95)]
    profile_body("hull", body, W, M["paint"], bevel=0.14)
    canopy = [(1.15, 1.05), (0.2, 1.58), (-0.8, 1.6), (-1.6, 1.1)]
    profile_body("canopy", canopy, W - 0.22, M["glass"], bevel=0.1)
    box("belly", (3.0, W - 0.5, 0.06), (0, 0, 0.5), M["teal_led"], bevel=0.03)
    box("headbar", (0.05, W - 0.3, 0.06), (2.33, 0, 0.82), M["head"], bevel=0.02)
    box("tailbar", (0.05, W - 0.3, 0.07), (-2.16, 0, 0.98), M["tail"], bevel=0.02)
    rotors = []
    fans = [(1.55, 1.55), (1.55, -1.55), (-1.45, 1.55), (-1.45, -1.55)]
    for i, (x, y) in enumerate(fans):
        z = 0.85
        box(f"arm_{i}", (0.22, abs(y) - 0.5, 0.12), (x, y / 2 + math.copysign(0.25, y), z), M["dark"], bevel=0.04)
        torus(f"duct_{i}", 0.62, 0.075, (x, y, z), M["dark"])
        torus(f"rim_{i}", 0.62, 0.035, (x, y, z - 0.1), M["sodium"], ring=6)
        cylinder(f"hubcap_{i}", 0.1, 0.16, (x, y, z), M["dark"], axis="Z", verts=12)
        rotor = box(f"rotor_{i}", (1.08, 0.12, 0.025), (0, 0, 0), M["rim"], bevel=0.01, segments=1)
        blade2 = box(f"rotor_{i}_b", (0.12, 1.08, 0.025), (0, 0, 0), M["rim"], bevel=0.01, segments=1)
        bpy.ops.object.select_all(action="DESELECT")
        rotor.select_set(True)
        blade2.select_set(True)
        bpy.context.view_layer.objects.active = rotor
        bpy.ops.object.join()
        rotor.location = (x, y, z + 0.02)
        spin(rotor, clockwise=(i in (0, 3)))
        rotors.append(rotor)
    join_static("skycar", keep=tuple(rotors))


def spin(ob: bpy.types.Object, clockwise: bool, frames: int = 12) -> None:
    """A seamless loop: one full turn over `frames` at 24 fps, linear, so the page can repeat it."""
    sign = -1 if clockwise else 1
    ob.rotation_euler = (0, 0, 0)
    ob.keyframe_insert("rotation_euler", index=2, frame=1)
    ob.rotation_euler = (0, 0, sign * 2 * math.pi)
    ob.keyframe_insert("rotation_euler", index=2, frame=1 + frames)
    fcurves = []
    act = ob.animation_data.action
    if hasattr(act, "fcurves"):           # Blender < 4.4
        fcurves = act.fcurves
    else:                                  # layered (slotted) actions
        for layer in act.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    fcurves.extend(bag.fcurves)
    for fc in fcurves:
        for k in fc.keyframe_points:
            k.interpolation = "LINEAR"
    bpy.context.scene.frame_start, bpy.context.scene.frame_end = 1, 1 + frames


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


def render_preview(name: str, length: float) -> None:
    """Three-quarter studio shot on a night-blue ground, like the page."""
    sc = bpy.context.scene
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
    target.location = (0, 0, length * 0.13 + 0.4)
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


BUILDERS = {"shuttle": (shuttle, 5.4), "robotaxi": (robotaxi, 4.6), "bus": (bus, 12.0), "skycar": (skycar, 4.8)}


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    want_render = "--render" in argv
    only = [a for a in argv if not a.startswith("--")] or list(BUILDERS)
    for name in only:
        build, length = BUILDERS[name]
        reset()
        build()
        export(name)
        if want_render:
            render_preview(name, length)


if __name__ == "__main__":
    main()
