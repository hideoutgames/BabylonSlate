import { describe, expect, it, vi } from "vitest";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { WebGPUPipelineContext } from "@babylonjs/core/Engines/WebGPU/webgpuPipelineContext";
import type { UniformBuffer } from "@babylonjs/core";
import { releaseDeletedWebGpuPipelineContexts } from "./webgpu-resource-release";

type FakeBuffer = { uniqueId: number; references: number };

/**
 * Prototype-level WebGPUEngine (its constructor needs a real device) with the
 * buffer manager as the GPU seam; Babylon's own Effect release, pipeline
 * context and UniformBuffer code runs unchanged.
 */
function webGpuEngine() {
  let nextId = 1;
  const live = new Set<FakeBuffer>();
  const bufferManager = {
    createBuffer: () => {
      const buffer = { uniqueId: nextId++, references: 1 };
      live.add(buffer);
      return buffer;
    },
    releaseBuffer: vi.fn((buffer: FakeBuffer) => {
      buffer.references -= 1;
      if (buffer.references !== 0) return false;
      live.delete(buffer);
      return true;
    }),
  };
  const engine = Object.assign(Object.create(WebGPUEngine.prototype), {
    _compiledEffects: {} as Record<string, unknown>,
    _uniformBuffers: [] as UniformBuffer[],
    _features: { trackUbosInFrame: true, checkUbosContentBeforeUpload: true },
    _bufferManager: bufferManager,
    _frameId: 0,
  }) as WebGPUEngine;
  return { engine, live };
}

/** A compiled Effect whose shader declares a uniform outside every uniform block. */
function compiledEffectWithLeftOverUniform(engine: WebGPUEngine, key: string) {
  const context = new WebGPUPipelineContext(
    { leftOverUniforms: [{ name: "tint", type: "vec4<f32>", length: 0 }] } as never,
    engine,
  );
  context.buildUniformLayout();
  const effect = { _key: key, getPipelineContext: () => context };
  (engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects[key] = effect;
  return { effect, leftOver: context.uniformBuffer! };
}

describe("releaseDeletedWebGpuPipelineContexts", () => {
  it("releases a disposed Effect's leftover uniform buffer and its GPU buffer", () => {
    const { engine, live } = webGpuEngine();
    releaseDeletedWebGpuPipelineContexts(engine);
    const { effect, leftOver } = compiledEffectWithLeftOverUniform(engine, "pbr@A");
    const kept = compiledEffectWithLeftOverUniform(engine, "pbr@B");
    expect(live.size).toBe(2);

    engine._releaseEffect(effect as never);

    expect(engine._uniformBuffers).not.toContain(leftOver);
    expect(engine._uniformBuffers).toContain(kept.leftOver);
    expect(live.size).toBe(1);
  });

  it("releases each context once when Babylon deletes it again", () => {
    const { engine, live } = webGpuEngine();
    releaseDeletedWebGpuPipelineContexts(engine);
    const { effect } = compiledEffectWithLeftOverUniform(engine, "pbr@A");
    const context = effect.getPipelineContext();

    engine._deletePipelineContext(context as never);
    engine._deletePipelineContext(context as never);

    expect(live.size).toBe(0);
    expect((engine as unknown as { _bufferManager: { releaseBuffer: ReturnType<typeof vi.fn> } })._bufferManager.releaseBuffer).toHaveBeenCalledOnce();
  });
});
