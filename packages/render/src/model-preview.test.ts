import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MeshBuilder, StandardMaterial, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { embedGlbExternalImages } from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { encodeTriangleGlb, isGltfModelBytes } from "./model-mesh";
import { attachSkeletonPreview, createLinkedSkeletonFromNodeRig } from "./node-rig";
import { MATERIAL_PREVIEW_MESH_NAME } from "./material-preview";
import {
  applyModelMaterialSlots,
  createModelPreviewScene,
  loadModelPreviewSource,
  previewRigRoot,
  visualMeshes,
} from "./model-preview";

const KENNEY_MANNEQUIN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../engine-content/kenney-assets/Mannequin",
);

function kenneyMannequinGlb(): Uint8Array {
  const glb = new Uint8Array(
    readFileSync(join(KENNEY_MANNEQUIN_DIR, "mannequin.glb")),
  );
  const png = new Uint8Array(
    readFileSync(join(KENNEY_MANNEQUIN_DIR, "mannequin.png")),
  );
  return embedGlbExternalImages(glb, { "Textures/texture-d.png": png });
}

describe("isGltfModelBytes", () => {
  it("accepts GLB bytes and rejects OBJ stubs", () => {
    expect(isGltfModelBytes(encodeTriangleGlb())).toBe(true);
    expect(isGltfModelBytes(new TextEncoder().encode("o cube\nv 0 0 0\n"))).toBe(
      false,
    );
    expect(isGltfModelBytes(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(isGltfModelBytes(null)).toBe(false);
  });
});

describe("applyModelMaterialSlots", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("keeps construction materials when a slot guid is empty", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const root = MeshBuilder.CreateBox("root", { size: 1 }, scene);
    const child = MeshBuilder.CreateBox("child", { size: 1 }, scene);
    child.parent = root;
    const constructionA = new StandardMaterial("slot-0", scene);
    const constructionB = new StandardMaterial("slot-1", scene);
    root.material = constructionA;
    child.material = constructionB;

    applyModelMaterialSlots(
      root,
      [
        { index: 0, name: "Hero Mat", materialGuid: null },
        { index: 1, name: "Slot 2", materialGuid: null },
      ],
      () => new StandardMaterial("unused", scene),
    );

    expect(root.material).toBe(constructionA);
    expect(child.material).toBe(constructionB);
  });

  it("assigns a resolved material to a filled slot and restores on clear", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const root = MeshBuilder.CreateBox("root", { size: 1 }, scene);
    const child = MeshBuilder.CreateBox("child", { size: 1 }, scene);
    child.parent = root;
    const constructionA = new StandardMaterial("slot-0", scene);
    const constructionB = new StandardMaterial("slot-1", scene);
    const override = new StandardMaterial("override", scene);
    root.material = constructionA;
    child.material = constructionB;

    applyModelMaterialSlots(
      root,
      [
        { index: 0, name: "Hero Mat", materialGuid: "mat-1" },
        { index: 1, name: "Slot 2", materialGuid: null },
      ],
      (guid) => (guid === "mat-1" ? override : null),
    );

    expect(root.material).toBe(override);
    expect(child.material).toBe(constructionB);

    applyModelMaterialSlots(
      root,
      [
        { index: 0, name: "Hero Mat", materialGuid: null },
        { index: 1, name: "Slot 2", materialGuid: null },
      ],
      () => null,
    );

    expect(root.material).toBe(constructionA);
    expect(child.material).toBe(constructionB);
  });

  it("skips a hidden placeholder root so slot 0 maps to the loaded mesh", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const root = MeshBuilder.CreateBox("placeholder", { size: 1 }, scene);
    const child = MeshBuilder.CreateBox("gltf-mesh", { size: 1 }, scene);
    child.parent = root;
    const stubMat = new StandardMaterial("stub", scene);
    const gltfMat = new StandardMaterial("gltf", scene);
    const override = new StandardMaterial("override", scene);
    root.material = stubMat;
    root.visibility = 0;
    child.material = gltfMat;

    applyModelMaterialSlots(
      root,
      [{ index: 0, name: "Hero Mat", materialGuid: "mat-1" }],
      (guid) => (guid === "mat-1" ? override : null),
    );

    expect(root.material).toBe(stubMat);
    expect(child.material).toBe(override);
  });
});

describe("loadModelPreviewSource", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("loads a GLB container onto the preview host", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createModelPreviewScene(handle.engine);
    const loaded = await loadModelPreviewSource(host, encodeTriangleGlb());
    expect(loaded).not.toBeNull();
    expect(host.mesh.visibility).toBe(0);
    expect(host.mesh.getChildMeshes().length).toBeGreaterThan(0);
    loaded?.dispose();
  });

  it("loads Kenney Mannequin (KHR_materials_unlit) and attaches a hierarchy overlay", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createModelPreviewScene(handle.engine);
    const loaded = await loadModelPreviewSource(host, kenneyMannequinGlb());
    expect(loaded).not.toBeNull();
    expect(loaded?.animationGroups.some((group) => group.name === "idle")).toBe(
      true,
    );
    const rigRoot = previewRigRoot(host);
    expect(rigRoot.name).not.toBe(MATERIAL_PREVIEW_MESH_NAME);
    const { skeleton } = createLinkedSkeletonFromNodeRig(rigRoot, {
      createMesh: true,
    });
    expect(skeleton.bones.map((bone) => bone.name)).not.toContain(
      MATERIAL_PREVIEW_MESH_NAME,
    );
    const preview = attachSkeletonPreview(rigRoot, host.scene, "hierarchy");
    expect(
      host.scene.meshes.some((mesh) => mesh.name.endsWith("_overlay")),
    ).toBe(true);
    expect(
      host.scene.transformNodes.some((node) => node.name === MATERIAL_PREVIEW_MESH_NAME) ||
        host.mesh.name === MATERIAL_PREVIEW_MESH_NAME,
    ).toBe(true);
    preview.dispose();
    loaded?.dispose();
  });

  it("keeps UVs on every Kenney part and applies slot 0 to the whole hierarchy", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createModelPreviewScene(handle.engine);
    const loaded = await loadModelPreviewSource(host, kenneyMannequinGlb());
    expect(loaded).not.toBeNull();
    const visuals = visualMeshes(host.mesh);
    expect(visuals.length).toBeGreaterThan(1);
    for (const part of visuals) {
      const uvs = part.getVerticesData(VertexBuffer.UVKind);
      expect(uvs?.length ?? 0).toBeGreaterThan(0);
    }
    const override = new StandardMaterial("slot-0", handle.scene);
    applyModelMaterialSlots(
      host.mesh,
      [{ index: 0, name: "texture-d", materialGuid: "mat-1" }],
      (guid) => (guid === "mat-1" ? override : null),
    );
    for (const part of visuals) {
      expect(part.material).toBe(override);
    }
    loaded?.dispose();
  });

  it("returns null for OBJ stubs", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createModelPreviewScene(handle.engine);
    expect(
      await loadModelPreviewSource(
        host,
        new TextEncoder().encode("o cube\nv 0 0 0\n"),
      ),
    ).toBeNull();
  });
});
