"""The "Waiting for you" film: Nova, Pixel and Scout in a white studio, with the real app screen. 24 fps, 31.5 s.

Every piece of app interface on screen is the app's own screen, captured unchanged by scripts/capture-queue-stills.mjs
from a sample studio (sample data). Nothing is redrawn. The cursor is drawn later, on top, at the real buttons' places:
this script writes where each button appears in every frame (targets.json).

  Blender -b --python scripts/motion/blender/film.py -- --stills DIR --out DIR [--width 1920] [--height 1080]
          [--samples 64] [--every 1] [--frames 1-756] [--targets PATH] [--aspect landscape|vertical] [--no-render]
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from bpy_extras import anim_utils
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Euler, Vector

import mascots as m

FPS = 24
DURATION = 31.5
LAST = int(round(DURATION * FPS))


def F(t):
    """Seconds to a frame number (frames start at 1)."""
    return int(round(t * FPS)) + 1


# ------------------------------------------------------------------ options --

def options():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    o = {"stills": "", "out": "/tmp/film", "width": 1920, "height": 1080, "samples": 64, "every": 1, "frames": "",
         "targets": "", "aspect": "landscape", "render": True}
    i = 0
    while i < len(argv):
        k = argv[i].lstrip("-")
        if k == "no-render":
            o["render"] = False
            i += 1
            continue
        v = argv[i + 1]
        i += 2
        o[k] = type(o[k])(v) if isinstance(o[k], int) else v
    return o


O = options()


# --------------------------------------------------------------- keyframes --

def channelbag(id_data):
    ad = id_data.animation_data
    if not ad or not ad.action:
        return None
    return anim_utils.action_get_channelbag_for_slot(ad.action, ad.action_slot)


def shape(id_data, data_path, frame, interp, easing):
    bag = channelbag(id_data)
    if not bag:
        return
    for fc in bag.fcurves:
        if fc.data_path != data_path:
            continue
        for kp in fc.keyframe_points:
            if abs(kp.co.x - frame) < 0.01:
                kp.interpolation = interp
                if easing:
                    kp.easing = easing


def key(obj, path, t, value, interp="BEZIER", easing=None):
    """Set obj.path = value at time t (seconds) and keep it there as a keyframe."""
    key_frame(obj, path, F(t), value, interp, easing)


def key_frame(obj, path, f, value, interp="BEZIER", easing=None):
    """The same, at an exact frame (for swaps that must happen between two neighbouring frames)."""
    target, attr = obj, path
    if "." in path:                      # e.g. "dof.aperture_fstop" on camera data
        head, attr = path.rsplit(".", 1)
        for part in head.split("."):
            target = getattr(target, part)
    setattr(target, attr, value)
    target.keyframe_insert(attr, frame=f)
    shape(obj if "." not in path else obj, path, f, interp, easing)


def key_value(node, t, value, interp="BEZIER", easing=None):
    f = F(t)
    node.outputs[0].default_value = value
    node.outputs[0].keyframe_insert("default_value", frame=f)
    shape(node.id_data, f'nodes["{node.name}"].outputs[0].default_value', f, interp, easing)


# ---------------------------------------------------------------- the stage --

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
scene.frame_start = 1
scene.frame_end = LAST
m.studio()

nova = m.build_nova((-0.95, 0.05, 0.0), yaw=math.radians(-10))
pixel = m.build_pixel((0.0, -0.12, 0.0))
scout = m.build_scout((0.95, 0.05, 0.0), yaw=math.radians(10))
CREW = {"nova": nova, "pixel": pixel, "scout": scout}
REST = {name: tuple(rig["root"].location) for name, rig in CREW.items()}

STILLS = O["stills"]
BOXES = json.load(open(os.path.join(STILLS, "boxes.json")))
PIECE_W = 1.3                       # every captured piece is 596 px wide in the app; on stage that is 1.3 m
M_PER_PX = PIECE_W / 596.0
SPOT = Vector((0.35, 0.25, 1.30))   # where a piece sits when it is the one being shown
EMIT = 2.0 ** (-m.EXPOSURE)


def rounded_alpha(nodes, links, uv, plane_w, plane_h, rect_w, rect_h, radius, inner, outer):
    """Alpha of a rounded rectangle (rect_w x rect_h, corner radius), soft between `inner` and `outer` metres from
    its edge, on a plane plane_w x plane_h whose UVs run 0..1."""
    sub = nodes.new("ShaderNodeVectorMath"); sub.operation = "SUBTRACT"; sub.inputs[1].default_value = (0.5, 0.5, 0.0)
    mul = nodes.new("ShaderNodeVectorMath"); mul.operation = "MULTIPLY"; mul.inputs[1].default_value = (plane_w, plane_h, 1.0)
    ab = nodes.new("ShaderNodeVectorMath"); ab.operation = "ABSOLUTE"
    q = nodes.new("ShaderNodeVectorMath"); q.operation = "SUBTRACT"; q.inputs[1].default_value = (rect_w / 2 - radius, rect_h / 2 - radius, 0.0)
    mx = nodes.new("ShaderNodeVectorMath"); mx.operation = "MAXIMUM"; mx.inputs[1].default_value = (0.0, 0.0, 0.0)
    ln = nodes.new("ShaderNodeVectorMath"); ln.operation = "LENGTH"
    sep = nodes.new("ShaderNodeSeparateXYZ")
    inner_max = nodes.new("ShaderNodeMath"); inner_max.operation = "MAXIMUM"
    inner_min = nodes.new("ShaderNodeMath"); inner_min.operation = "MINIMUM"; inner_min.inputs[1].default_value = 0.0
    add = nodes.new("ShaderNodeMath"); add.operation = "ADD"
    dist = nodes.new("ShaderNodeMath"); dist.operation = "SUBTRACT"; dist.inputs[1].default_value = radius
    edge = nodes.new("ShaderNodeMapRange"); edge.interpolation_type = "SMOOTHSTEP"
    edge.inputs[1].default_value = inner
    edge.inputs[2].default_value = outer
    edge.inputs[3].default_value = 1.0
    edge.inputs[4].default_value = 0.0
    links.new(uv, sub.inputs[0]); links.new(sub.outputs[0], mul.inputs[0]); links.new(mul.outputs[0], ab.inputs[0])
    links.new(ab.outputs[0], q.inputs[0]); links.new(q.outputs[0], mx.inputs[0]); links.new(mx.outputs[0], ln.inputs[0])
    links.new(q.outputs[0], sep.inputs[0]); links.new(sep.outputs["X"], inner_max.inputs[0]); links.new(sep.outputs["Y"], inner_max.inputs[1])
    links.new(inner_max.outputs[0], inner_min.inputs[0]); links.new(ln.outputs["Value"], add.inputs[0]); links.new(inner_min.outputs[0], add.inputs[1])
    links.new(add.outputs[0], dist.inputs[0]); links.new(dist.outputs[0], edge.inputs[0])
    return edge.outputs[0]


def plane(name, width, height):
    import bmesh
    bm = bmesh.new()
    bm.loops.layers.uv.new("UVMap")
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5, calc_uvs=True)
    for v in bm.verts:
        v.co.x *= width
        v.co.y *= height
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    return obj


def screen_piece(name, file, location, round_px=0, shadow=0.17, depth=0.0, zoom=1.0):
    """A piece of the real app screen, standing in the studio and lit from inside like a display. Starts invisible.
    `depth` keeps every piece a few millimetres apart, so two pieces never fight over the same spot; `zoom` shows a
    small piece (a single row) larger, the way a camera would move closer. The pixels are the app's own."""
    image = bpy.data.images.load(os.path.join(STILLS, file))
    px_w, px_h = image.size[0] / BOXES["scale"], image.size[1] / BOXES["scale"]
    width, height = px_w * M_PER_PX, px_h * M_PER_PX
    obj = plane(name, width, height)
    obj.rotation_euler = Euler((math.radians(90), 0, 0))
    obj.location = location
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    for n in list(nodes):
        nodes.remove(n)
    coord = nodes.new("ShaderNodeTexCoord")
    tex = nodes.new("ShaderNodeTexImage"); tex.image = image; tex.interpolation = "Cubic"
    emit = nodes.new("ShaderNodeEmission"); emit.inputs["Strength"].default_value = EMIT
    clear = nodes.new("ShaderNodeBsdfTransparent")
    mix = nodes.new("ShaderNodeMixShader")
    out = nodes.new("ShaderNodeOutputMaterial")
    opacity = nodes.new("ShaderNodeValue"); opacity.name = "opacity"; opacity.outputs[0].default_value = 0.0
    alpha = nodes.new("ShaderNodeMath"); alpha.operation = "MULTIPLY"
    links.new(coord.outputs["UV"], tex.inputs["Vector"])
    links.new(tex.outputs["Color"], emit.inputs["Color"])
    if round_px:
        corner = rounded_alpha(nodes, links, coord.outputs["UV"], width, height, width, height, round_px * M_PER_PX, -0.002, 0.0)
        rounded = nodes.new("ShaderNodeMath"); rounded.operation = "MULTIPLY"
        links.new(tex.outputs["Alpha"], rounded.inputs[0]); links.new(corner, rounded.inputs[1])
        links.new(rounded.outputs[0], alpha.inputs[0])
    else:
        links.new(tex.outputs["Alpha"], alpha.inputs[0])
    links.new(opacity.outputs[0], alpha.inputs[1])
    links.new(alpha.outputs[0], mix.inputs["Fac"])
    links.new(clear.outputs["BSDF"], mix.inputs[1]); links.new(emit.outputs["Emission"], mix.inputs[2])
    links.new(mix.outputs["Shader"], out.inputs["Surface"])
    obj.data.materials.append(mat)
    obj["px"] = (px_w, px_h)
    obj["size"] = (width, height)
    piece = {"obj": obj, "opacity": opacity, "width": width, "height": height, "file": file, "shadow": None,
             "depth": depth, "zoom": zoom}
    obj.scale = (zoom, zoom, zoom)
    if shadow:
        piece["shadow"] = drop_shadow(obj, width, height, (round_px or 22) * M_PER_PX, shadow)
    return piece


