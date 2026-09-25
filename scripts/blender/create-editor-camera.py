"""Build the solid editor camera in Blender; export its source and runtime mesh.

Run this file in Blender or through Blender MCP with __file__ set.
Uses an isolated scene, -Y forward / Z up in Blender, +Z forward / Y up in Babylon.
"""
import json
from pathlib import Path

import bpy
from mathutils import Vector


def rectangle(width, height, corner):
    return [
        (-width + corner, -height), (width - corner, -height),
        (width, -height + corner), (width, height - corner),
        (width - corner, height), (-width + corner, height),
        (-width, height - corner), (-width, -height + corner),
    ]


scene = bpy.data.scenes.new("Slate Standard Camera")
bpy.context.window.scene = scene
# One closed silhouette: low tapered body with a directly attached solid lens.
rings = [
    (-.730, rectangle(.129, .110, .016)),
    (-.714, rectangle(.145, .126, .018)),
    (-.244, rectangle(.174, .154, .018)),
    (-.228, rectangle(.158, .138, .012)),
    (-.228, rectangle(.145, .104, .012)),
    (-.050, rectangle(.196, .118, .014)),
    (-.030, rectangle(.196, .118, .014)),
    (-.043, rectangle(.172, .094, .012)),
]
vertices = [(x, -z, y) for z, ring in rings for x, y in ring]
faces = [tuple(reversed(range(8)))]
for ring in range(len(rings) - 1):
    for i in range(8):
        faces.append((ring * 8 + i, ring * 8 + (i + 1) % 8,
                      (ring + 1) * 8 + (i + 1) % 8, (ring + 1) * 8 + i))
faces.append(tuple(range((len(rings) - 1) * 8, len(rings) * 8)))
mesh = bpy.data.meshes.new("Editor Camera")
mesh.from_pydata(vertices, [], faces)
mesh.update()
model = bpy.data.objects.new("Editor Camera", mesh)
scene.collection.objects.link(model)
bpy.context.view_layer.objects.active = model
model.select_set(True)
for name, color in [
    ("Slate Blue", (.27, .43, .61, 1)),
    ("Lens Housing", (.22, .34, .49, 1)),
    ("Lens Face", (.065, .105, .15, 1)),
]:
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    mesh.materials.append(material)
for polygon in mesh.polygons:
    if polygon.index >= 33:
        polygon.material_index = 1
mesh.polygons[-1].material_index = 2
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode="OBJECT")
mesh.calc_loop_triangles()
model["forward_axis"] = "-Y (Blender), +Z (Babylon)"
for area in bpy.context.screen.areas:
    if area.type == "VIEW_3D":
        space = area.spaces.active
        space.overlay.show_overlays = False
        space.shading.type = "SOLID"
        space.shading.color_type = "MATERIAL"
        space.region_3d.view_location = (0, .35, 0)
        space.region_3d.view_distance = 1.35
        space.region_3d.view_rotation = (
            Vector((0, .35, 0)) - Vector((1.05, -.65, .45))
        ).to_track_quat("-Z", "Y")

# Face shading is baked into vertex colors: one unlit material, no textures.
positions, colors, indices, lookup = [], [], [], {}
key_light = Vector((-.4, -.5, .8)).normalized()
for triangle in mesh.loop_triangles:
    polygon = mesh.polygons[triangle.polygon_index]
    color = mesh.materials[polygon.material_index].diffuse_color
    shade = .70 + .30 * max(0, polygon.normal.dot(key_light))
    rgb = tuple(round(c * shade * 255) for c in color[:3])
    face = []
    for vertex_index in triangle.vertices:
        v = mesh.vertices[vertex_index].co
        xyz = (round(v.x * 10000), round(v.z * 10000), round(-v.y * 10000))
        key = xyz + rgb
        if key not in lookup:
            lookup[key] = len(lookup)
            positions.extend(xyz)
            colors.extend(rgb)
        face.append(lookup[key])
    # The basis preserves handedness; reverse winding for Babylon's LH scene.
    indices.extend((face[0], face[2], face[1]))

repo = Path(__file__).resolve().parents[2]
target = repo / "packages/render/src/editor-camera-geometry.json"
target.write_text(json.dumps(
    {"positions": positions, "colors": colors, "indices": indices},
    separators=(",", ":"),
) + "\n")
source = repo / "engine-content/editor-models/camera.blend"
source.parent.mkdir(parents=True, exist_ok=True)
bpy.data.libraries.write(str(source), {scene}, compress=True)
print(json.dumps({"triangles": len(indices) // 3, "vertices": len(lookup),
                  "geometryBytes": target.stat().st_size}))
