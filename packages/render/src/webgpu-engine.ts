import {
  AbstractEngine,
  DracoDecoder,
  KhronosTextureContainer2,
  MeshoptCompression,
} from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { _CommonDispose } from "@babylonjs/core/Engines/engine.common";
import type { CreateEngineOptions } from "./create-engine";
import { configureGltfMeshDecoders } from "./gltf-mesh-decoders";
import {
  configureKtx2DecoderRuntime,
  configureKtx2Transcoder,
} from "./ktx2-transcoder";
import { pruneReleasedWebGpuCacheEntries } from "./webgpu-cache-pruning";
import { releaseDeletedWebGpuPipelineContexts } from "./webgpu-resource-release";

/** A fully initialized project Engine, with the same offline assets as WebGL2. */
export async function createAppWebGpuEngine(
  canvas: HTMLCanvasElement,
  options: Pick<
    CreateEngineOptions,
    "ktx2BasePath" | "dracoBasePath" | "meshoptBasePath"
  > = {},
  signal?: AbortSignal,
): Promise<WebGPUEngine> {
  signal?.throwIfAborted();
  if (
    typeof navigator === "undefined" ||
    !("gpu" in navigator) ||
    !navigator.gpu
  )
    throw new Error("WebGPU is unavailable in this browser.");
  configureKtx2Transcoder(KhronosTextureContainer2, options.ktx2BasePath);
  configureGltfMeshDecoders(DracoDecoder, MeshoptCompression, {
    dracoBasePath: options.dracoBasePath,
    meshoptBasePath: options.meshoptBasePath,
  });
  const engine: WebGPUEngine = new WebGPUEngine(canvas, {
    antialias: false,
    stencil: true,
    adaptToDeviceRatio: false,
    useLargeWorldRendering: true,
    useExactSrgbConversions: true,
    // Babylon 9.29's WebGPU restore rebuilds every resource before its new
    // device exists, so a lost Engine is replaced instead (`whenWebGpuDeviceLost`).
    // This also stops textures keeping their source bytes for that restore.
    doNotHandleContextLost: true,
    // Babylon intersects this list with the actual adapter's features.
    deviceDescriptor: {
      requiredFeatures: [
        "texture-compression-astc",
        "texture-compression-bc",
        "texture-compression-etc2",
        "float32-filterable",
        "float32-blendable",
        "timestamp-query",
      ],
      // Babylon 9.29 reads this after storing the adapter's limits and
      // before requesting the device.
      get requiredLimits(): Record<string, number> {
        return adapterRequiredLimits(engine.supportedLimits);
      },
    },
  });
  let initialized = false;
  try {
    // Browser adapter/device requests have no cancellation API. Keep ownership
    // until they settle, then release a superseded Engine before returning.
    await engine.initAsync();
    initialized = true;
    signal?.throwIfAborted();
    configureKtx2DecoderRuntime(KhronosTextureContainer2, {
      caps: engine.getCaps(),
      renderer: engine.getInfo().renderer,
    });
    watchWebGpuDevice(engine);
    releaseDeletedWebGpuPipelineContexts(engine);
    pruneReleasedWebGpuCacheEntries(engine);
    return engine;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      if (initialized) engine.dispose();
      else disposeFailedWebGpuInitialization(engine, canvas);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "WebGPU initialization and cleanup failed.",
        { cause: error },
      );
    throw error;
  }
}

/** WebGPU's default `maxUniformBuffersPerShaderStage`; requesting it is a no-op. */
const DEFAULT_UNIFORM_BUFFERS_PER_SHADER_STAGE = 12;

/**
 * Highest `maxUniformBuffersPerShaderStage` the Engine asks for. Babylon binds
 * one uniform buffer per light in the vertex shader, and the forward light
 * budget is this limit less four (`forwardLightBudget`), so 20 gives 16 slots:
 * the Medium tier's 16 local lights, and every light of the Feature Test main
 * scene (9) with room to spare. Past that, Clustered Forward is the route to
 * many lights. The cap also keeps a Metal adapter that offers 44 from admitting
 * 40-light shaders at High and Ultra, which would be well beyond the 11 to 13
 * slots that WebGL2 desktops give. Babylon's known light bindings cover 32.
 */
export const REQUESTED_UNIFORM_BUFFERS_PER_SHADER_STAGE = 20;

/**
 * Limits the device requests; every other limit keeps its WebGPU default, and
 * none is ever above the adapter's, so the device request cannot be refused
 * for this. Babylon builds its caps from the granted device limits.
 *
 * - `maxInterStageShaderVariables` at the adapter's maximum: Babylon's WGSL
 *   fragment input struct always declares `@builtin(front_facing)`, which
 *   Chromium counts, so the default 16 leaves 15 user varyings, fewer than a
 *   shadowed PBR material can need.
 * - `maxUniformBuffersPerShaderStage` up to
 *   {@link REQUESTED_UNIFORM_BUFFERS_PER_SHADER_STAGE}, only when the adapter
 *   offers more than the default 12. D3D12 adapters report 12, so they keep
 *   the default; Metal reports more (44 on Apple GPUs). The default's 8 light
 *   slots made lights swap by camera distance in scenes with more, and each
 *   swap recompiled every lit material.
 */
