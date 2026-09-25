import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Scene } from "@babylonjs/core/scene";
import { parseLandscapeProperties, type LandscapeProperties } from "@babylonslate/core";
import type { MeshAssetContext } from "./mesh-assets";
import { RENDERING_GROUP } from "./sorting";

const CHUNK_CELLS = 32;
type Chunk = { mesh: Mesh; x: number; z: number; width: number; depth: number };
const landscapes = new WeakMap<Mesh, { data: LandscapeProperties; chunks: Chunk[] }>();

function chunkData(data: LandscapeProperties, chunk: Omit<Chunk, "mesh">): VertexData {
  const positions: number[] = []; const normals: number[] = []; const uvs: number[] = []; const colors: number[] = []; const indices: number[] = [];
  const side = data.subdivisions + 1;
  const dx = data.width / data.subdivisions; const dz = data.depth / data.subdivisions;
  for (let z = 0; z <= chunk.depth; z++) for (let x = 0; x <= chunk.width; x++) {
    const gx = x + chunk.x; const gz = z + chunk.z; const i = gz * side + gx;
    const px = gx * dx - data.width / 2; const pz = gz * dz - data.depth / 2;
    positions.push(px, data.heights[i]!, pz);
    // Sample beyond chunk boundaries so adjacent chunks share identical normals.
    const left = Math.max(0, gx - 1); const right = Math.min(side - 1, gx + 1);
    const back = Math.max(0, gz - 1); const front = Math.min(side - 1, gz + 1);
    const nx = -(data.heights[gz * side + right]! - data.heights[gz * side + left]!) / ((right - left) * dx);
    const nz = -(data.heights[front * side + gx]! - data.heights[back * side + gx]!) / ((front - back) * dz);
    const length = Math.hypot(nx, 1, nz);
    normals.push(nx / length, 1 / length, nz / length);
    uvs.push(px / 8, pz / 8);
    colors.push(...data.weights.slice(i * 4, i * 4 + 4));
    if (x < chunk.width && z < chunk.depth) {
      const a = z * (chunk.width + 1) + x; const b = a + chunk.width + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const vertex = new VertexData();
  Object.assign(vertex, { positions, normals, uvs, colors, indices });
  return vertex;
}

export function createLandscapeMesh(scene: Scene, name: string, properties: unknown, assets?: MeshAssetContext): Mesh {
  const data = parseLandscapeProperties(properties);
  const root = new Mesh(name, scene);
  root.isPickable = false;
  const chunks: Chunk[] = [];
  for (let z = 0; z < data.subdivisions; z += CHUNK_CELLS) for (let x = 0; x < data.subdivisions; x += CHUNK_CELLS) {
    const mesh = new Mesh(`${name}:landscape:${x}:${z}`, scene);
    const chunk = { mesh, x, z, width: Math.min(CHUNK_CELLS, data.subdivisions - x), depth: Math.min(CHUNK_CELLS, data.subdivisions - z) };
    chunkData(data, chunk).applyToMesh(mesh, true);
    mesh.parent = root;
    mesh.renderingGroupId = RENDERING_GROUP.world;
    mesh.hasVertexAlpha = false;
    mesh.metadata = { landscapeRoot: root };
    chunks.push(chunk);
  }
  landscapes.set(root, { data, chunks });
  updateLandscapeMesh(root, data, assets);
  return root;
}

export function updateLandscapeMesh(root: Mesh, properties: unknown, assets?: MeshAssetContext): void {
  const state = landscapes.get(root);
  if (!state) return;
  const data = parseLandscapeProperties(properties);
  const previous = state.data;
  const side = data.subdivisions + 1;
  for (const chunk of state.chunks) {
    let dirty = data.width !== previous.width || data.depth !== previous.depth;
    for (let z = Math.max(0, chunk.z - 1); !dirty && z <= Math.min(data.subdivisions, chunk.z + chunk.depth + 1); z++) {
      for (let x = Math.max(0, chunk.x - 1); x <= Math.min(data.subdivisions, chunk.x + chunk.width + 1); x++) {
        const i = z * side + x;
        if (data.heights[i] !== previous.heights[i] || [0, 1, 2, 3].some((l) => data.weights[i * 4 + l] !== previous.weights[i * 4 + l])) { dirty = true; break; }
      }
    }
    if (dirty) {
      const vertex = chunkData(data, chunk);
      chunk.mesh.updateVerticesData(VertexBuffer.PositionKind, vertex.positions!, true);
      chunk.mesh.updateVerticesData(VertexBuffer.NormalKind, vertex.normals!);
      chunk.mesh.updateVerticesData(VertexBuffer.ColorKind, vertex.colors!);
    }
    const material = data.materialGuid ? assets?.resolveMaterial?.(data.materialGuid, { scene: root.getScene() }) : null;
    chunk.mesh.material = material ?? root.getScene().defaultMaterial;
    chunk.mesh.useVertexColors = Boolean(material);
    chunk.mesh.receiveShadows = true;
  }
  state.data = data;
}
