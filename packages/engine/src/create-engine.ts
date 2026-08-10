import { Color3, Color4, Engine, Scene } from "@babylonjs/core";
import type { SerializedScene } from "@babylonslate/shared";
import { createDefaultScene } from "@babylonslate/shared";
import { applySceneToBabylonScene } from "./scene-loader";

export interface EngineHandle {
  engine: Engine;
  scene: Scene;
  dispose: () => void;
  resize: () => void;
  loadScene: (sceneData: SerializedScene) => void;
}

export function createEngine(canvas: HTMLCanvasElement): EngineHandle {
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.08, 0.09, 0.11, 1);

  const loadScene = (sceneData: SerializedScene) => {
    applySceneToBabylonScene(scene, sceneData);
  };

  loadScene(createDefaultScene());

  const resize = () => engine.resize();

  engine.runRenderLoop(() => {
    scene.meshes.forEach((mesh) => {
      if (mesh.name !== "__root__") {
        mesh.rotation.y += 0.01;
      }
    });
    scene.render();
  });

  return {
    engine,
    scene,
    dispose: () => {
      scene.dispose();
      engine.dispose();
    },
    resize,
    loadScene,
  };
}

export function setHighlightColor(scene: Scene, color: Color3): void {
  scene.ambientColor = color;
}