def drop_shadow(panel, width, height, radius, strength, blur=0.09):
    """A soft shadow behind a floating piece, the way the app's own windows float on a Mac. Follows the piece."""
    margin = blur * 2.2
    w, h = width + 2 * margin, height + 2 * margin
    obj = plane(panel.name + "_shadow", w, h)
    mat = bpy.data.materials.new(panel.name + "_shadow")
    mat.use_nodes = True
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    for n in list(nodes):
        nodes.remove(n)
    coord = nodes.new("ShaderNodeTexCoord")
    soft = rounded_alpha(nodes, links, coord.outputs["UV"], w, h, width, height, radius, -blur * 0.5, blur * 1.7)
    opacity = nodes.new("ShaderNodeValue"); opacity.name = "opacity"; opacity.outputs[0].default_value = 0.0
    a1 = nodes.new("ShaderNodeMath"); a1.operation = "MULTIPLY"; a1.inputs[1].default_value = strength
    a2 = nodes.new("ShaderNodeMath"); a2.operation = "MULTIPLY"
    black = nodes.new("ShaderNodeEmission"); black.inputs["Color"].default_value = (0.02, 0.02, 0.06, 1.0); black.inputs["Strength"].default_value = 0.0
    clear = nodes.new("ShaderNodeBsdfTransparent")
    mix = nodes.new("ShaderNodeMixShader")
    out = nodes.new("ShaderNodeOutputMaterial")
    links.new(soft, a1.inputs[0]); links.new(a1.outputs[0], a2.inputs[0]); links.new(opacity.outputs[0], a2.inputs[1])
    links.new(a2.outputs[0], mix.inputs["Fac"]); links.new(clear.outputs["BSDF"], mix.inputs[1]); links.new(black.outputs["Emission"], mix.inputs[2])
    links.new(mix.outputs["Shader"], out.inputs["Surface"])
    obj.data.materials.append(mat)
    obj.location = (0.0, -0.035, -0.06)     # in the piece's own frame: a little below, and behind it
    obj.parent = panel
    return {"obj": obj, "opacity": opacity}


