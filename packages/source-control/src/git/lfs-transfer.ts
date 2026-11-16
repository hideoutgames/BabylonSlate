import { isStorageNotFound, type ProjectStorage } from "@haptic/core";
import { authorizedHttp, type CredentialSource } from "../credentials";
import {
  isTransferMismatch,
  originOf,
  parseJsonObject,
  type FileTransferClient,
  type FileTransferRequest,
  type FileTransferResponse,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "../http";
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
 * Framing the transport owns, for a whole body or a streamed file alike.
 * GitLab's upload actions name `Transfer-Encoding: chunked`, which git-lfs
 * reads as an instruction rather than a header to send.
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

function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function damaged(oid: string): SyncError {
  return new SyncError("lfs", `LFS object ${oid} arrived damaged.`, { code: "lfs-object-corrupt" });
}

export interface LfsTransferOptions {
  repositoryUrl: string;
  branch: string;
  http: HttpClient;
  credential: CredentialSource;
  /** The project folder the objects' working files are in. */
  storage: ProjectStorage;
  /**
   * The host's native file transfer, bound to that folder: an object then
   * streams between the server and its file, and its bytes never enter
   * JavaScript. Without one (the web build, `FakeSync`'s hosts) bodies cross
   * whole through `http`.
   */
  files?: FileTransferClient;
  counters?: TransferCounters;
}

/**
 * Git LFS basic transfer through the batch API. The batch request carries the
 * repository's credential; a transfer action is sent with exactly the headers
 * the server gave it (less the transport's own framing, `TRANSPORT_HEADERS`),
 * and the stored credential is added only when the action is on the
 * repository's own origin and brings no Authorization of its own (one
 * `authorizedHttp` rule for both transports). No transfer follows a redirect.
 * A download is checked against its oid and size before it is in place: a
 * native file transfer checks it before moving its temporary file over the
 * object's, a whole body is checked here before it is written. A native
 * upload is sent only when the file is the object its name says.
 */
export class LfsTransfer {
  private readonly batchUrl: string;
  private readonly origin: string;
  private readonly ref: { name: string };
  private readonly http: HttpClient;
  private readonly authorized: HttpClient;
  private readonly files: FileTransferClient | null;
  private readonly authorizedFiles: FileTransferClient | null;
  private readonly storage: ProjectStorage;
  private readonly counters?: TransferCounters;

  constructor(options: LfsTransferOptions) {
    const base = lfsEndpointFromRepoUrl(options.repositoryUrl);
    if (!base) throw new SyncError("not-found", `Invalid repository URL: ${options.repositoryUrl}`);
    this.batchUrl = `${base}/objects/batch`;
    this.origin = originOf(base)!;
    this.ref = { name: `refs/heads/${options.branch}` };
    this.http = options.http;
    this.authorized = authorizedHttp(options.credential, options.http, "basic");
    this.files = options.files ?? null;
    this.authorizedFiles = options.files ? authorizedHttp(options.credential, options.files, "basic") : null;
    this.storage = options.storage;
    this.counters = options.counters;
  }

  /**
   * Uploads the objects the server asks for, each from the working file
   * `pathOf` names (one of the object's size); resolves to how many it asked
   * for.
   */
  async upload(objects: readonly LfsObject[], pathOf: (object: LfsObject) => Promise<string>): Promise<number> {
    let uploaded = 0;
    for (const entry of await this.batch("upload", objects)) {
      const upload = entry.actions.upload;
      if (!upload) continue;
      const path = await pathOf(entry);
      const headers = { "Content-Type": "application/octet-stream" };
      const { status } = this.files
        ? await this.sendFile(upload, { method: "PUT", headers, path, expected: { size: entry.size, sha256: entry.oid } }, () =>
            new SyncError("lfs", `${path} is not the LFS object its name says, so it cannot be uploaded.`, { code: "lfs-object-corrupt" }),
          )
        : await this.transfer(upload, { method: "PUT", body: await this.readObject(path, entry), headers });
      if (status !== 200 && status !== 201) throw statusError(status, `Uploading LFS object ${entry.oid}`);
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

  /**
   * Downloads each object into every working file `pathsOf` names (their
   * folders must exist), each checked against its size and SHA-256 before it
   * is in place.
   */
  async download(objects: readonly LfsObject[], pathsOf: (object: LfsObject) => readonly string[]): Promise<void> {
    for (const entry of await this.batch("download", objects)) {
      const download = this.downloadAction(entry);
      if (this.files) {
        for (const path of pathsOf(entry)) await this.downloadFile(download, entry, path);
        continue;
      }
      const bytes = await this.downloadBytes(download, entry);
      for (const path of pathsOf(entry)) await this.storage.writeBinary(path, bytes);
    }
  }

  /**
   * One object's bytes, downloaded and checked, and never left in the
   * working tree. A native transfer lands it in `scratch` (a file under
   * `.git`), which is read and then removed: the caller wants the bytes, so
   * they enter JavaScript either way.
   */
  async read(object: LfsObject, scratch: string): Promise<Uint8Array> {
    const [entry] = await this.batch("download", [object]);
    if (!entry) throw new SyncError("lfs", `The server has no LFS object ${object.oid}.`, { code: "lfs-object-missing" });
    const download = this.downloadAction(entry);
    if (!this.files) return this.downloadBytes(download, entry);
    await this.storage.mkdir(parentOf(scratch), true);
    try {
      await this.downloadFile(download, entry, scratch);
      return await this.storage.readBinary(scratch);
    } finally {
      await this.storage.remove(scratch).catch((error: unknown) => {
        if (!isStorageNotFound(error)) throw error;
      });
    }
  }

  private downloadAction(entry: BatchObject): LfsAction {
    const download = entry.actions.download;
    if (!download) throw new SyncError("lfs", `The server has no LFS object ${entry.oid}.`, { code: "lfs-object-missing" });
    return download;
  }

  private async downloadBytes(download: LfsAction, entry: LfsObject): Promise<Uint8Array> {
    const response = await this.transfer(download, { method: "GET", headers: {}, responseType: "binary" });
    if (response.status !== 200) throw statusError(response.status, `Downloading LFS object ${entry.oid}`);
    const bytes = response.bodyBytes ?? new Uint8Array();
    if (bytes.byteLength !== entry.size || (await sha256Hex(bytes)) !== entry.oid) throw damaged(entry.oid);
    return bytes;
  }

  private async downloadFile(download: LfsAction, entry: LfsObject, path: string): Promise<void> {
    const request = { method: "GET" as const, headers: {}, path, expected: { size: entry.size, sha256: entry.oid } };
    const { status } = await this.sendFile(download, request, () => damaged(entry.oid));
    if (status !== 200) throw statusError(status, `Downloading LFS object ${entry.oid}`);
  }

  /** The working file's bytes for a whole-body upload; one gone or of another size since `pathOf` is missing. */
  private async readObject(path: string, object: LfsObject): Promise<Uint8Array> {
    try {
      const bytes = await this.storage.readBinary(path);
      if (bytes.byteLength === object.size) return bytes;
    } catch (error) {
      if (!isStorageNotFound(error)) throw error;
    }
    throw new SyncError("lfs", `${path} is missing, so it cannot be uploaded.`, { code: "lfs-object-missing" });
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

  /**
   * Where an action goes and with which headers (exactly its own laid over
   * `base`), and whether the stored credential goes with it: only on the
   * repository's origin, and only when the action brings no Authorization.
   */
  private route(action: LfsAction, base: Record<string, string>): { url: string; headers: Record<string, string>; credentialed: boolean } {
    const origin = originOf(action.href);
    if (!origin) throw new SyncError("lfs", "The LFS server named a transfer address that is not HTTPS.");
    const ownAuthorization = Object.keys(action.header).some((name) => name.toLowerCase() === "authorization");
    return { url: action.href, headers: withHeaders(base, action.header), credentialed: origin === this.origin && !ownAuthorization };
  }

  private async transfer(action: LfsAction, request: Omit<HttpRequest, "url" | "disableRedirects">): Promise<HttpResponse> {
    const { url, headers, credentialed } = this.route(action, request.headers);
    if (credentialed) return this.send(this.authorized, { ...request, url, headers });
    return this.send(this.http, { ...request, url, headers, disableRedirects: true });
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

  /** An action through the native file transfer; `mismatch` is the failure when the host refuses the bytes. */
  private async sendFile(
    action: LfsAction,
    request: Omit<FileTransferRequest, "url" | "disableRedirects">,
    mismatch: () => SyncError,
  ): Promise<FileTransferResponse> {
    const { url, headers, credentialed } = this.route(action, request.headers);
    let response: FileTransferResponse;
    try {
      response = credentialed
        ? await this.authorizedFiles!({ ...request, url, headers })
        : await this.files!({ ...request, url, headers, disableRedirects: true });
    } catch (error) {
      if (isTransferMismatch(error)) throw Object.assign(mismatch(), { cause: error });
      throw requestError(error);
    }
    if (this.counters) {
      if (request.method === "PUT") this.counters.sent += response.bytes;
      else this.counters.received += response.bytes;
    }
    return response;
  }
}
