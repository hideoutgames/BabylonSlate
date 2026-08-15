export const PREVIEW_PACK_MESSAGE = "babylonslate-preview-pack";
export const PREVIEW_READY_MESSAGE = "babylonslate-preview-ready";
export const PREVIEW_STATS_MESSAGE = "babylonslate-preview-stats";
export const PREVIEW_DIAGNOSTICS_MESSAGE = "babylonslate-preview-diagnostics";
export const PREVIEW_STOP_MESSAGE = "babylonslate-preview-stop";

export type PreviewPackMessage = {
  type: typeof PREVIEW_PACK_MESSAGE;
  files: Record<string, ArrayBuffer>;
};

export type PreviewReadyMessage = {
  type: typeof PREVIEW_READY_MESSAGE;
  startupSceneGuid: string;
};

export type PreviewStatsMessage = {
  type: typeof PREVIEW_STATS_MESSAGE;
  ticks: number;
  scriptMs: number;
  physicsMs: number;
};

export type PreviewDiagnosticsMessage = {
  type: typeof PREVIEW_DIAGNOSTICS_MESSAGE;
  diagnostics: Array<{
    message: string;
    severity: string;
    assetGuid?: string;
    graphId?: string;
    nodeId?: string;
    btNodeId?: string;
  }>;
};

export function isPreviewPackMessage(value: unknown): value is PreviewPackMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as { type?: unknown; files?: unknown };
  return record.type === PREVIEW_PACK_MESSAGE && !!record.files && typeof record.files === "object";
}

export function isPreviewDiagnosticsMessage(
  value: unknown,
): value is PreviewDiagnosticsMessage {
  if (!value || typeof value !== "object") return false;
  return (value as { type?: unknown }).type === PREVIEW_DIAGNOSTICS_MESSAGE;
}

export function filesFromPreviewPack(
  message: PreviewPackMessage,
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const [path, buffer] of Object.entries(message.files)) {
    files.set(path, new Uint8Array(buffer));
  }
  return files;
}

export function previewPackFromFiles(
  files: Map<string, Uint8Array>,
): PreviewPackMessage {
  const record: Record<string, ArrayBuffer> = {};
  for (const [path, bytes] of files) {
    record[path] = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }
  return { type: PREVIEW_PACK_MESSAGE, files: record };
}
