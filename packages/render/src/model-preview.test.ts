import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Frustum,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  StandardMaterial,
  VertexBuffer,
  Vector3,
} from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCelShadingSettings } from "@haptic/core";
import {
  buildBoxGlbFixture,
  cookGeneratedCollisionFromGltf,
  encodeGlbJsonBin,
  splitGlbJsonBin,
  decodeHasset,
  embedGlbExternalImages,
  encodeHasset,
} from "@haptic/assets";
import { createTestEngine } from "./create-null-engine";
import { isEngineDefaultMaterial } from "./default-material";
import {
  encodeTriangleGlb,
  encodeUvHierarchyGlb,
} from "./glb-test-fixtures";
import { loadModelContainer, parentContainerRoots } from "./model-container";
import {
  isGltfModelBytes,
} from "./model-mesh";
import {
  attachSkeletonPreview,
  createLinkedSkeletonFromNodeRig,
} from "./node-rig";
import { MATERIAL_PREVIEW_MESH_NAME } from "./material-preview";
import { CelMaterial } from "./cel-material";
import { setSceneRenderSettings } from "./scene-render-mode";
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

function visualNamed(root: Parameters<typeof visualMeshes>[0], name: string) {
  return visualMeshes(root).find((part) => part.name === name);
}

describe("isGltfModelBytes", () => {
  it("accepts GLB bytes and rejects OBJ stubs", () => {
    expect(isGltfModelBytes(encodeTriangleGlb())).toBe(true);
    expect(
      isGltfModelBytes(new TextEncoder().encode("o cube\nv 0 0 0\n")),
    ).toBe(false);
    expect(isGltfModelBytes(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(isGltfModelBytes(null)).toBe(false);
  });
});

describe("applyModelMaterialSlots", () => {
  const handles: Array<{
    engine: { dispose: () => void };
    scene: { dispose: () => void };
  }> = [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  /** A loaded two-part model under a hidden placeholder, part-b first in the file; each part names its own glTF material. */
  async function twoParts(options = { separateMaterials: true, laterMaterialFirst: true }) {
    const handle = createTestEngine();
    handles.push(handle);
    const container = await loadModelContainer(handle.scene, encodeUvHierarchyGlb(options), "two-parts.glb");
    container.addAllToScene();
    const root = MeshBuilder.CreateBox("placeholder", { size: 1 }, handle.scene);
    root.visibility = 0;
    parentContainerRoots(root, container);
    const part = (name: string) => root.getChildMeshes().find((mesh) => mesh.name === name)!;
    return { scene: handle.scene, root, partA: part("part-a"), partB: part("part-b") };
  }
  const slots = (a: string | null, b: string | null) => [
    { index: 0, name: "MatA", materialGuid: a },
    { index: 1, name: "MatB", materialGuid: b },
  ];

  it("draws each part with the slot of the glTF material its primitive names, not child visit order", async () => {
    const { scene, root, partA, partB } = await twoParts();
    const [a, b] = [new StandardMaterial("a", scene), new StandardMaterial("b", scene)];
    applyModelMaterialSlots(root, slots("a", "b"), (guid) => (guid === "a" ? a : guid === "b" ? b : null));
    expect([partA.material, partB.material]).toEqual([a, b]);
  });

  it("draws an empty or unresolved slot with the engine default, never the file's material or a previous Material", async () => {
    const { scene, root, partA, partB } = await twoParts();
    // The load skips the file's materials.
    expect([partA.material, partB.material, scene.materials.some((material) => material.name.startsWith("Mat"))]).toEqual([null, null, false]);
    const authored = new StandardMaterial("authored", scene);
    applyModelMaterialSlots(root, slots("a", null), () => authored);
    expect([partA.material, partB.material]).toEqual([authored, null]);
    applyModelMaterialSlots(root, slots("broken", null), () => null);
    expect(partA.material).toBeNull();
    expect(isEngineDefaultMaterial(scene.defaultMaterial)).toBe(true);
  });

  it("gives every instance and clone of a model's part the part's slot", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const scene = handle.scene;
    // A template container, as Play keeps one per model load.
    const container = await loadModelContainer(scene, encodeUvHierarchyGlb({ separateMaterials: true, laterMaterialFirst: true }), "two-parts.glb");
    const instance = container.instantiateModelsToScene((name) => name, false, { doNotInstantiate: true });
    const copy = new Mesh("copy-root", scene);
    for (const node of instance.rootNodes) node.parent = copy;
    const partA = copy.getChildMeshes().find((mesh) => mesh.name === "part-a")!;
    const clone = partA.clone("part-a-clone", copy)!;
    const a = new StandardMaterial("a", scene);
    applyModelMaterialSlots(copy, slots("a", null), (guid) => (guid === "a" ? a : null));
    expect(copy.getChildMeshes().filter((mesh) => mesh.material === a).map((mesh) => mesh.name).sort()).toEqual(["part-a", "part-a-clone"]);
    expect(clone.material).toBe(a);
  });

  it("leaves a placeholder root that no glTF primitive made alone", async () => {
    const { scene, root, partA } = await twoParts({ separateMaterials: false, laterMaterialFirst: false });
    const stub = new StandardMaterial("stub", scene);
    root.material = stub;
    const shared = new StandardMaterial("shared", scene);
    applyModelMaterialSlots(root, [{ index: 0, name: "MatA", materialGuid: "shared" }], () => shared);
    expect([root.material, partA.material]).toEqual([stub, shared]);
  });

  it("draws every primitive of a file without materials with its one slot", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const container = await loadModelContainer(handle.scene, encodeTriangleGlb(), "triangle.glb");
    container.addAllToScene();
    const root = new Mesh("root", handle.scene);
    parentContainerRoots(root, container);
    const only = new StandardMaterial("only", handle.scene);
    applyModelMaterialSlots(root, [{ index: 0, name: "Material", materialGuid: "only" }], () => only);
    expect(visualMeshes(root).map((mesh) => mesh.material)).toEqual([only]);
  });
});

describe("loadModelPreviewSource", () => {
  const handles: Array<{
    engine: { dispose: () => void };
    scene: { dispose: () => void };
  }> = [];

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

  it("binds the same hard-step CEL uniforms as world scenes", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createModelPreviewScene(handle.engine);
    setSceneRenderSettings(host.scene, {
      mode: "cel",
      cel: normalizeCelShadingSettings({
        shadowBands: 4,
        shadowThreshold: 0.4,
        shadowStrength: 0.7,
        specularStrength: 0.3,
        specularSize: 0.25,
      }),
    });
    // The engine default checker texture never reports ready under
    // NullEngine, so bind an explicit textureless CEL material for the
    // uniform assertion instead.
    const material = new CelMaterial(new PBRMaterial("preview-cel", host.scene), host.scene);
    const mesh = host.mesh;
    mesh.material = material;
    host.scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    await material.forceCompilationAsync(mesh);
    const subMesh = mesh.subMeshes[0]!;
    expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
    const uniforms = vi.spyOn(subMesh.effect!, "setFloat4");
    material.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
    expect(
      uniforms.mock.calls.filter(([name]) => name === "slateCelBands").at(-1),
    ).toEqual(["slateCelBands", 4, 0.4, 0.7, 0]);
    expect(
      uniforms.mock.calls.filter(([name]) => name === "slateCelSpecular").at(-1),
    ).toEqual(["slateCelSpecular", 0.3, 0.25, 0, 0]);
    host.dispose();
  });

  it("aligns generated collision points with a rotated imported model without manual rotation", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createModelPreviewScene(handle.engine);
    const { json, bin } = splitGlbJsonBin(buildBoxGlbFixture(2))!;
    json.nodes = [
      { translation: [3, 2, 1], rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)], children: [1] },
      { mesh: 0, translation: [1, 0, 0], scale: [1, 2, 3] },
    ];
    const bytes = encodeGlbJsonBin(json, bin);
    const loaded = await loadModelPreviewSource(host, bytes, 0.25);
    try {
      expect(loaded).not.toBeNull();
      const collider = cookGeneratedCollisionFromGltf(bytes, { importScale: 0.25 });
      expect(collider.rotation).toEqual([0, 0, 0, 1]);
      const [mesh] = visualMeshes(host.mesh);
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const world = mesh.computeWorldMatrix(true);
      expect(collider.points).toHaveLength(8);
      for (let index = 0; index < positions.length; index += 3) {
        const point = Vector3.TransformCoordinates(Vector3.FromArray(positions, index), world);
        expect(collider.points).toContainEqual({
          x: expect.closeTo(point.x, 5), y: expect.closeTo(point.y, 5), z: expect.closeTo(point.z, 5),
        });
      }
    } finally {
      loaded?.dispose();
      host.dispose();
    }
  });

  it("frames small imported models inside the camera frustum before interaction", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const host = createModelPreviewScene(handle.engine);
    const loaded = await loadModelPreviewSource(
      host,
      encodeUvHierarchyGlb(),
      0.01,
    );
    host.scene.updateTransformMatrix(true);
    const planes = Frustum.GetPlanes(host.scene.getTransformMatrix());

    const parts = visualMeshes(host.mesh);
    expect(parts).toHaveLength(2);
    expect(parts.every((part) => part.isInFrustum(planes))).toBe(true);
    loaded?.dispose();
    host.dispose();
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
      host.scene.transformNodes.some(
        (node) => node.name === MATERIAL_PREVIEW_MESH_NAME,
      ) || host.mesh.name === MATERIAL_PREVIEW_MESH_NAME,
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
      expect(
        part.getVerticesData(VertexBuffer.UVKind)?.length ?? 0,
      ).toBeGreaterThan(0);
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

  it("loads a Model.source view after a hasset round-trip", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const glb = encodeTriangleGlb();
    const encoded = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
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
    const source = (await decodeHasset(encoded)).chunks.get("source")!;
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
