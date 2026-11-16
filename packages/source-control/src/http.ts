/** One request through the host's native HTTP (CapacitorHttp, Electron `net.fetch`); web has none. */
export interface HttpRequest {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Record<string, string>;
  /** Text, or bytes (Git packs, LFS objects). */
  body?: string | Uint8Array;
  /** `binary` answers `bodyBytes` instead of `bodyText`. */
  responseType?: "text" | "binary";
  /** Return a 3xx as is instead of following it. Every credentialed request sets it. */
  disableRedirects?: boolean;
}

export interface HttpResponse {
  status: number;
  /** Empty for a `binary` request. */
  bodyText: string;
  /** A `binary` request's body. */
  bodyBytes?: Uint8Array;
  headers?: Record<string, string>;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * One file streamed natively between a URL and the repository's project
 * folder (`@haptic/vfs` `NativeFileTransfer`, bound to that folder), so its
 * bytes never enter JavaScript: `GET` downloads into `path`, committed only
 * when it matches `expected`; `PUT` sends `path`, only when it matches.
 */
export interface FileTransferRequest {
  method: "GET" | "PUT";
  url: string;
  headers: Record<string, string>;
  path: string;
  expected?: { size: number; sha256: string };
  /** Redirects are never followed; `authorizedHttp` sets this as it does for every credentialed request. */
  disableRedirects?: boolean;
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
}

export interface FileTransferResponse {
  status: number;
  /** Body bytes sent or received, and their SHA-256 as the host computed it (0 and `""` for a download not committed). */
  bytes: number;
  sha256: string;
}

export type FileTransferClient = (request: FileTransferRequest) => Promise<FileTransferResponse>;

/** A transfer whose body or file did not match `expected` (`@haptic/vfs` `transfer-mismatch`): nothing was committed or sent. */
export function isTransferMismatch(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "transfer-mismatch";
}

/** The response object, or null when the body is empty, invalid JSON, or not an object. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The response array, or null when the body is not a JSON array. */
export function parseJsonArray(text: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stringField(json: Record<string, unknown> | null, key: string): string | null {
  const value = json?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}
