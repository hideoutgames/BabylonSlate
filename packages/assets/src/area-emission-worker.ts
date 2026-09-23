import { decodeSourceToRgba } from "./decode-source-rgba";
import { encodeAreaEmission, type AreaEmissionProgress } from "./area-emission";
import { processAreaEmissionRgba } from "./area-emission-processing";

export type AreaEmissionRequest = { source: Uint8Array; sourceHash: string; mime?: string };
export type AreaEmissionReply = { progress: AreaEmissionProgress } | { bytes: Uint8Array } | { error: string };

self.onmessage = async (event: MessageEvent<AreaEmissionRequest>) => {
  const send = (value: AreaEmissionReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(value, transfer);
  try {
    const { source, sourceHash, mime } = event.data;
    send({ progress: { phase: "decoding", progress: 0 } });
    // Match the original raster's sampling before the native 1024-square copy.
    // Downsample policy for ordinary material textures must not alter emission.
    const decoded = await decodeSourceToRgba(source, Number.MAX_SAFE_INTEGER, mime);
    const rgba = await processAreaEmissionRgba(decoded.rgba, decoded.width, decoded.height, async (progress) => {
      send({ progress: { phase: "filtering", progress } });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const bytes = await encodeAreaEmission(rgba, sourceHash);
    send({ bytes }, [bytes.buffer]);
  } catch (error) { send({ error: error instanceof Error ? error.message : String(error) }); }
};
