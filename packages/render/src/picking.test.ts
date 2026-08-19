import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedGlbExternalImages } from "@babylonslate/assets";
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
import { editorComponentMeshName, editorMeshName } from "./scene-loader";
import { meshNamesInCanvasRect, projectToCanvas } from "./two-d";
import { visualMeshes } from "./visual-meshes";

const WIDTH = 800;
const HEIGHT = 600;

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

  it("picks an audio icon when the view is not edge-on to world XY", () => {
    const position = new Vector3(0, 2, 0);
    prepareView(position);
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([audioActor("spk")]));
    const visual = sync.visualMeshesForActor("spk")[0];
    if (!visual) throw new Error("missing audio visual");
    visual.computeWorldMatrix(true, scene.activeCamera);
    expect(pickWorld(sync, visual.getAbsolutePosition())).toBe("spk");
  });

  it("does not pick a locked origin collider, then hits after unlock", () => {
    const position = new Vector3(0, 2, 0);
    prepareView(position, 0);
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([audioActor("spk", true)]));
    const lockedIcon = sync.visualMeshesForActor("spk")[0];
    if (lockedIcon) lockedIcon.isPickable = false;
    expect(pickWorld(sync, position)).toBeNull();
    sync.apply(sceneWith([audioActor("spk", false)]));
    const unlockedIcon = sync.visualMeshesForActor("spk")[0];
    if (unlockedIcon) unlockedIcon.isPickable = false;
    expect(pickWorld(sync, position)).toBe("spk");
  });

  it("refreshes camera-dependent world matrices inside pickAtCanvas", () => {
    const position = new Vector3(0, 2, 0);
    prepareView(position, 0);
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([audioActor("spk")]));
    sync.meshForActor("spk")!.isPickable = false;
    const projected = projectToCanvas(scene, position, WIDTH, HEIGHT);
    if (!projected) throw new Error("projection failed");
    const hit = pickAtCanvas(scene, projected.x, projected.y);
    expect(hit ? sync.actorForMesh(hit.meshName) : null).toBe("spk");
  });

  it("marquee-selects an audio helper once, skipping the origin collider", () => {
    const position = new Vector3(0, 2, 0);
    prepareView(position);
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([audioActor("spk")]));
    for (const mesh of scene.meshes) {
      mesh.computeWorldMatrix(true, scene.activeCamera);
    }
    scene.updateTransformMatrix();
    const projected = projectToCanvas(scene, position, WIDTH, HEIGHT);
    if (!projected) throw new Error("projection failed");
    const names = meshNamesInCanvasRect(
      scene,
      { x: projected.x - 40, y: projected.y - 40, width: 80, height: 80 },
      WIDTH,
      HEIGHT,
    );
    expect(names).not.toContain(editorMeshName("spk"));
    expect(names).toContain(editorComponentMeshName("spk", "audio"));
    expect(
      names.map((name) => sync.actorForMesh(name)).filter(Boolean),
    ).toEqual(["spk"]);
  });

  it("picks a model at the visual center when the glTF node is translated", async () => {
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
    const root = sync.meshForActor("hero");
    expect(root?.getTotalVertices()).toBe(0);
    await vi.waitFor(() => {
      expect(visualMeshes(root!).length).toBeGreaterThan(0);
    });
    const part = visualMeshes(root!)[0]!;
    part.computeWorldMatrix(true);
    vi.spyOn(scene, "pick").mockReturnValue({
      hit: true,
      pickedMesh: part,
    } as never);
    const hit = pickAtCanvas(scene, 1, 1);
    expect(hit?.meshName).toBe(editorMeshName("hero"));
    expect(sync.actorForMesh(hit!.meshName)).toBe("hero");
  });

  it("picks a Kenney Mannequin body part back to the actor", async () => {
    prepareView(new Vector3(0, 0.8, 0));
    const sync = new EditorSceneSync(scene);
    const component = createMeshComponent("mesh", "box");
    component.properties.assetGuid = "mannequin";
    sync.setMeshAssets({
      modelBytes: new Map([["mannequin", kenneyMannequinGlb()]]),
    });
    sync.apply(
      sceneWith([
        createActor("hero", "Mannequin", {
          components: [component],
        }),
      ]),
    );
    const root = sync.meshForActor("hero");
    await vi.waitFor(() => {
      expect(visualMeshes(root!).some((part) => part.name === "torso")).toBe(
        true,
      );
    });
    const torso = visualMeshes(root!).find((part) => part.name === "torso");
    expect(torso).toBeDefined();
    torso!.computeWorldMatrix(true);
    expect(pickWorld(sync, torso!.getAbsolutePosition())).toBe("hero");
  });

  it("does not pick a locked Mannequin after instantiate", async () => {
    prepareView(new Vector3(0, 0.8, 0));
    const sync = new EditorSceneSync(scene);
    const component = createMeshComponent("mesh", "box");
    component.properties.assetGuid = "mannequin";
    sync.setMeshAssets({
      modelBytes: new Map([["mannequin", kenneyMannequinGlb()]]),
    });
    sync.apply(
      sceneWith([
        createActor("hero", "Mannequin", {
          locked: true,
          components: [component],
        }),
      ]),
    );
    const root = sync.meshForActor("hero");
    await vi.waitFor(() => {
      expect(visualMeshes(root!).length).toBeGreaterThan(1);
    });
    const torso = visualMeshes(root!).find((part) => part.name === "torso");
    expect(torso?.isPickable).toBe(false);
    expect(pickWorld(sync, torso!.getAbsolutePosition())).toBeNull();
  });
});
