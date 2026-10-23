import type { ProjectStorage } from "@haptic/core";
import { encodeAssetDocument, decodeAssetDocument } from "./asset-document";
import { derivedDataRoot } from "./derived-data";

export const TRACE_ASSET_TYPE = "Trace";
export const TRACE_FILE_EXTENSION = ".htrace";

export function isTracePath(path: string): boolean {
  return path.endsWith(TRACE_FILE_EXTENSION);
}

export function tracesDir(projectGuid: string): string {
  return `${derivedDataRoot(projectGuid)}/traces`;
}

/** `derived/{projectGuid}/traces/{fileName}.htrace` */
export function tracePath(projectGuid: string, fileName: string): string {
  const base = fileName.endsWith(TRACE_FILE_EXTENSION)
    ? fileName
    : `${fileName}${TRACE_FILE_EXTENSION}`;
  return `${tracesDir(projectGuid)}/${base}`;
}

/** Encode a recorded session as a Trace document in the .hasset container. */
export async function encodeTraceDocument(document: {
  name: string;
  guid: string;
  payload: Record<string, unknown>;
}): Promise<Uint8Array> {
  return encodeAssetDocument({
    type: TRACE_ASSET_TYPE,
    name: document.name,
    guid: document.guid,
    version: 1,
    payload: document.payload,
  });
}

export async function decodeTraceDocument(
  bytes: Uint8Array,
): Promise<{
  name: string;
  guid: string;
  payload: Record<string, unknown>;
}> {
  const decoded = await decodeAssetDocument(bytes);
  return {
    name: decoded.name,
    guid: decoded.guid,
    payload: decoded.payload,
  };
}

export async function writeTraceDocument(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  fileName: string,
  document: {
    name: string;
    guid: string;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const path = tracePath(projectGuid, fileName);
  await derivedStorage.mkdir(tracesDir(projectGuid), true);
  await derivedStorage.writeBinary(path, await encodeTraceDocument(document));
  return path;
}

/** A recorded trace in the project's derived data. */
export type TraceDocumentEntry = {
  path: string;
  fileName: string;
  /** When it was recorded, from the editor's `session-<ms>` name, else the file's time; null when neither is known. */
  recordedAt: number | null;
  /** Bytes on disk, where the storage reports it. */
  size: number | null;
};

/** The project's recorded traces, newest first. */
export async function listTraceDocuments(
  derivedStorage: ProjectStorage,
  projectGuid: string,
): Promise<TraceDocumentEntry[]> {
  const dir = tracesDir(projectGuid);
  if (!(await derivedStorage.exists(dir))) return [];
  return (await derivedStorage.readdir(dir))
    .filter((entry) => !entry.isDir && isTracePath(entry.name))
    .map((entry) => {
      const named = /^session-(\d+)\.htrace$/.exec(entry.name);
      return {
        path: `${dir}/${entry.name}`,
        fileName: entry.name,
        recordedAt: named ? Number(named[1]) : (entry.mtime ?? null),
        size: entry.size ?? null,
      };
    })
    .sort((a, b) => (b.recordedAt ?? -Infinity) - (a.recordedAt ?? -Infinity) || b.fileName.localeCompare(a.fileName));
}

export async function readTraceDocument(
  derivedStorage: ProjectStorage,
  path: string,
): Promise<{
  name: string;
  guid: string;
  payload: Record<string, unknown>;
} | null> {
  if (!(await derivedStorage.exists(path))) {
    return null;
  }
  return decodeTraceDocument(await derivedStorage.readBinary(path));
}
