import type { MeshoptDecoder as MeshoptDecoderModule } from "meshoptimizer/decoder";

/** The npm meshopt decoder (its WASM inlined); synchronous once `ready` has resolved. */
export type GltfMeshoptDecoder = typeof MeshoptDecoderModule;

let meshoptDecoder: GltfMeshoptDecoder | null = null;
let loading: Promise<void> | null = null;

/**
 * Loads the decoders the glTF geometry reader (`glb-geometry.ts`) uses for compressed geometry, once: today the
 * meshopt decoder for `EXT_meshopt_compression`. The reader stays synchronous, so every place that precedes a
 * collision cook or a geometry read awaits this first; a read before it resolves reports the geometry unreadable
 * instead of decoding. Never rejects: a decoder that cannot load leaves meshopt geometry unreadable, and the next call
 * tries again. Loaded by a dynamic import, so a bundle that never awaits this does not carry the decoder.
 */
export function gltfGeometryDecodersReady(): Promise<void> {
  loading ??= import("meshoptimizer/decoder").then(async ({ MeshoptDecoder }) => {
    if (!MeshoptDecoder.supported) return;
    await MeshoptDecoder.ready;
    meshoptDecoder = MeshoptDecoder;
  }).catch(() => {
    loading = null;
  });
  return loading;
}

/** The meshopt decoder once {@link gltfGeometryDecodersReady} has resolved, else null. */
export function readyGltfMeshoptDecoder(): GltfMeshoptDecoder | null {
  return meshoptDecoder;
}
