import { sceneRenderPathStatus } from "./scene-render-path";
import type { ResolvedRenderingPipeline } from "@babylonslate/core";
import {
  EngineInstrumentation,
  type AbstractEngine,
  type Scene,
} from "@babylonjs/core";
import { sceneShadowController } from "./shadow-controller";
import { effectiveShadowSettings } from "@babylonslate/core";
import { sceneRenderingSettings } from "./render-settings";
import { sceneLightingLimits } from "./scene-lighting";

const instruments = new WeakMap<AbstractEngine, EngineInstrumentation>();
export type RenderDiagnostics = {
  cpuMs: number;
  gpuMs: number | null;
  gpuStatus: "available" | "pending" | "unsupported";
  width: number;
  height: number;
  samples: number;
  shadowPasses: number;
  shadowMapBytes: number;
  shadowDrawCalls: number;
  shadowTriangles: number;
  readbackMs: number | null;
  shadowLights: ReturnType<
    ReturnType<typeof sceneShadowController>["diagnostics"]
  >;
  qualityLimits: string[];
  pipeline: ResolvedRenderingPipeline;
};

export function createRenderDiagnostics(
  scene: Scene,
  cpuMs: () => number,
  readbackMs: () => number | null = () => null,
): () => RenderDiagnostics {
  const engine = scene.getEngine();
  let instrument = instruments.get(engine);
  const supported = !!engine.getCaps().timerQuery;
  if (!instrument && supported) {
    instrument = new EngineInstrumentation(engine);
    instrument.captureGPUFrameTime = true;
    instruments.set(engine, instrument);
    const owned = instrument;
    engine.onDisposeObservable.addOnce(() => {
      owned.dispose();
      instruments.delete(engine);
    });
  }
  return () => {
    const counter = instrument?.gpuFrameTimeCounter;
    const available = supported && !!counter?.count;
    const target = scene.activeCamera?.outputRenderTarget;
    const size = target?.getSize();
    const metrics = sceneShadowController(scene).metrics();
    const state = sceneRenderingSettings(scene);
    return {
      cpuMs: cpuMs(),
      pipeline: sceneRenderPathStatus(scene),
      readbackMs: readbackMs(),
      shadowDrawCalls: sceneShadowController(scene).shadowDrawCalls(),
      shadowTriangles: sceneShadowController(scene).shadowTriangles(),
      gpuMs: available ? counter.current / 1_000_000 : null,
      gpuStatus: available
        ? "available"
        : supported
          ? "pending"
          : "unsupported",
      width: size?.width ?? engine.getRenderWidth(),
      height: size?.height ?? engine.getRenderHeight(),
      samples: target?.samples ?? 1,
      shadowPasses: metrics.passes,
      shadowMapBytes: metrics.bytes,
      shadowLights: state.lightsDebug
        ? sceneShadowController(scene).diagnostics()
        : [],
      qualityLimits: [
        ...sceneRenderPathStatus(scene).limits,
        ...sceneLightingLimits(scene),
        ...effectiveShadowSettings(
          state.shadows,
          engine._features.supportCSM,
          state.mode,
        ).limits,
        ...sceneShadowController(scene).limits(),
      ],
    };
  };
}

export function lightsDebugText(diagnostics: RenderDiagnostics): string | null {
  if (!diagnostics.shadowLights.length) return null;
  return diagnostics.shadowLights
    .map(
      (light) =>
        `${light.name}: illumination ${light.illumination}; shadows ${light.status}${light.reason ? ` (${light.reason})` : ""}; ${light.mapSize}px / ${light.passes} passes${light.effectiveFilter ? ` / ${light.effectiveFilter}` : ""}`,
    )
    .join("\n");
}