def show(piece, t0, t1, v0, v1, interp="BEZIER"):
    """Fade a piece (and its shadow) from v0 at t0 to v1 at t1."""
    key_value(piece["opacity"], t0, v0, interp)
    key_value(piece["opacity"], t1, v1, interp)
    if piece["shadow"]:
        key_value(piece["shadow"]["opacity"], t0, v0, interp)
        key_value(piece["shadow"]["opacity"], t1, v1, interp)


def move(piece, t, location, interp="BEZIER", easing=None, scale=None):
    obj = piece["obj"]
    key(obj, "location", t, Vector(location), interp, easing)
    if scale is not None:
        s = scale * piece["zoom"]
        key(obj, "scale", t, Vector((s, s, s)), interp, easing)


def spot(piece):
    return SPOT + Vector((0.0, piece["depth"], 0.0))


def finalize_visibility(piece):
    """Leave a piece (and its shadow) out of the render whenever it is fully faded, so nothing invisible can get in
    the way of what is shown."""
    bag = channelbag(piece["opacity"].id_data)
    curve = next(fc for fc in bag.fcurves if fc.data_path == 'nodes["opacity"].outputs[0].default_value')
    previous = None
    for f in range(1, LAST + 1):
        visible = curve.evaluate(f) > 0.002
        if visible != previous:
            for obj in (piece["obj"], piece["shadow"]["obj"] if piece["shadow"] else None):
                if obj is not None:
                    obj.hide_render = not visible
                    obj.keyframe_insert("hide_render", frame=f)
            previous = visible


