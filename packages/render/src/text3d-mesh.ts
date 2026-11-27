import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { CreatePolygon } from "@babylonjs/core/Meshes/Builders/polygonBuilder";
import {
  CreateTextShapePaths,
  type IFontData,
} from "@babylonjs/core/Meshes/Builders/textBuilder";
import earcut from "earcut";
import {
  parseText3DProperties,
  type Text3DAlignment,
  type Text3DProperties,
} from "@haptic/core";
import {
  bundledAsciiTypeFace,
  parseTypeFaceJson,
} from "./default-typeface";
import type { MeshAssetContext } from "./mesh-assets";
import { setUnlitMaterial, type UnlitBinding, type UnlitMaterialKey } from "./unlit-material";
import { VisualBundle } from "./visual-bundle";

const TEXT3D_RESOLUTION = 4;
/** Max cached CPU 3D text geometries per font (zero GPU memory held between Scenes). */
const TEXT3D_GEOMETRY_CACHE_MAX = 256;
// Keyed by the cached chunk instance; CreateTextShapePaths only reads the font.
const parsedTypeFaces = new WeakMap<Uint8Array, IFontData | null>();

interface CachedText3DGeometry {
  positions: Float32Array;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  indices: Uint16Array | Uint32Array | null;
}

const text3DGeometryCache = new WeakMap<IFontData, Map<string, CachedText3DGeometry | null>>();

function getCachedText3DGeometry(font: IFontData, key: string): CachedText3DGeometry | null | undefined {
  const byFont = text3DGeometryCache.get(font);
  if (!byFont || !byFont.has(key)) return undefined;
  const hit = byFont.get(key)!;
  // Touch LRU order.
  byFont.delete(key);
  byFont.set(key, hit);
  return hit;
}

function putCachedText3DGeometry(font: IFontData, key: string, value: CachedText3DGeometry | null): void {
  let byFont = text3DGeometryCache.get(font);
  if (!byFont) {
    byFont = new Map();
    text3DGeometryCache.set(font, byFont);
  }
  byFont.delete(key);
  byFont.set(key, value);
  while (byFont.size > TEXT3D_GEOMETRY_CACHE_MAX) {
    const oldest = byFont.keys().next().value;
    if (oldest === undefined) break;
    byFont.delete(oldest);
  }
}

function captureText3DGeometry(mesh: Mesh): CachedText3DGeometry | null {
  const rawPositions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!rawPositions || rawPositions.length === 0) return null;
  const positions = rawPositions instanceof Float32Array ? rawPositions.slice() : Float32Array.from(rawPositions);
  const rawNormals = mesh.getVerticesData(VertexBuffer.NormalKind);
  const normals = rawNormals && rawNormals.length > 0
    ? (rawNormals instanceof Float32Array ? rawNormals.slice() : Float32Array.from(rawNormals))
    : null;
  const rawUvs = mesh.getVerticesData(VertexBuffer.UVKind);
  const uvs = rawUvs && rawUvs.length > 0
    ? (rawUvs instanceof Float32Array ? rawUvs.slice() : Float32Array.from(rawUvs))
    : null;
  const rawIndices = mesh.getIndices();
  let indices: Uint16Array | Uint32Array | null = null;
  if (rawIndices && rawIndices.length > 0) {
    const is32 = positions.length / 3 > 0xffff;
    indices = is32
      ? (rawIndices instanceof Uint32Array ? rawIndices.slice() : Uint32Array.from(rawIndices))
      : (rawIndices instanceof Uint16Array ? rawIndices.slice() : Uint16Array.from(rawIndices));
  }
  return { positions, normals, uvs, indices };
}

function materializeText3DGeometry(scene: Scene, name: string, cached: CachedText3DGeometry): Mesh {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = cached.positions;
  if (cached.normals) vd.normals = cached.normals;
  if (cached.uvs) vd.uvs = cached.uvs;
  if (cached.indices) vd.indices = cached.indices;
  vd.applyToMesh(mesh);
  return mesh;
}

export function resolveText3DFontData(
  properties: Text3DProperties,
  assets?: MeshAssetContext,
): { font: IFontData; bundled: boolean } {
  const guid = properties.fontAssetGuid;
  if (guid) {
    const bytes = assets?.fontFacetypeBytes?.get(guid);
    if (bytes) {
      let parsed = parsedTypeFaces.get(bytes);
      if (parsed === undefined) {
        parsed = parseTypeFaceJson(bytes);
        parsedTypeFaces.set(bytes, parsed);
      }
      if (parsed) return { font: parsed, bundled: false };
    }
  }
  return { font: bundledAsciiTypeFace, bundled: true };
}

/** 3D Text draws from both sides, fogged with the world, its back faces' geometry normal flipped. */
const TEXT3D_MATERIAL: UnlitMaterialKey = { textured: false, backFaceCulling: false, fog: true, role: "world" };

function text3DBinding(color: readonly [number, number, number]): UnlitBinding {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    texture: null, color: [clamp(color[0]), clamp(color[1]), clamp(color[2])], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: true,
  };
}

