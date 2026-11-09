import { ENGINE_VERSION } from "@haptic/core";
import { collectAssetDependencyMetadata } from "./asset-dependencies";
import {
  capsuleMesh,
  coneMesh,
  cubeMesh,
  cylinderMesh,
  discMesh,
  hemisphereMesh,
  planeMesh,
  pyramidMesh,
  sphereMesh,
  SUBDIVIDED_PLANE_QUADS,
  torusMesh,
  tubeMesh,
  wedgeMesh,
  type PrimitiveMesh,
} from "./editor-primitive-geometry";
import { encodeHasset } from "./hasset";
import type { ProjectTreeFile } from "./hproject";
import { encodeGlbJsonBin } from "./importers/glb-parse";
import { normalizeModelPayload } from "./model-payload";
import { bakeGltfOccluder } from "./occluder-bake";
import { createDefaultPluginSettings, encodePluginSettingsDocument } from "./plugin-settings";
import {
  cookGeneratedCollisionFromGltf,
  createDefaultSimpleCollider,
  type ModelSimpleCollider,
} from "./simple-collision";

export const EDITOR_PRIMITIVES_DISPLAY_NAME = "EditorPrimitives";
export const EDITOR_PRIMITIVES_PLUGIN_GUID = "c0ffee00-0001-4000-8000-000000000001";
const EDITOR_PRIMITIVES_SETTINGS_FILE = "editor-primitives.plugin.hasset";

/** A primitive's simple collision, in the loaded model's space; `generated` cooks the convex hull of the mesh. */
type PrimitiveCollision =
  | { kind: "box"; halfExtents: { x: number; y: number; z: number } }
  | { kind: "sphere"; radius: number }
  | { kind: "capsule"; radius: number; halfHeight: number }
  | { kind: "cylinder" | "cone"; radius: number; height: number }
  | { kind: "generated" };

export interface EditorPrimitive {
  /** Model asset name and file stem. */
  name: string;
  guid: string;
  mesh: () => PrimitiveMesh;
  collision: PrimitiveCollision;
  /** False where simplified LODs would remove the vertices the shape exists for. */
  autoLod: boolean;
}

/** Thin collision for the flat shapes, as an importer cooks a flat mesh. */
const FLAT_HALF_THICKNESS = 0.01;

function primitive(index: number, name: string, mesh: () => PrimitiveMesh, collision: PrimitiveCollision, autoLod = true): EditorPrimitive {
  return { name, guid: `c0ffee00-0001-4000-8000-${(0x100 + index).toString(16).padStart(12, "0")}`, mesh, collision, autoLod };
}

/** Every Model the plugin ships, in Content Browser order. Guids are stable: scenes reference them. */
export const EDITOR_PRIMITIVES: readonly EditorPrimitive[] = [
  primitive(1, "Cube", cubeMesh, { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } }),
  primitive(2, "Sphere", sphereMesh, { kind: "sphere", radius: 0.5 }),
  primitive(3, "Hemisphere", hemisphereMesh, { kind: "generated" }),
  primitive(4, "Cylinder", cylinderMesh, { kind: "cylinder", radius: 0.5, height: 1 }),
  primitive(5, "Cone", coneMesh, { kind: "cone", radius: 0.5, height: 1 }),
  primitive(6, "Capsule", capsuleMesh, { kind: "capsule", radius: 0.5, halfHeight: 0.5 }),
  primitive(7, "Torus", torusMesh, { kind: "generated" }),
  primitive(8, "Tube", tubeMesh, { kind: "cylinder", radius: 0.5, height: 1 }),
  primitive(9, "Pyramid", pyramidMesh, { kind: "generated" }),
  primitive(10, "Wedge", wedgeMesh, { kind: "generated" }),
  primitive(11, "Plane", () => planeMesh(1), { kind: "box", halfExtents: { x: 0.5, y: FLAT_HALF_THICKNESS, z: 0.5 } }),
  primitive(
    12,
    "SubdividedPlane",
    () => planeMesh(SUBDIVIDED_PLANE_QUADS),
    { kind: "box", halfExtents: { x: 0.5, y: FLAT_HALF_THICKNESS, z: 0.5 } },
    false,
  ),
  primitive(13, "Disc", discMesh, { kind: "cylinder", radius: 0.5, height: 2 * FLAT_HALF_THICKNESS }),
];

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/** One node, one mesh, one primitive and no material, so the Model's single slot 0 draws it. */
export function encodePrimitiveGlb(name: string, mesh: PrimitiveMesh): Uint8Array {
  const vertexCount = mesh.positions.length / 3;
  if (vertexCount > 0xffff) throw new Error(`${name} has more vertices than 16-bit indices reach`);
  const views: Array<{ data: Float32Array | Uint16Array; target: number }> = [
    { data: new Float32Array(mesh.positions), target: ARRAY_BUFFER },
    { data: new Float32Array(mesh.normals), target: ARRAY_BUFFER },
    { data: new Float32Array(mesh.uvs), target: ARRAY_BUFFER },
    { data: new Uint16Array(mesh.indices), target: ELEMENT_ARRAY_BUFFER },
  ];
  const bin = new Uint8Array(views.reduce((total, view) => total + Math.ceil(view.data.byteLength / 4) * 4, 0));
  const bufferViews: Record<string, unknown>[] = [];
  let offset = 0;
  for (const view of views) {
    bin.set(new Uint8Array(view.data.buffer, view.data.byteOffset, view.data.byteLength), offset);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: view.data.byteLength, target: view.target });
    offset += Math.ceil(view.data.byteLength / 4) * 4;
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const positions = views[0]!.data;
  for (let index = 0; index < positions.length; index++) {
    min[index % 3] = Math.min(min[index % 3]!, positions[index]!);
    max[index % 3] = Math.max(max[index % 3]!, positions[index]!);
  }
  return encodeGlbJsonBin(
    {
      asset: { version: "2.0", generator: "Haptic EditorPrimitives" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name, mesh: 0 }],
      meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] }],
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: vertexCount, type: "VEC3", min, max },
        { bufferView: 1, componentType: FLOAT, count: vertexCount, type: "VEC3" },
        { bufferView: 2, componentType: FLOAT, count: vertexCount, type: "VEC2" },
        { bufferView: 3, componentType: UNSIGNED_SHORT, count: mesh.indices.length, type: "SCALAR" },
      ],
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
    },
    bin,
  );
}

