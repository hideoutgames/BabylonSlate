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
    (-.664, rectangle(.119, .123, .016)),
    (-.648, rectangle(.133, .141, .018)),
    (-.178, rectangle(.160, .173, .018)),
    (-.162, rectangle(.151, .155, .012)),
    (-.162, rectangle(.133, .130, .012)),
    (-.050, rectangle(.180, .145, .014)),
    (-.030, rectangle(.180, .145, .014)),
    (-.043, rectangle(.158, .118, .012)),
]
vertices = [(x, -z, y) for z, ring in rings for x, y in ring]
faces = [tuple(reversed(range(8)))]
material_indices = [0]
for ring in range(len(rings) - 1):
    for i in range(8):
        # Replace the body's top face with an inset solid grip, not a bridge.
        if ring == 1 and i == 4:
            continue
        faces.append((ring * 8 + i, ring * 8 + (i + 1) % 8,
                      (ring + 1) * 8 + (i + 1) % 8, (ring + 1) * 8 + i))
        material_indices.append(1 if ring >= 4 else 0)
faces.append(tuple(range((len(rings) - 1) * 8, len(rings) * 8)))
material_indices.append(2)

# A shallow, solid top grip grows directly from the body, with sloped ends.
def grip_vertex(x, z, rise):
    top = .141 + (z + .648) / .470 * .032
    return (x, -z, top + rise)


grip_base = len(vertices)
vertices.extend(grip_vertex(x, z, 0) for x, z in [
    (.053, -.558), (-.053, -.558), (-.053, -.266), (.053, -.266),
])
grip_top = len(vertices)
vertices.extend(grip_vertex(x, z, .035) for x, z in [
    (.040, -.528), (-.040, -.528), (-.040, -.286), (.040, -.286),
])
outer = (12, 13, 21, 20)
for i in range(4):
    j = (i + 1) % 4
    faces.append((outer[i], outer[j], grip_base + j, grip_base + i))
    faces.append((grip_base + i, grip_base + j, grip_top + j, grip_top + i))
    material_indices.extend((0, 0))
faces.append(tuple(range(grip_top, grip_top + 4)))
material_indices.append(0)
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
for polygon, material_index in zip(mesh.polygons, material_indices):
    polygon.material_index = material_index
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