# ----------------------------------------------------------- the real screen --

# The full window, placed so its "Reply to Anna" card sits exactly where the lifted card will start.
win_card = BOXES["window"]["card-reply"]
vw, vh = BOXES["viewport"]["width"], BOXES["viewport"]["height"]
card_cx, card_cy = win_card["x"] + win_card["width"] / 2, win_card["y"] + win_card["height"] / 2
WIN_Y = 0.62
window_center = Vector((SPOT.x - (card_cx - vw / 2) * M_PER_PX, WIN_Y, SPOT.z + (card_cy - vh / 2) * M_PER_PX))
window = screen_piece("window", "window.png", window_center, round_px=14, shadow=0.12)
card_in_window = Vector((SPOT.x, WIN_Y - 0.004, SPOT.z))

reply = screen_piece("card_reply", "card-reply.png", card_in_window, depth=0.0)
done_reply = screen_piece("done_reply", "done-reply.png", SPOT, depth=-0.01, zoom=1.35)
offer = screen_piece("offer", "offer.png", SPOT, depth=-0.02, zoom=1.12)
rules = screen_piece("rules", "rules.png", SPOT, depth=-0.03, zoom=1.25)
done_gas = screen_piece("done_gas", "done-gas.png", SPOT, depth=-0.04, zoom=1.35)
undone_gas = screen_piece("undone_gas", "undone-gas.png", SPOT, depth=-0.05, zoom=1.35)
receipts = screen_piece("receipts", "receipts.png", SPOT, depth=-0.06, zoom=1.3)
PIECES = [window, reply, done_reply, offer, rules, done_gas, undone_gas, receipts]
for piece in PIECES:
    show(piece, 0.0, 0.01, 0.0, 0.0, "CONSTANT")

BELOW = Vector((0.0, 0.0, -0.22))

# the window rises in behind them, then dims while the card is shown, then leaves
move(window, 0.0, window_center + BELOW * 1.4)
move(window, 4.75, window_center + BELOW * 1.4)
move(window, 5.6, window_center, easing="EASE_OUT")
show(window, 4.75, 5.45, 0.0, 1.0)
show(window, 9.5, 10.3, 1.0, 0.28)
show(window, 13.2, 13.9, 0.28, 0.0)

# the reply card lifts out of the window towards us
key_value(reply["opacity"], 9.38, 0.0, "CONSTANT")
key_value(reply["opacity"], 9.4, 1.0)
move(reply, 0.0, card_in_window)
move(reply, 9.45, card_in_window, scale=1.0)
move(reply, 10.45, spot(reply), scale=1.0)
if reply["shadow"]:
    key_value(reply["shadow"]["opacity"], 9.45, 0.0)
    key_value(reply["shadow"]["opacity"], 10.3, 1.0)


def swap(a, b, t, dur=0.2):
    """The tapped piece gives way to what the app shows next, in the same place, with a small settle."""
    show(a, t, t + dur, 1.0, 0.0)
    show(b, t, t + dur, 0.0, 1.0)
    move(b, t, spot(b), scale=0.97)
    move(b, t + 0.32, spot(b), scale=1.0)


def enter(piece, t, dur=0.7):
    move(piece, 0.0, spot(piece) + BELOW)
    move(piece, t, spot(piece) + BELOW, scale=0.98)
    move(piece, t + dur, spot(piece), scale=1.0, easing="EASE_OUT")
    show(piece, t, t + dur * 0.8, 0.0, 1.0)


def leave(piece, t, dur=0.45):
    move(piece, t, spot(piece), scale=1.0)
    move(piece, t + dur, spot(piece) - BELOW * 0.6, scale=0.985)
    show(piece, t, t + dur, 1.0, 0.0)


