import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { decodeAssetDocument } from "./asset-document";
import { buildEditorPrimitivesFiles, EDITOR_PRIMITIVES_PLUGIN_GUID } from "./editor-primitives";
import type { ProjectTreeFile } from "./hproject";
import { extractGltfCollisionMesh } from "./glb-geometry";
import { decodeHassetChunk, readHassetHeader } from "./hasset";
import { normalizeModelPayload } from "./model-payload";
import { discoverEnginePlugins } from "./plugin-host";
import { PLUGIN_SETTINGS_TYPE } from "./plugin-settings";
import { AssetRegistry } from "./registry";
import { bytesEqual } from "./test-support/bytes";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGIN_DIR = join(REPO_ROOT, "engine-plugins", "editor-primitives");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

type Bounds = [[number, number, number], [number, number, number]];
const UNIT: Bounds = [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]];
const FLAT: Bounds = [[-0.5, 0, -0.5], [0.5, 0, 0.5]];

/** Hand-derived shape facts: glTF-space bounds, enclosed volume (closed shapes) or upward area (flat shapes). */
const SHAPES: Array<{
  name: string;
  bounds: Bounds;
  volume?: number;
  upwardArea?: number;
  /** Relative tolerance for the faceted surface against the smooth one. */
  tolerance: number;
  collider: Record<string, unknown>;
  autoLod: boolean;
}> = [
  { name: "Cube", bounds: UNIT, volume: 1, tolerance: 1e-6, collider: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } }, autoLod: true },
  { name: "Sphere", bounds: UNIT, volume: Math.PI / 6, tolerance: 0.03, collider: { kind: "sphere", radius: 0.5 }, autoLod: true },
  { name: "Hemisphere", bounds: [[-0.5, 0, -0.5], [0.5, 0.5, 0.5]], volume: Math.PI / 12, tolerance: 0.03, collider: { kind: "generated" }, autoLod: true },
  { name: "Cylinder", bounds: UNIT, volume: Math.PI / 4, tolerance: 0.03, collider: { kind: "cylinder", radius: 0.5, height: 1 }, autoLod: true },
  { name: "Cone", bounds: UNIT, volume: Math.PI / 12, tolerance: 0.03, collider: { kind: "cone", radius: 0.5, height: 1 }, autoLod: true },
  { name: "Capsule", bounds: [[-0.5, -1, -0.5], [0.5, 1, 0.5]], volume: Math.PI / 4 + Math.PI / 6, tolerance: 0.03, collider: { kind: "capsule", radius: 0.5, halfHeight: 0.5 }, autoLod: true },
  { name: "Torus", bounds: [[-0.5, -0.15, -0.5], [0.5, 0.15, 0.5]], volume: 2 * Math.PI ** 2 * 0.35 * 0.15 ** 2, tolerance: 0.06, collider: { kind: "generated" }, autoLod: true },
  { name: "Tube", bounds: UNIT, volume: Math.PI * (0.25 - 0.0625), tolerance: 0.03, collider: { kind: "cylinder", radius: 0.5, height: 1 }, autoLod: true },
  { name: "Pyramid", bounds: UNIT, volume: 1 / 3, tolerance: 1e-6, collider: { kind: "generated" }, autoLod: true },
  { name: "Wedge", bounds: UNIT, volume: 0.5, tolerance: 1e-6, collider: { kind: "generated" }, autoLod: true },
  { name: "Plane", bounds: FLAT, upwardArea: 1, tolerance: 1e-6, collider: { kind: "box", halfExtents: { x: 0.5, y: 0.01, z: 0.5 } }, autoLod: true },
  { name: "SubdividedPlane", bounds: FLAT, upwardArea: 1, tolerance: 1e-6, collider: { kind: "box", halfExtents: { x: 0.5, y: 0.01, z: 0.5 } }, autoLod: false },
  { name: "Disc", bounds: FLAT, upwardArea: Math.PI / 4, tolerance: 0.03, collider: { kind: "cylinder", radius: 0.5, height: 0.02 }, autoLod: true },
];

function triangles(mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> }) {
  const point = (index: number) => [mesh.positions[index * 3]!, mesh.positions[index * 3 + 1]!, mesh.positions[index * 3 + 2]!] as const;
  const out: Array<{ a: readonly number[]; b: readonly number[]; c: readonly number[]; normal: number[] }> = [];
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const a = point(mesh.indices[index]!), b = point(mesh.indices[index + 1]!), c = point(mesh.indices[index + 2]!);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    out.push({ a, b, c, normal: [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!] });
  }
  return out;
}

