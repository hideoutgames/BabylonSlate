/// <reference lib="webworker" />
import { decodeSourceToRgba, packRawRgbaTexture } from "@haptic/assets";

export interface TextureDownsampleRequest {
  id: number;
  bytes: Uint8Array;
  targetEdge: number;
}

export type TextureDownsampleResponse =
  | { id: number; ok: true; bytes: Uint8Array }
  | { id: number; ok: false; error: string };

self.onmessage = async (event: MessageEvent<TextureDownsampleRequest>) => {
  const { id, bytes, targetEdge } = event.data;
  try {
    const decoded = await decodeSourceToRgba(bytes, targetEdge);
    const packed = packRawRgbaTexture(decoded.width, decoded.height, decoded.rgba);
    const response: TextureDownsampleResponse = { id, ok: true, bytes: packed };
    self.postMessage(response, [packed.buffer]);
  } catch (error) {
    const response: TextureDownsampleResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
