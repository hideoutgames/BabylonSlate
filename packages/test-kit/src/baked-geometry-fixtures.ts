import type {
  BakeGeometrySource,
  GeneratedBakeTopology,
} from "@babylonslate/core";

export function bakeGeometryFixture(): {
  source: BakeGeometrySource;
  topology: GeneratedBakeTopology;
} {
  const positions = new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]);
  return {
    source: {
      vertexCount: 4,
      indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
      attributes: [
        {
          name: "position",
          componentType: "f32",
          components: 3,
          normalized: false,
          data: new Uint8Array(positions.buffer),
        },
        {
          name: "color",
          componentType: "u8",
          components: 4,
          normalized: true,
          data: new Uint8Array([
            1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255,
          ]),
        },
        {
          name: "custom",
          componentType: "i16",
          components: 1,
          normalized: false,
          data: new Uint8Array([255, 255, 0, 128, 255, 127, 17, 0]),
        },
      ],
    },
    topology: {
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      originalVertices: new Uint32Array([0, 2, 1, 0, 3, 2]),
      uv2: new Float32Array([
        0.1, 0.1, 0.3, 0.3, 0.3, 0.1, 0.6, 0.1, 0.6, 0.3, 0.8, 0.3,
      ]),
    },
  };
}
