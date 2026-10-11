"""The three Sidemates teammates as glossy 3D characters, and a bright studio to put them in.

Run inside Blender (headless is fine):  Blender -b --python <script that imports this file>

Shapes, proportions and face positions come from the real 2D drawings in site/characters (100 x 100 units there,
1 unit = 1 cm here, so a body is about 65 cm wide). Nothing is downloaded and nothing needs an add-on.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

# ---------------------------------------------------------------- colours ----

def srgb(hex_string, mix_white=0.0):
    """'#6757d9' -> linear RGB tuple (Blender colour inputs are linear)."""
    h = hex_string.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [v + (1 - v) * mix_white for v in c]
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c)


BRAND = {"nova": "#6757d9", "pixel": "#d86889", "scout": "#299575"}
EXPOSURE = -0.7   # the lit characters sit a little lower, so their colours stay true; the white backdrop is boosted to compensate


def material(name, color, roughness=0.3, coat=0.0, coat_roughness=0.05, sss=0.0, sss_radius=(1.0, 0.4, 0.3),
             metallic=0.0, emission=None, emission_strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]

    def put(key, value):
        if key in b.inputs:
            b.inputs[key].default_value = value

    put("Base Color", (*color, 1.0))
    put("Roughness", roughness)
    put("Metallic", metallic)
    put("Coat Weight", coat)
    put("Coat Roughness", coat_roughness)
    put("Subsurface Weight", sss)
    put("Subsurface Radius", sss_radius)
    put("Subsurface Scale", 0.05)
    if emission:
        put("Emission Color", (*emission, 1.0))
        put("Emission Strength", emission_strength)
    return m


def vinyl(name, hex_string):
    """Soft glossy toy plastic: a little light travels under the surface, and a clear coat gives the highlights."""
    return material(name, srgb(hex_string), roughness=0.36, coat=0.55, coat_roughness=0.09, sss=0.05, sss_radius=(0.9, 0.35, 0.25))


def gloss_black(name="black"):
    """Deep black with a soft highlight (a mirror finish would reflect the white studio and look like chrome)."""
    m = material(name, (0.008, 0.008, 0.011), roughness=0.22, coat=0.0)
    b = m.node_tree.nodes["Principled BSDF"]
    if "Specular IOR Level" in b.inputs:
        b.inputs["Specular IOR Level"].default_value = 0.45
    return m


# ------------------------------------------------------------------ helpers --

def link(obj, collection=None):
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def smooth(obj):
    for poly in obj.data.polygons:
        poly.use_smooth = True


def new_mesh_object(name, bm):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    link(obj)
    smooth(obj)
    return obj


def sphere(name, radii, location=(0, 0, 0), segments=64, rings=32):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    for v in bm.verts:
        v.co.x *= radii[0]
        v.co.y *= radii[1]
        v.co.z *= radii[2]
        v.co += Vector(location)
    return new_mesh_object(name, bm)


def rounded_box(name, size, radius, location=(0, 0, 0), segments=14):
    """A pillow: a box whose every edge is rounded (the Nova body, side pods)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]
        v.co.y *= size[1]
        v.co.z *= size[2]
        v.co += Vector(location)
    obj = new_mesh_object(name, bm)
    bevel = obj.modifiers.new("round", "BEVEL")
    bevel.width = radius
    bevel.segments = segments
    bevel.limit_method = "NONE"
    bevel.use_clamp_overlap = True
    bevel.harden_normals = True
    return obj


def cylinder(name, radius, depth, location, segments=32):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius, depth=depth)
    for v in bm.verts:
        v.co += Vector(location)
    return new_mesh_object(name, bm)


