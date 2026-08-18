import { Material, Mesh, PointLight, Quaternion, SpotLight, StandardMaterial, UniversalCamera, Vector3, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultSpritePayload } from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { encodeAnimatedTriangleGlb, encodeParentedAnimatedTriangleGlb, encodeTriangleGlb, glbClipNames } from "./model-mesh";
import { ResourceCache } from "./resource-cache";
import { AUTHORED_FILL_LIGHT_INTENSITY } from "./scene-illumination";
import {
  applyAssignMesh,
  applyPossessCamera,
  applySnapshotToScene,
  createPlayMesh,
  createSnapshotSceneBinding,
  isPlayHelperMeshKind,
} from "./snapshot-apply";
import { DEFAULT_LIGHT_INTENSITY, setupDefaultViewport } from "./viewport";

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
    const positions = model.getVerticesData(VertexBuffer.PositionKind);
    expect(positions).not.toBeNull();
    expect(positions!.length).toBe(9);
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

  it("does not start an AnimationGroup load for a GLB with no clips", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    binding.modelBytes = new Map([["model-1", encodeTriangleGlb()]]);
    createPlayMesh(scene, 2, "box", "model-1", binding);
    expect(binding.slotAnimLoads?.get(2)).toBeUndefined();
    expect(binding.slotAnimationGroups?.get(2)).toBeUndefined();
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

  it("does not show a cube for camera, audio, or empty Play slots", () => {
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
    applySnapshotToScene(scene, binding, {
      frameId: 1,
      tickIndex: 1,
      alpha: 1,
      actorCount: 3,
      actors: [1, 2, 8].map((slotId) => ({
        slotId,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        flags: 1,
      })),
    });
    for (const slotId of [1, 2, 8]) {
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
    expect(mesh!.infiniteDistance).toBe(true);
    expect(mesh!.ignoreCameraMaxZ).toBe(true);
    expect(isPlayHelperMeshKind("skybox")).toBe(false);
    binding.liveSlots.add(3);
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
    expect(mesh!.isVisible).toBe(true);
  });
});
