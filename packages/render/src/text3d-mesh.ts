import { Color3, Mesh, MeshBuilder, StandardMaterial, VertexBuffer, type Scene } from "@babylonjs/core";
import { CreateText, type IFontData } from "@babylonjs/core/Meshes/Builders/textBuilder";
import earcut from "earcut";
import {
  parseText3DProperties,
  type Text3DProperties,
} from "@babylonslate/core";
import {
  bundledAsciiTypeFace,
  parseTypeFaceJson,
} from "./default-typeface";
import type { MeshAssetContext } from "./mesh-assets";

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

export function createText3DMesh(
  scene: Scene,
  name: string,
  properties: unknown,
  assets?: MeshAssetContext,
): Mesh {
  const parsed = parseText3DProperties(properties);
  const { font } = resolveText3DFontData(parsed, assets);
  const text = parsed.text.length > 0 ? parsed.text : " ";
  const created = CreateText(
    name,
    text,
    font,
    {
      size: parsed.size,
      depth: parsed.depth,
      resolution: 4,
    },
    scene,
    earcut,
  );
  const mesh =
    created ?? MeshBuilder.CreateBox(name, { size: parsed.size }, scene);
  const material = new StandardMaterial(`${name}:text3d`, scene);
  material.diffuseColor = new Color3(
    parsed.color[0],
    parsed.color[1],
    parsed.color[2],
  );
  material.emissiveColor = material.diffuseColor.scale(0.15);
  mesh.material = material;
  mesh.receiveShadows = false;
  mesh.metadata = { ...(mesh.metadata ?? {}), text3d: true };
  if (!mesh.getVerticesData(VertexBuffer.PositionKind)) {
    mesh.dispose();
    return createFallbackBox(scene, name, parsed, material);
  }
  return mesh;
}

function createFallbackBox(
  scene: Scene,
  name: string,
  parsed: Text3DProperties,
  material: StandardMaterial,
): Mesh {
  const mesh = MeshBuilder.CreateBox(name, { size: parsed.size }, scene);
  mesh.material = material;
  mesh.receiveShadows = false;
  mesh.metadata = { ...(mesh.metadata ?? {}), text3d: true };
  return mesh;
}
