import { createDefaultMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";

/** A Material whose base color samples `textureGuid` through a block named "sample". */
export function sampledTextureDocument(textureGuid: string): MaterialDocument {
  const doc = createDefaultMaterialDocument();
  doc.nodes.push(
    { id: "texture", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Albedo", textureGuid } },
    { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
    { id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: {} },
  );
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
  doc.edges.push(
    { id: "texture-sample", sourceNodeId: "texture", sourcePinId: "out", targetNodeId: "sample", targetPinId: "texture" },
    { id: "uv-sample", sourceNodeId: "uv", sourcePinId: "uv", targetNodeId: "sample", targetPinId: "uv" },
    { id: "sample-output", sourceNodeId: "sample", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" },
  );
  return doc;
}
