import {
  Color3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
  type Scene,
} from "@babylonjs/core";
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
} from "@babylonslate/core";
import {
  bundledAsciiTypeFace,
  parseTypeFaceJson,
} from "./default-typeface";
import type { MeshAssetContext } from "./mesh-assets";

const TEXT3D_RESOLUTION = 4;

export function resolveText3DFontData(
  properties: Text3DProperties,
  assets?: MeshAssetContext,
): { font: IFontData; bundled: boolean } {
  const guid = properties.fontAssetGuid;
  if (guid) {
    const bytes = assets?.fontFacetypeBytes?.get(guid);
    if (bytes) {
      const parsed = parseTypeFaceJson(bytes);
      if (parsed) return { font: parsed, bundled: false };
    }
  }
  return { font: bundledAsciiTypeFace, bundled: true };
}

function createText3DMaterial(
  scene: Scene,
  name: string,
  color: [number, number, number],
): StandardMaterial {
  const material = new StandardMaterial(`${name}:text3d`, scene);
  material.disableLighting = true;
  material.backFaceCulling = false;
  material.twoSidedLighting = true;
  material.emissiveColor = new Color3(color[0], color[1], color[2]);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  return material;
}

function applyText3DVisual(mesh: Mesh, material: StandardMaterial): Mesh {
  mesh.material = material;
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
  const shapePaths = CreateTextShapePaths(
    normalizeText3DNewlines(text),
    size,
    TEXT3D_RESOLUTION,
    font,
  );
  const meshes: Mesh[] = [];
  for (const shapePath of shapePaths) {
    if (!shapePath.paths.length) continue;
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
      if (!holeVectors.length && holes.length && meshes.length === 0) {
        for (const hole of holes) {
          holeVectors.push(pathPointsToShape(hole.getPoints()));
        }
        holes.length = 0;
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
  if (meshes.length === 0) return null;
  const merged =
    meshes.length === 1 ? meshes[0]! : Mesh.MergeMeshes(meshes, true, true);
  if (!merged) {
    for (const mesh of meshes) mesh.dispose();
    return null;
  }
  bakeCreateTextOrientation(merged, scene, alignment);
  merged.name = name;
  return merged;
}

function createFallbackPlane(
  scene: Scene,
  name: string,
  parsed: Text3DProperties,
  material: StandardMaterial,
): Mesh {
  const mesh = MeshBuilder.CreatePlane(name, { size: parsed.size }, scene);
  return applyText3DVisual(mesh, material);
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
  const material = createText3DMaterial(scene, name, parsed.color);
  const created = createFlatTextMesh(
    scene,
    name,
    text,
    parsed.size,
    font,
    parsed.alignment,
  );
  if (!created || !created.getVerticesData(VertexBuffer.PositionKind)) {
    created?.dispose();
    return createFallbackPlane(scene, name, parsed, material);
  }
  return applyText3DVisual(created, material);
}
