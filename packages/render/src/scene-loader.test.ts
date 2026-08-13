import { Mesh, StandardMaterial } from "@babylonjs/core";
import { describe, expect, it, afterEach } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedComponent,
  type SerializedScene,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import {
  actorIdFromMeshName,
  applySceneToBabylonScene,
  clearSceneMeshes,
  countSceneMeshes,
  editorMeshName,
} from "./scene-loader";

function lightComponent(
  color: [number, number, number] = [1, 1, 1],
): SerializedComponent {
  return {
    id: "light",
    classId: "LightComponent",
    properties: { intensity: 1, color, lightKind: "point" },
  };
}

function sceneWithActors(
  actors: SerializedScene["actors"],
): SerializedScene {
  return { ...createDefaultScene(), actors };
}

describe("scene-loader", () => {
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

  it("creates one mesh per actor from default scene data", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, createDefaultScene());
    expect(countSceneMeshes(scene)).toBe(1);
    expect(scene.getMeshByName(editorMeshName("actor-1"))).not.toBeNull();
  });

  it("replaces meshes when loading a new scene", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, createDefaultScene());
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("box-a", "A", {
          components: [createMeshComponent("c1", "box")],
        }),
        createActor("box-b", "B", {
          components: [createMeshComponent("c2", "sphere")],
        }),
      ]),
    );

    expect(countSceneMeshes(scene)).toBe(2);
    expect(scene.getMeshByName(editorMeshName("actor-1"))).toBeNull();
    expect(scene.getMeshByName(editorMeshName("box-a"))).not.toBeNull();
  });

  it("handles an empty actor list", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, createDefaultScene());
    applySceneToBabylonScene(scene, sceneWithActors([]));
    expect(countSceneMeshes(scene)).toBe(0);
  });

  it("clearSceneMeshes removes all non-root meshes", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, createDefaultScene());
    clearSceneMeshes(scene);
    expect(countSceneMeshes(scene)).toBe(0);
  });

  it("places each actor at its serialized transform", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("box-a", "A", {
          transform: {
            position: [1, 2, 3],
            rotation: [0, 0, 0, 1],
            scale: [2, 2, 2],
          },
          components: [createMeshComponent("c1", "box")],
        }),
      ]),
    );

    const box = scene.getMeshByName(editorMeshName("box-a"));
    expect(box).not.toBeNull();
    expect([box!.position.x, box!.position.y, box!.position.z]).toEqual([
      1, 2, 3,
    ]);
    expect(box!.scaling.x).toBe(2);
  });

  it("parents child actors to their parent mesh", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("parent", "Parent"),
        createActor("child", "Child", { parentId: "parent" }),
      ]),
    );

    const child = scene.getMeshByName(editorMeshName("child"));
    expect(child?.parent?.name).toBe(editorMeshName("parent"));
  });

  it("creates a pickable cube proxy for actors without a mesh component", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(
      scene,
      sceneWithActors([createActor("empty", "Empty")]),
    );
    const mesh = scene.getMeshByName(editorMeshName("empty"));
    expect(mesh).not.toBeNull();
    expect(mesh!.billboardMode).toBe(Mesh.BILLBOARDMODE_NONE);
    expect(
      (mesh!.metadata as { editorBillboard?: string } | null)?.editorBillboard,
    ).toBeUndefined();
  });

  it("represents a LightComponent actor with a lightbulb billboard", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("lamp", "Point Light", { components: [lightComponent()] }),
      ]),
    );
    const mesh = scene.getMeshByName(editorMeshName("lamp"));
    expect(mesh).not.toBeNull();
    expect(mesh!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(
      (mesh!.metadata as { editorBillboard?: string }).editorBillboard,
    ).toBe("light");
  });

  it("represents CameraComponent and AudioComponent actors with billboards", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("cam", "Camera", {
          components: [
            {
              id: "camera",
              classId: "CameraComponent",
              properties: {},
            },
          ],
        }),
        createActor("spk", "Speaker", {
          components: [
            {
              id: "audio",
              classId: "AudioComponent",
              properties: {},
            },
          ],
        }),
      ]),
    );
    const camera = scene.getMeshByName(editorMeshName("cam"));
    const audio = scene.getMeshByName(editorMeshName("spk"));
    expect(camera!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(
      (camera!.metadata as { editorBillboard?: string }).editorBillboard,
    ).toBe("camera");
    expect(audio!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(
      (audio!.metadata as { editorBillboard?: string }).editorBillboard,
    ).toBe("audio");
  });

  it("keeps a MeshComponent visual when the actor also has a LightComponent", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("lamp", "Lamp", {
          components: [createMeshComponent("mesh", "box"), lightComponent()],
        }),
      ]),
    );
    const mesh = scene.getMeshByName(editorMeshName("lamp"));
    expect(mesh).not.toBeNull();
    expect(mesh!.billboardMode).toBe(Mesh.BILLBOARDMODE_NONE);
    expect(
      (mesh!.metadata as { editorBillboard?: string } | null)?.editorBillboard,
    ).toBeUndefined();
  });

  it("tints a light billboard from LightComponent color", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("lamp", "Red Light", {
          components: [lightComponent([1, 0.2, 0.1])],
        }),
      ]),
    );
    const mesh = scene.getMeshByName(editorMeshName("lamp"))!;
    const material = mesh.material as StandardMaterial;
    expect(material.emissiveColor.r).toBeCloseTo(1);
    expect(material.emissiveColor.g).toBeCloseTo(0.2);
    expect(material.emissiveColor.b).toBeCloseTo(0.1);
  });

  it("hides invisible actors and unlocks pickability from the locked flag", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("hidden", "Hidden", { visible: false, locked: true }),
      ]),
    );
    const mesh = scene.getMeshByName(editorMeshName("hidden"))!;
    expect(mesh.isVisible).toBe(false);
    expect(mesh.isPickable).toBe(false);
  });

  it("maps mesh names back to actor ids", () => {
    expect(actorIdFromMeshName(editorMeshName("abc"))).toBe("abc");
    expect(actorIdFromMeshName("actor-3")).toBeNull();
  });

  it("clearSceneMeshes is safe on an already empty scene", () => {
    const { scene } = createHandle();
    clearSceneMeshes(scene);
    expect(countSceneMeshes(scene)).toBe(0);
  });
});
