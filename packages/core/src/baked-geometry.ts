import type { BakedReceiverIdentity } from "./baked-lighting";

/** Immutable seam topology; authored model buffers remain the source of all attributes. */
export interface BakedGeometryManifest {
  version: 1;
  sceneGuid: string;
  receiver: BakedReceiverIdentity;
  sourceHash: string;
  sourceVertexCount: number;
  indexCount: number;
  vertexCount: number;
  /** SHA-256 of the canonical little-endian topology chunk. */
  contentHash: string;
  provider: { id: string; version: string; adapterVersion: string };
  layout: {
    width: number;
    height: number;
    paddingTexels: number;
    uvSet: 1;
    coordinates: "normalized-bottom-first";
    mipLevels: 1;
  };
}

export interface GeneratedBakeTopology {
  /** Input triangle order and winding are retained exactly. */
  indices: Uint32Array;
  /** Each generated vertex refers to one complete original vertex. */
  originalVertices: Uint32Array;
  uv2: Float32Array;
}

export type BakeVertexComponentType =
  "i8" | "u8" | "i16" | "u16" | "u32" | "f32";

/** Packed per-vertex data. Interleaved sources are copied into this format by their owner. */
export interface BakeVertexAttribute {
  name: string;
  componentType: BakeVertexComponentType;
  components: number;
  normalized: boolean;
  data: Uint8Array;
}

export interface BakeGeometrySource {
  vertexCount: number;
  indices: Uint32Array;
  attributes: readonly BakeVertexAttribute[];
}