def bake_modifiers(obj):
    """Apply modifiers so the shape can be ray-cast and parented plainly."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = bpy.data.meshes.new_from_object(evaluated)
    old = obj.data
    obj.modifiers.clear()
    obj.data = mesh
    bpy.data.meshes.remove(old)
    smooth(obj)


def surface_point(body, x, z, probe_y=-3.0):
    """Where a ray from the camera side hits this body (and only this body) at (x, z): (location, normal).
    Bodies are built at the origin with no transform, so object space is world space here."""
    hit, location, normal, _ = body.ray_cast(Vector((x, probe_y, z)), Vector((0, 1, 0)), distance=10.0)
    if not hit:
        raise RuntimeError(f"nothing to put a face on at x={x} z={z}")
    return location, normal.normalized()


def orient_to(obj, normal):
    """Local Z along the surface normal, local Y as upright as the surface allows."""
    obj.rotation_euler = normal.to_track_quat("Z", "Y").to_euler()


# ------------------------------------------------------------------ the rig --
# Each character: root (on the floor: where it stands, which way it faces, squash and stretch) -> pivot (in the
# middle of the body: flips, tilts, looking up) -> every visible part. Expressions that only show at moments (happy
# closed eyes, an open mouth) are built too, hidden at scale 0, so a film can swap them in.

PIVOTS = {}


def make_root(name, center_z=0.3):
    """Characters are built at the world origin (so faces can be ray-cast in plain coordinates) and moved into place at the end."""
    root = bpy.data.objects.new(name, None)
    root.empty_display_type = "PLAIN_AXES"
    link(root)
    pivot = bpy.data.objects.new(f"{name}_pivot", None)
    pivot.empty_display_type = "SPHERE"
    pivot.empty_display_size = 0.05
    link(pivot)
    pivot.location = (0, 0, center_z)
    pivot.parent = root
    PIVOTS[name] = pivot
    bpy.context.view_layer.update()
    return root


def attach(child, parent):
    """Parent without moving: the child keeps its place in the world."""
    bpy.context.view_layer.update()
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()


def adopt(root, obj):
    attach(obj, PIVOTS[root.name])


def place(root, location, yaw):
    root.location = location
    root.rotation_euler = Euler((0, 0, yaw))
    bpy.context.view_layer.update()


def flatten_base(bm, rz, keep=0.72, squash=0.3):
    """A soft, settled bottom, so a round body sits on the floor instead of balancing on a point."""
    for v in bm.verts:
        if v.co.z < -keep * rz:
            v.co.z = -keep * rz + (v.co.z + keep * rz) * squash


# --------------------------------------------------------------- face parts --

def stroke(name, body, points_xz, center_xz, mat, radius=0.0105, lift=0.0025):
    """A rounded line drawn on the body (the smile, closed happy eyes). Its origin is at center_xz, so it can pop in."""
    center, _ = surface_point(body, *center_xz)
    pts = []
    for x, z in points_xz:
        loc, nrm = surface_point(body, x, z)
        pts.append(loc + nrm * lift - center)
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 6
    curve.use_fill_caps = True
    spline = curve.splines.new("POLY")
    spline.points.add(len(pts) - 1)
    for p, co in zip(spline.points, pts):
        p.co = (*co, 1.0)
    obj = bpy.data.objects.new(name, curve)
    link(obj)
    obj.location = center
    obj.data.materials.append(mat)
    for end, co in (("a", pts[0]), ("b", pts[-1])):
        cap = sphere(f"{name}_cap_{end}", (radius, radius, radius), location=center + co, segments=16, rings=8)
        cap.data.materials.append(mat)
        attach(cap, obj)
    return obj


def open_mouth(name, body, center_xz, mat, width=0.062, depth=0.05, steps=24):
    """A happy open mouth (the drawing's "D"), bent onto the body so it sits in the face."""
    center, _ = surface_point(body, *center_xz)
    outline = []
    for i in range(steps + 1):
        a = math.pi + math.pi * i / steps                      # the round bottom, left to right
        outline.append((center_xz[0] + width * math.cos(a), center_xz[1] + 0.012 + depth * math.sin(a)))
    bm = bmesh.new()
    front, back = [], []
    for x, z in outline:
        loc, nrm = surface_point(body, x, z)
        front.append(bm.verts.new(loc + nrm * 0.0025 - center))
        back.append(bm.verts.new(loc - nrm * 0.01 - center))
    bm.faces.new(front)
    bm.faces.new(list(reversed(back)))
    n = len(front)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((front[i], back[i], back[j], front[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = new_mesh_object(name, bm)
    obj.location = center
    obj.data.materials.append(mat)
    return obj


def face(root, body, mats, eye_x=0.105, eye_z=0.31, eye_size=(0.034, 0.048), mouth=(0.045, 0.2, 0.057), mouth_z=0.205,
         cheek_z=0.21, cheek_x=0.205, cheek_size=(0.04, 0.02), gaze=(0.0, 0.0)):
    """Two glossy eyes, a smile and two cheeks, placed on the body surface the way the 2D drawings place them,
    plus happy closed eyes and an open mouth, hidden until a film shows them."""
    parts = {}
    for side, sx in (("l", -1), ("r", 1)):
        ex, ez = sx * eye_x + gaze[0], eye_z + gaze[1]
        loc, nrm = surface_point(body, ex, ez)
        eye = sphere(f"{root.name}_eye_{side}", (eye_size[0], eye_size[1], 0.014), location=(0, 0, 0))
        orient_to(eye, nrm)
        eye.location = loc - nrm * 0.004
        eye.data.materials.append(mats["eye"])
        adopt(root, eye)
        parts[f"eye_{side}"] = eye
        arch = [(ex + (t / 12 - 0.5) * 0.074, ez - 0.012 + 0.03 * math.sin(math.pi * t / 12)) for t in range(13)]
        happy = stroke(f"{root.name}_happy_{side}", body, arch, (ex, ez), mats["eye"], radius=0.0095)
        happy.scale = (0.0, 0.0, 0.0)
        adopt(root, happy)
        parts[f"happy_{side}"] = happy
        cloc, cnrm = surface_point(body, sx * cheek_x, cheek_z)
        cheek = sphere(f"{root.name}_cheek_{side}", (cheek_size[0], cheek_size[1], 0.007))
        orient_to(cheek, cnrm)
        cheek.location = cloc - cnrm * 0.004
        cheek.data.materials.append(mats["cheek"])
        adopt(root, cheek)
        parts[f"cheek_{side}"] = cheek
    # the smile: a quadratic curve like the drawing's "q6 5 12 -1", sampled onto the surface
    a, c, b = (-0.06, mouth_z + 0.0), (0.0, mouth_z - 0.05), (0.06, mouth_z - 0.007)
    pts = []
    for i in range(17):
        t = i / 16
        pts.append(((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]))
    smile = stroke(f"{root.name}_smile", body, pts, (0.0, mouth_z - 0.018), mats["eye"])
    adopt(root, smile)
    parts["smile"] = smile
    mouth_open = open_mouth(f"{root.name}_open", body, (0.0, mouth_z - 0.006), mats["mouth"])
    mouth_open.scale = (0.0, 0.0, 0.0)
    adopt(root, mouth_open)
    parts["open"] = mouth_open
    return parts


def mouth_material(name):
    """A soft, dark mouth: matte, so it never catches the studio lights and turns into an outline."""
    m = material(name, (0.05, 0.006, 0.014), roughness=0.92)
    b = m.node_tree.nodes["Principled BSDF"]
    if "Specular IOR Level" in b.inputs:
        b.inputs["Specular IOR Level"].default_value = 0.05
    return m


# ------------------------------------------------------------ the three one by one --

def build_nova(location=(0, 0, 0), yaw=0.0, gaze=(0.0, 0.0)):
    """The robot: a soft box with an antenna and two side pods (the drawing's 64 x 58 body, 20 unit corners).
    The pods hang from little shoulders, so they can wave like arms, and the antenna can wobble."""
    root = make_root("nova", center_z=0.31)
    mats = {"body": vinyl("nova_body", BRAND["nova"]), "eye": gloss_black("nova_eye"), "mouth": mouth_material("nova_mouth"),
            "cheek": material("nova_cheek", srgb(BRAND["nova"], 0.45), roughness=0.4, coat=0.2)}
    body = rounded_box("nova_body", (0.64, 0.44, 0.58), 0.19, location=(0, 0, 0.29))
    body.data.materials.append(mats["body"])
    bake_modifiers(body)
    adopt(root, body)
    arms = []
    for sx in (-1, 1):
        shoulder = bpy.data.objects.new(f"nova_arm_{'l' if sx < 0 else 'r'}", None)
        link(shoulder)
        shoulder.location = (sx * 0.31, 0.0, 0.37)
        adopt(root, shoulder)
        pod = rounded_box(f"nova_pod_{sx}", (0.125, 0.15, 0.22), 0.058, location=(sx * 0.355, 0.0, 0.29))
        pod.data.materials.append(mats["body"])
        bake_modifiers(pod)
        attach(pod, shoulder)
        arms.append(shoulder)
    antenna = bpy.data.objects.new("nova_antenna", None)
    link(antenna)
    antenna.location = (0, 0, 0.565)
    adopt(root, antenna)
    stem = cylinder("nova_stem", 0.022, 0.13, (0, 0.0, 0.625))
    stem.data.materials.append(mats["body"])
    attach(stem, antenna)
    ball = sphere("nova_ball", (0.052, 0.052, 0.052), location=(0, 0, 0.72))
    ball.data.materials.append(mats["body"])
    attach(ball, antenna)
    bpy.context.view_layer.update()
    parts = face(root, body, mats, eye_x=0.105, eye_z=0.31, mouth_z=0.205, cheek_x=0.205, cheek_z=0.21, gaze=gaze)
    place(root, location, yaw)
    return {"root": root, "pivot": PIVOTS["nova"], "body": body, "parts": parts, "mats": mats, "ball": ball, "stem": stem,
            "antenna": antenna, "arms": arms}


def build_pixel(location=(0, 0, 0), yaw=0.0, gaze=(0.0, 0.0)):
    """The blob: a soft egg, a little wider than tall, settled on its base."""
    root = make_root("pixel", center_z=0.26)
    mats = {"body": vinyl("pixel_body", BRAND["pixel"]), "eye": gloss_black("pixel_eye"), "mouth": mouth_material("pixel_mouth"),
            "cheek": material("pixel_cheek", srgb(BRAND["pixel"], 0.45), roughness=0.4, coat=0.2)}
    rx, ry, rz = 0.345, 0.31, 0.335
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=96, v_segments=48, radius=1.0)
    for v in bm.verts:
        v.co.x *= rx
        v.co.y *= ry
        v.co.z *= rz
        # a little lean to the upper left, like the drawing's soft egg
        v.co.x += 0.012 * (v.co.z / rz)
    flatten_base(bm, rz)
    for v in bm.verts:
        v.co.z += rz * 0.72 + 0.0
    body = new_mesh_object("pixel_body", bm)
    body.data.materials.append(mats["body"])
    adopt(root, body)
    bpy.context.view_layer.update()
    parts = face(root, body, mats, eye_x=0.105, eye_z=0.30, mouth_z=0.195, cheek_x=0.2, cheek_z=0.20, gaze=gaze)
    place(root, location, yaw)
    return {"root": root, "pivot": PIVOTS["pixel"], "body": body, "parts": parts, "mats": mats}


def leaf(name, material_, side, base=(0, 0.0, 0.54)):
    """One leaf: a flattened ellipsoid with a gentle bend, tilted out from the top of the body. Its origin is at the base."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=1.0)
    for v in bm.verts:
        v.co.x *= 0.17
        v.co.y *= 0.032
        v.co.z *= 0.085
        # a leaf that is fullest in the middle and pointed at the tip
        taper = 1.0 - 0.45 * max(0.0, (v.co.x / 0.17)) ** 2
        v.co.z *= taper
        v.co.x += 0.17  # the base sits at the origin
        v.co.y += 0.02 * (v.co.x / 0.34) ** 2  # curl a little toward the viewer's back
    obj = new_mesh_object(name, bm)
    obj.data.materials.append(material_)
    obj.location = base
    obj.rotation_euler = Euler((0, math.radians(-(48 if side > 0 else 132)), 0))
    return obj


def build_scout(location=(0, 0, 0), yaw=0.0, gaze=(0.0, 0.0)):
    """The sprout: a round-bottomed egg with two leaves that can sway."""
    root = make_root("scout", center_z=0.25)
    mats = {"body": vinyl("scout_body", BRAND["scout"]), "eye": gloss_black("scout_eye"), "mouth": mouth_material("scout_mouth"),
            "cheek": material("scout_cheek", srgb(BRAND["scout"], 0.5), roughness=0.4, coat=0.2)}
    mats["leaf"] = material("scout_leaf", srgb("#1f8a6a"), roughness=0.38, coat=0.7, coat_roughness=0.08, sss=0.2)
    rx, ry, rz = 0.33, 0.30, 0.30
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=96, v_segments=48, radius=1.0)
    for v in bm.verts:
        v.co.x *= rx
        v.co.y *= ry
        v.co.z *= rz
        # narrower at the top, rounder at the bottom
        up = max(0.0, v.co.z / rz)
        v.co.x *= 1.0 - 0.14 * up
        v.co.y *= 1.0 - 0.1 * up
    flatten_base(bm, rz)
    for v in bm.verts:
        v.co.z += rz * 0.72 + 0.0
    body = new_mesh_object("scout_body", bm)
    body.data.materials.append(mats["body"])
    adopt(root, body)
    leaves = []
    for name, side in (("scout_leaf_l", -1), ("scout_leaf_r", 1)):
        lf = leaf(name, mats["leaf"], side, base=(-0.012 if side < 0 else 0.012, 0.0, 0.5))
        adopt(root, lf)
        leaves.append(lf)
    bpy.context.view_layer.update()
    parts = face(root, body, mats, eye_x=0.105, eye_z=0.295, mouth_z=0.19, cheek_x=0.19, cheek_z=0.192, gaze=gaze)
    place(root, location, yaw)
    return {"root": root, "pivot": PIVOTS["scout"], "body": body, "parts": parts, "mats": mats, "leaves": leaves}


# ---------------------------------------------------------------- the stage --

def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def area_light(name, location, target, energy, size, size_y=None, color=(1, 1, 1), spread=math.radians(110)):
    light = bpy.data.lights.new(name, "AREA")
    light.energy = energy
    light.shape = "RECTANGLE"
    light.size = size
    light.size_y = size_y or size
    light.color = color
    light.spread = spread
    obj = bpy.data.objects.new(name, light)
    obj.location = location
    link(obj)
    look_at(obj, target)
    return obj


def studio(floor_gloss=0.06, world_strength=0.9, world_color=(0.93, 0.93, 0.95)):
    """A bright seamless studio: a glossy white floor that fades into a white world, with big soft lights.

    The world has two faces. What the lights "see" is a soft grey-white environment; what the camera sees is a clean
    white-to-pearl gradient, so the picture stays airy while the characters keep true colours."""
    scene = bpy.context.scene
    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    env = nodes["Background"]
    env.inputs["Color"].default_value = (*world_color, 1.0)
    env.inputs["Strength"].default_value = world_strength
    cam_bg = nodes.new("ShaderNodeBackground")
    ramp = nodes.new("ShaderNodeValToRGB")
    coord = nodes.new("ShaderNodeTexCoord")
    sep = nodes.new("ShaderNodeSeparateXYZ")
    path = nodes.new("ShaderNodeLightPath")
    mix = nodes.new("ShaderNodeMixShader")
    out = nodes["World Output"]
    links.new(coord.outputs["Generated"], sep.inputs["Vector"])
    links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], cam_bg.inputs["Color"])
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (1.0, 1.0, 1.0, 1.0)
    ramp.color_ramp.elements[1].position = 0.62
    ramp.color_ramp.elements[1].color = (0.915, 0.915, 0.945, 1.0)
    cam_bg.inputs["Strength"].default_value = 2.0 ** (-EXPOSURE)
    links.new(path.outputs["Is Camera Ray"], mix.inputs["Fac"])
    links.new(env.outputs["Background"], mix.inputs[1])
    links.new(cam_bg.outputs["Background"], mix.inputs[2])
    links.new(mix.outputs["Shader"], out.inputs["Surface"])
    scene.world = world
    floor_mat = material("floor", (0.93, 0.93, 0.95), roughness=floor_gloss, coat=0.0,
                         emission=(1.0, 1.0, 1.0), emission_strength=0.95)
    fb = floor_mat.node_tree.nodes["Principled BSDF"]
    if "Specular IOR Level" in fb.inputs:
        fb.inputs["Specular IOR Level"].default_value = 0.1   # a soft, faint reflection, like a lacquered table
    floor = cyclorama(floor_mat)
    area_light("key", (-3.4, -4.2, 5.2), (0, 0, 0.35), 900, 4.5, 3.2, color=(1.0, 0.985, 0.96))
    area_light("fill", (5.0, -4.5, 2.2), (0, 0, 0.3), 260, 6.0, 4.0, color=(0.96, 0.98, 1.0))
    area_light("rim", (1.5, 4.5, 3.0), (0, 0, 0.4), 420, 5.0, 2.0, color=(1.0, 1.0, 1.0))
    return floor


def cyclorama(mat, half_width=40.0, flat_to=5.0, radius=4.0, height=30.0, segments=48):
    """A photographer's seamless backdrop: the floor curves up into the wall, so there is no horizon line."""
    profile = [(-30.0, 0.0), (flat_to, 0.0)]
    for i in range(1, segments + 1):
        a = -math.pi / 2 + (math.pi / 2) * i / segments
        profile.append((flat_to + radius * math.cos(a), radius + radius * math.sin(a)))
    profile.append((flat_to + radius, height))
    bm = bmesh.new()
    rows = [(bm.verts.new((-half_width, y, z)), bm.verts.new((half_width, y, z))) for y, z in profile]
    for (a0, b0), (a1, b1) in zip(rows, rows[1:]):
        bm.faces.new((a0, b0, b1, a1))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = new_mesh_object("cyclorama", bm)
    obj.data.materials.append(mat)
    return obj


def ui_panel(path, width, location, rotation=(0.0, 0.0, 0.0), name="panel", strength=1.0):
    """A piece of the real screen (a PNG with rounded corners) standing in the scene, lit from inside like a display."""
    image = bpy.data.images.load(path)
    aspect = image.size[1] / image.size[0]
    bm = bmesh.new()
    bm.loops.layers.uv.new("UVMap")  # calc_uvs only fills a layer that exists
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5, calc_uvs=True)
    for v in bm.verts:   # the grid spans -0.5..0.5, so this makes the panel `width` metres wide
        v.co.x *= width
        v.co.y *= width * aspect
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    link(obj)
    obj.rotation_euler = Euler((math.radians(90), 0, 0))
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.interpolation = "Cubic"
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = (2.0 ** (-EXPOSURE)) * strength
    clear = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(tex.outputs["Color"], emit.inputs["Color"])
    nt.links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
    nt.links.new(clear.outputs["BSDF"], mix.inputs[1])
    nt.links.new(emit.outputs["Emission"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    obj.data.materials.append(mat)
    obj.location = location
    obj.rotation_euler = Euler((math.radians(90) + rotation[0], rotation[1], rotation[2]))
    return obj


def camera(location=(0.0, -6.8, 1.25), target=(0.0, 0.0, 0.34), lens=72.0, fstop=4.0, focus_object=None, focus_distance=None):
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = lens
    cam_data.sensor_width = 36.0
    cam_data.dof.use_dof = True
    cam_data.dof.aperture_fstop = fstop
    if focus_object is not None:
        cam_data.dof.focus_object = focus_object
    else:
        cam_data.dof.focus_distance = focus_distance or (Vector(location) - Vector(target)).length
    cam = bpy.data.objects.new("cam", cam_data)
    cam.location = location
    link(cam)
    look_at(cam, target)
    bpy.context.scene.camera = cam
    return cam


def render_settings(width=1920, height=1080, samples=96, engine="CYCLES", denoise=True):
    scene = bpy.context.scene
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.engine = engine
    if engine == "BLENDER_EEVEE":
        ee = scene.eevee
        settings = {
            "taa_render_samples": samples, "use_shadows": True, "shadow_ray_count": 4, "shadow_step_count": 16,
            "shadow_resolution_scale": 1.0, "use_raytracing": True, "ray_tracing_method": "SCREEN",
            "use_fast_gi": True, "fast_gi_method": "GLOBAL_ILLUMINATION", "fast_gi_resolution": "1",
            "fast_gi_ray_count": 4, "fast_gi_step_count": 12, "fast_gi_quality": 1.0, "fast_gi_distance": 1.5,
            "gi_cubemap_resolution": "1024", "clamp_surface_indirect": 8.0,
        }
        for key, value in settings.items():
            try:
                setattr(ee, key, value)
            except (AttributeError, TypeError, ValueError) as error:
                print("EEVEE setting skipped:", key, error)
        rt = ee.ray_tracing_options
        for key, value in {"resolution_scale": "1", "use_denoise": True, "denoise_spatial": True, "denoise_temporal": True,
                           "denoise_bilateral": True, "trace_max_roughness": 0.6, "screen_trace_quality": 1.0,
                           "screen_trace_thickness": 0.25}.items():
            try:
                setattr(rt, key, value)
            except (AttributeError, TypeError, ValueError) as error:
                print("EEVEE ray setting skipped:", key, error)
        scene.render.dither_intensity = 1.0
    if engine == "CYCLES":
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type != "CPU"
        scene.cycles.device = "GPU"
        scene.cycles.samples = samples
        scene.cycles.use_denoising = denoise
        scene.cycles.denoiser = "OPENIMAGEDENOISE"
        scene.cycles.max_bounces = 8
        scene.cycles.diffuse_bounces = 3
        scene.cycles.glossy_bounces = 4
        scene.cycles.transmission_bounces = 4
        scene.cycles.sample_clamp_indirect = 8.0
    for name in ("Khronos PBR Neutral", "AgX", "Standard"):
        try:
            scene.view_settings.view_transform = name
            break
        except TypeError:
            continue
    scene.view_settings.look = "None"
    scene.view_settings.exposure = EXPOSURE
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "16"
    scene.render.film_transparent = False
