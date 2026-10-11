"""One still of the three teammates in the studio, to judge the look before building a film.

  Blender -b --python scripts/motion/blender/look-test.py -- out.png [samples] [width]
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
import mascots as m

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
out = argv[0] if argv else "/tmp/look-test.png"
samples = int(argv[1]) if len(argv) > 1 else 64
width = int(argv[2]) if len(argv) > 2 else 1920

bpy.ops.wm.read_factory_settings(use_empty=True)
m.studio()
nova = m.build_nova((-0.98, 0.0, 0.0), yaw=math.radians(-9))
pixel = m.build_pixel((0.0, -0.18, 0.0), yaw=0.0)
scout = m.build_scout((0.98, 0.0, 0.0), yaw=math.radians(9))
STILLS = os.environ.get("STILLS", "")
if STILLS:
    m.ui_panel(os.path.join(STILLS, "card-reply.png"), 0.9, (0.0, 0.55, 1.28), rotation=(math.radians(-6), 0, 0))
m.camera(location=(0.0, -6.8, 1.3), target=(0.0, 0.0, 0.34), lens=72, fstop=5.6, focus_object=pixel["body"])
m.render_settings(width=width, height=round(width * 9 / 16), samples=samples)
bpy.context.scene.render.filepath = out
bpy.ops.render.render(write_still=True)
print("WROTE", out)
