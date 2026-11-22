import type { StorageReadOptions } from "@haptic/core";
import { encodeBase64, type BabylonSlateScopedStoragePlugin } from "./capacitor-scoped-storage";

/**
 * The binary storage transport of the iOS and Android apps: file bytes move
 * as raw HTTP bodies between the web view and the storage plugin instead of
 * base64 strings inside Capacitor's JSON bridge.
 *
 * This file is the single source of the wire format. The native sides mirror
 * these names and must change with them:
 * `apps/editor/ios/App/App/BabylonSlateScopedStoragePlugin.swift` (`BinaryStorageBridge`) and
 * `apps/editor/android/app/src/main/java/no/hideout/babylonslate/BabylonSlateScopedStoragePlugin.java`
 * (`BINARY_*`). Format: `.agents/reference/architecture/vfs.md#binary-storage-transport`.
 *
 * - URL: `<baseUrl>/<token>/file?<location>[&offset=&length=&revision=][&size=]`, every value
 *   `encodeURIComponent`-encoded. `<location>` is `directory=<Capacitor directory>&path=<full path>`
 *   (app storage, named as `readDocumentsRange` names it) or `folder=<id>&path=<project path>[&readScope=<id>]`.
 * - The per-launch token is a path segment, not a header, so a read is a CORS simple request with no
 *   preflight; a write is a `POST` with a raw body and no `Content-Type`, simple for the same reason.
 * - Answers carry the revision, total size and bytes read in headers; a failure has a status, the
 *   plugin's error code in `X-Haptic-Error` and its message as the body.
 */
export const BINARY_BRIDGE_REVISION_HEADER = "X-Haptic-Revision";
export const BINARY_BRIDGE_TOTAL_BYTES_HEADER = "X-Haptic-Total-Bytes";
export const BINARY_BRIDGE_ACTUAL_BYTES_HEADER = "X-Haptic-Actual-Bytes";
export const BINARY_BRIDGE_ERROR_HEADER = "X-Haptic-Error";
/** The native side could not see a write's body (a web view that drops custom-scheme bodies). */
export const BINARY_BRIDGE_BODY_MISSING = "BODY_MISSING";
/** Bytes per `appendWriteChunk` call on hosts that write in chunks (Android). */
export const BINARY_BRIDGE_CHUNK_BYTES = 1 << 20;

export interface NativeBinaryBridgeConfig {
  /** Scheme, host and path prefix, without a trailing slash (`haptic-storage://bridge`, `https://localhost/_haptic_storage`). */
  baseUrl: string;
  /** Random per launch; only this page learns it. */
  token: string;
  /** `body`: writes are POST bodies (iOS). `chunks`: base64 chunks through the plugin (Android WebView exposes no request bodies). */
  writes: "body" | "chunks";
}

/** Where a file lives: app storage (Capacitor directory and full path) or a chosen folder. */
export type NativeFileLocation =
  | { directory: string; path: string }
  | { folder: string; path: string; readScope?: string };

export interface NativeBinaryRange {
  bytes: Uint8Array;
  totalSize: number;
  revision: string;
  actualBytesRead: number;
}

export type NativeBinaryBridgePlugin = Pick<BabylonSlateScopedStoragePlugin,
  "getBinaryBridgeConfig" | "beginWrite" | "appendWriteChunk" | "commitWrite" | "abortWrite">;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A rejection shaped as Capacitor shapes a plugin's, so the adapters' existing error mapping applies. */
export class NativeBinaryBridgeError extends Error {
  readonly code: string | undefined;
  readonly data: { actualBytesRead: number };
  constructor(message: string, code: string | undefined, actualBytesRead: number) {
    super(message);
    this.name = "NativeBinaryBridgeError";
    this.code = code;
    this.data = { actualBytesRead };
  }
}

function locationQuery(location: NativeFileLocation): string {
  const parts = "directory" in location
    ? [`directory=${encodeURIComponent(location.directory)}`]
    : [`folder=${encodeURIComponent(location.folder)}`, ...(location.readScope ? [`readScope=${encodeURIComponent(location.readScope)}`] : [])];
  parts.push(`path=${encodeURIComponent(location.path)}`);
  return parts.join("&");
}

