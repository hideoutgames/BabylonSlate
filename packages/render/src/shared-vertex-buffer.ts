import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";

type AlignedVertexBuffer = VertexBuffer & { effectiveByteStride?: number; effectiveByteOffset?: number };

/** Borrow a model attribute while its owning container remains leased. */
export function sharedVertexBuffer(source: AlignedVertexBuffer): VertexBuffer {
  return new VertexBuffer(source.engine, source.getWrapperBuffer(), source.getKind(), {
    // WebGPU may substitute a 4-byte-aligned copy with its own layout.
    stride: source.effectiveByteStride ?? source.byteStride,
    offset: source.effectiveByteOffset ?? source.byteOffset,
    size: source.getSize(),
    type: source.type,
    normalized: source.normalized,
    useBytes: true,
    instanced: source.getIsInstanced(),
    divisor: source.getInstanceDivisor(),
    takeBufferOwnership: false,
  });
}
