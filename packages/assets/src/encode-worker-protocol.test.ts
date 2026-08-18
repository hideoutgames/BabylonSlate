import { describe, expect, it } from "vitest";
import {
  ENCODE_WORKER_DECODE_UNAVAILABLE,
  isRgbaEncodeRequest,
  isSourceEncodeRequest,
  sourceEncodeTransferables,
} from "./encode-worker-protocol";

describe("encode worker protocol", () => {
  it("identifies transferable source encode jobs", () => {
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
    expect(isSourceEncodeRequest(message)).toBe(true);
    expect(isRgbaEncodeRequest(message)).toBe(false);
    expect(sourceEncodeTransferables(message)).toEqual([source]);
  });

  it("identifies Safari fallback RGBA encode jobs", () => {
    const rgba = new Uint8Array(4).buffer;
    const message = {
      type: "encode" as const,
      id: 8,
      rgba,
      width: 1,
      height: 1,
      settings: {
        format: "uastc" as const,
        quality: 2,
        maxDimension: 64,
        generateMipmaps: false,
      },
    };
    expect(isRgbaEncodeRequest(message)).toBe(true);
    expect(isSourceEncodeRequest(message)).toBe(false);
  });

  it("names the worker reply that requests a main-thread decode fallback", () => {
    expect(ENCODE_WORKER_DECODE_UNAVAILABLE).toBe("decode_unavailable");
  });
});
