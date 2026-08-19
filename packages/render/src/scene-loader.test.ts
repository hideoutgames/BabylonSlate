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
  createPrimitiveMesh,
  editorComponentMeshName,
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

  it("creates editor meshes for the default cube and camera", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, createDefaultScene());
    expect(scene.getMeshByName(editorMeshName("actor-1"))).not.toBeNull();
    expect(scene.getMeshByName(editorMeshName("actor-camera"))).not.toBeNull();
    expect(scene.getMeshByName(editorMeshName("actor-skybox"))).not.toBeNull();
    expect(countSceneMeshes(scene)).toBeGreaterThan(1);
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
    const origin = scene.getMeshByName(editorMeshName("lamp"));
    const mesh = scene.getMeshByName(editorComponentMeshName("lamp", "light"));
    expect(origin!.billboardMode).toBe(Mesh.BILLBOARDMODE_NONE);
    expect(origin!.visibility).toBe(0);
    expect(origin!.isVisible).toBe(true);
    expect(origin!.isPickable).toBe(true);
    expect(
      (origin!.metadata as { editorPickProxy?: boolean }).editorPickProxy,
    ).toBe(true);
    expect(mesh).not.toBeNull();
    expect(mesh!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(
      (mesh!.metadata as { editorBillboard?: string }).editorBillboard,
    ).toBe("light");
  });

  it("represents CameraComponent, AudioComponent, and ParticleComponent actors with billboards", () => {
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
        createActor("fx", "Sparks", {
          components: [
            {
              id: "particle",
              classId: "ParticleComponent",
              properties: {},
            },
          ],
        }),
      ]),
    );
    const camera = scene.getMeshByName(editorComponentMeshName("cam", "camera"));
    const audio = scene.getMeshByName(editorComponentMeshName("spk", "audio"));
    const particle = scene.getMeshByName(
      editorComponentMeshName("fx", "particle"),
    );
    expect(scene.getMeshByName(editorMeshName("cam"))!.billboardMode).toBe(
      Mesh.BILLBOARDMODE_NONE,
    );
    expect(camera!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(
      (camera!.metadata as { editorBillboard?: string }).editorBillboard,
    ).toBe("camera");
    expect(audio!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(
      (audio!.metadata as { editorBillboard?: string }).editorBillboard,
    ).toBe("audio");
    expect(particle!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(
      (particle!.metadata as { editorBillboard?: string }).editorBillboard,
    ).toBe("particle");
  });

  it("represents a RigidBodyComponent actor with a rigidbody billboard, not a white cube", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("body", "Body", {
          components: [
            {
              id: "rb",
              classId: "RigidBodyComponent",
              properties: { motionType: "dynamic" },
            },
          ],
        }),
      ]),
    );
    const origin = scene.getMeshByName(editorMeshName("body"));
    const icon = scene.getMeshByName(editorComponentMeshName("body", "rb"));
    expect(origin!.billboardMode).toBe(Mesh.BILLBOARDMODE_NONE);
    expect(origin!.visibility).toBe(0);
    expect(
      (origin!.metadata as { editorPickProxy?: boolean }).editorPickProxy,
    ).toBe(true);
    expect(icon).not.toBeNull();
    expect(icon!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(
      (icon!.metadata as { editorBillboard?: string }).editorBillboard,
    ).toBe("rigidbody");
    expect(icon!.getBoundingInfo().boundingBox.extendSize.x).toBeGreaterThan(
      0.1,
    );
  });

  it("draws a ColliderComponent as world-space dashed geometry parented with local TRS", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("body", "Body", {
          components: [
            {
              id: "rb",
              classId: "RigidBodyComponent",
              properties: { motionType: "dynamic" },
            },
            {
              id: "col",
              classId: "ColliderComponent",
              properties: {
                shape: { kind: "box", halfExtents: { x: 0.5, y: 0.25, z: 0.5 } },
              },
              transform: {
                position: [1, 2, 3],
                rotation: [0, 0, 0, 1],
                scale: [2, 1, 1],
              },
            },
          ],
        }),
      ]),
    );
    const origin = scene.getMeshByName(editorMeshName("body"));
    const dashes = scene.getMeshByName(editorComponentMeshName("body", "col"));
    expect(origin!.visibility).toBe(0);
    expect(dashes).not.toBeNull();
    expect(dashes!.parent).toBe(origin);
    expect(dashes!.isPickable).toBe(false);
    expect([dashes!.position.x, dashes!.position.y, dashes!.position.z]).toEqual(
      [1, 2, 3],
    );
    expect(dashes!.scaling.x).toBe(2);
    expect(dashes!.renderingGroupId).toBe(1);
    expect(dashes!.getChildMeshes().length).toBeGreaterThan(0);
  });

  it("parents camera, light, and audio billboards under a non-billboard origin", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("cam", "Camera", {
          transform: {
            position: [1, 2, 3],
            rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
            scale: [1, 1, 1],
          },
          components: [
            {
              id: "camera",
              classId: "CameraComponent",
              properties: {},
            },
          ],
        }),
      ]),
    );
    const origin = scene.getMeshByName(editorMeshName("cam"));
    const icon = scene.getMeshByName(editorComponentMeshName("cam", "camera"));
    expect(origin!.billboardMode).toBe(Mesh.BILLBOARDMODE_NONE);
    expect(origin!.rotationQuaternion!.y).toBeCloseTo(Math.SQRT1_2, 5);
    expect(icon!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(icon!.parent).toBe(origin);
    expect(
      (icon!.metadata as { editorBillboard?: string }).editorBillboard,
    ).toBe("camera");
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
    const mesh = scene.getMeshByName(editorComponentMeshName("lamp", "light"))!;
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
    expect(actorIdFromMeshName("editorActor:ground:layer-1:0:0")).toBe("ground");
    expect(actorIdFromMeshName("editorActor:ground:layer-1:0:0:anim")).toBe(
      "ground",
    );
    expect(actorIdFromMeshName("editorActor:ground:layer-1:0:0:a1")).toBe(
      "ground",
    );
    expect(actorIdFromMeshName("editorActor:ground:layer-1:0:0:a1:anim")).toBe(
      "ground",
    );
    expect(
      actorIdFromMeshName(editorComponentMeshName("hero", "prefab-mesh")),
    ).toBe("hero");
  });

  it("parents offset component meshes under the actor origin", () => {
    const { scene } = createHandle();
    const box = createMeshComponent("box", "box");
    const sphere = {
      ...createMeshComponent("sphere", "sphere"),
      transform: {
        position: [2, 0, 0] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
    };
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("hero", "Hero", {
          transform: {
            position: [5, 1, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          components: [box, sphere],
        }),
      ]),
    );
    const root = scene.getMeshByName(editorMeshName("hero"));
    const boxMesh = scene.getMeshByName(editorComponentMeshName("hero", "box"));
    const sphereMesh = scene.getMeshByName(
      editorComponentMeshName("hero", "sphere"),
    );
    expect(root?.position.x).toBe(5);
    expect(root?.position.y).toBe(1);
    expect(boxMesh?.parent).toBe(root);
    expect(sphereMesh?.parent).toBe(root);
    expect(boxMesh?.position.x).toBe(0);
    expect(sphereMesh?.position.x).toBe(2);
  });

  it("keeps a nested child actor origin at the child transform", () => {
    const { scene } = createHandle();
    const sphere = {
      ...createMeshComponent("sphere", "sphere"),
      transform: {
        position: [2, 0, 0] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
    };
    applySceneToBabylonScene(
      scene,
      sceneWithActors([
        createActor("parent", "Parent", {
          components: [createMeshComponent("box", "box")],
        }),
        createActor("child", "Child", {
          parentId: "parent",
          transform: {
            position: [4, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          components: [sphere],
        }),
      ]),
    );
    const parent = scene.getMeshByName(editorMeshName("parent"));
    const childRoot = scene.getMeshByName(editorMeshName("child"));
    const childSphere = scene.getMeshByName(
      editorComponentMeshName("child", "sphere"),
    );
    expect(childRoot?.parent).toBe(parent);
    expect(childRoot?.position.x).toBe(4);
    expect(childSphere?.parent).toBe(childRoot);
    expect(childSphere?.position.x).toBe(2);
  });

  it("builds a pickable origin marker for meshKind pivot", () => {
    const { scene } = createHandle();
    const mesh = createPrimitiveMesh(scene, "origin", "pivot");
    expect(mesh.isPickable).toBe(true);
    expect(mesh.getChildMeshes().length).toBeGreaterThan(0);
    expect(scene.getMeshByName("origin:axis-x")).not.toBeNull();
    expect(scene.getMeshByName("origin:axis-y")).not.toBeNull();
    expect(scene.getMeshByName("origin:axis-z")).not.toBeNull();
  });

  it("clearSceneMeshes is safe on an already empty scene", () => {
    const { scene } = createHandle();
    clearSceneMeshes(scene);
    expect(countSceneMeshes(scene)).toBe(0);
  });
});
