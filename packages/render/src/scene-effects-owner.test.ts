import {
  FreeCamera,
  ImageProcessingPostProcess,
  NullEngine,
  Scene,
  Vector3,
} from "@babylonjs/core";
import {
  DEFAULT_RENDER_EFFECTS,
  type RenderEffectsSettings,
} from "@babylonslate/core";
import { expect, it } from "vitest";
import { SceneEffectsOwner } from "./scene-effects-owner";
import { setSceneEffectsEnabled } from "./render-settings";
import { updateSceneRenderingSettings } from "./render-settings";

function host(effects?: Partial<RenderEffectsSettings>) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  scene.activeCamera = camera;
  if (effects)
    updateSceneRenderingSettings(scene, {
      mode: "pbr",
      effects: { ...DEFAULT_RENDER_EFFECTS, ...effects },
    });
  return { engine, scene, camera };
}

function passNames(camera: FreeCamera): string[] {
  return camera._postProcesses
    .filter(Boolean)
    .map((pass) => pass!.getClassName());
}

it("attaches nothing while settings match the established pipeline", () => {
  const { engine, scene, camera } = host();
  const owner = new SceneEffectsOwner(scene);
  try {
    expect(owner.hasEnabledEntries).toBe(false);
    owner.useNative(camera);
    expect(owner.passes).toHaveLength(0);
    expect(passNames(camera)).toHaveLength(0);
    expect(owner.nativeReadyFor(camera)).toBe(true);
  } finally {
    owner.dispose();
    scene.dispose();
    engine.dispose();
  }
});

it("composes bloom, the display stage and FXAA in order for Scene Linear", () => {
  const { engine, scene, camera } = host({
    colorPipeline: { version: 1, mode: "sceneLinear" },
    bloom: {
      enabled: true,
      threshold: 0.5,
      weight: 0.4,
      kernel: 32,
      scale: 0.25,
    },
    fxaa: true,
  });
  const owner = new SceneEffectsOwner(scene);
  try {
    owner.useNative(camera);
    expect(passNames(camera)).toEqual([
      "ExtractHighlightsPostProcess",
      "BlurPostProcess",
      "BlurPostProcess",
      "BloomMergePostProcess",
      "ImageProcessingPostProcess",
      "FxaaPostProcess",
    ]);
    expect(owner.passes).toHaveLength(6);
    const display = owner.passes[4] as ImageProcessingPostProcess;
    expect(display.fromLinearSpace).toBe(true);
    expect(display.imageProcessingConfiguration).not.toBe(
      scene.imageProcessingConfiguration,
    );
    expect(owner.nativeReadyFor(camera)).toBe(true);
  } finally {
    owner.dispose();
    scene.dispose();
    engine.dispose();
  }
});

it("keeps Legacy Display effects byte-sized without a display stage", () => {
  const { engine, scene, camera } = host({
    bloom: {
      enabled: true,
      threshold: 0.8,
      weight: 0.2,
      kernel: 16,
      scale: 0.5,
    },
    fxaa: true,
  });
  const owner = new SceneEffectsOwner(scene);
  try {
    owner.useNative(camera);
    expect(passNames(camera)).toEqual([
      "ExtractHighlightsPostProcess",
      "BlurPostProcess",
      "BlurPostProcess",
      "BloomMergePostProcess",
      "FxaaPostProcess",
    ]);
  } finally {
    owner.dispose();
    scene.dispose();
    engine.dispose();
  }
});

it("rebuilds on a settings change and detaches on useGraph", async () => {
  const { engine, scene, camera } = host({
    fxaa: true,
  });
  const owner = new SceneEffectsOwner(scene);
  try {
    owner.useNative(camera);
    const first = owner.passes.slice();
    expect(passNames(camera)).toEqual(["FxaaPostProcess"]);
    updateSceneRenderingSettings(scene, {
      mode: "pbr",
      effects: {
        ...DEFAULT_RENDER_EFFECTS,
        vignette: { enabled: true, weight: 2, color: [0, 0, 0] },
        fxaa: true,
      },
    });
    expect(owner.nativeReadyFor(camera)).toBe(false);
    owner.useNative(camera);
    expect(owner.passes.some((pass) => first.includes(pass))).toBe(false);
    expect(passNames(camera)).toEqual([
      "ImageProcessingPostProcess",
      "FxaaPostProcess",
    ]);
    owner.useGraph();
    expect(owner.passes).toHaveLength(0);
    expect(passNames(camera)).toHaveLength(0);
    owner.dispose();
    // Every retired generation settles through the owner's cleanup contract.
    await owner.whenDisposed();
    await owner.whenReleased();
  } finally {
    owner.dispose();
    scene.dispose();
    engine.dispose();
  }
});

it("releases readiness with the session post-processing toggle", () => {
  const { engine, scene, camera } = host({
    colorPipeline: { version: 1, mode: "sceneLinear" },
  });
  const owner = new SceneEffectsOwner(scene);
  try {
    owner.useNative(camera);
    expect(passNames(camera)).toEqual(["ImageProcessingPostProcess"]);
    setSceneEffectsEnabled(scene, false);
    expect(owner.hasEnabledEntries).toBe(false);
    expect(owner.nativeReadyFor(camera)).toBe(false);
    owner.useNative(camera);
    expect(passNames(camera)).toHaveLength(0);
    // Materials emit display color again while the toggle is off.
    expect(scene.imageProcessingConfiguration.applyByPostProcess).toBe(false);
  } finally {
    owner.dispose();
    scene.dispose();
    engine.dispose();
  }
});

it("moves per-material image processing into the post stage only for Scene Linear", () => {
  const { engine, scene } = host({
    colorPipeline: { version: 1, mode: "sceneLinear" },
  });
  try {
    expect(scene.imageProcessingConfiguration.applyByPostProcess).toBe(true);
    updateSceneRenderingSettings(scene, { mode: "cel" });
    expect(scene.imageProcessingConfiguration.applyByPostProcess).toBe(false);
    updateSceneRenderingSettings(scene, {
      mode: "pbr",
      effects: { ...DEFAULT_RENDER_EFFECTS },
    });
    expect(scene.imageProcessingConfiguration.applyByPostProcess).toBe(false);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
