import { AssetContainer } from "@babylonjs/core/assetContainer";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Geometry } from "@babylonjs/core/Meshes/geometry";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";
import { modelMaterialIndexOf, setModelMaterialIndex } from "./model-container";

/** Max retained CPU blueprint bytes per Engine (zero GPU memory held between Scenes). */
const GLB_BLUEPRINT_MAX_BYTES = 64 * 1024 * 1024;
/** Max distinct static GLB models cached on one Engine. */
const GLB_BLUEPRINT_MAX_ENTRIES = 128;

interface CapturedSubMesh {
  materialIndex: number;
  verticesStart: number;
  verticesCount: number;
  indexStart: number;
  indexCount: number;
}

interface CapturedGeometry {
  positions: Float32Array | null;
  normals: Float32Array | null;
  tangents: Float32Array | null;
  uvs: Float32Array | null;
  uvs2: Float32Array | null;
  uvs3: Float32Array | null;
  uvs4: Float32Array | null;
  uvs5: Float32Array | null;
  uvs6: Float32Array | null;
  colors: Float32Array | null;
  indices: Uint16Array | Uint32Array | null;
  bytes: number;
}

interface CapturedNode {
  kind: "mesh" | "transform";
  name: string;
  parentIndex: number;
  position: [number, number, number];
  rotation: [number, number, number];
  rotationQuaternion: [number, number, number, number] | null;
  scaling: [number, number, number];
  isVisible: boolean;
  sideOrientation: number;
  materialIndex: number | null | undefined;
  geometryIndex: number;
  subMeshes: CapturedSubMesh[];
  isRootNode: boolean;
}

export interface GlbGeometryBlueprint {
  geometries: CapturedGeometry[];
  nodes: CapturedNode[];
  bytes: number;
}

interface EngineBlueprintCache {
  entries: Map<string, GlbGeometryBlueprint>;
  bytes: number;
}

const engineCaches = new WeakMap<AbstractEngine, EngineBlueprintCache>();

function cacheForEngine(engine: AbstractEngine): EngineBlueprintCache {
  let cache = engineCaches.get(engine);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    engineCaches.set(engine, cache);
    engine.onDisposeObservable.addOnce(() => {
      cache!.entries.clear();
      cache!.bytes = 0;
    });
  }
  return cache;
}

function copyFloatArray(data: ReturnType<Geometry["getVerticesData"]>): Float32Array | null {
  if (!data || data.length === 0) return null;
  return data instanceof Float32Array ? data.slice() : Float32Array.from(data);
}

function captureGeometry(geometry: Geometry): CapturedGeometry | null {
  const positions = copyFloatArray(geometry.getVerticesData("position"));
  if (!positions) return null;
  const normals = copyFloatArray(geometry.getVerticesData("normal"));
  const tangents = copyFloatArray(geometry.getVerticesData("tangent"));
  const uvs = copyFloatArray(geometry.getVerticesData("uv"));
  const uvs2 = copyFloatArray(geometry.getVerticesData("uv2"));
  const uvs3 = copyFloatArray(geometry.getVerticesData("uv3"));
  const uvs4 = copyFloatArray(geometry.getVerticesData("uv4"));
  const uvs5 = copyFloatArray(geometry.getVerticesData("uv5"));
  const uvs6 = copyFloatArray(geometry.getVerticesData("uv6"));
  const colors = copyFloatArray(geometry.getVerticesData("color"));
  const rawIndices = geometry.getIndices();
  let indices: Uint16Array | Uint32Array | null = null;
  if (rawIndices && rawIndices.length > 0) {
    const is32 = geometry.getIndexBuffer()?.is32Bits === true || positions.length / 3 > 0xffff;
    indices = is32
      ? (rawIndices instanceof Uint32Array ? rawIndices.slice() : Uint32Array.from(rawIndices))
      : (rawIndices instanceof Uint16Array ? rawIndices.slice() : Uint16Array.from(rawIndices));
  }
  let bytes = positions.byteLength;
  for (const arr of [normals, tangents, uvs, uvs2, uvs3, uvs4, uvs5, uvs6, colors, indices]) {
    if (arr) bytes += arr.byteLength;
  }
  return {
    positions, normals, tangents, uvs, uvs2, uvs3, uvs4, uvs5, uvs6, colors, indices, bytes,
  };
}

/** Standard vertex kinds captured into `CapturedGeometry`; any extra custom kind opts out to full glTF parse. */
const SUPPORTED_VERTEX_KINDS = new Set([
  "position", "normal", "tangent", "uv", "uv2", "uv3", "uv4", "uv5", "uv6", "color",
]);

