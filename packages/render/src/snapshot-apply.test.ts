import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Material, Mesh, PointLight, Quaternion, SpotLight, StandardMaterial, TransformNode, UniversalCamera, Vector3, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultSpritePayload, decodeBabasset, embedGlbExternalImages, encodeBabasset } from "@babylonslate/assets";
import { applyAnimStateToScene, sceneAnimHostFromBinding } from "./anim-apply";
import { createTestEngine } from "./create-null-engine";
import { encodeAnimatedTriangleGlb, encodeParentedAnimatedTriangleGlb, encodeTriangleGlb, encodeUvHierarchyGlb, glbClipNames } from "./model-mesh";
import { glbContainerLoadCount } from "./glb-anim";
import { visualMeshes } from "./visual-meshes";
import { RENDERING_GROUP } from "./sorting";
import { ResourceCache } from "./resource-cache";
import { AUTHORED_FILL_LIGHT_INTENSITY } from "./scene-illumination";
import {
  applyAssignMesh,
  applyMaterialToActorMeshes,
  applyPossessCamera,
  applySnapshotToScene,
  createPlayMesh,
  createSnapshotSceneBinding,
  isPlayHelperMeshKind,
} from "./snapshot-apply";
import { DEFAULT_LIGHT_INTENSITY, setupDefaultViewport } from "./viewport";

function kenneyMannequinGlb(): Uint8Array {
  const dir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../engine-content/kenney-assets/Mannequin",
  );
  return embedGlbExternalImages(
    new Uint8Array(readFileSync(join(dir, "mannequin.glb"))),
    {
      "Textures/texture-d.png": new Uint8Array(
        readFileSync(join(dir, "mannequin.png")),
      ),
    },
  );
}