function headerNumber(response: Response, name: string): number | null {
  const value = response.headers.get(name);
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function failure(response: Response): Promise<NativeBinaryBridgeError> {
  const code = response.headers.get(BINARY_BRIDGE_ERROR_HEADER) ?? undefined;
  let message = "";
  try { message = await response.text(); } catch { /* The status says enough. */ }
  return new NativeBinaryBridgeError(message || `Storage request failed (${response.status})`, code, headerNumber(response, BINARY_BRIDGE_ACTUAL_BYTES_HEADER) ?? 0);
}

/** A view fetch accepts as a body: never one over a SharedArrayBuffer, which no request may carry. */
function requestBody(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return data.buffer instanceof ArrayBuffer ? data as Uint8Array<ArrayBuffer> : new Uint8Array(data);
}

/**
 * Client of the binary transport. Reads are `fetch` GETs answered with the
 * file's bytes as `response.arrayBuffer()`, so no base64 string exists on
 * either side. Writes are POST bodies or, where the web view hides bodies,
 * 1 MiB base64 chunks each encoded on its own (never one string for the
 * file), staged natively and renamed into place on commit.
 */
export class NativeBinaryBridge {
  private bodyWrites: boolean;

  constructor(
    private readonly config: NativeBinaryBridgeConfig,
    private readonly plugin: NativeBinaryBridgePlugin,
    private readonly fetchImpl: Fetch = (input, init) => globalThis.fetch(input, init),
  ) {
    this.bodyWrites = config.writes === "body";
  }

  private url(location: NativeFileLocation, extra = ""): string {
    return `${this.config.baseUrl}/${encodeURIComponent(this.config.token)}/file?${locationQuery(location)}${extra}`;
  }

  async read(location: NativeFileLocation, options?: StorageReadOptions): Promise<Uint8Array> {
    const response = await this.fetchImpl(this.url(location), { signal: options?.signal });
    if (!response.ok) throw await failure(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async readRange(location: NativeFileLocation, offset: number, length: number, expectedRevision?: string, options?: StorageReadOptions): Promise<NativeBinaryRange> {
    const revision = expectedRevision === undefined ? "" : `&revision=${encodeURIComponent(expectedRevision)}`;
    const response = await this.fetchImpl(this.url(location, `&offset=${offset}&length=${length}${revision}`), { signal: options?.signal });
    if (!response.ok) throw await failure(response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      totalSize: headerNumber(response, BINARY_BRIDGE_TOTAL_BYTES_HEADER) ?? -1,
      revision: response.headers.get(BINARY_BRIDGE_REVISION_HEADER) ?? "",
      actualBytesRead: headerNumber(response, BINARY_BRIDGE_ACTUAL_BYTES_HEADER) ?? bytes.byteLength,
    };
  }

  /**
   * Replaces the file atomically. Resolves `false`, having written nothing,
   * when this web view turns out not to deliver request bodies; callers then
   * write through the plugin, as without a bridge.
   */
  async write(location: NativeFileLocation, data: Uint8Array): Promise<boolean> {
    if (this.config.writes === "chunks") {
      await this.writeChunks(location, data);
      return true;
    }
    if (!this.bodyWrites) return false;
    const response = await this.fetchImpl(this.url(location, `&size=${data.byteLength}`), { method: "POST", body: requestBody(data) });
    if (response.ok) return true;
    const error = await failure(response);
    if (error.code === BINARY_BRIDGE_BODY_MISSING) {
      this.bodyWrites = false;
      return false;
    }
    throw error;
  }

  /** The original file stays as it was until `commitWrite`; any failure aborts the staged session. */
  private async writeChunks(location: NativeFileLocation, data: Uint8Array): Promise<void> {
    const plugin = this.plugin as Required<NativeBinaryBridgePlugin>;
    const target = "directory" in location
      ? { directory: location.directory, path: location.path }
      : { folder: location.folder, path: location.path };
    const { writeId } = await plugin.beginWrite(target);
    try {
      let offset = 0;
      for (; data.byteLength - offset > BINARY_BRIDGE_CHUNK_BYTES; offset += BINARY_BRIDGE_CHUNK_BYTES) {
        await plugin.appendWriteChunk({ writeId, data: encodeBase64(data.subarray(offset, offset + BINARY_BRIDGE_CHUNK_BYTES)) });
      }
      await plugin.commitWrite({ writeId, data: encodeBase64(data.subarray(offset)), size: data.byteLength });
    } catch (error) {
      await plugin.abortWrite({ writeId }).catch(() => {});
      throw error;
    }
  }
}

const bridges = new WeakMap<object, Promise<NativeBinaryBridge | null>>();

function isConfig(value: unknown): value is NativeBinaryBridgeConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Partial<NativeBinaryBridgeConfig>;
  return typeof config.baseUrl === "string" && config.baseUrl !== "" && typeof config.token === "string" && config.token !== "" &&
    (config.writes === "body" || config.writes === "chunks");
}

/**
 * The plugin's binary transport, asked for once per plugin and page; `null`
 * where it has none (the web, tests and mocks), and adapters then use the
 * plugin's own calls. Never probed by method presence: Capacitor's proxy
 * answers every name and rejects the ones the platform lacks.
 */
export function nativeBinaryBridge(plugin: Partial<NativeBinaryBridgePlugin>, fetchImpl?: Fetch): Promise<NativeBinaryBridge | null> {
  let bridge = bridges.get(plugin);
  if (!bridge) {
    bridge = (async () => {
      if (typeof plugin.getBinaryBridgeConfig !== "function") return null;
      try {
        const config: unknown = await plugin.getBinaryBridgeConfig();
        return isConfig(config) ? new NativeBinaryBridge(config, plugin as NativeBinaryBridgePlugin, fetchImpl) : null;
      } catch {
        return null;
      }
    })();
    bridges.set(plugin, bridge);
  }
  return bridge;
}
