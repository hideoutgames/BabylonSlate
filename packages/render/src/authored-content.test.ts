import { StandardMaterial, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedScene,
} from "@babylonslate/core";
import {
  createDefaultSpritePayload,
  createDefaultTilemapPayload,
  normalizeTilesetPayload,
  setTile,
} from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { ResourceCache } from "./resource-cache";
import { applySceneToBabylonScene, editorMeshName } from "./scene-loader";
import type { MeshAssetContext } from "./mesh-assets";
import { encodeTriangleGlb } from "./model-mesh";
import { setupDefaultViewport } from "./viewport";

function sceneWith(
  actors: SerializedScene["actors"],
): SerializedScene {
  return { ...createDefaultScene(), actors };
}

describe("authored mesh content", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  function createHandle() {
    const handle = createTestEngine();
    handles.push(handle);
    return handle;
  }

  it("assigns a ResourceCache texture to a sprite quad", () => {
    const { scene } = createHandle();
    const cache = new ResourceCache();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sprite = createDefaultSpritePayload();
    sprite.textureGuid = "tex-1";
    const assets: MeshAssetContext = {
      resourceCache: cache,
      textureBytes: new Map([["tex-1", bytes]]),
      spritePayloads: new Map([["sprite-1", sprite]]),
    };
    applySceneToBabylonScene(
      scene,
      sceneWith([
        createActor("hero", "Hero", {
          components: [
            {
              id: "spr",
              classId: "SpriteComponent",
              properties: { assetGuid: "sprite-1" },
            },
          ],
        }),
      ]),
      assets,
    );
    const mesh = scene.getMeshByName(editorMeshName("hero"));
    expect(mesh).not.toBeNull();
    const material = mesh!.material as StandardMaterial | null;
    expect(material).toBeInstanceOf(StandardMaterial);
    expect(material!.emissiveTexture).toBeTruthy();
  });

  it("assigns a ResourceCache texture to tilemap chunk meshes", () => {
    const { scene } = createHandle();
    const cache = new ResourceCache();
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const tileset = normalizeTilesetPayload({
      textureGuid: "atlas",
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    let tilemap = createDefaultTilemapPayload();
    tilemap = { ...tilemap, tilesetGuid: "tileset-1", chunkSize: 2 };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    const assets: MeshAssetContext = {
      resourceCache: cache,
      textureBytes: new Map([["atlas", bytes]]),
      tilemaps: new Map([["map-1", tilemap]]),
      tilesets: new Map([["tileset-1", tileset]]),
    };
    applySceneToBabylonScene(
      scene,
      sceneWith([
        createActor("ground", "Ground", {
          components: [
            {
              id: "tm",
              classId: "TilemapComponent",
              properties: { assetGuid: "map-1" },
            },
          ],
        }),
      ]),
      assets,
    );
    const root = scene.getMeshByName(editorMeshName("ground"));
    expect(root).not.toBeNull();
    const child = root!.getChildren()[0] as { material?: StandardMaterial };
    expect(child.material).toBeInstanceOf(StandardMaterial);
    expect(child.material!.emissiveTexture).toBeTruthy();
  });

  it("loads a GLB assetGuid as the authored mesh instead of a box", () => {
    const { scene } = createHandle();
    const glb = encodeTriangleGlb();
    applySceneToBabylonScene(
      scene,
      sceneWith([
        createActor("tree", "Tree", {
          components: [
            {
              ...createMeshComponent("mesh", "box"),
              properties: { meshKind: "box", assetGuid: "model-1" },
            },
          ],
        }),
      ]),
      { modelBytes: new Map([["model-1", glb]]) },
    );
    const mesh = scene.getMeshByName(editorMeshName("tree"));
    expect(mesh).not.toBeNull();
    const positions = mesh!.getVerticesData(VertexBuffer.PositionKind);
    expect(positions).not.toBeNull();
    expect(positions!.length).toBe(9);
  });

  it("creates a PointLight from LightComponent instead of only the default hemi", () => {
    const { scene } = createHandle();
    const hemi = scene.lights.length;
    applySceneToBabylonScene(
      scene,
      sceneWith([
        createActor("lamp", "Lamp", {
          transform: {
            position: [2, 3, 4],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          components: [
            {
              id: "light",
              classId: "LightComponent",
              properties: {
                lightKind: "point",
                intensity: 2.5,
                color: [1, 0, 0],
              },
            },
          ],
        }),
      ]),
    );
    const point = scene.lights.find((light) => light.name === "authoredLight:lamp");
    expect(point).toBeDefined();
    expect(point!.intensity).toBeCloseTo(2.5, 5);
    expect(point!.getClassName()).toBe("PointLight");
    expect(hemi).toBe(0);
    expect(scene.lights.length).toBeGreaterThan(0);
  });

  it("does not steal the first CameraComponent when Default Camera is unset", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);
    const orbit = scene.activeCamera;
    applySceneToBabylonScene(
      scene,
      sceneWith([
        createActor("cam", "Camera", {
          transform: {
            position: [0, 2, -6],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          components: [
            {
              id: "camera",
              classId: "CameraComponent",
              properties: {
                fieldOfView: 50,
                projectionMode: "perspective",
              },
            },
          ],
        }),
      ]),
    );
    expect(scene.getCameraByName("authoredCamera:cam")).toBeTruthy();
    expect(scene.activeCamera).toBe(orbit);
    expect(scene.activeCamera?.name).not.toBe("authoredCamera:cam");
  });

  it("uses the named Default Camera as activeCamera", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);
    const data = sceneWith([
      createActor("cam", "Camera", {
        transform: {
          position: [0, 2, -6],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            id: "camera",
            classId: "CameraComponent",
            properties: {
              fieldOfView: 50,
              projectionMode: "perspective",
            },
          },
        ],
      }),
    ]);
    data.settings.mainCameraActorId = "cam";
    data.settings.mainCameraComponentId = "camera";
    applySceneToBabylonScene(scene, data);
    expect(scene.activeCamera?.name).toBe("authoredCamera:cam");
  });
});
