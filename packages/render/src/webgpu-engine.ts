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
  const engine = new WebGPUEngine(canvas, {
    antialias: false,
    stencil: true,
    adaptToDeviceRatio: false,
    useLargeWorldRendering: true,
    useExactSrgbConversions: true,
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
    return engine;
  } catch (error) {
    try {
      if (initialized) engine.dispose();
      else disposeFailedWebGpuInitialization(engine, canvas);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "WebGPU initialization and cleanup failed.",
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Babylon 9.20's dispose assumes initAsync created every helper. Its failed
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
