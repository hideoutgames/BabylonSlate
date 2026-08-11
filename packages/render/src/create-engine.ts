import { Color4, Engine, KhronosTextureContainer2, Scene } from "@babylonjs/core";
import type { SerializedScene } from "@babylonslate/core";
import { createDefaultScene } from "@babylonslate/core";
import { configureKtx2Transcoder } from "./ktx2-transcoder";
import { applySceneToBabylonScene } from "./scene-loader";
import { setupDefaultViewport } from "./viewport";

export interface EngineHandle {
  engine: Engine;
  scene: Scene;
  dispose: () => void;
  resize: () => void;
  loadScene: (sceneData: SerializedScene) => void;
}

/**
 * Requires a real WebGL context, so it is covered by the Playwright suite
 * rather than by unit tests. P4 replaces this demo loop with snapshot-driven,
 * render-on-demand sync.
 */
export function createEngine(canvas: HTMLCanvasElement): EngineHandle {
  configureKtx2Transcoder(KhronosTextureContainer2);
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });
  const scene = new Scene(engine);
  // Match dark shell --background (Minimal Neutral oklch(0.145 0 0) ≈ #252525).
  scene.clearColor = new Color4(37 / 255, 37 / 255, 37 / 255, 1);

  setupDefaultViewport(scene);

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