/**
 * Captures a static, rigid-hierarchy GLB `AssetContainer` into pure CPU typed arrays
 * so subsequent Scenes on the same Engine (Editor -> Play -> Editor) skip GLB parsing,
 * Draco/Meshopt WASM decoding, and flat-normal reconstruction while holding zero GPU memory.
 * Skinned, animated, morphed, or instanced-node containers return null and load normally.
 */
export function captureGlbBlueprint(container: AssetContainer): GlbGeometryBlueprint | null {
  if (
    container.skeletons.length > 0 ||
    container.animationGroups.length > 0 ||
    container.morphTargetManagers.length > 0 ||
    container.meshes.length === 0
  ) {
    return null;
  }
  const orderedNodes: Node[] = [];
  const nodeIndex = new Map<Node, number>();
  const addNode = (node: Node) => {
    if (nodeIndex.has(node)) return;
    if (node.parent && !nodeIndex.has(node.parent)) addNode(node.parent);
    nodeIndex.set(node, orderedNodes.length);
    orderedNodes.push(node);
  };
  for (const node of container.rootNodes) addNode(node);
  for (const node of container.transformNodes) addNode(node);
  for (const mesh of container.meshes) addNode(mesh);

  const rootSet = new Set<Node>(container.rootNodes);
  const geometries: CapturedGeometry[] = [];
  const geometryIndexBySource = new Map<Geometry, number>();
  const capturedNodes: CapturedNode[] = [];
  let totalBytes = 512;

  for (const node of orderedNodes) {
    const parentIndex = node.parent ? (nodeIndex.get(node.parent) ?? -1) : -1;
    if (node instanceof Mesh) {
      if (node.isBlocked || node.instances.length > 0 || node.hasThinInstances) return null;
      let geometryIndex = -1;
      if (node.geometry) {
        for (const kind of node.getVerticesDataKinds()) {
          if (!SUPPORTED_VERTEX_KINDS.has(kind)) return null;
        }
        const existing = geometryIndexBySource.get(node.geometry);
        if (existing !== undefined) {
          geometryIndex = existing;
        } else {
          const captured = captureGeometry(node.geometry);
          if (!captured) return null;
          geometryIndex = geometries.length;
          geometries.push(captured);
          geometryIndexBySource.set(node.geometry, geometryIndex);
          totalBytes += captured.bytes;
        }
      }
      const subMeshes: CapturedSubMesh[] = (node.subMeshes ?? []).map((sub) => ({
        materialIndex: sub.materialIndex,
        verticesStart: sub.verticesStart,
        verticesCount: sub.verticesCount,
        indexStart: sub.indexStart,
        indexCount: sub.indexCount,
      }));
      capturedNodes.push({
        kind: "mesh",
        name: node.name,
        parentIndex,
        position: [node.position.x, node.position.y, node.position.z],
        rotation: [node.rotation.x, node.rotation.y, node.rotation.z],
        rotationQuaternion: node.rotationQuaternion
          ? [node.rotationQuaternion.x, node.rotationQuaternion.y, node.rotationQuaternion.z, node.rotationQuaternion.w]
          : null,
        scaling: [node.scaling.x, node.scaling.y, node.scaling.z],
        isVisible: node.isVisible,
        sideOrientation: node.sideOrientation,
        materialIndex: modelMaterialIndexOf(node),
        geometryIndex,
        subMeshes,
        isRootNode: rootSet.has(node),
      });
    } else if (node instanceof TransformNode) {
      capturedNodes.push({
        kind: "transform",
        name: node.name,
        parentIndex,
        position: [node.position.x, node.position.y, node.position.z],
        rotation: [node.rotation.x, node.rotation.y, node.rotation.z],
        rotationQuaternion: node.rotationQuaternion
          ? [node.rotationQuaternion.x, node.rotationQuaternion.y, node.rotationQuaternion.z, node.rotationQuaternion.w]
          : null,
        scaling: [node.scaling.x, node.scaling.y, node.scaling.z],
        isVisible: true,
        sideOrientation: Mesh.FRONTSIDE,
        materialIndex: undefined,
        geometryIndex: -1,
        subMeshes: [],
        isRootNode: rootSet.has(node),
      });
    } else {
      // Unsupported node kind (e.g. embedded camera/light) — fall back to full glTF load.
      return null;
    }
  }

  if (geometries.length === 0) return null;
  return { geometries, nodes: capturedNodes, bytes: totalBytes };
}