CLICKS = [
    {"name": "Save draft", "piece": reply, "file": "card-reply", "t": 11.0},
    {"name": "Yes, do these automatically", "piece": offer, "file": "offer", "t": 16.2},
    {"name": "Undo", "piece": done_gas, "file": "done-gas", "t": 20.8},
    {"name": "Download the list", "piece": receipts, "file": "receipts", "t": 25.0},
]
swap(reply, done_reply, 11.12)
leave(done_reply, 13.2)
enter(offer, 13.55)
swap(offer, rules, 16.32)
leave(rules, 18.8)
enter(done_gas, 19.15)
swap(done_gas, undone_gas, 20.92)
leave(undone_gas, 22.75)
enter(receipts, 23.2)
leave(receipts, 26.6)
for piece in PIECES:
    finalize_visibility(piece)


# ------------------------------------------------------------ the teammates --

def hold_all(rig, t):
    """Pin everything that animates to its rest pose at t, so later moves start from rest."""
    root, pivot = rig["root"], rig["pivot"]
    key(root, "location", t, Vector(REST[root.name]))
    key(root, "scale", t, Vector((1, 1, 1)))
    key(pivot, "rotation_euler", t, Euler((0, 0, 0)))


def drop(rig, t, height=3.4):
    """Fall in from above the frame and land with a squash, a small rebound and a settle."""
    root = rig["root"]
    x, y, _ = REST[root.name]
    key(root, "location", 0.0, Vector((x, y, height)), "CONSTANT")
    key(root, "location", t, Vector((x, y, height)), "QUAD", "EASE_IN")
    key(root, "scale", t, Vector((0.9, 0.9, 1.14)))
    key(root, "location", t + 0.42, Vector((x, y, 0.0)), "BEZIER")
    key(root, "scale", t + 0.42, Vector((1.0, 1.0, 1.0)))
    key(root, "scale", t + 0.47, Vector((1.26, 1.26, 0.7)))
    key(root, "location", t + 0.5, Vector((x, y, 0.0)), "QUAD", "EASE_OUT")
    key(root, "scale", t + 0.58, Vector((0.94, 0.94, 1.08)))
    key(root, "location", t + 0.68, Vector((x, y, 0.09)), "QUAD", "EASE_IN")
    key(root, "location", t + 0.84, Vector((x, y, 0.0)))
    key(root, "scale", t + 0.86, Vector((1.08, 1.08, 0.92)))
    key(root, "scale", t + 1.0, Vector((1.0, 1.0, 1.0)))
    key(root, "location", t + 1.2, Vector((x, y, 0.0)))


def hop(rig, t, height=0.42, dur=0.62, squash=0.2):
    """Anticipate, push off, rise, fall, land with a squash, and settle."""
    root = rig["root"]
    x, y, _ = REST[root.name]
    s = squash
    key(root, "location", t - 0.12, Vector((x, y, 0.0)))
    key(root, "scale", t - 0.12, Vector((1, 1, 1)))
    key(root, "scale", t, Vector((1 + s * 0.7, 1 + s * 0.7, 1 - s)))
    key(root, "location", t, Vector((x, y, 0.0)))
    key(root, "location", t + 0.07, Vector((x, y, height * 0.18)), "QUAD", "EASE_OUT")
    key(root, "scale", t + 0.07, Vector((0.9, 0.9, 1.16)))
    key(root, "location", t + dur * 0.5, Vector((x, y, height)), "QUAD", "EASE_IN")
    key(root, "scale", t + dur * 0.5, Vector((0.98, 0.98, 1.03)))
    key(root, "location", t + dur, Vector((x, y, 0.0)))
    key(root, "scale", t + dur, Vector((1.0, 1.0, 1.0)))
    key(root, "scale", t + dur + 0.05, Vector((1 + s, 1 + s, 1 - s * 1.2)))
    key(root, "scale", t + dur + 0.16, Vector((0.96, 0.96, 1.05)))
    key(root, "scale", t + dur + 0.3, Vector((1, 1, 1)))
    key(root, "location", t + dur + 0.3, Vector((x, y, 0.0)))


def blink(rig, t):
    f = F(t)
    for side in ("l", "r"):
        eye = rig["parts"][f"eye_{side}"]
        key_frame(eye, "scale", f - 1, Vector((1, 1, 1)))
        key_frame(eye, "scale", f + 1, Vector((1.05, 0.08, 1)))
        key_frame(eye, "scale", f + 4, Vector((1, 1, 1)))


