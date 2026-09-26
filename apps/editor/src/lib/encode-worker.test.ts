import { afterEach, describe, expect, it, vi } from "vitest";
import { textureEncodeSize } from "@babylonslate/assets";
import workerSource from "../../public/basis/encode-worker.js?raw";

type WorkerReply = { type: string; id?: number; error?: string };
type EncodeSize = { width: number; height: number };

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Runs the shipped classic encode worker with fake browser and Basis globals
 * and returns the canvas draw size and the RGBA size handed to Basis.
 */
async function workerEncodeSize(
  source: EncodeSize,
  settings: { maxDimension: number; blockAlign?: number },
): Promise<{ drawn: EncodeSize; encoded: EncodeSize; rgbaBytes: number }> {
  const replies: WorkerReply[] = [];
  const drawn: EncodeSize[] = [];
  const encoded: (EncodeSize & { rgbaBytes: number })[] = [];
  const self: {
    location: { href: string };
    postMessage: (message: WorkerReply) => void;
    onmessage?: (event: { data: unknown }) => void;
  } = {
    location: { href: "https://editor.test/basis/encode-worker.js" },
    postMessage: (message) => replies.push(message),
  };
  vi.stubGlobal("self", self);
  vi.stubGlobal("importScripts", () => undefined);
  vi.stubGlobal("BASIS", async () => ({
    BasisEncoder: class {
      setCreateKTX2File() {}
      setKTX2UASTCSupercompression() {}
      setUASTC() {}
      setMipGen() {}
      setPerceptual() {}
      setSliceSourceImage(_slice: number, rgba: Uint8Array, width: number, height: number) {
        encoded.push({ width, height, rgbaBytes: rgba.byteLength });
      }
      encode() {
        return 16;
      }
      delete() {}
    },
  }));
  vi.stubGlobal("createImageBitmap", async () => ({ ...source, close: () => undefined }));
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return {
          drawImage: (_image: unknown, _x: number, _y: number, width: number, height: number) => {
            drawn.push({ width, height });
          },
          getImageData: (_x: number, _y: number, width: number, height: number) => ({
            data: new Uint8ClampedArray(width * height * 4),
          }),
        };
      }
    },
  );
  new Function(workerSource)();
  self.onmessage!({ data: { type: "init" } });
  await vi.waitFor(() => expect(replies.map((reply) => reply.type)).toContain("loaded"));
  self.onmessage!({
    data: {
      type: "encode",
      id: 1,
      source: new Uint8Array([0x89]).buffer,
      mime: "image/png",
      settings: { format: "uastc", quality: 2, generateMipmaps: true, ...settings },
    },
  });
  await vi.waitFor(() => expect(replies.find((reply) => reply.id === 1)?.type).toBe("encoded"));
  const { rgbaBytes, ...size } = encoded[0]!;
  return { drawn: drawn[0]!, encoded: size, rgbaBytes };
}

describe("Basis encode worker", () => {
  it("encodes Particle sources at the clamped size rounded up to 4x4 blocks", async () => {
    const particle = (width: number, height: number, maxDimension = 2048) =>
      workerEncodeSize({ width, height }, { maxDimension, blockAlign: 4 });

    const tiny = await particle(1, 1);
    expect(tiny.encoded).toEqual({ width: 4, height: 4 });
    // The whole image is stretched once to the aligned size.
    expect(tiny.drawn).toEqual({ width: 4, height: 4 });
    expect(tiny.rgbaBytes).toBe(4 * 4 * 4);
    expect((await particle(1000, 750)).encoded).toEqual({ width: 1000, height: 752 });
    expect((await particle(512, 384)).encoded).toEqual({ width: 512, height: 384 });
    // Clamp first (3000x1001 -> 2048x683), then align.
    expect((await particle(3000, 1001)).encoded).toEqual({ width: 2048, height: 684 });
  });

  it("matches the shared textureEncodeSize helper", async () => {
    const cases: [EncodeSize, { maxDimension: number; blockAlign?: number }][] = [
      [{ width: 1, height: 1 }, { maxDimension: 1, blockAlign: 4 }],
      [{ width: 1000, height: 750 }, { maxDimension: 250, blockAlign: 4 }],
      [{ width: 3, height: 4097 }, { maxDimension: 2048, blockAlign: 4 }],
      [{ width: 3000, height: 1001 }, { maxDimension: 2048 }],
      [{ width: 1, height: 1 }, { maxDimension: 2048 }],
    ];
    for (const [source, settings] of cases) {
      const expected = textureEncodeSize(source.width, source.height, settings);
      expect((await workerEncodeSize(source, settings)).encoded, JSON.stringify([source, settings])).toEqual({
        width: expected.width,
        height: expected.height,
      });
    }
  });
});
