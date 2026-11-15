import { authorizedHttp, type CredentialSource } from "../credentials";
import { originOf, parseJsonObject, type HttpClient, type HttpRequest, type HttpResponse } from "../http";
import { lfsEndpointFromRepoUrl } from "../lfs-endpoint";
import { sha256Hex } from "../lfs-pointer";
import { SyncError } from "../sync-port";
import { LFS_JSON } from "../types";
import { requestError, statusError } from "./errors";
import type { TransferCounters } from "./git-http";

export interface LfsObject {
  oid: string;
  size: number;
}

interface LfsAction {
  href: string;
  header: Record<string, string>;
}

interface BatchObject extends LfsObject {
  actions: Partial<Record<"upload" | "download" | "verify", LfsAction>>;
  error?: { code: number; message: string };
}

/** git-lfs's batch size. */
const BATCH_LIMIT = 100;

/**
 * Framing the transport owns for a whole body. GitLab's upload actions name
 * `Transfer-Encoding: chunked`, which git-lfs reads as an instruction rather
 * than a header to send.
 */
const TRANSPORT_HEADERS = new Set(["transfer-encoding", "content-length", "connection", "host"]);

function parseAction(raw: unknown): LfsAction | null {
  if (!raw || typeof raw !== "object") return null;
  const { href, header } = raw as { href?: unknown; header?: unknown };
  if (typeof href !== "string") return null;
  const headers: Record<string, string> = {};
  if (header && typeof header === "object") {
    for (const [name, value] of Object.entries(header)) {
      if (typeof value === "string" && !TRANSPORT_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
  }
  return { href, header: headers };
}

/** `base` with `extra` laid over it, header names compared without case. */
function withHeaders(base: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const replaced = new Set(Object.keys(extra).map((name) => name.toLowerCase()));
  return { ...Object.fromEntries(Object.entries(base).filter(([name]) => !replaced.has(name.toLowerCase()))), ...extra };
}

function parseBatch(text: string): BatchObject[] | null {
  const objects = parseJsonObject(text)?.objects;
  if (!Array.isArray(objects)) return null;
  const out: BatchObject[] = [];
  for (const raw of objects) {
    if (!raw || typeof raw !== "object") return null;
    const entry = raw as { oid?: unknown; size?: unknown; actions?: unknown; error?: unknown };
    if (typeof entry.oid !== "string" || typeof entry.size !== "number") return null;
    const actions: BatchObject["actions"] = {};
    if (entry.actions && typeof entry.actions === "object") {
      for (const name of ["upload", "download", "verify"] as const) {
        const action = parseAction((entry.actions as Record<string, unknown>)[name]);
        if (action) actions[name] = action;
      }
    }
    const error = entry.error as { code?: unknown; message?: unknown } | undefined;
    out.push({
      oid: entry.oid,
      size: entry.size,
      actions,
      ...(error && typeof error === "object"
        ? { error: { code: Number(error.code), message: typeof error.message === "string" ? error.message : "LFS object error" } }
        : {}),
    });
  }
  return out;
}

/**
 * Git LFS basic transfer through the batch API. The batch request carries the
 * repository's credential; a transfer action is sent with exactly the headers
 * the server gave it (less the transport's own framing, `TRANSPORT_HEADERS`),
 * and the stored credential is added only when the action is on the
 * repository's own origin and brings no Authorization of its own.
 * No transfer follows a redirect. Downloads are checked against their oid and
 * size before they are handed over.
 */
export class LfsTransfer {
  private readonly batchUrl: string;
  private readonly origin: string;
  private readonly ref: { name: string };
  private readonly http: HttpClient;
  private readonly authorized: HttpClient;
  private readonly counters?: TransferCounters;

  constructor(options: {
    repositoryUrl: string;
    branch: string;
    http: HttpClient;
    credential: CredentialSource;
    counters?: TransferCounters;
  }) {
    const base = lfsEndpointFromRepoUrl(options.repositoryUrl);
    if (!base) throw new SyncError("not-found", `Invalid repository URL: ${options.repositoryUrl}`);
    this.batchUrl = `${base}/objects/batch`;
    this.origin = originOf(base)!;
    this.ref = { name: `refs/heads/${options.branch}` };
    this.http = options.http;
    this.authorized = authorizedHttp(options.credential, options.http, "basic");
    this.counters = options.counters;
  }

  /** Uploads the objects the server asks for; resolves to how many it asked for. */
  async upload(objects: readonly LfsObject[], read: (object: LfsObject) => Promise<Uint8Array>): Promise<number> {
    let uploaded = 0;
    for (const entry of await this.batch("upload", objects)) {
      const upload = entry.actions.upload;
      if (!upload) continue;
      const bytes = await read(entry);
      const response = await this.transfer(upload, {
        method: "PUT",
        body: bytes,
        headers: { "Content-Type": "application/octet-stream" },
      });
      if (response.status !== 200 && response.status !== 201) throw statusError(response.status, `Uploading LFS object ${entry.oid}`);
      const verify = entry.actions.verify;
      if (verify) {
        const verified = await this.transfer(verify, {
          method: "POST",
          body: JSON.stringify({ oid: entry.oid, size: entry.size }),
          headers: { Accept: LFS_JSON, "Content-Type": LFS_JSON },
        });
        if (verified.status !== 200) throw statusError(verified.status, `Verifying LFS object ${entry.oid}`);
      }
      uploaded += 1;
    }
    return uploaded;
  }

  /** Downloads each object, checks its size and SHA-256, then hands it to `write`. */
  async download(objects: readonly LfsObject[], write: (object: LfsObject, bytes: Uint8Array) => Promise<void>): Promise<void> {
    for (const entry of await this.batch("download", objects)) {
      const download = entry.actions.download;
      if (!download) throw new SyncError("lfs", `The server has no LFS object ${entry.oid}.`, { code: "lfs-object-missing" });
      const response = await this.transfer(download, { method: "GET", headers: {}, responseType: "binary" });
      if (response.status !== 200) throw statusError(response.status, `Downloading LFS object ${entry.oid}`);
      const bytes = response.bodyBytes ?? new Uint8Array();
      if (bytes.byteLength !== entry.size || (await sha256Hex(bytes)) !== entry.oid) {
        throw new SyncError("lfs", `LFS object ${entry.oid} arrived damaged.`, { code: "lfs-object-corrupt" });
      }
      await write(entry, bytes);
    }
  }

  private async batch(operation: "upload" | "download", objects: readonly LfsObject[]): Promise<BatchObject[]> {
    const unique = [...new Map(objects.map((object) => [object.oid, object])).values()];
    const out: BatchObject[] = [];
    for (let start = 0; start < unique.length; start += BATCH_LIMIT) {
      const chunk = unique.slice(start, start + BATCH_LIMIT);
      const response = await this.send(this.authorized, {
        method: "POST",
        url: this.batchUrl,
        headers: { Accept: LFS_JSON, "Content-Type": LFS_JSON },
        body: JSON.stringify({
          operation,
          transfers: ["basic"],
          ref: this.ref,
          objects: chunk.map(({ oid, size }) => ({ oid, size })),
          hash_algo: "sha256",
        }),
      });
      if (response.status !== 200) throw statusError(response.status, "The LFS batch request");
      const entries = parseBatch(response.bodyText);
      if (!entries) throw new SyncError("lfs", "The LFS server sent an unreadable batch response.");
      const wanted = new Set(chunk.map((object) => object.oid));
      for (const entry of entries) {
        if (!wanted.has(entry.oid)) continue;
        if (entry.error) {
          const missing = entry.error.code === 404;
          throw new SyncError("lfs", `LFS object ${entry.oid}: ${entry.error.message}`, missing ? { code: "lfs-object-missing" } : {});
        }
        out.push(entry);
      }
    }
    return out;
  }

  private async transfer(action: LfsAction, request: Omit<HttpRequest, "url" | "disableRedirects">): Promise<HttpResponse> {
    const origin = originOf(action.href);
    if (!origin) throw new SyncError("lfs", "The LFS server named a transfer address that is not HTTPS.");
    const ownAuthorization = Object.keys(action.header).some((name) => name.toLowerCase() === "authorization");
    const headers = withHeaders(request.headers, action.header);
    if (origin === this.origin && !ownAuthorization) return this.send(this.authorized, { ...request, url: action.href, headers });
    return this.send(this.http, { ...request, url: action.href, headers, disableRedirects: true });
  }

  private async send(http: HttpClient, request: HttpRequest): Promise<HttpResponse> {
    let response: HttpResponse;
    try {
      response = await http(request);
    } catch (error) {
      throw requestError(error);
    }
    if (this.counters) {
      this.counters.sent += typeof request.body === "string" ? request.body.length : (request.body?.byteLength ?? 0);
      this.counters.received += response.bodyBytes?.byteLength ?? response.bodyText.length;
    }
    return response;
  }
}