def happy(rig, t0, t1, mouth=True):
    """Closed happy eyes (and an open mouth) from t0 to t1. Swaps happen between two neighbouring frames."""
    parts = rig["parts"]
    f0, f1 = F(t0), F(t1)
    swaps = [(f"eye_{s}", False) for s in ("l", "r")] + [(f"happy_{s}", True) for s in ("l", "r")]
    if mouth:
        swaps += [("smile", False), ("open", True)]
    for name, shows in swaps:
        obj = parts[name]
        off, on = Vector((0, 0, 0)), Vector((1, 1, 1))
        if shows:
            key_frame(obj, "scale", f0 - 1, off, "CONSTANT")
            key_frame(obj, "scale", f0, on * 1.22)
            key_frame(obj, "scale", f0 + 3, on, "CONSTANT")
            key_frame(obj, "scale", f1 - 1, on, "CONSTANT")
            key_frame(obj, "scale", f1, off, "CONSTANT")
        else:
            key_frame(obj, "scale", f0 - 1, on, "CONSTANT")
            key_frame(obj, "scale", f0, off, "CONSTANT")
            key_frame(obj, "scale", f1, on, "CONSTANT")


def look(rig, t, pitch_deg, dur=0.5):
    """Tilt the whole body back (negative) to look up at the screen, like a small creature would."""
    pivot = rig["pivot"]
    key(pivot, "rotation_euler", t, Euler(tuple(pivot.rotation_euler)))
    key(pivot, "rotation_euler", t + dur, Euler((math.radians(pitch_deg), 0, 0)))


def wiggle(obj, t, axis, amount_deg, times=3, period=0.22, base=None):
    base = Euler(tuple(obj.rotation_euler)) if base is None else base
    key(obj, "rotation_euler", t, base)
    for i in range(times):
        e = Euler(tuple(base))
        e[axis] += math.radians(amount_deg * (1 if i % 2 == 0 else -1) * (1 - i / (times + 1)))
        key(obj, "rotation_euler", t + period * (i + 0.5), e)
    key(obj, "rotation_euler", t + period * (times + 0.5), base)


def backflip(rig, t, dur=1.0, height=0.55):
    """Nova's rewind: a backward somersault on the spot."""
    root, pivot = rig["root"], rig["pivot"]
    x, y, _ = REST[root.name]
    key(root, "location", t - 0.12, Vector((x, y, 0.0)))
    key(root, "scale", t - 0.12, Vector((1, 1, 1)))
    key(root, "scale", t, Vector((1.15, 1.15, 0.8)))
    key(root, "location", t, Vector((x, y, 0.0)), "QUAD", "EASE_OUT")
    key(root, "scale", t + 0.08, Vector((0.92, 0.92, 1.12)))
    key(root, "location", t + dur * 0.5, Vector((x, y, height)), "QUAD", "EASE_IN")
    key(root, "location", t + dur, Vector((x, y, 0.0)))
    key(root, "scale", t + dur - 0.02, Vector((1, 1, 1)))
    key(root, "scale", t + dur + 0.05, Vector((1.2, 1.2, 0.78)))
    key(root, "scale", t + dur + 0.2, Vector((0.97, 0.97, 1.04)))
    key(root, "scale", t + dur + 0.34, Vector((1, 1, 1)))
    start = Euler(tuple(pivot.rotation_euler))
    key(pivot, "rotation_euler", t + 0.02, start, "CUBIC", "EASE_IN_OUT")
    key(pivot, "rotation_euler", t + dur - 0.04, Euler((start.x - math.tau, 0, 0)), "CONSTANT")
    key(pivot, "rotation_euler", t + dur + 0.05, start)   # the same pose, without the extra turn


# drop in, one after another
for name, t in (("nova", 0.45), ("pixel", 0.8), ("scout", 1.15)):
    rig = CREW[name]
    key(rig["pivot"], "rotation_euler", 0.0, Euler((0, 0, 0)))
    drop(rig, t)
for name, times in (("nova", (2.2, 6.4, 12.6, 17.9, 24.1, 30.4)), ("pixel", (2.9, 7.5, 15.3, 19.7, 26.2, 30.9)),
                    ("scout", (3.6, 8.2, 14.0, 22.1, 27.4))):
    for t in times:
        blink(CREW[name], t)

