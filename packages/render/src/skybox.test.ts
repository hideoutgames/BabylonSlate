import { PBRMaterial, Texture } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createSkyboxComponent } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import {
  applyActorTransform,
  applySceneToBabylonScene,
  editorMeshName,
} from "./scene-loader";
import { isSkyboxMesh } from "./skybox";

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

  it("builds an unlit infinite skybox for the default 3D scene", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, createDefaultScene());
    const mesh = scene.getMeshByName(editorMeshName("actor-skybox"));
    expect(mesh).not.toBeNull();
    expect(isSkyboxMesh(mesh!)).toBe(true);
    expect(mesh!.isPickable).toBe(false);
    expect(mesh!.infiniteDistance).toBe(true);
    expect(mesh!.ignoreCameraMaxZ).toBe(true);
    expect(mesh!.receiveShadows).toBe(false);
    const material = mesh!.material as PBRMaterial;
    expect(material.backFaceCulling).toBe(false);
    expect(material.disableLighting).toBe(true);
    expect(material.twoSidedLighting).toBe(true);
    expect(mesh!.applyFog).toBe(false);
    expect(material.reflectionTexture?.coordinatesMode).toBe(Texture.SKYBOX_MODE);
  });

  it("stays unpickable after the actor is unlocked", () => {
    const { scene } = createHandle();
    const sceneData = createDefaultScene();
    const skybox = sceneData.actors.find((actor) => actor.id === "actor-skybox");
    expect(skybox).toBeDefined();
    skybox!.locked = false;
    applySceneToBabylonScene(scene, sceneData);
    const mesh = scene.getMeshByName(editorMeshName("actor-skybox"))!;
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
