import { Mesh, PBRMaterial, Texture, UniversalCamera, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createSkyboxComponent } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import {
  applyActorTransform,
  applySceneToBabylonScene,
  editorMeshName,
} from "./scene-loader";
import {
  ENGINE_DEFAULT_SKYBOX_GUID,
  isSkyboxMesh,
  skyboxCubeCacheGuid,
} from "./skybox";
import { RENDERING_GROUP } from "./sorting";
import { applyAuthoredCameraLens } from "./scene-illumination";

describe("editor skybox mesh", () => {
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

  it("builds an unlit skybox at the actor transform, not camera-locked", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, createDefaultScene());
    const mesh = scene.getMeshByName(editorMeshName("actor-skybox")) as Mesh | null;
    expect(mesh).not.toBeNull();
    expect(isSkyboxMesh(mesh!)).toBe(true);
    expect(mesh!.isPickable).toBe(false);
    expect(mesh!.infiniteDistance).toBe(false);
    expect(mesh!.ignoreCameraMaxZ).toBe(true);
    expect(mesh!.receiveShadows).toBe(false);
    expect(mesh!.renderingGroupId).toBe(RENDERING_GROUP.background);
    const material = mesh!.material as PBRMaterial;
    expect(material.backFaceCulling).toBe(false);
    expect(material.disableLighting).toBe(true);
    expect(material.twoSidedLighting).toBe(true);
    expect(mesh!.applyFog).toBe(false);
    expect(material.reflectionTexture?.coordinatesMode).toBe(Texture.SKYBOX_MODE);
  });

  it("keeps the authored actor position instead of following the camera", () => {
    const { scene } = createHandle();
    const actor = createActor("sky", "Skybox", {
      transform: {
        position: [4, 5, 6],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      components: [createSkyboxComponent("sky-comp")],
    });
    const sceneData = { ...createDefaultScene(), actors: [actor] };
    applySceneToBabylonScene(scene, sceneData);
    const mesh = scene.getMeshByName(editorMeshName("sky")) as Mesh;
    applyActorTransform(mesh, actor);
    expect(mesh.infiniteDistance).toBe(false);
    expect(mesh.position.x).toBeCloseTo(4);
    expect(mesh.position.y).toBeCloseTo(5);
    expect(mesh.position.z).toBeCloseTo(6);
  });

  it("draws a large skybox beyond the authored far clip and restores normal clipping", () => {
    const { scene } = createHandle();
    const actor = createActor("sky", "Skybox", {
      components: [createSkyboxComponent("sky-comp", 10000)],
    });
    applySceneToBabylonScene(scene, { ...createDefaultScene(), actors: [actor] });
    const mesh = scene.getMeshByName(editorMeshName("sky")) as Mesh;
    const camera = new UniversalCamera("possessed", Vector3.Zero(), scene);
    applyAuthoredCameraLens(camera, {
      projectionMode: "perspective", nearClip: 0.1, farClip: 1000,
    }, 16 / 9);
    scene.activeCamera = camera;
    const faceCenter = new Vector3(0, 0, 5000);
    const projectedDepth = () =>
      Vector3.TransformCoordinates(faceCenter, camera.getProjectionMatrix()).z;
    expect(projectedDepth()).toBeGreaterThan(1);
    let skyDepth: number | undefined;
    let skyAspect: number | undefined;
    mesh.onBeforeRenderObservable.add(() => {
      skyDepth = projectedDepth();
      const matrix = camera.getProjectionMatrix().m;
      skyAspect = matrix[5]! / matrix[0]!;
    });
    // Exercise Babylon's actual per-mesh clip exemption, including restoration.
    mesh.render(mesh.subMeshes[0]!, false);
    expect(skyDepth).toBeGreaterThan(0);
    expect(skyDepth).toBeLessThan(1);
    expect(skyAspect).toBeCloseTo(16 / 9);
    expect(camera.maxZ).toBe(1000);
    expect(projectedDepth()).toBeGreaterThan(1);
  });

  it("keys the default cubemap separately from authored face combinations", () => {
    expect(skyboxCubeCacheGuid(undefined)).toBe(ENGINE_DEFAULT_SKYBOX_GUID);
    expect(
      skyboxCubeCacheGuid({
        px: "tex-right",
        py: null,
        pz: null,
        nx: null,
        ny: null,
        nz: null,
      }),
    ).toBe("skybox:tex-right,default,default,default,default,default");
  });

  it("stays unpickable after the actor is unlocked", () => {
    const { scene } = createHandle();
    const sceneData = createDefaultScene();
    const skybox = sceneData.actors.find((actor) => actor.id === "actor-skybox");
    expect(skybox).toBeDefined();
    skybox!.locked = false;
    applySceneToBabylonScene(scene, sceneData);
    const mesh = scene.getMeshByName(editorMeshName("actor-skybox")) as Mesh;
    applyActorTransform(mesh, skybox!);
    expect(mesh.isPickable).toBe(false);
  });

  it("removes the skybox mesh when the actor is deleted", () => {
    const { scene } = createHandle();
    const sceneData = createDefaultScene();
    applySceneToBabylonScene(scene, sceneData);
    applySceneToBabylonScene(scene, {
      ...sceneData,
      actors: sceneData.actors.filter((actor) => actor.id !== "actor-skybox"),
    });
    expect(scene.getMeshByName(editorMeshName("actor-skybox"))).toBeNull();
  });

  it("rebuilds when a face guid is assigned", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    const actor = createActor("sky", "Skybox", {
      components: [createSkyboxComponent("sky-comp")],
    });
    const sceneData = { ...createDefaultScene(), actors: [actor] };
    sync.apply(sceneData);
    const before = scene.getMeshByName(editorMeshName("sky"));
    expect(before).not.toBeNull();
    actor.components[0]!.properties.faces = {
      px: "tex-right",
      py: null,
      pz: null,
      nx: null,
      ny: null,
      nz: null,
    };
    sync.apply(sceneData);
    const after = scene.getMeshByName(editorMeshName("sky"));
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    sync.dispose();
  });
});