# they look up at the screen when it arrives, and keep watching it
look(nova, 5.1, -13)
look(pixel, 5.3, -11)
look(scout, 5.5, -13)

# Pixel is delighted that the reply is a draft
hop(pixel, 11.2)
happy(pixel, 11.2, 12.4)
nova_antenna = nova["antenna"]
wiggle(nova_antenna, 11.3, 1, 16, times=4, base=Euler((0, 0, 0)))
# Scout cheers when the offer is accepted, leaves swaying
hop(scout, 16.42)
happy(scout, 16.42, 17.6)
for i, lf in enumerate(scout["leaves"]):
    wiggle(lf, 16.42, 1, 18 if i else -18, times=4, period=0.2)
# Nova rewinds when something is undone
backflip(nova, 21.0)
happy(nova, 21.0, 22.1)
# a small bounce when the list is ready
for name, t in (("pixel", 25.15), ("nova", 25.25), ("scout", 25.35)):
    hop(CREW[name], t, height=0.12, dur=0.36, squash=0.1)

# the close: everyone faces us again, hops, and Nova waves
for name in CREW:
    look(CREW[name], 26.9, 0, dur=0.3)
for name, t in (("nova", 27.7), ("pixel", 27.9), ("scout", 28.1)):
    hop(CREW[name], t, height=0.36, dur=0.58)
    happy(CREW[name], t, t + 1.9)
for i, arm in enumerate(nova["arms"]):
    up = 120 if i == 0 else -120
    key(arm, "rotation_euler", 27.5, Euler((0, 0, 0)))
    key(arm, "rotation_euler", 27.8, Euler((0, math.radians(up), 0)))
    for n in range(4):
        key(arm, "rotation_euler", 28.0 + n * 0.22, Euler((0, math.radians(up + (18 if n % 2 == 0 else -18) * (1 if i == 0 else -1)), 0)))
    key(arm, "rotation_euler", 29.0, Euler((0, math.radians(up), 0)))
    key(arm, "rotation_euler", 29.4, Euler((0, 0, 0)))
for i, lf in enumerate(scout["leaves"]):
    wiggle(lf, 28.1, 1, 16 if i else -16, times=4, period=0.22)


# ------------------------------------------------------------------ camera --

cam_data = bpy.data.cameras.new("cam")
cam_data.sensor_width = 36.0
cam_data.dof.use_dof = True
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
target = bpy.data.objects.new("cam_target", None)
scene.collection.objects.link(target)
track = cam.constraints.new("TRACK_TO")
track.target = target
track.track_axis = "TRACK_NEGATIVE_Z"
track.up_axis = "UP_Y"
cam_data.dof.focus_object = target

VERTICAL = O["aspect"] == "vertical"
# shots: (time, camera, target, lens, shift_x, shift_y, f-stop, interpolation to the next key)
if not VERTICAL:
    SHOTS = [
        (0.0, (0.0, -6.4, 1.05), (0.0, 0.0, 0.6), 60, 0.0, 0.0, 4.5, "BEZIER"),
        (4.5 - 1 / FPS, (0.0, -6.05, 1.02), (0.0, 0.0, 0.6), 60, 0.0, 0.0, 4.5, "CONSTANT"),
        (4.5, (0.05, -7.3, 1.42), (0.05, 0.3, 1.28), 50, -0.17, 0.0, 5.6, "BEZIER"),
        (9.3, (0.1, -6.9, 1.42), (0.1, 0.3, 1.28), 50, -0.17, 0.0, 5.6, "BEZIER"),
        (10.6, (0.62, -4.95, 1.22), (0.36, 0.25, 0.98), 50, -0.15, 0.0, 4.0, "BEZIER"),
        (13.4, (0.55, -4.8, 1.21), (0.35, 0.25, 0.97), 50, -0.15, 0.0, 4.0, "BEZIER"),
        (18.9, (0.66, -4.7, 1.2), (0.36, 0.25, 0.97), 50, -0.15, 0.0, 4.0, "BEZIER"),
        (22.9, (0.52, -4.65, 1.21), (0.35, 0.25, 0.97), 50, -0.15, 0.0, 4.0, "BEZIER"),
        (27.0 - 1 / FPS, (0.58, -4.5, 1.21), (0.35, 0.25, 0.97), 50, -0.15, 0.0, 4.0, "CONSTANT"),
        (27.0, (0.0, -6.3, 1.02), (0.0, 0.0, 0.6), 60, 0.0, 0.0, 4.5, "BEZIER"),
        (DURATION, (0.0, -5.85, 1.0), (0.0, 0.0, 0.6), 60, 0.0, 0.0, 4.5, "BEZIER"),
    ]