function adapterRequiredLimits(
  supported: GPUSupportedLimits | undefined,
): Record<string, number> {
  const limits: Record<string, number> = {};
  const interStage = supported?.maxInterStageShaderVariables;
  if (typeof interStage === "number")
    limits.maxInterStageShaderVariables = interStage;
  const uniformBuffers = supported?.maxUniformBuffersPerShaderStage;
  if (
    typeof uniformBuffers === "number" &&
    Number.isFinite(uniformBuffers) &&
    uniformBuffers > DEFAULT_UNIFORM_BUFFERS_PER_SHADER_STAGE
  )
    limits.maxUniformBuffersPerShaderStage = Math.min(
      Math.floor(uniformBuffers),
      REQUESTED_UNIFORM_BUFFERS_PER_SHADER_STAGE,
    );
  return limits;
}

/**
 * Babylon 9.29's dispose assumes initAsync created every helper. Its failed
 * adapter/device path dereferences missing helpers before releasing listeners
 * and EngineStore ownership. This adapter is only for failed initialization,
 * before this Engine can own any application Scene or resource-cache entry.
 */
function disposeFailedWebGpuInitialization(
  engine: WebGPUEngine,
  canvas: HTMLCanvasElement,
): void {
  const partial = engine as unknown as {
    _isDisposed: boolean;
    _timestampQuery?: { dispose(): void };
    _mainTexture?: { destroy(): void };
    _depthTexture?: { destroy(): void };
    _textureHelper?: { destroyDeferredTextures(): void };
    _bufferManager?: { destroyDeferredBuffers(): void };
    _device?: { destroy(): void };
    _context?: { unconfigure(): void };
  };
  // Suppress native device-loss recovery if cleanup destroys a partial device.
  partial._isDisposed = true;
  const failures: unknown[] = [];
  const release = (action: () => void) => {
    try {
      action();
    } catch (error) {
      failures.push(error);
    }
  };
  release(() => partial._timestampQuery?.dispose());
  release(() => partial._mainTexture?.destroy());
  release(() => partial._depthTexture?.destroy());
  release(() => partial._textureHelper?.destroyDeferredTextures());
  release(() => partial._bufferManager?.destroyDeferredBuffers());
  release(() => partial._context?.unconfigure());
  release(() => partial._device?.destroy());
  release(() => _CommonDispose(engine, canvas));
  release(() => AbstractEngine.prototype.dispose.call(engine));
  if (failures.length)
    throw new AggregateError(
      failures,
      "Failed to release a partially initialized WebGPU Engine.",
    );
}

type DiagnosedDevice = {
  lost?: Promise<{ reason?: string; message?: string }>;
  addEventListener?: (type: "uncapturederror", listener: (event: { error?: { message?: string } }) => void) => void;
};

export interface WebGpuDeviceLoss {
  reason: string;
  message: string;
}

const deviceLosses = new WeakMap<AbstractEngine, Promise<WebGpuDeviceLoss>>();

/**
 * Settles when the WebGPU device of an Engine from `createAppWebGpuEngine` is
 * lost while the Engine is still in use; never for its own disposal. A lost
 * Engine cannot recover in place: release it and create a new one.
 */
export function whenWebGpuDeviceLost(engine: AbstractEngine): Promise<WebGpuDeviceLoss> | null {
  return deviceLosses.get(engine) ?? null;
}

/**
 * A lost device makes every later call fail with an unrelated-looking
 * InvalidStateError. Log the loss and uncaptured errors so copied load reports
 * name the cause, mark the Engine lost and notify its context-lost observers
 * (Babylon does neither with `doNotHandleContextLost`). Disposal destroys the
 * device after marking the Engine disposed, so it is not a loss.
 */
export function watchWebGpuDevice(engine: WebGPUEngine): void {
  // Pinned Babylon 9.29 owning-device boundary.
  const device = (engine as unknown as { _device?: DiagnosedDevice })._device;
  if (device?.lost) {
    deviceLosses.set(engine, new Promise<WebGpuDeviceLoss>((resolve) => {
      void device.lost!.then((info) => {
        if (engine.isDisposed) return;
        const loss = { reason: info.reason ?? "unknown", message: info.message || "no message" };
        console.error(`[render] WebGPU device lost (${loss.reason}): ${loss.message}`);
        (engine as unknown as { _contextWasLost: boolean })._contextWasLost = true;
        try {
          engine.onContextLostObservable.notifyObservers(engine);
        } catch (error) {
          console.error(`[render] A context-lost observer failed: ${String(error)}`);
        }
        resolve(loss);
      }, () => undefined);
    }));
  }
  device?.addEventListener?.("uncapturederror", (event) => {
    console.warn(`[render] WebGPU uncaptured error: ${event.error?.message ?? "unknown"}`);
  });
}