function applyText3DVisual(mesh: Mesh, binding: UnlitBinding): Mesh {
  setUnlitMaterial(mesh, TEXT3D_MATERIAL, binding);
  mesh.receiveShadows = false;
  mesh.metadata = { ...(mesh.metadata ?? {}), text3d: true };
  return mesh;
}

function pathPointsToShape(points: Array<{ x: number; y: number }>): Vector3[] {
  const shape: Vector3[] = [];
  for (const point of points) {
    shape.push(new Vector3(point.x, 0, point.y));
  }
  return shape;
}

function bakeCreateTextOrientation(
  mesh: Mesh,
  scene: Scene,
  alignment: Text3DAlignment,
): void {
  mesh.computeWorldMatrix(true);
  mesh.refreshBoundingInfo();
  const bbox = mesh.getBoundingInfo().boundingBox;
  if (alignment === "left") {
    mesh.position.x += -bbox.minimumWorld.x;
  } else if (alignment === "right") {
    mesh.position.x += -bbox.maximumWorld.x;
  } else {
    mesh.position.x += -(bbox.minimumWorld.x + bbox.maximumWorld.x) / 2;
  }
  mesh.position.y += -(bbox.minimumWorld.y + bbox.maximumWorld.y) / 2;
  mesh.position.z +=
    -(bbox.minimumWorld.z + bbox.maximumWorld.z) / 2 + bbox.extendSize.z;
  const pivot = new TransformNode("text3d-pivot", scene);
  pivot.rotation.x = -Math.PI / 2;
  mesh.parent = pivot;
  mesh.bakeCurrentTransformIntoVertices();
  mesh.parent = null;
  pivot.dispose();
}

function normalizeText3DNewlines(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

function createFlatTextMesh(
  scene: Scene,
  name: string,
  text: string,
  size: number,
  font: IFontData,
  alignment: Text3DAlignment,
): Mesh | null {
  const normalized = normalizeText3DNewlines(text);
  const cacheKey = `${normalized}\0${size}\0${alignment}`;
  const cached = getCachedText3DGeometry(font, cacheKey);
  if (cached !== undefined) {
    return cached ? materializeText3DGeometry(scene, name, cached) : null;
  }
  const shapePaths = CreateTextShapePaths(
    normalized,
    size,
    TEXT3D_RESOLUTION,
    font,
  );
  const meshes: Mesh[] = [];
  for (const shapePath of shapePaths) {
    if (!shapePath.paths.length) continue;
    // Each hole belongs to the contour that contains it; a hole inside no
    // contour is never punched into an unrelated one.
    const holes = shapePath.holes.slice();
    for (const path of shapePath.paths) {
      const shape = pathPointsToShape(path.getPoints());
      if (shape.length < 3) continue;
      const holeVectors: Vector3[][] = [];
      const leftover = holes.slice();
      for (const hole of leftover) {
        const points = hole.getPoints();
        const inside = points.some((point) => path.isPointInside(point));
        if (!inside) continue;
        holeVectors.push(pathPointsToShape(points));
        holes.splice(holes.indexOf(hole), 1);
      }
      meshes.push(
        CreatePolygon(
          `${name}:poly`,
          {
            shape,
            holes: holeVectors.length ? holeVectors : undefined,
            sideOrientation: Mesh.FRONTSIDE,
          },
          scene,
          earcut,
        ),
      );
    }
  }
  if (meshes.length === 0) {
    putCachedText3DGeometry(font, cacheKey, null);
    return null;
  }
  const merged =
    meshes.length === 1 ? meshes[0]! : Mesh.MergeMeshes(meshes, true, true);
  if (!merged) {
    for (const mesh of meshes) mesh.dispose();
    putCachedText3DGeometry(font, cacheKey, null);
    return null;
  }
  bakeCreateTextOrientation(merged, scene, alignment);
  merged.name = name;
  putCachedText3DGeometry(font, cacheKey, captureText3DGeometry(merged));
  return merged;
}

function createFallbackPlane(
  scene: Scene,
  name: string,
  parsed: Text3DProperties,
  binding: UnlitBinding,
): Mesh {
  const mesh = MeshBuilder.CreatePlane(name, { size: parsed.size }, scene);
  return applyText3DVisual(mesh, binding);
}

export function createText3DMesh(
  scene: Scene,
  name: string,
  properties: unknown,
  assets?: MeshAssetContext,
): Mesh {
  const parsed = parseText3DProperties(properties);
  const { font } = resolveText3DFontData(parsed, assets);
  const text = parsed.text.length > 0 ? parsed.text : " ";
  const bundle = new VisualBundle();
  try {
    const binding = text3DBinding(parsed.color);
    const created = createFlatTextMesh(scene, name, text, parsed.size, font, parsed.alignment);
    let mesh: Mesh;
    if (!created || !created.getVerticesData(VertexBuffer.PositionKind)) {
      created?.dispose();
      mesh = createFallbackPlane(scene, name, parsed, binding);
    } else mesh = applyText3DVisual(created, binding);
    bundle.ownRenderUser(mesh);
    mesh.onDisposeObservable.addOnce(() => bundle.dispose());
    return mesh;
  } catch (error) {
    bundle.dispose();
    throw error;
  }
}