/** The collider id is the Model guid with the variant group bumped, so it stays stable and unique. */
function colliderId(modelGuid: string): string {
  return modelGuid.replace("-8000-", "-8001-");
}

function primitiveCollider(entry: EditorPrimitive, glb: Uint8Array): ModelSimpleCollider {
  const id = colliderId(entry.guid);
  const { collision } = entry;
  if (collision.kind === "generated") return cookGeneratedCollisionFromGltf(glb, { id });
  return { ...createDefaultSimpleCollider(collision.kind, { id }), ...collision };
}

async function encodePrimitiveModel(entry: EditorPrimitive): Promise<Uint8Array> {
  const glb = encodePrimitiveGlb(entry.name, entry.mesh());
  const payload = normalizeModelPayload({
    materialSlots: [{ index: 0, name: "Material", materialGuid: null }],
    clipNames: [],
    skeletonGuid: null,
    importScale: 1,
    simpleColliders: [primitiveCollider(entry, glb)],
    autoLod: entry.autoLod,
    occluder: bakeGltfOccluder(glb, 1),
  }) as unknown as Record<string, unknown>;
  return encodeHasset({
    header: {
      ...collectAssetDependencyMetadata("Model", payload, { dependencies: [] }),
      engineVersion: ENGINE_VERSION,
      guid: entry.guid,
      mode: "thin",
      name: entry.name,
      parentClass: null,
      payload,
      type: "Model",
      version: 1,
    },
    chunks: [{ id: "source", kind: "geometry", mime: "model/gltf-binary", data: glb }],
  });
}

/** Directory-form EditorPrimitives files (no plugin.json; discovery uses PluginSettings). */
export async function buildEditorPrimitivesFiles(): Promise<ProjectTreeFile[]> {
  const settings = createDefaultPluginSettings({
    pluginGuid: EDITOR_PRIMITIVES_PLUGIN_GUID,
    displayName: EDITOR_PRIMITIVES_DISPLAY_NAME,
  });
  settings.enabledByDefault = false;
  settings.iconKey = "Box";
  settings.description =
    "Basic shape Models for blocking out levels: Cube, Sphere, Hemisphere, Cylinder, Cone, Capsule, Torus, Tube, Pyramid, Wedge, Plane, SubdividedPlane and Disc.";
  settings.author = "Haptic";
  settings.category = "Engine";
  settings.engineVersion = ENGINE_VERSION;

  const files: ProjectTreeFile[] = [
    { path: EDITOR_PRIMITIVES_SETTINGS_FILE, data: await encodePluginSettingsDocument(settings) },
  ];
  for (const entry of EDITOR_PRIMITIVES) {
    files.push({ path: `assets/${entry.name}.hasset`, data: await encodePrimitiveModel(entry) });
  }
  return files;
}