/** Divergence theorem: positive only when every face winds counter-clockwise seen from outside. */
function signedVolume(mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> }): number {
  return triangles(mesh).reduce((sum, { a, normal }) => sum + (a[0]! * normal[0]! + a[1]! * normal[1]! + a[2]! * normal[2]!) / 6, 0);
}

/** One build for the whole file: a build hashes, hulls and bakes every Model. */
let built: Promise<ProjectTreeFile[]> | undefined;
function editorPrimitivesFiles(): Promise<ProjectTreeFile[]> {
  built ??= buildEditorPrimitivesFiles();
  return built;
}

async function modelFiles() {
  return (await editorPrimitivesFiles()).filter((file) => file.path.startsWith("assets/"));
}

describe("buildEditorPrimitivesFiles", () => {
  it("authors disabled-by-default EditorPrimitives settings and one Model per shape", async () => {
    const files = await editorPrimitivesFiles();
    expect(files.map((file) => file.path).sort()).toEqual([
      "assets/Capsule.hasset",
      "assets/Cone.hasset",
      "assets/Cube.hasset",
      "assets/Cylinder.hasset",
      "assets/Disc.hasset",
      "assets/Hemisphere.hasset",
      "assets/Plane.hasset",
      "assets/Pyramid.hasset",
      "assets/Sphere.hasset",
      "assets/SubdividedPlane.hasset",
      "assets/Torus.hasset",
      "assets/Tube.hasset",
      "assets/Wedge.hasset",
      "editor-primitives.plugin.hasset",
    ]);
    const settings = await decodeAssetDocument(files.find((file) => file.path === "editor-primitives.plugin.hasset")!.data);
    expect(settings.type).toBe(PLUGIN_SETTINGS_TYPE);
    expect(settings.guid).toBe(EDITOR_PRIMITIVES_PLUGIN_GUID);
    expect(settings.payload).toMatchObject({
      displayName: "EditorPrimitives",
      pluginGuid: EDITOR_PRIMITIVES_PLUGIN_GUID,
      enabledByDefault: false,
      iconKey: "Box",
    });
  });

  it("makes each Model a material-free GLB on slot 0 with stable unique guids and its shape's collision", async () => {
    const guids = new Set<string>([EDITOR_PRIMITIVES_PLUGIN_GUID]);
    for (const shape of SHAPES) {
      const file = (await modelFiles()).find((entry) => entry.path === `assets/${shape.name}.hasset`)!;
      const header = readHassetHeader(file.data);
      expect(header).toMatchObject({ type: "Model", name: shape.name, dependencies: [], requiredDependencies: [] });
      guids.add(header.guid);
      const payload = normalizeModelPayload(header.payload);
      expect(payload.materialSlots).toEqual([{ index: 0, name: "Material", materialGuid: null }]);
      expect(payload).toMatchObject({ importScale: 1, skeletonGuid: null, clipNames: [], autoLod: shape.autoLod });
      expect(payload.simpleColliders).toHaveLength(1);
      expect(payload.simpleColliders[0]).toMatchObject(shape.collider);
      const glb = await decodeHassetChunk(file.data, "source");
      const json = JSON.parse(new TextDecoder().decode(glb!.subarray(20, 20 + new DataView(glb!.buffer, glb!.byteOffset).getUint32(12, true)))) as {
        materials?: unknown[];
        meshes: Array<{ primitives: Array<{ material?: number; attributes: Record<string, number> }> }>;
      };
      expect(json.materials ?? []).toEqual([]);
      expect(json.meshes.flatMap((mesh) => mesh.primitives).map((primitive) => [primitive.material, Object.keys(primitive.attributes).sort()]))
        .toEqual([[undefined, ["NORMAL", "POSITION", "TEXCOORD_0"]]]);
    }
    // The plugin and its 13 Models.
    expect(guids.size).toBe(14);
    const ids = new Set((await modelFiles()).map((file) => normalizeModelPayload(readHassetHeader(file.data).payload).simpleColliders[0]!.id));
    expect(ids.size).toBe(13);
  });

  it("builds closed shapes that enclose their volume and flat shapes that face up", async () => {
    for (const shape of SHAPES) {
      const file = (await modelFiles()).find((entry) => entry.path === `assets/${shape.name}.hasset`)!;
      const mesh = extractGltfCollisionMesh((await decodeHassetChunk(file.data, "source"))!)!;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let index = 0; index < mesh.positions.length; index++) {
        min[index % 3] = Math.min(min[index % 3]!, mesh.positions[index]!);
        max[index % 3] = Math.max(max[index % 3]!, mesh.positions[index]!);
      }
      for (let axis = 0; axis < 3; axis++) {
        expect(min[axis], `${shape.name} min`).toBeCloseTo(shape.bounds[0][axis]!, 5);
        expect(max[axis], `${shape.name} max`).toBeCloseTo(shape.bounds[1][axis]!, 5);
      }
      if (shape.volume !== undefined) {
        expect(Math.abs(signedVolume(mesh) - shape.volume) / shape.volume, `${shape.name} volume`).toBeLessThan(shape.tolerance);
      } else {
        const faces = triangles(mesh);
        for (const { normal } of faces) {
          expect(normal[0], `${shape.name} faces up`).toBeCloseTo(0, 9);
          expect(normal[2], `${shape.name} faces up`).toBeCloseTo(0, 9);
          expect(normal[1]!, `${shape.name} faces up`).toBeGreaterThan(0);
        }
        const area = faces.reduce((sum, { normal }) => sum + normal[1]! / 2, 0);
        expect(Math.abs(area - shape.upwardArea!) / shape.upwardArea!, `${shape.name} area`).toBeLessThan(shape.tolerance);
      }
    }
  });

  it("subdivides the Subdivided Plane into 64 × 64 quads and leaves the Plane as one quad", async () => {
    const counts = async (name: string) => {
      const file = (await modelFiles()).find((entry) => entry.path === `assets/${name}.hasset`)!;
      const mesh = extractGltfCollisionMesh((await decodeHassetChunk(file.data, "source"))!)!;
      return { vertices: mesh.positions.length / 3, triangles: mesh.indices.length / 3 };
    };
    expect(await counts("Plane")).toEqual({ vertices: 4, triangles: 2 });
    expect(await counts("SubdividedPlane")).toEqual({ vertices: 65 * 65, triangles: 64 * 64 * 2 });
  });

  it("is discovered as a read-only engine plugin whose Models a registry indexes", async () => {
    const storage = new MemoryStorageAdapter("opfs");
    await storage.openDocumentsProject("engine-plugins");
    await storage.mkdir("editor-primitives/assets", true);
    for (const file of await editorPrimitivesFiles()) {
      await storage.writeBinary(`editor-primitives/${file.path}`, file.data);
    }
    const discovered = await discoverEnginePlugins(storage);
    expect(discovered.map((entry) => [entry.pluginGuid, entry.folderPath, entry.readOnly, entry.settings.enabledByDefault]))
      .toEqual([[EDITOR_PRIMITIVES_PLUGIN_GUID, "editor-primitives", true, false]]);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot({ id: "plugin", kind: "plugin", pathPrefix: "editor-primitives/assets", readOnly: true });
    const models = registry.list().filter((entry) => entry.header.type === "Model");
    expect(models.map((entry) => entry.header.name).sort()).toEqual(SHAPES.map((shape) => shape.name).sort());
    expect(models.every((entry) => !entry.placeholder)).toBe(true);
  });

  it("matches the committed engine-plugins/editor-primitives directory", async () => {
    const files = await editorPrimitivesFiles();
    if (UPDATE) {
      rmSync(PLUGIN_DIR, { recursive: true, force: true });
      for (const file of files) {
        const path = join(PLUGIN_DIR, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.data);
      }
    }
    expect(existsSync(PLUGIN_DIR)).toBe(true);
    const committed = readdirSync(PLUGIN_DIR, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(PLUGIN_DIR, join(entry.parentPath, entry.name)).split("\\").join("/"))
      .sort();
    expect(committed).toEqual(files.map((file) => file.path).sort());
    for (const file of files) {
      expect(bytesEqual(new Uint8Array(readFileSync(join(PLUGIN_DIR, file.path))), file.data), file.path).toBe(true);
    }
  });
});
