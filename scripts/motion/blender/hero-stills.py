"""Two key frames of the 3D film, to agree on the look before animating anything.

  Blender -b --python scripts/motion/blender/hero-stills.py -- <out-dir> [samples] [width] [engine CYCLES|BLENDER_EEVEE] [shots a,b]
Needs STILLS=<folder of UI pieces from scripts/capture-queue-stills.mjs> for shot b.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
import mascots as m

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
out_dir = argv[0] if argv else "/tmp"
samples = int(argv[1]) if len(argv) > 1 else 64
width = int(argv[2]) if len(argv) > 2 else 1920
engine = argv[3] if len(argv) > 3 else "CYCLES"
shots = (argv[4] if len(argv) > 4 else "a,b").split(",")
stills = os.environ.get("STILLS", "")
tag = "eevee" if engine == "BLENDER_EEVEE" else "cycles"


def render(name):
    bpy.context.scene.render.filepath = os.path.join(out_dir, f"hero-{name}-{tag}.png")
    bpy.ops.render.render(write_still=True)
    print("WROTE", bpy.context.scene.render.filepath)


if "a" in shots:
    # A. Meet your sidemates: the three in a row, room above them for the words.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    m.studio()
    m.build_nova((-0.95, 0.05, 0.0), yaw=math.radians(-10))
    pixel = m.build_pixel((0.0, -0.12, 0.0))
    m.build_scout((0.95, 0.05, 0.0), yaw=math.radians(10))
    m.camera(location=(0.0, -6.3, 1.05), target=(0.0, 0.0, 0.62), lens=60, fstop=4.5, focus_object=pixel["body"])
    m.render_settings(width=width, height=round(width * 9 / 16), samples=samples, engine=engine)
    render("a")

if "b" in shots and stills:
    # B. A real card, prepared and waiting: Pixel looks up at it, the other two lean in. Room on the left for the words.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    m.studio()
    pixel = m.build_pixel((0.75, -0.2, 0.0), yaw=math.radians(-4), gaze=(0.0, 0.035))
    m.build_nova((-0.02, 0.28, 0.0), yaw=math.radians(-20), gaze=(0.025, 0.03))
    m.build_scout((1.52, 0.28, 0.0), yaw=math.radians(20), gaze=(-0.025, 0.03))
    m.ui_panel(os.path.join(stills, "card-reply.png"), 1.22, (0.75, 0.22, 1.42), rotation=(math.radians(-6), 0, 0), name="card")
    cam = m.camera(location=(0.0, -7.0, 1.3), target=(0.55, 0.0, 0.85), lens=50, fstop=3.5, focus_object=pixel["body"])
    cam.data.shift_x = -0.12   # the group sits right of centre, leaving room for the words
    m.render_settings(width=width, height=round(width * 9 / 16), samples=samples, engine=engine)
    render("b")
