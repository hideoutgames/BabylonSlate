import type { TextureEncodeSettings } from "./texture-compression";

/** Worker could not decode source bytes; host should run Safari Image.decode fallback. */
export const ENCODE_WORKER_DECODE_UNAVAILABLE = "decode_unavailable" as const;

export interface SourceEncodeRequest {
  type: "encode";
  id: number;
  source: ArrayBuffer;
  mime?: string;
  settings: TextureEncodeSettings;
}

export interface RgbaEncodeRequest {
  type: "encode";
  id: number;
  rgba: ArrayBuffer;
  width: number;
  height: number;
  settings: TextureEncodeSettings;
}

export type EncodeWorkerHostMessage =
  | { type: "init" }
  | { type: "recycle" }
  | SourceEncodeRequest
  | RgbaEncodeRequest;

export type EncodeWorkerReply =
  | { type: "loaded" }
  | { type: "recycled" }
  | { type: "encoded"; id: number; ktx2: ArrayBuffer; wallMs: number }
  | { type: "error"; id?: number; error: string }
  | {
      type: typeof ENCODE_WORKER_DECODE_UNAVAILABLE;
      id: number;
      error: string;
    };

export function isSourceEncodeRequest(
  message: unknown,
): message is SourceEncodeRequest {
  if (!message || typeof message !== "object") return false;
  const value = message as Record<string, unknown>;
  return value.type === "encode" && value.source instanceof ArrayBuffer;
}

export function isRgbaEncodeRequest(
  message: unknown,
): message is RgbaEncodeRequest {
  if (!message || typeof message !== "object") return false;
  const value = message as Record<string, unknown>;
  return value.type === "encode" && value.rgba instanceof ArrayBuffer;
}

export function sourceEncodeTransferables(
  message: SourceEncodeRequest,
): Transferable[] {
  return [message.source];
}
