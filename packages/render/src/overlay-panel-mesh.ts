import {
  Color3,
  Mesh,
  StandardMaterial,
  VertexData,
  type Scene,
} from "@babylonjs/core";
import {
  overlayNineSliceCells,
  overlayPanelDestFromScale,
  parseOverlayPanelProperties,
  type OverlayPanelProperties,
} from "@babylonslate/core";
import { applyAlbedoTexture, type MeshAssetContext } from "./mesh-assets";
import { overlayTextureWorldSize } from "./overlay-texture-quad";

export type OverlayPanelMeshOptions = OverlayPanelProperties & {
  destWidth?: number;
  destHeight?: number;
};

function overlayUnlitMaterial(scene: Scene, name: string): StandardMaterial {
  const material = new StandardMaterial(`${name}-unlit`, scene);
  material.disableLighting = true;
  material.emissiveColor = Color3.White();
  material.diffuseColor = Color3.White();
  material.backFaceCulling = false;
  return material;
}

function sourceSizePx(
  properties: OverlayPanelProperties,
  destWidth: number,
  destHeight: number,
  assets?: MeshAssetContext,
): { width: number; height: number } {
  const ppu = assets?.pixelsPerUnit && assets.pixelsPerUnit > 0 ? assets.pixelsPerUnit : 100;
  if (properties.source !== "texture" || !properties.textureGuid) {
    return { width: destWidth * ppu, height: destHeight * ppu };
  }
  const world = overlayTextureWorldSize(
    properties.textureGuid,
    assets?.textureBytes,
    ppu,
    assets?.texturePixelSizes,
  );
  return { width: world.width * ppu, height: world.height * ppu };
}

/** 9-slice unlit overlay panel used by editor Preview and Play `2dpanel`. */
export function createOverlayPanelMesh(
  scene: Scene,
  name: string,
  properties: OverlayPanelMeshOptions,
  assets?: MeshAssetContext,
): Mesh {
  const parsed = parseOverlayPanelProperties(properties);
  const dest = overlayPanelDestFromScale(
    typeof properties.destWidth === "number" ? properties.destWidth : 1,
    typeof properties.destHeight === "number" ? properties.destHeight : 1,
  );
  const ppu = assets?.pixelsPerUnit && assets.pixelsPerUnit > 0 ? assets.pixelsPerUnit : 100;
  const src = sourceSizePx(parsed, dest.destWidth, dest.destHeight, assets);
  const cells = overlayNineSliceCells({
    destWidth: dest.destWidth,
    destHeight: dest.destHeight,
    srcWidthPx: src.width,
    srcHeightPx: src.height,
    marginLeft: parsed.marginLeft,
    marginRight: parsed.marginRight,
    marginTop: parsed.marginTop,
    marginBottom: parsed.marginBottom,
    pixelsPerUnit: ppu,
  });
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vertex = 0;
  for (const cell of cells) {
    if (cell.width <= 1e-8 || cell.height <= 1e-8) continue;
    const x0 = cell.x / dest.destWidth;
    const y0 = cell.y / dest.destHeight;
    const x1 = (cell.x + cell.width) / dest.destWidth;
    const y1 = (cell.y + cell.height) / dest.destHeight;
    positions.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);
    uvs.push(cell.u0, cell.v0, cell.u1, cell.v0, cell.u1, cell.v1, cell.u0, cell.v1);
    indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3);
    vertex += 4;
  }
  const mesh = new Mesh(name, scene);
  if (positions.length === 0) {
    const fallback = overlayUnlitMaterial(scene, name);
    mesh.material = fallback;
    return mesh;
  }
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.uvs = uvs;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  vertexData.normals = normals;
  vertexData.applyToMesh(mesh);
  const compiled =
    parsed.source === "material" && parsed.materialGuid
      ? assets?.resolveMaterial?.(parsed.materialGuid, {
          scene,
          unlit: true,
        }) ?? null
      : null;
  mesh.material = compiled ?? overlayUnlitMaterial(scene, name);
  if (parsed.source === "texture") {
    applyAlbedoTexture(mesh, scene, parsed.textureGuid, assets);
  }
  return mesh;
}

export function overlayPanelVisualKind(
  properties: OverlayPanelMeshOptions,
  assets?: MeshAssetContext,
): string {
  const parsed = parseOverlayPanelProperties(properties);
  const dest = overlayPanelDestFromScale(
    typeof properties.destWidth === "number" ? properties.destWidth : 1,
    typeof properties.destHeight === "number" ? properties.destHeight : 1,
  );
  return [
    "2dpanel",
    parsed.source,
    parsed.textureGuid ?? "",
    parsed.materialGuid ?? "",
    parsed.marginLeft,
    parsed.marginRight,
    parsed.marginTop,
    parsed.marginBottom,
    parsed.hitTest,
    assets?.pixelsPerUnit ?? 100,
    dest.destWidth,
    dest.destHeight,
  ].join(":");
}