/** Remember a static GLB container's CPU blueprint on `engine` for subsequent Scenes. */
export function rememberEngineGlbBlueprint(
  engine: AbstractEngine,
  key: string,
  container: AssetContainer,
): boolean {
  if (engine.isDisposed) return false;
  const cache = cacheForEngine(engine);
  if (cache.entries.has(key)) {
    const existing = cache.entries.get(key)!;
    cache.entries.delete(key);
    cache.entries.set(key, existing);
    return true;
  }
  const blueprint = captureGlbBlueprint(container);
  if (!blueprint || blueprint.bytes > GLB_BLUEPRINT_MAX_BYTES) return false;
  while (
    (cache.entries.size >= GLB_BLUEPRINT_MAX_ENTRIES || cache.bytes + blueprint.bytes > GLB_BLUEPRINT_MAX_BYTES) &&
    cache.entries.size > 0
  ) {
    const oldestKey = cache.entries.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.entries.get(oldestKey)!;
    cache.bytes -= oldest.bytes;
    cache.entries.delete(oldestKey);
  }
  cache.entries.set(key, blueprint);
  cache.bytes += blueprint.bytes;
  return true;
}

/**
 * Rebuild an `AssetContainer` in `scene` synchronously from a cached CPU blueprint on `scene.getEngine()`.
 * Returns null on cache miss.
 */
export function materializeEngineGlbBlueprint(scene: Scene, key: string): AssetContainer | null {
  const engine = scene.getEngine();
  if (engine.isDisposed || scene.isDisposed) return null;
  const cache = engineCaches.get(engine);
  const blueprint = cache?.entries.get(key);
  if (!blueprint) return null;
  // Touch LRU order.
  cache!.entries.delete(key);
  cache!.entries.set(key, blueprint);

  const container = new AssetContainer(scene);
  const builtGeometries: Geometry[] = [];
  for (const geo of blueprint.geometries) {
    const vd = new VertexData();
    vd.positions = geo.positions;
    if (geo.normals) vd.normals = geo.normals;
    if (geo.tangents) vd.tangents = geo.tangents;
    if (geo.uvs) vd.uvs = geo.uvs;
    if (geo.uvs2) vd.uvs2 = geo.uvs2;
    if (geo.uvs3) vd.uvs3 = geo.uvs3;
    if (geo.uvs4) vd.uvs4 = geo.uvs4;
    if (geo.uvs5) vd.uvs5 = geo.uvs5;
    if (geo.uvs6) vd.uvs6 = geo.uvs6;
    if (geo.colors) vd.colors = geo.colors;
    if (geo.indices) vd.indices = geo.indices;
    const geometry = new Geometry(Geometry.RandomId(), scene, vd, false);
    // Keep container-owned resources out of active scene lists, matching LoadAssetContainerAsync.
    scene.removeGeometry(geometry);
    container.geometries.push(geometry);
    builtGeometries.push(geometry);
  }

  const builtNodes: Node[] = [];
  for (const spec of blueprint.nodes) {
    let node: TransformNode;
    if (spec.kind === "mesh") {
      const mesh = new Mesh(spec.name, scene, null, null, true, false);
      scene.removeMesh(mesh, false);
      mesh.isVisible = spec.isVisible;
      mesh.overrideMaterialSideOrientation = spec.sideOrientation;
      if (spec.geometryIndex >= 0) {
        builtGeometries[spec.geometryIndex]!.applyToMesh(mesh);
        if (spec.subMeshes.length > 0) {
          mesh.subMeshes = [];
          for (const sub of spec.subMeshes) {
            new SubMesh(sub.materialIndex, sub.verticesStart, sub.verticesCount, sub.indexStart, sub.indexCount, mesh);
          }
        }
      }
      if (spec.materialIndex !== undefined) {
        setModelMaterialIndex(mesh, spec.materialIndex);
      }
      container.meshes.push(mesh);
      node = mesh;
    } else {
      const transform = new TransformNode(spec.name, scene, true);
      scene.removeTransformNode(transform);
      container.transformNodes.push(transform);
      node = transform;
    }
    node.position = new Vector3(spec.position[0], spec.position[1], spec.position[2]);
    node.rotation = new Vector3(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
    node.rotationQuaternion = spec.rotationQuaternion
      ? new Quaternion(spec.rotationQuaternion[0], spec.rotationQuaternion[1], spec.rotationQuaternion[2], spec.rotationQuaternion[3])
      : null;
    node.scaling = new Vector3(spec.scaling[0], spec.scaling[1], spec.scaling[2]);
    if (spec.parentIndex >= 0) {
      node.parent = builtNodes[spec.parentIndex] ?? null;
    }
    if (spec.isRootNode) {
      container.rootNodes.push(node);
    }
    // Pre-seed world matrix cache cleanly without attaching to scene.
    node.computeWorldMatrix(true);
    builtNodes.push(node);
  }
  return container;
}

/** Test seam: count of cached static GLB blueprints on `engine`. */
export function engineGlbBlueprintCount(engine: AbstractEngine): number {
  return engineCaches.get(engine)?.entries.size ?? 0;
}
