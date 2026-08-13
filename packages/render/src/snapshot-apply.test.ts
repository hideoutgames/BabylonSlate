import { PointLight, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultSpritePayload } from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { ResourceCache } from "./resource-cache";
import { encodeTriangleGlb } from "./model-mesh";
import {
  createPlayMesh,
  createSnapshotSceneBinding,
  applySnapshotToScene,
} from "./snapshot-apply";

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
    expect(spriteMesh.material).toBeTruthy();

    const model = createPlayMesh(scene, 2, "box", "model-1", binding);
    const positions = model.getVerticesData(VertexBuffer.PositionKind);
    expect(positions).not.toBeNull();
    expect(positions!.length).toBe(9);
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

  it("binds the first camera slot as activeCamera and follows snapshot position", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    createPlayMesh(scene, 0, "camera", null, binding);
    expect(scene.activeCamera?.name).toBe("authoredCamera:0");
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
    expect(scene.activeCamera).toBe(camera);
    expect(camera).toBeDefined();
    if (camera && "position" in camera) {
      expect((camera as { position: { x: number; y: number; z: number } }).position.x).toBeCloseTo(3);
      expect((camera as { position: { y: number } }).position.y).toBeCloseTo(4);
    }
  });
});