else:
    SHOTS = [
        (0.0, (0.0, -7.6, 1.15), (0.0, 0.0, 0.85), 50, 0.0, -0.12, 4.5, "BEZIER"),
        (4.5 - 1 / FPS, (0.0, -7.2, 1.12), (0.0, 0.0, 0.85), 50, 0.0, -0.12, 4.5, "CONSTANT"),
        (4.5, (0.0, -8.6, 1.5), (0.0, 0.3, 1.2), 50, 0.0, -0.1, 5.6, "BEZIER"),
        (9.3, (0.05, -8.2, 1.5), (0.05, 0.3, 1.2), 50, 0.0, -0.1, 5.6, "BEZIER"),
        (10.6, (0.4, -5.2, 1.45), (0.35, 0.25, 1.05), 50, 0.0, -0.12, 2.8, "BEZIER"),
        (13.4, (0.36, -5.05, 1.44), (0.35, 0.25, 1.05), 50, 0.0, -0.12, 2.8, "BEZIER"),
        (18.9, (0.44, -4.95, 1.42), (0.35, 0.25, 1.04), 50, 0.0, -0.12, 2.8, "BEZIER"),
        (22.9, (0.34, -4.9, 1.44), (0.35, 0.25, 1.05), 50, 0.0, -0.12, 2.8, "BEZIER"),
        (27.0 - 1 / FPS, (0.38, -4.8, 1.44), (0.35, 0.25, 1.05), 50, 0.0, -0.12, 2.8, "CONSTANT"),
        (27.0, (0.0, -7.4, 1.12), (0.0, 0.0, 0.85), 50, 0.0, -0.12, 4.5, "BEZIER"),
        (DURATION, (0.0, -7.0, 1.1), (0.0, 0.0, 0.85), 50, 0.0, -0.12, 4.5, "BEZIER"),
    ]
for t, c, g, lens, sx, sy, fstop, interp in SHOTS:
    key(cam, "location", t, Vector(c), interp)
    key(target, "location", t, Vector(g), interp)
    key(cam_data, "lens", t, lens, interp)
    key(cam_data, "shift_x", t, sx, interp)
    key(cam_data, "shift_y", t, sy, interp)
    key(cam_data, "dof.aperture_fstop", t, fstop, interp)

m.render_settings(width=O["width"], height=O["height"], samples=O["samples"], engine="BLENDER_EEVEE")


# ----------------------------------------------- where the real buttons are --

def control_point(piece, file, label):
    c = BOXES["pieces"][file]["controls"][label]
    return Vector(((c["u"] - 0.5) * piece["width"], (0.5 - c["v"]) * piece["height"], 0.0))


targets = {"fps": FPS, "frames": LAST, "width": O["width"], "height": O["height"], "clicks": []}
for click in CLICKS:
    local = control_point(click["piece"], click["file"], click["name"])
    entry = {"name": click["name"], "click": F(click["t"]), "from": F(click["t"] - 1.5), "to": F(click["t"] + 0.8), "points": {}}
    for f in range(entry["from"], entry["to"] + 1):
        scene.frame_set(f)
        world = click["piece"]["obj"].matrix_world @ local
        ndc = world_to_camera_view(scene, cam, world)
        entry["points"][str(f)] = [round(ndc.x, 5), round(1.0 - ndc.y, 5)]
    targets["clicks"].append(entry)
scene.frame_set(1)
if O["targets"]:
    with open(O["targets"], "w") as handle:
        json.dump(targets, handle)
    print("TARGETS", O["targets"])


# ------------------------------------------------------------------- render --

if O["render"]:
    os.makedirs(O["out"], exist_ok=True)
    scene.render.filepath = os.path.join(O["out"], "f_")
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"
    scene.render.use_overwrite = False
    scene.render.use_placeholder = True
    if O["frames"]:
        a, b = (int(x) for x in O["frames"].split("-"))
        scene.frame_start, scene.frame_end = a, b
    scene.frame_step = max(1, O["every"])
    bpy.ops.render.render(animation=True)
    print("RENDERED", O["out"])
