/**
 * Dedicated audio reverb bake worker. Hosts collect static triangles; this
 * thread runs occupancy / flood-fill / sparse probes and returns chunk bytes.
 */
import {
  bakeAudioReverb,
  unpackAudioReverbTriangles,
} from "./audio-reverb";

type BakeRequest = {
  id: number;
  triangles: Float32Array;
};

type BakeResponse =
  | { id: number; ok: true; bytes: Uint8Array }
  | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<BakeRequest>) => {
  const msg = event.data;
  try {
    const bytes = bakeAudioReverb(unpackAudioReverbTriangles(msg.triangles));
    const copy = bytes.slice();
    const response: BakeResponse = { id: msg.id, ok: true, bytes: copy };
    (self as unknown as Worker).postMessage(response, [copy.buffer]);
  } catch (error: unknown) {
    const response: BakeResponse = {
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
