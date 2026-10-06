import { describe, expect, it } from "vitest";
import {
  sourceEncodeTransferables,
} from "./encode-worker-protocol";

describe("encode worker protocol", () => {
  it("transfers the source buffer of a source encode job", () => {
    const source = new Uint8Array([1, 2, 3]).buffer;
    const message = {
      type: "encode" as const,
      id: 7,
      source,
      mime: "image/webp",
      settings: {
        format: "uastc" as const,
        quality: 2,
        maxDimension: 512,
        generateMipmaps: true,
      },
    };
    expect(sourceEncodeTransferables(message)).toEqual([source]);
  });
});
