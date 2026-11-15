import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";

type AlignedVertexBuffer = VertexBuffer & { effectiveByteStride?: number; effectiveByteOffset?: number };

/** Borrow a model attribute while its owning container remains leased. */
export function sharedVertexBuffer(source: AlignedVertexBuffer): VertexBuffer {
  return new VertexBuffer(source.engine, source.getWrapperBuffer(), source.getKind(), {
    // The layout of the buffer's aligned copy where it has one, else its own.
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
