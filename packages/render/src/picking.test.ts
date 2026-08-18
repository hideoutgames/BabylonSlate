import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  type SerializedScene,
} from "@babylonslate/core";
import { createEditorCamera } from "./editor-camera";
import { EditorSceneSync } from "./editor-scene-sync";
import { encodeTranslatedTetrahedronGlb } from "./model-mesh";
import { pickAtCanvas } from "./picking";
import { editorComponentMeshName } from "./scene-loader";
import { projectToCanvas } from "./two-d";

const WIDTH = 800;
const HEIGHT = 600;

function sceneWith(actors: SerializedScene["actors"]): SerializedScene {
  return { ...createDefaultScene(), actors };
}

function audioActor(id: string, locked = false) {
  return createActor(id, "Speaker", {
    locked,
    transform: {
      ...identitySerializedTransform(),
      position: [0, 2, 0],
    },
    components: [
      {
        id: "audio",
        classId: "AudioComponent",
        properties: {},
      },
    ],
  });
}

describe("editor tap picking", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({
      renderWidth: WIDTH,
      renderHeight: HEIGHT,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    scene = new Scene(engine);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  function prepareView(target: Vector3, alpha = -Math.PI / 2) {
    const camera = createEditorCamera(scene, { mode: "3d" });
    camera.camera.alpha = alpha;
    camera.frame(target);
    camera.camera.getViewMatrix();
    scene.updateTransformMatrix();
    return camera;
  }

  function pickWorld(sync: EditorSceneSync, point: Vector3) {
    for (const mesh of scene.meshes) {
      mesh.computeWorldMatrix(true, scene.activeCamera);
    }
    scene.render();
    scene.updateTransformMatrix();
    const projected = projectToCanvas(scene, point, WIDTH, HEIGHT);
    if (!projected) throw new Error("projection failed");
    const hit = pickAtCanvas(scene, projected.x, projected.y);
    return hit ? sync.actorForMesh(hit.meshName) : null;
  }

  it("picks an unlocked box at its world position", () => {
    const position = new Vector3(2, 0, 0);
    prepareView(position);
    const sync = new EditorSceneSync(scene);
    sync.apply(
      sceneWith([
        createActor("box", "Box", {
          transform: {
            ...identitySerializedTransform(),
            position: [position.x, position.y, position.z],
          },
          components: [createMeshComponent("mesh", "box")],
        }),
      ]),
    );
    expect(pickWorld(sync, position)).toBe("box");
  });

  it("picks an audio helper from the origin collider when the icon is not pickable", () => {
    const position = new Vector3(0, 2, 0);
    prepareView(position, 0);
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([audioActor("spk")]));
    const visual = sync.visualMeshesForActor("spk")[0];
    if (!visual) throw new Error("missing audio visual");
    expect(visual.name).toBe(editorComponentMeshName("spk", "audio"));
    visual.isPickable = false;
    visual.computeWorldMatrix(true, scene.activeCamera);
    expect(pickWorld(sync, visual.getAbsolutePosition())).toBe("spk");
  });

  it("does not pick a locked audio helper, then hits after unlock", () => {
    const position = new Vector3(0, 2, 0);
    prepareView(position, 0);
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([audioActor("spk", true)]));
    expect(pickWorld(sync, position)).toBeNull();
    sync.apply(sceneWith([audioActor("spk", false)]));
    expect(pickWorld(sync, position)).toBe("spk");
  });

  it("picks a model at the visual center when the glTF node is translated", () => {
    const translation: [number, number, number] = [4, 0, 0];
    const visual = new Vector3(4.25, 0.25, 0.25);
    prepareView(visual);
    const sync = new EditorSceneSync(scene);
    const component = createMeshComponent("mesh", "box");
    component.properties.assetGuid = "hero";
    sync.setMeshAssets({
      modelBytes: new Map([["hero", encodeTranslatedTetrahedronGlb(translation)]]),
    });
    sync.apply(
      sceneWith([
        createActor("hero", "Hero", {
          components: [component],
        }),
      ]),
    );
    expect(sync.meshForActor("hero")?.getTotalVertices()).toBe(4);
    expect(pickWorld(sync, visual)).toBe("hero");
  });
});
