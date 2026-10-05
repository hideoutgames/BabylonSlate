import { Matrix, Mesh, MeshBuilder, StandardMaterial } from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";
import { createActor, identitySerializedTransform, parseText2DProperties } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { applyOverlayVisualStyle, overlayVisualStyle } from "./overlay-visual-style";
import { applyAssignMesh, applyOverlayVisualStyleCommand, applyText2DAppearCommand, createSnapshotSceneBinding, playComponentMeshName } from "./snapshot-apply";
import { prewarmMaterial } from "./material-compiler";
import { createMeshForComponent } from "./scene-loader";
import { createJoystick2DMesh, joystick2DMesh } from "./joystick2d-mesh";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const handle of handles.splice(0)) { handle.scene.dispose(); handle.engine.dispose(); } });
function host() { const handle = createTestEngine(); handles.push(handle); return handle; }

it("binds distinct tints through a shared frozen native material without changing its authored color or alpha", async () => {
  const { scene } = host();
  scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
  const material = new StandardMaterial("shared", scene);
  material.disableLighting = true;
  material.emissiveColor.set(0.8, 0.4, 0.2);
  material.alpha = 0.7;
  const first = MeshBuilder.CreatePlane("first", {}, scene), second = MeshBuilder.CreatePlane("second", {}, scene);
  first.material = second.material = material;
  applyOverlayVisualStyle(first, { opacity: 0.4, tint: [1, 0.5, 0.25, 0.5] });
  applyOverlayVisualStyle(second, { opacity: 0.8, tint: [0.25, 1, 0.5, 1] });
  for (const mesh of [first, second]) { await prewarmMaterial(material, mesh); expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true); }
  material.freeze();
  for (const mesh of [first, second, first]) {
    const effect = mesh.subMeshes[0]!.effect!;
    const write = vi.spyOn(effect, "setFloat4");
    material.bindForSubMesh(mesh.computeWorldMatrix(true), mesh, mesh.subMeshes[0]!);
    expect(write).toHaveBeenCalledWith("slateOverlayTint", ...(mesh === first ? [1, 0.5, 0.25, 0.2] : [0.25, 1, 0.5, 0.8]));
    write.mockRestore();
  }
  expect(material.emissiveColor.asArray()).toEqual([0.8, 0.4, 0.2]);
  expect(material.alpha).toBe(0.7);
  expect(first.material).toBe(second.material);
});

it("updates only the target component without traversing or rebuilding nested visuals, preserving reveal alpha", () => {
  const { scene } = host();
  const binding = createSnapshotSceneBinding();
  const text2d = parseText2DProperties({ text: "[u]A[/u][img=photo]", appearModes: ["fade"], appearTransition: "linear", appearInterval: 0, appearDuration: 1 }, { rich: true });
  applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 1, meshKind: "2drichtext", meshAssetGuid: null, parts: [
    { componentId: "label", meshKind: "2drichtext", text2d, ...identitySerializedTransform() },
    { componentId: "child", parentId: "label", meshKind: "2dtexture", ...identitySerializedTransform() },
  ] });
  const root = binding.meshes.get(1)!;
  const label = root.getChildMeshes().find(mesh => mesh.name === playComponentMeshName(1, "label")) as Mesh;
  const child = root.getChildMeshes().find(mesh => mesh.name === playComponentMeshName(1, "child")) as Mesh;
  const glyphs = label.getChildMeshes(true).filter(mesh => mesh !== child);
  const materials = glyphs.map(mesh => mesh.material);
  const traversal = vi.spyOn(label, "getChildMeshes");
  applyText2DAppearCommand(binding, { type: "setText2DAppear", slotId: 1, componentId: "label", progress: 0.5 });
  applyOverlayVisualStyleCommand(binding, { type: "setOverlayVisualStyle", slotId: 1, componentId: "label", style: { opacity: 0.25, tint: [0.5, 1, 0.5, 1] } });
  expect(traversal).not.toHaveBeenCalled();
  expect(binding.meshes.get(1)).toBe(root);
  expect(glyphs.map(mesh => mesh.material)).toEqual(materials);
  expect(glyphs.map(mesh => mesh.visibility)).toEqual([0.5, 0.5, 0.5]);
  expect(glyphs.map(mesh => overlayVisualStyle(mesh).opacity)).toEqual([0.25, 0.25, 0.25]);
  expect(overlayVisualStyle(child)).toEqual({ opacity: 1, tint: [1, 1, 1, 1] });
  applyOverlayVisualStyleCommand(binding, { type: "setOverlayVisualStyle", slotId: 1, componentId: "missing", style: { opacity: 0, tint: [0, 0, 0, 0] } });
  expect(overlayVisualStyle(label).opacity).toBe(0.25);
});

it("loads authored multipliers in editor visuals and fades both joystick surfaces without altering their distinct alpha", () => {
  const { scene } = host();
  const actor = createActor("image", "Image");
  const component = { id: "texture", classId: "2DTextureComponent", properties: { opacity: 0.3, tint: [0.2, 0.4, 0.8, 0.5] } };
  const image = createMeshForComponent(scene, "image", actor, component);
  expect(overlayVisualStyle(image)).toEqual({ opacity: 0.3, tint: [0.2, 0.4, 0.8, 0.5] });
  const joystick = createJoystick2DMesh(scene, "joystick", { opacity: 0.5 });
  const visual = joystick2DMesh(joystick)!;
  expect(overlayVisualStyle(joystick).opacity).toBe(0.5);
  expect(overlayVisualStyle(visual.thumb).opacity).toBe(0.5);
  expect(visual.fallbacks.background.alpha).toBe(0.35);
  expect(visual.fallbacks.joystick.alpha).toBe(0.85);
});
