import { version, type GitHttpRequest, type GitHttpResponse, type HttpClient as IsoHttpClient } from "isomorphic-git";
import type { FileTransferClient, HttpClient } from "../http";
import { throwIfCancelled } from "../sync-port";
import { requestError } from "./errors";

/**
 * `http` refusing to send once `signal` aborts, and refusing the answer of a
 * request that was cancelled while it ran (native HTTP cannot stop one).
 */
export function cancellableHttp(http: HttpClient, signal: AbortSignal | undefined): HttpClient {
  if (!signal) return http;
  return async (request) => {
    throwIfCancelled(signal);
    const response = await http(request);
    throwIfCancelled(signal);
    return response;
  };
}

/**
 * The native file transfer under the same rule, except that the host can
 * stop a transfer: `signal` goes with each request, so aborting cancels it
 * there and a download leaves no file.
 */
export function cancellableFiles(files: FileTransferClient, signal: AbortSignal | undefined): FileTransferClient {
  if (!signal) return files;
  return async (request) => {
    throwIfCancelled(signal);
    const response = await files({ ...request, signal });
    throwIfCancelled(signal);
    return response;
  };
}

/** Servers tell Git clients by a `git/` agent; native HTTP would otherwise send the WebView's. */
const USER_AGENT = `git/isomorphic-git@${version()}`;

/** Byte counts of one operation's traffic, for the benchmark. */
export interface TransferCounters {
  sent: number;
  received: number;
}

async function collect(body: GitHttpRequest["body"]): Promise<Uint8Array | undefined> {
  if (!body) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function* once(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  if (bytes.byteLength > 0) yield bytes;
}

/**
 * Git smart HTTP for isomorphic-git over one HTTP client (callers pass the
 * repository's `authorizedHttp`, which refuses every other origin). Request
 * bodies are buffered and responses arrive whole: native HTTP has no streams.
 */
export function gitHttp(http: HttpClient, counters?: TransferCounters): IsoHttpClient {
  return {
    async request({ url, method = "GET", headers = {}, body }: GitHttpRequest): Promise<GitHttpResponse> {
      if (method !== "GET" && method !== "POST") throw new Error(`Git smart HTTP does not use ${method}.`);
      const bytes = await collect(body);
      const named = Object.keys(headers).some((name) => name.toLowerCase() === "user-agent");
      const sent: Record<string, string> = named ? headers : { ...headers, "User-Agent": USER_AGENT };
      let response;
      try {
        response = await http({ method, url, headers: sent, ...(bytes ? { body: bytes } : {}), responseType: "binary" });
      } catch (error) {
        throw requestError(error);
      }
      const received = response.bodyBytes ?? new Uint8Array();
      if (counters) {
        counters.sent += bytes?.byteLength ?? 0;
        counters.received += received.byteLength;
      }
      return {
        url,
        method,
        statusCode: response.status,
        statusMessage: `HTTP ${response.status}`,
        headers: Object.fromEntries(Object.entries(response.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
        body: once(received),
      };
    },
  };
}
