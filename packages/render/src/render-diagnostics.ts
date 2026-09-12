import { CascadedShadowGenerator, EngineInstrumentation, type AbstractEngine, type Scene } from "@babylonjs/core";
import { sceneShadowController } from "./shadow-controller";
import { effectiveShadowSettings } from "@babylonslate/core";
import { sceneRenderingSettings } from "./render-settings";

const instruments = new WeakMap<AbstractEngine, EngineInstrumentation>();
export type RenderDiagnostics = {
  cpuMs: number;
  gpuMs: number | null;
  gpuStatus: "available" | "pending" | "unsupported";
  width: number; height: number; samples: number;
  shadowPasses: number; shadowMapBytes: number;
  shadowLights: ReturnType<ReturnType<typeof sceneShadowController>["diagnostics"]>;
  qualityLimits: string[];
};

export function createRenderDiagnostics(scene: Scene, cpuMs: () => number): () => RenderDiagnostics {
  const engine = scene.getEngine();
  let instrument = instruments.get(engine);
  const supported = !!engine.getCaps().timerQuery;
  if (!instrument && supported) {
    instrument = new EngineInstrumentation(engine);
    instrument.captureGPUFrameTime = true;
    instruments.set(engine, instrument);
    const owned = instrument;
    engine.onDisposeObservable.addOnce(() => { owned.dispose(); instruments.delete(engine); });
  }
  return () => {
    const counter = instrument?.gpuFrameTimeCounter;
    const available = supported && !!counter?.count;
    const target = scene.activeCamera?.outputRenderTarget;
    const size = target?.getSize();
    const lights = sceneShadowController(scene).diagnostics();
    const state = sceneRenderingSettings(scene);
    return {
      cpuMs: cpuMs(),
      gpuMs: available ? counter.current / 1_000_000 : null,
      gpuStatus: available ? "available" : supported ? "pending" : "unsupported",
      width: size?.width ?? engine.getRenderWidth(), height: size?.height ?? engine.getRenderHeight(),
      samples: target?.samples ?? 1,
      shadowPasses: lights.reduce((sum, light) => sum + light.passes, 0),
      // Conservative depth + color attachment estimate, excluding driver overhead.
      shadowMapBytes: lights.reduce((sum, light) => sum + light.passes * light.mapSize ** 2 * 8, 0),
      shadowLights: lights,
      qualityLimits: effectiveShadowSettings(state.shadows, state.shadowDeviceProfile, CascadedShadowGenerator.IsSupported, state.mode).limits,
    };
  };
}