describe("createPlayMesh", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("lists named clips from an animated GLB and none from a static triangle", () => {
    expect(glbClipNames(encodeAnimatedTriangleGlb("Walk"))).toEqual(["Walk"]);
    expect(glbClipNames(encodeTriangleGlb())).toEqual([]);
  });

  it("binds a sprite texture and loads a GLB assetGuid instead of a box", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    binding.resourceCache = new ResourceCache();
    binding.textureBytes = new Map([["tex-1", new Uint8Array([1, 2, 3, 4])]]);
    const sprite = createDefaultSpritePayload();
    sprite.textureGuid = "tex-1";
    binding.spritePayloads = new Map([["sprite-1", sprite]]);
    binding.modelBytes = new Map([["model-1", encodeTriangleGlb()]]);

    const spriteMesh = createPlayMesh(scene, 1, "sprite", "sprite-1", binding);
    expect(spriteMesh.material).toBeInstanceOf(StandardMaterial);
    const material = spriteMesh.material as StandardMaterial;
    expect(material.transparencyMode).toBe(Material.MATERIAL_ALPHATEST);
    expect(material.alphaCutOff).toBeCloseTo(0.4);

    const model = createPlayMesh(scene, 2, "box", "model-1", binding);
    expect(model.getTotalVertices()).toBe(0);
    expect(model.isPickable).toBe(false);
    expect(model.isVisible).toBe(false);
  });

  it("builds unlit overlay planes for 2DTexture, 2DMaterial, and 2DButton", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const texture = createPlayMesh(scene, 1, "2dtexture", "tex-1");
    const material = createPlayMesh(scene, 2, "2dmaterial", "mat-1");
    const button = createPlayMesh(scene, 3, "2dbutton", null);
    expect(texture.getClassName()).toBe("Mesh");
    expect((texture.material as StandardMaterial).disableLighting).toBe(true);
    expect((material.material as StandardMaterial).disableLighting).toBe(true);
    expect((button.material as StandardMaterial).disableLighting).toBe(true);
    expect(button.isPickable).toBe(true);
  });

  it("honors overlay HitTest when stamping assignMesh metadata", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: null,
      meshKind: "2dtexture",
      actorGuid: "banner",
      hitTest: "block",
      hasButton: true,
      buttonComponentId: "btn-1",
    });
    const mesh = binding.meshes.get(4);
    expect(mesh?.isPickable).toBe(true);
    expect(
      (mesh?.metadata as { overlayActorGuid?: string }).overlayActorGuid,
    ).toBe("banner");
    expect(
      (mesh?.metadata as { overlayButtonComponentId?: string })
        .overlayButtonComponentId,
    ).toBe("btn-1");
  });

  it("puts primitive and model Play meshes in the same world rendering group", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    binding.modelBytes = new Map([["model-1", encodeTriangleGlb()]]);
    const box = createPlayMesh(scene, 1, "box", null, binding);
    const model = createPlayMesh(scene, 2, "box", "model-1", binding);
    await binding.slotAnimLoads?.get(2);
    expect(box.renderingGroupId).toBe(model.renderingGroupId);
    expect(box.renderingGroupId).toBeGreaterThan(0);
    for (const child of model.getChildMeshes()) {
      expect(child.renderingGroupId).toBe(model.renderingGroupId);
    }
  });

  it("loads a Model guid once for two Play slots", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    const bytes = encodeTriangleGlb();
    binding.modelBytes = new Map([["model-1", bytes]]);
    const first = createPlayMesh(scene, 2, "box", "model-1", binding);
    const second = createPlayMesh(scene, 3, "box", "model-1", binding);
    await binding.slotAnimLoads?.get(2);
    await binding.slotAnimLoads?.get(3);
    expect(visualMeshes(first).length).toBeGreaterThan(0);
    expect(visualMeshes(second).length).toBeGreaterThan(0);
    expect(glbContainerLoadCount(scene)).toBe(1);
  });

  it("adopts the full GLB container when the file has no clips", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    binding.modelBytes = new Map([["model-1", encodeTriangleGlb()]]);
    const model = createPlayMesh(scene, 2, "box", "model-1", binding);
    expect(glbClipNames(encodeTriangleGlb())).toEqual([]);
    await binding.slotAnimLoads?.get(2);
    expect(model.visibility).toBe(0);
    expect(model.getChildMeshes().length).toBeGreaterThan(0);
  });

  it("loads a static Model.source view after a babasset round-trip", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
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
    const binding = createSnapshotSceneBinding();
    binding.modelBytes = new Map([["model-1", source]]);
    const model = createPlayMesh(scene, 2, "box", "model-1", binding);
    await binding.slotAnimLoads?.get(2);
    expect(visualMeshes(model).length).toBeGreaterThan(0);
  });

  it("applies Model material slots after the container loads", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    const override = new StandardMaterial("slot-mat", scene);
    binding.modelBytes = new Map([["model-1", encodeTriangleGlb()]]);
    binding.modelPayloads = new Map([
      [
        "model-1",
        {
            clipNames: [],
            skeletonGuid: null,
            importScale: 1,
            materialSlots: [{ index: 0, name: "Hero Mat", materialGuid: "mat-1" }],
        },
      ],
    ]);
    binding.resolveMaterial = (guid) => (guid === "mat-1" ? override : null);
    const model = createPlayMesh(scene, 2, "box", "model-1", binding);
    await binding.slotAnimLoads?.get(2);
    const visible = model.getChildMeshes().filter((mesh) => mesh.visibility > 0);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.some((mesh) => mesh.material === override)).toBe(true);
    expect(model.material).not.toBe(override);
  });

  it("lets MeshComponent.materialGuid win over Model slots", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    const slotMat = new StandardMaterial("slot-mat", scene);
    const meshMat = new StandardMaterial("mesh-mat", scene);
    binding.modelBytes = new Map([["model-1", encodeTriangleGlb()]]);
    binding.modelPayloads = new Map([
      [
        "model-1",
        {
            clipNames: [],
            skeletonGuid: null,
            importScale: 1,
            materialSlots: [{ index: 0, name: "Hero Mat", materialGuid: "mat-1" }],
        },
      ],
    ]);
    binding.resolveMaterial = (guid) => {
      if (guid === "mat-1") return slotMat;
      if (guid === "mesh-mat") return meshMat;
      return null;
    };
    binding.materialAssetGuids.set(2, "mesh-mat");
    const model = createPlayMesh(scene, 2, "box", "model-1", binding);
    applyMaterialToActorMeshes(binding, 2, model);
    await binding.slotAnimLoads?.get(2);
    applyMaterialToActorMeshes(binding, 2, model);
    expect(model.material).toBe(meshMat);
    for (const child of model.getChildMeshes()) {
      expect(child.material).toBe(meshMat);
    }
  });

  it("registers paused AnimationGroups from an animated GLB onto the slot", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    binding.modelBytes = new Map([["hero-model", encodeAnimatedTriangleGlb()]]);
    createPlayMesh(scene, 2, "box", "hero-model", binding);
    await binding.slotAnimLoads?.get(2);
    const group = binding.slotAnimationGroups?.get(2)?.find((entry) => {
      return entry.name === "Idle" && entry.clipAssetGuid === "hero-model";
    });
    expect(group).toBeDefined();
    expect(group?.from).toBeLessThan(group?.to ?? 0);
  });

  it("adopts every UV'd glTF part and applies a shared slot to all of them", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    const override = new StandardMaterial("slot-0", scene);
    binding.modelBytes = new Map([["hero-model", encodeUvHierarchyGlb()]]);
    binding.modelPayloads = new Map([
      [
        "hero-model",
        {
          clipNames: [],
          skeletonGuid: null,
          importScale: 1,
          materialSlots: [{ index: 0, name: "MatA", materialGuid: "mat-1" }],
        },
      ],
    ]);
    binding.resolveMaterial = (guid) => (guid === "mat-1" ? override : null);
    const root = createPlayMesh(scene, 2, "box", "hero-model", binding);
    await binding.slotAnimLoads?.get(2);
    const visuals = visualMeshes(root);
    expect(visuals).toHaveLength(2);
    for (const part of visuals) {
      expect(part.getVerticesData(VertexBuffer.UVKind)?.length ?? 0).toBeGreaterThan(
        0,
      );
      expect(part.material).toBe(override);
    }
  });

  it("maps separate glTF materials to independent Play slots", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    const slot0 = new StandardMaterial("slot-0", scene);
    const slot1 = new StandardMaterial("slot-1", scene);
    binding.modelBytes = new Map([
      ["hero-model", encodeUvHierarchyGlb({ separateMaterials: true })],
    ]);
    binding.modelPayloads = new Map([
      [
        "hero-model",
        {
          clipNames: [],
          skeletonGuid: null,
          importScale: 1,
          materialSlots: [
            { index: 0, name: "MatA", materialGuid: "mat-a" },
            { index: 1, name: "MatB", materialGuid: "mat-b" },
          ],
        },
      ],
    ]);
    binding.resolveMaterial = (guid) =>
      guid === "mat-a" ? slot0 : guid === "mat-b" ? slot1 : null;
    const root = createPlayMesh(scene, 2, "box", "hero-model", binding);
    await binding.slotAnimLoads?.get(2);
    const visuals = visualMeshes(root);
    expect(visuals).toHaveLength(2);
    const partA = visuals.find((part) => part.name === "part-a");
    const partB = visuals.find((part) => part.name === "part-b");
    expect(partA?.material).toBe(slot0);
    expect(partB?.material).toBe(slot1);
  });

  it("seeks a paused GLB clip so animState moves a targeted node", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    binding.modelBytes = new Map([
      ["hero-model", encodeParentedAnimatedTriangleGlb("Walk")],
    ]);
    createPlayMesh(scene, 2, "box", "hero-model", binding);
    await binding.slotAnimLoads?.get(2);
    const native = scene.animationGroups.find((group) => group.name === "Walk");
    expect(native).toBeDefined();
    expect(native!.animatables.length).toBeGreaterThan(0);
    expect(native!.isPlaying).toBe(false);

    const target = native!.targetedAnimations[0]?.target as TransformNode | undefined;
    expect(target).toBeDefined();
    const poseAt = () => {
      target!.computeWorldMatrix(true);
      const position = target!.getAbsolutePosition();
      return [position.x, position.y, position.z];
    };
    const host = sceneAnimHostFromBinding(binding, {
      animationGroups: scene.animationGroups,
    });
    const command = {
      type: "animState" as const,
      slotId: 2,
      stateId: "walk",
      normalisedTime: 0,
      blendWeights: { walk: 1 },
      clipName: "Walk",
      clipKind: "animation" as const,
      clipAssetGuid: "hero-model",
    };
    applyAnimStateToScene(host, command);
    const atStart = poseAt();
    applyAnimStateToScene(host, { ...command, normalisedTime: 1 });
    expect(poseAt()).not.toEqual(atStart);
    expect(native!.isPlaying).toBe(false);
  });

  it("seeks a named clip on a multi-mesh hierarchy GLB", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    binding.modelBytes = new Map([
      ["hero-model", encodeUvHierarchyGlb({ clipName: "Run" })],
    ]);
    createPlayMesh(scene, 2, "box", "hero-model", binding);
    await binding.slotAnimLoads?.get(2);
    const native = scene.animationGroups.find((group) => group.name === "Run");
    expect(native).toBeDefined();
    expect(native!.animatables.length).toBeGreaterThan(0);
    expect(native!.isPlaying).toBe(false);

    const target = native!.targetedAnimations[0]?.target as TransformNode | undefined;
    expect(target).toBeDefined();
    const poseAt = () => {
      target!.computeWorldMatrix(true);
      const position = target!.getAbsolutePosition();
      return [position.x, position.y, position.z];
    };
    const host = sceneAnimHostFromBinding(binding, {
      animationGroups: scene.animationGroups,
    });
    const command = {
      type: "animState" as const,
      slotId: 2,
      stateId: "run",
      normalisedTime: 0,
      blendWeights: { run: 1 },
      clipName: "Run",
      clipKind: "animation" as const,
      clipAssetGuid: "hero-model",
    };
    applyAnimStateToScene(host, command);
    const atStart = poseAt();
    applyAnimStateToScene(host, { ...command, normalisedTime: 1 });
    expect(poseAt()).not.toEqual(atStart);
    expect(native!.isPlaying).toBe(false);
  });

  it("adopts a pack GLB with UVs on every visual mesh and slot 0 on all parts", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    const override = new StandardMaterial("slot-0", scene);
    binding.modelBytes = new Map([["mannequin", kenneyMannequinGlb()]]);
    binding.modelPayloads = new Map([
      [
        "mannequin",
        {
          clipNames: ["idle"],
          skeletonGuid: null,
          importScale: 1,
          materialSlots: [{ index: 0, name: "texture-d", materialGuid: "mat-1" }],
        },
      ],
    ]);
    binding.resolveMaterial = (guid) => (guid === "mat-1" ? override : null);
    const root = createPlayMesh(scene, 2, "box", "mannequin", binding);
    await binding.slotAnimLoads?.get(2);
    const visuals = visualMeshes(root);
    expect(visuals.length).toBeGreaterThan(1);
    for (const part of visuals) {
      expect(part.getVerticesData(VertexBuffer.UVKind)?.length ?? 0).toBeGreaterThan(
        0,
      );
      expect(part.material).toBe(override);
    }
  });

  it("seeks pack-GLB idle on paused groups with live animatables", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    binding.modelBytes = new Map([["mannequin", kenneyMannequinGlb()]]);
    createPlayMesh(scene, 2, "box", "mannequin", binding);
    await binding.slotAnimLoads?.get(2);
    const native = scene.animationGroups.find((group) => group.name === "idle");
    expect(native).toBeDefined();
    expect(native!.animatables.length).toBeGreaterThan(0);
    expect(native!.isPlaying).toBe(false);

    const target = native!.targetedAnimations[0]?.target as TransformNode | undefined;
    expect(target).toBeDefined();
    const poseAt = () => {
      target!.computeWorldMatrix(true);
      const position = target!.getAbsolutePosition();
      const rotation = target!.rotationQuaternion ?? target!.rotation;
      return [position.x, position.y, position.z, rotation.x, rotation.y, rotation.z];
    };
    const host = sceneAnimHostFromBinding(binding, {
      animationGroups: scene.animationGroups,
    });
    const command = {
      type: "animState" as const,
      slotId: 2,
      stateId: "idle",
      normalisedTime: 0,
      blendWeights: { idle: 1 },
      clipName: "idle",
      clipKind: "animation" as const,
      clipAssetGuid: "mannequin",
    };
    applyAnimStateToScene(host, command);
    const atStart = poseAt();
    applyAnimStateToScene(host, { ...command, normalisedTime: 1 });
    expect(poseAt()).not.toEqual(atStart);
    expect(native!.isPlaying).toBe(false);
  });

  it("stamps native AnimationGroups with Animation asset guids when mapped", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    binding.modelBytes = new Map([["hero-model", encodeAnimatedTriangleGlb()]]);
    binding.modelClipAnimationGuids = new Map([
      ["hero-model", new Map([["Idle", "hero-idle-anim"]])],
    ]);
    createPlayMesh(scene, 2, "box", "hero-model", binding);
    await binding.slotAnimLoads?.get(2);
    const group = binding.slotAnimationGroups?.get(2)?.find((entry) => {
      return entry.name === "Idle" && entry.clipAssetGuid === "hero-idle-anim";
    });
    expect(group).toBeDefined();
  });

  it("stamps retargeted AnimationGroups with the retargeted Animation guid", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    const glb = encodeParentedAnimatedTriangleGlb("Idle");
    binding.modelBytes = new Map([
      ["hero-model", glb],
      ["mixamo-model", glb],
    ]);
    binding.retargetAnimationLoads = new Map([
      [
        "hero-model",
        [
          {
            animationGuid: "retargeted-idle",
            clipName: "Idle",
            sourceModelGuid: "mixamo-model",
          },
        ],
      ],
    ]);
    createPlayMesh(scene, 2, "box", "hero-model", binding);
    await binding.slotAnimLoads?.get(2);
    const group = binding.slotAnimationGroups?.get(2)?.find((entry) => {
      return entry.name === "Idle" && entry.clipAssetGuid === "retargeted-idle";
    });
    expect(group).toBeDefined();
    expect(group?.from).toBeLessThan(group?.to ?? 0);
  });

  it("keeps the slot mesh as the transform root for a parented animated GLB", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    binding.modelBytes = new Map([
      ["hero-model", encodeParentedAnimatedTriangleGlb()],
    ]);
    const root = createPlayMesh(scene, 2, "box", "hero-model", binding);
    binding.meshes.set(2, root);
    await binding.slotAnimLoads?.get(2);
    expect(binding.meshes.get(2)).toBe(root);
    expect(root.isDisposed()).toBe(false);
    const transformUnderSlot = scene.transformNodes.filter((node) =>
      node.isDescendantOf(root),
    );
    expect(transformUnderSlot.length).toBeGreaterThan(0);
    const descendant = root.getChildMeshes().find((mesh) => mesh !== root);
    expect(descendant).toBeDefined();
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 2,
          position: { x: 10, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    descendant!.computeWorldMatrix(true);
    expect(descendant!.getAbsolutePosition().x).toBeCloseTo(10);
    const group = binding.slotAnimationGroups?.get(2)?.find(
      (entry) => entry.name === "Idle",
    );
    expect(group).toBeDefined();
  });

  it("creates a PointLight for light:point mesh kinds", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    createPlayMesh(scene, 4, "light:point", null, binding);
    const light = binding.lights.get(4);
    expect(light).toBeInstanceOf(PointLight);
    expect(light!.name).toBe("authoredLight:4");
  });

  it("does not steal activeCamera for a camera that is not the Default Camera", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    setupDefaultViewport(scene);
    const orbit = scene.activeCamera;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 0,
      meshAssetGuid: null,
      meshKind: "camera",
      camera: { isDefault: false, projectionMode: "perspective" },
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 0,
          position: { x: 3, y: 4, z: -8 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    const camera = binding.cameras.get(0);
    expect(scene.activeCamera).toBe(orbit);
    expect(scene.activeCamera).not.toBe(camera);
    expect(camera).toBeDefined();
    if (camera && "position" in camera) {
      expect((camera as { position: { x: number; y: number; z: number } }).position.x).toBeCloseTo(3);
      expect((camera as { position: { y: number } }).position.y).toBeCloseTo(4);
    }
  });

  it("possesses a camera created by assignMesh before the first snapshot", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    setupDefaultViewport(scene);
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 0,
      meshAssetGuid: null,
      meshKind: "camera",
      camera: { isDefault: true, projectionMode: "perspective" },
    });
    applyPossessCamera(scene, binding, 0);
    expect(binding.cameras.get(0)).toBeDefined();
    expect(scene.activeCamera?.name).toBe("authoredCamera:0");
  });

  it("applies camera component rotation on top of the actor snapshot", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    const yaw: [number, number, number, number] = [
      0,
      Math.SQRT1_2,
      0,
      Math.SQRT1_2,
    ];
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 0,
      meshAssetGuid: null,
      meshKind: "camera",
      camera: { projectionMode: "perspective" },
      parts: [
        {
          componentId: "cam",
          meshKind: "camera",
          meshAssetGuid: null,
          parentId: null,
          position: [0, 0, 0],
          rotation: yaw,
          scale: [1, 1, 1],
        },
      ],
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 0,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    const camera = binding.cameras.get(0) as UniversalCamera;
    const expected = Vector3.Forward().applyRotationQuaternion(
      new Quaternion(...yaw),
    );
    const forward = camera.getDirection(Vector3.Forward());
    expect(forward.x).toBeCloseTo(expected.x, 5);
    expect(forward.y).toBeCloseTo(expected.y, 5);
    expect(forward.z).toBeCloseTo(expected.z, 5);
  });

  it("dims the default hemispheric fill when assignMesh adds an authored light", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    setupDefaultViewport(scene);
    expect(scene.getLightByName("light")!.intensity).toBe(DEFAULT_LIGHT_INTENSITY);
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: null,
      meshKind: "light:point",
      light: { color: [1, 1, 1], intensity: 1, enabled: true },
    });
    expect(scene.getLightByName("light")!.intensity).toBeCloseTo(
      AUTHORED_FILL_LIGHT_INTENSITY,
    );
  });

  it("restores the default fill when the last Play light despawns", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    setupDefaultViewport(scene);
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: null,
      meshKind: "light:point",
      light: { color: [1, 1, 1], intensity: 1, enabled: true },
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 4,
          position: { x: 0, y: 1, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    expect(scene.getLightByName("light")!.intensity).toBeCloseTo(
      AUTHORED_FILL_LIGHT_INTENSITY,
    );
    applySnapshotToScene(scene, binding, {
      frameId: 2,
      tickIndex: 2,
      alpha: 1,
      actorCount: 0,
      actors: [],
    });
    expect(scene.getLightByName("light")!.intensity).toBe(DEFAULT_LIGHT_INTENSITY);
  });

  it("applies authored light color and intensity from assignMesh", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: null,
      meshKind: "light:point",
      light: {
        color: [0.2, 0.4, 0.8],
        intensity: 3.5,
        enabled: true,
        range: 12,
      },
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 4,
          position: { x: 0, y: 1, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    const light = binding.lights.get(4);
    expect(light).toBeInstanceOf(PointLight);
    expect(light!.intensity).toBeCloseTo(3.5);
    expect(light!.diffuse.r).toBeCloseTo(0.2);
    expect(light!.diffuse.b).toBeCloseTo(0.8);
    const mesh = binding.meshes.get(4);
    expect(mesh).toBeDefined();
    expect(
      [mesh!, ...mesh!.getChildMeshes()].filter((entry) => entry.isVisible),
    ).toEqual([]);
  });

  it("does not show a cube for a light part under an origin root", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 3,
      meshAssetGuid: null,
      meshKind: "light:spot",
      light: { color: [1, 1, 1], intensity: 1, enabled: true },
      parts: [
        {
          componentId: "lamp",
          meshKind: "light:spot",
          meshAssetGuid: null,
          parentId: null,
          position: [0, 1, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      ],
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 3,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    expect(binding.lights.get(3)).toBeInstanceOf(SpotLight);
    const root = binding.meshes.get(3);
    expect(root).toBeDefined();
    expect(
      [root!, ...root!.getChildMeshes()].filter((entry) => entry.isVisible),
    ).toEqual([]);
  });

  it("does not show a cube for camera, audio, particle, or empty Play slots", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshAssetGuid: null,
      meshKind: "camera",
      camera: { isDefault: false, projectionMode: "perspective" },
    });
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 2,
      meshAssetGuid: null,
      meshKind: "audio",
    });
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 3,
      meshAssetGuid: null,
      meshKind: "particle",
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 4,
      actors: [1, 2, 3, 8].map((slotId) => ({
        slotId,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        flags: 1,
      })),
    });
    for (const slotId of [1, 2, 3, 8]) {
      const mesh = binding.meshes.get(slotId);
      expect(mesh, `slot ${slotId}`).toBeDefined();
      expect(
        [mesh!, ...mesh!.getChildMeshes()].filter((entry) => entry.isVisible),
        `slot ${slotId} visible meshes`,
      ).toEqual([]);
    }
  });

  it("steals activeCamera only when assignMesh marks the Default Camera", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshAssetGuid: null,
      meshKind: "camera",
      camera: { isDefault: true, projectionMode: "perspective" },
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 1,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    expect(scene.activeCamera).toBe(binding.cameras.get(1));
  });

  it("snaps the Play camera to the pixel grid when pixelPerfect is on", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    binding.pixelPerfect = true;
    binding.pixelsPerUnit = 100;
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshAssetGuid: null,
      meshKind: "camera",
      camera: { isDefault: true, projectionMode: "orthographic" },
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 1,
          position: { x: 0.014, y: 0.026, z: -8 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    const camera = binding.cameras.get(1) as { position: { x: number; y: number } };
    expect(camera.position.x).toBeCloseTo(0.01, 6);
    expect(camera.position.y).toBeCloseTo(0.03, 6);
  });

  it("prefers a possessed camera over the Default Camera", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    setupDefaultViewport(scene);
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshAssetGuid: null,
      meshKind: "camera",
      camera: { isDefault: true, projectionMode: "perspective" },
    });
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 2,
      meshAssetGuid: null,
      meshKind: "camera",
      camera: { isDefault: false, projectionMode: "perspective" },
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 2,
      actors: [1, 2].map((slotId) => ({
        slotId,
        position: { x: slotId, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        flags: 1,
      })),
    });
    expect(scene.activeCamera?.name).toBe("authoredCamera:1");

    applyPossessCamera(scene, binding, 2);
    expect(scene.activeCamera?.name).toBe("authoredCamera:2");
  });

  it("restores the Default Camera after a possessed camera despawns", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    setupDefaultViewport(scene);
    const fallback = scene.getCameraByName("camera");
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshAssetGuid: null,
      meshKind: "camera",
      camera: { isDefault: true, projectionMode: "perspective" },
    });
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 2,
      meshAssetGuid: null,
      meshKind: "camera",
      camera: { isDefault: false, projectionMode: "perspective" },
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 2,
      actors: [1, 2].map((slotId) => ({
        slotId,
        position: { x: slotId, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        flags: 1,
      })),
    });
    applyPossessCamera(scene, binding, 2);
    expect(scene.activeCamera?.name).toBe("authoredCamera:2");

    applySnapshotToScene(scene, binding, {
      frameId: 2,
      tickIndex: 2,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 1,
          position: { x: 1, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    expect(scene.activeCamera).toBe(binding.cameras.get(1));
    expect(scene.activeCamera?.name).toBe("authoredCamera:1");
    expect(scene.activeCamera).not.toBe(fallback);
  });

  it("keeps a visible mesh for every actor slot in one snapshot", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 0,
      meshAssetGuid: null,
      meshKind: "box",
    });
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshAssetGuid: null,
      meshKind: "sphere",
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 2,
      actors: [
        {
          slotId: 0,
          position: { x: -3, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
        {
          slotId: 1,
          position: { x: 3, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });

    expect(binding.meshes.size).toBe(2);
    const first = binding.meshes.get(0);
    const second = binding.meshes.get(1);
    expect(first?.isVisible).toBe(true);
    expect(second?.isVisible).toBe(true);
    expect(first?.position.x).toBeCloseTo(-3);
    expect(second?.position.x).toBeCloseTo(3);
    expect(first).not.toBe(second);
  });

  it("owns a distinct frozen world matrix for every actor slot", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 0,
      meshAssetGuid: null,
      meshKind: "box",
    });
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshAssetGuid: null,
      meshKind: "sphere",
    });

    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 2,
      actors: [
        {
          slotId: 0,
          position: { x: -3, y: 1, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
        {
          slotId: 1,
          position: { x: 4, y: -1, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });

    const firstWorld = binding.meshes.get(0)!.getWorldMatrix();
    const secondWorld = binding.meshes.get(1)!.getWorldMatrix();
    expect(firstWorld).not.toBe(secondWorld);
    expect(firstWorld.getTranslation().asArray()).toEqual([-3, 1, 0]);
    expect(secondWorld.getTranslation().asArray()).toEqual([4, -1, 0]);
    expect(binding.meshes.get(0)!.isWorldMatrixFrozen).toBe(true);
    expect(binding.meshes.get(1)!.isWorldMatrixFrozen).toBe(true);
  });

  it("rebuilds a slot visual when assignMesh arrives after the first snapshot", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    const snapshot = {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 7,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    };
    applySnapshotToScene(scene, binding, snapshot);
    const placeholderVertices = binding.meshes.get(7)!.getTotalVertices();

    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 7,
      meshAssetGuid: null,
      meshKind: "sphere",
    });
    applySnapshotToScene(scene, binding, snapshot);

    const rebuilt = binding.meshes.get(7);
    expect(rebuilt?.isVisible).toBe(true);
    expect(rebuilt!.getTotalVertices()).not.toBe(placeholderVertices);
  });

  it("keeps assigned geometry hidden until the first snapshot supplies its TRS", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 0,
      meshAssetGuid: null,
      meshKind: "box",
    });
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshAssetGuid: null,
      meshKind: "sphere",
    });
    const box = binding.meshes.get(0);
    const sphere = binding.meshes.get(1);
    expect.soft(box?.isVisible).toBe(false);
    expect.soft(sphere?.isVisible).toBe(false);
    expect(box!.getTotalVertices()).not.toBe(sphere!.getTotalVertices());
    expect(box!.getBoundingInfo().boundingBox.extendSize.x).toBeGreaterThan(0.2);
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 2,
      actors: [
        {
          slotId: 0,
          position: { x: -4, y: 1, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 2, y: 2, z: 2 },
          flags: 1,
        },
        {
          slotId: 1,
          position: { x: 4, y: 2, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    expect(box?.isVisible).toBe(true);
    expect(sphere?.isVisible).toBe(true);
    expect(box?.position.asArray()).toEqual([-4, 1, 0]);
    expect(sphere?.position.asArray()).toEqual([4, 2, 0]);
  });

  it("parents assignMesh parts under the snapshot-driven actor origin", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 0,
      meshAssetGuid: null,
      meshKind: "box",
      parts: [
        {
          componentId: "box",
          meshKind: "box",
          meshAssetGuid: null,
          parentId: null,
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        {
          componentId: "sphere",
          meshKind: "sphere",
          meshAssetGuid: null,
          parentId: null,
          position: [2, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      ],
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 0,
          position: { x: 5, y: 1, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    const root = binding.meshes.get(0);
    expect(root?.name).toBe("actor-0");
    expect(root?.position.x).toBeCloseTo(5);
    const box = scene.getMeshByName("actor-0|box");
    const sphere = scene.getMeshByName("actor-0|sphere");
    expect(box?.parent).toBe(root);
    expect(sphere?.parent).toBe(root);
    expect(box?.position.x).toBeCloseTo(0);
    expect(sphere?.position.x).toBeCloseTo(2);
  });

  it("creates a visible unpickable skybox for meshKind skybox", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 3,
      meshAssetGuid: null,
      meshKind: "skybox",
      skybox: {
        size: 1000,
        faces: {
          px: null,
          py: null,
          pz: null,
          nx: null,
          ny: null,
          nz: null,
        },
      },
    });
    const mesh = scene.getMeshByName("actor-3") as Mesh | null;
    expect(mesh).not.toBeNull();
    expect(mesh!.isVisible).toBe(false);
    expect(mesh!.isPickable).toBe(false);
    expect(mesh!.infiniteDistance).toBe(false);
    expect(mesh!.ignoreCameraMaxZ).toBe(true);
    expect(mesh!.renderingGroupId).toBe(RENDERING_GROUP.background);
    expect(isPlayHelperMeshKind("skybox")).toBe(false);
    expect(isPlayHelperMeshKind("rigidbody")).toBe(true);
    binding.liveSlots.add(3);
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 1,
      actors: [
        {
          slotId: 3,
          position: { x: 7, y: 2, z: -3 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          flags: 1,
        },
      ],
    });
    expect(mesh!.isVisible).toBe(true);
    expect(mesh!.isWorldMatrixFrozen).toBe(false);
    expect(mesh!.infiniteDistance).toBe(false);
    expect(mesh!.position.x).toBeCloseTo(7);
    expect(mesh!.position.y).toBeCloseTo(2);
    expect(mesh!.position.z).toBeCloseTo(-3);
  });

  it("keeps authored skybox size across a second assignMesh rebuild", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    const command = {
      type: "assignMesh" as const,
      slotId: 5,
      meshAssetGuid: null,
      meshKind: "skybox" as const,
      skybox: {
        size: 250,
        faces: {
          px: null,
          py: null,
          pz: null,
          nx: null,
          ny: null,
          nz: null,
        },
      },
    };
    applyAssignMesh(scene, binding, command);
    applyAssignMesh(scene, binding, command);
    const rebuilt = scene.getMeshByName("actor-5") as Mesh;
    const extent = rebuilt.getBoundingInfo().boundingBox.extendSize.x;
    expect(extent).toBeCloseTo(125);
  });

  it("creates a 3D Text mesh for meshKind text3d", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: null,
      meshKind: "text3d",
      text3d: {
        text: "Hi",
        size: 1,
        depth: 0.1,
        color: [1, 0, 0],
        fontAssetGuid: null,
      },
    });
    const mesh = scene.getMeshByName("actor-4") as Mesh | null;
    expect(mesh).not.toBeNull();
    expect((mesh!.metadata as { text3d?: boolean }).text3d).toBe(true);
    expect(isPlayHelperMeshKind("text3d")).toBe(false);
  });

  it("hides a RigidBody Play helper instead of drawing a white cube", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 4,
      meshAssetGuid: null,
      meshKind: "rigidbody",
    });
    const mesh = scene.getMeshByName("actor-4") as Mesh | null;
    expect(mesh).not.toBeNull();
    expect(mesh!.isVisible).toBe(false);
    expect(mesh!.isPickable).toBe(false);
    expect(
      (mesh!.metadata as { playHelperVisual?: boolean }).playHelperVisual,
    ).toBe(true);
  });

  it("draws Play collider dashes when meshKind encodes a collider shape", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 5,
      meshAssetGuid: null,
      meshKind: "collider:{\"kind\":\"box\",\"halfExtents\":{\"x\":0.5,\"y\":0.5,\"z\":0.5}}",
    });
    const mesh = scene.getMeshByName("actor-5") as Mesh | null;
    expect(mesh).not.toBeNull();
    expect(
      (mesh!.metadata as { editorColliderVisual?: boolean }).editorColliderVisual,
    ).toBe(true);
    expect(mesh!.getChildMeshes().length).toBeGreaterThan(0);
  });
});
