import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MeshBuilder, StandardMaterial, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeBabasset,
  embedGlbExternalImages,
  encodeBabasset,
} from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { isEngineDefaultMaterial } from "./default-material";
import { encodeTriangleGlb, encodeUvHierarchyGlb, isGltfModelBytes } from "./model-mesh";
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

function visualNamed(
  root: Parameters<typeof visualMeshes>[0],
  name: string,
) {
  return visualMeshes(root).find((part) => part.name === name);
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
    expect(isEngineDefaultMaterial(root.material)).toBe(false);
    expect(isEngineDefaultMaterial(scene.defaultMaterial)).toBe(true);
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

  it("maps construction materials to named slot indices, not child visit order", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const root = MeshBuilder.CreateBox("placeholder", { size: 1 }, scene);
    root.visibility = 0;
    const partB = MeshBuilder.CreateBox("part-b", { size: 1 }, scene);
    const partA = MeshBuilder.CreateBox("part-a", { size: 1 }, scene);
    partB.parent = root;
    partA.parent = root;
    const matB = new StandardMaterial("MatB", scene);
    const matA = new StandardMaterial("MatA", scene);
    const slot0 = new StandardMaterial("slot-0", scene);
    const slot1 = new StandardMaterial("slot-1", scene);
    partB.material = matB;
    partA.material = matA;

    applyModelMaterialSlots(
      root,
      [
        { index: 0, name: "MatA", materialGuid: "mat-a" },
        { index: 1, name: "MatB", materialGuid: "mat-b" },
      ],
      (guid) => (guid === "mat-a" ? slot0 : guid === "mat-b" ? slot1 : null),
    );

    expect(partA.material).toBe(slot0);
    expect(partB.material).toBe(slot1);
  });

  it("maps same-named construction clones to one slot, not the next unused index", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const root = MeshBuilder.CreateBox("placeholder", { size: 1 }, scene);
    root.visibility = 0;
    const partB = MeshBuilder.CreateBox("part-b", { size: 1 }, scene);
    const partA = MeshBuilder.CreateBox("part-a", { size: 1 }, scene);
    partB.parent = root;
    partA.parent = root;
    partB.material = new StandardMaterial("Skin", scene);
    partA.material = new StandardMaterial("Skin", scene);
    const slot0 = new StandardMaterial("slot-0", scene);
    const slot1 = new StandardMaterial("slot-1", scene);

    applyModelMaterialSlots(
      root,
      [
        { index: 0, name: "Skin", materialGuid: "mat-skin" },
        { index: 1, name: "Trim", materialGuid: "mat-trim" },
      ],
      (guid) => (guid === "mat-skin" ? slot0 : guid === "mat-trim" ? slot1 : null),
    );

    expect(partA.material).toBe(slot0);
    expect(partB.material).toBe(slot0);
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

  it("loads a hierarchy-rig pack GLB (KHR_materials_unlit) and attaches an overlay", async () => {
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

  it("adopts every UV'd part and applies a shared slot to the whole hierarchy", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createModelPreviewScene(handle.engine);
    const loaded = await loadModelPreviewSource(host, encodeUvHierarchyGlb());
    expect(loaded).not.toBeNull();
    const visuals = visualMeshes(host.mesh);
    expect(visuals).toHaveLength(2);
    for (const part of visuals) {
      expect(part.getVerticesData(VertexBuffer.UVKind)?.length ?? 0).toBeGreaterThan(
        0,
      );
    }
    const override = new StandardMaterial("slot-0", handle.scene);
    applyModelMaterialSlots(
      host.mesh,
      [{ index: 0, name: "MatA", materialGuid: "mat-1" }],
      (guid) => (guid === "mat-1" ? override : null),
    );
    for (const part of visuals) {
      expect(part.material).toBe(override);
    }
    loaded?.dispose();
  });

  it("maps separate glTF materials to independent slots after adopt", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createModelPreviewScene(handle.engine);
    const loaded = await loadModelPreviewSource(
      host,
      encodeUvHierarchyGlb({ separateMaterials: true }),
    );
    expect(loaded).not.toBeNull();
    const visuals = visualMeshes(host.mesh);
    expect(visuals).toHaveLength(2);
    const slot0 = new StandardMaterial("slot-0", handle.scene);
    const slot1 = new StandardMaterial("slot-1", handle.scene);
    applyModelMaterialSlots(
      host.mesh,
      [
        { index: 0, name: "MatA", materialGuid: "mat-a" },
        { index: 1, name: "MatB", materialGuid: "mat-b" },
      ],
      (guid) => (guid === "mat-a" ? slot0 : guid === "mat-b" ? slot1 : null),
    );
    expect(visualNamed(host.mesh, "part-a")?.material).toBe(slot0);
    expect(visualNamed(host.mesh, "part-b")?.material).toBe(slot1);
    loaded?.dispose();
  });

  it("maps glTF material indices even when slot names and visit order disagree", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createModelPreviewScene(handle.engine);
    const loaded = await loadModelPreviewSource(
      host,
      encodeUvHierarchyGlb({
        separateMaterials: true,
        laterMaterialFirst: true,
      }),
    );
    expect(loaded).not.toBeNull();
    expect(visualMeshes(host.mesh).map((part) => part.name)).toEqual([
      "part-b",
      "part-a",
    ]);
    const slot0 = new StandardMaterial("slot-0", handle.scene);
    const slot1 = new StandardMaterial("slot-1", handle.scene);
    applyModelMaterialSlots(
      host.mesh,
      [
        { index: 0, name: "Body", materialGuid: "mat-a" },
        { index: 1, name: "Leaves", materialGuid: "mat-b" },
      ],
      (guid) => (guid === "mat-a" ? slot0 : guid === "mat-b" ? slot1 : null),
    );
    expect(visualNamed(host.mesh, "part-a")?.material).toBe(slot0);
    expect(visualNamed(host.mesh, "part-b")?.material).toBe(slot1);
    loaded?.dispose();
  });

  it("keeps UVs on every pack-GLB part and applies slot 0 to the whole hierarchy", async () => {
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

  it("loads a Model.source view after a babasset round-trip", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const glb = encodeTriangleGlb();
    const encoded = await encodeBabasset({
      header: {
        guid: "model-1",
        type: "Model",
        name: "Hero",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        payload: {},
      },
      chunks: [
        {
          id: "source",
          kind: "geometry",
          mime: "model/gltf-binary",
          data: glb,
        },
      ],
      blobThreshold: 1024 * 1024,
    });
    const source = (await decodeBabasset(encoded)).chunks.get("source")!;
    expect(
      source.byteOffset > 0 || source.buffer.byteLength > source.byteLength,
    ).toBe(true);
    const host = createModelPreviewScene(handle.engine);
    const loaded = await loadModelPreviewSource(host, source);
    expect(loaded).not.toBeNull();
    expect(host.mesh.getChildMeshes().length).toBeGreaterThan(0);
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

describe("applyModelMaterialSlots disposal", () => {
  function setupTwoConstructions(scene: import("@babylonslate/core").Scene) {
    const root = MeshBuilder.CreateBox("root", { size: 1 }, scene);
    const child = MeshBuilder.CreateBox("child", { size: 1 }, scene);
    child.parent = root;
    const constructionA = new StandardMaterial("slot-0", scene);
    const constructionB = new StandardMaterial("slot-1", scene);
    root.material = constructionA;
    child.material = constructionB;
    return { root, child, constructionA, constructionB };
  }

  it("disposes shadowed constructions only when every slot is assigned", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const { root, child, constructionA, constructionB } =
      setupTwoConstructions(scene);
    const override = new StandardMaterial("override", scene);

    applyModelMaterialSlots(
      root,
      [
        { index: 0, name: "S0", materialGuid: "mat-1" },
        { index: 1, name: "S1", materialGuid: "mat-2" },
      ],
      (guid) => new StandardMaterial(`resolved-${guid}`, scene),
      { disposeShadowed: true },
    );

    expect(root.material?.name).toBe("resolved-mat-1");
    expect(child.material?.name).toBe("resolved-mat-2");
    expect(constructionA.isDisposed()).toBe(true);
    expect(constructionB.isDisposed()).toBe(true);
  });

  it("keeps constructions alive when any slot is unassigned (fallback contract)", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const { root, child, constructionA, constructionB } =
      setupTwoConstructions(scene);

    applyModelMaterialSlots(
      root,
      [
        { index: 0, name: "S0", materialGuid: "mat-1" },
        { index: 1, name: "S1", materialGuid: null },
      ],
      (guid) => (guid === "mat-1" ? new StandardMaterial("resolved", scene) : null),
      { disposeShadowed: true },
    );

    expect(root.material?.name).toBe("resolved");
    // Per-construction granularity: the shadowed one goes, the fallback one
    // (and every mesh that can still fall back to it) stays.
    expect(child.material).toBe(constructionB);
    expect(constructionA.isDisposed()).toBe(true);
    expect(constructionB.isDisposed()).toBe(false);
  });

  it("defaults to keeping constructions when the option is absent", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const { root, child, constructionA, constructionB } =
      setupTwoConstructions(scene);
    const override = new StandardMaterial("override", scene);

    applyModelMaterialSlots(
      root,
      [
        { index: 0, name: "S0", materialGuid: "m" },
        { index: 1, name: "S1", materialGuid: "m2" },
      ],
      () => override,
    );

    expect(constructionA.isDisposed()).toBe(false);
    expect(constructionB.isDisposed()).toBe(false);
  });
});
