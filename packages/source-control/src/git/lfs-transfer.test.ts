import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StorageNotFoundError, type ProjectStorage } from "@haptic/core";
import { fixedCredential } from "../credentials";
import type { FileTransferClient, FileTransferRequest, HttpRequest, HttpResponse } from "../http";
import { isSyncError, type SyncError } from "../sync-port";
import { LfsTransfer } from "./lfs-transfer";

const CREDENTIAL = { origin: "https://git.example", username: "x-access-token", token: "secret", kind: "token" as const };
const BASIC = `Basic ${btoa("x-access-token:secret")}`;
const BYTES = new TextEncoder().encode("abc");
/** `sha256sum` of "abc". */
const OID = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const OBJECT = { oid: OID, size: 3 };
const PATH = `assets/.blobs/${OID}`;
const BATCH_URL = "https://git.example/team/game.git/info/lfs/objects/batch";

type Transport = "whole-body" | "native";
/** A request as the server saw it, whichever transport carried it. */
type Seen = Pick<HttpRequest, "method" | "url" | "headers" | "disableRedirects"> & { body?: Uint8Array | string; path?: string; expected?: FileTransferRequest["expected"] };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Project storage on a map. An object's file is reachable only by the
 * whole-body path: with `native` set, reading or writing a `.blobs` file
 * through it throws, so the native arm proves no object byte went through
 * JavaScript storage.
 */
function memoryStorage(native: boolean, files: Map<string, Uint8Array>) {
  const removed: string[] = [];
  const guard = (path: string) => {
    if (native && path.includes("/.blobs/")) throw new Error(`An object's bytes went through JavaScript: ${path}`);
  };
  const storage = {
    readBinary: async (path: string) => {
      guard(path);
      const bytes = files.get(path);
      if (!bytes) throw new StorageNotFoundError(path);
      return bytes;
    },
    writeBinary: async (path: string, bytes: Uint8Array) => {
      guard(path);
      files.set(path, bytes);
    },
    mkdir: async () => {},
    remove: async (path: string) => {
      removed.push(path);
      if (!files.delete(path)) throw new StorageNotFoundError(path);
    },
  } as unknown as ProjectStorage;
  return { storage, removed };
}

/**
 * The repository's LFS server, reached through native HTTP (`whole-body`) or
 * through a native file transfer whose host streams between the server and
 * the files map (`native`): the transfer's own fake host checks `expected`
 * and leaves no file on a mismatch, as every platform's does.
 */
function host(
  transport: Transport,
  batch: (operation: string) => unknown,
  transfers: (request: Seen) => HttpResponse = () => ({ status: 200, bodyText: "" }),
) {
  const requests: Seen[] = [];
  const files = new Map<string, Uint8Array>([[PATH, BYTES]]);
  const { storage, removed } = memoryStorage(transport === "native", files);
  const http = async (request: HttpRequest): Promise<HttpResponse> => {
    requests.push({ method: request.method, url: request.url, headers: request.headers, disableRedirects: request.disableRedirects, ...(request.body === undefined ? {} : { body: request.body }) });
    if (request.url === BATCH_URL) {
      const body = JSON.parse(request.body as string) as { operation: string };
      return { status: 200, bodyText: JSON.stringify(batch(body.operation)) };
    }
    return transfers(requests.at(-1)!);
  };
  const native: FileTransferClient = async (request) => {
    const seen: Seen = { method: request.method, url: request.url, headers: request.headers, disableRedirects: request.disableRedirects, path: request.path, ...(request.expected ? { expected: request.expected } : {}) };
    requests.push(seen);
    const mismatch = (bytes: Uint8Array) => request.expected && (bytes.byteLength !== request.expected.size || sha256(bytes) !== request.expected.sha256);
    if (request.method === "PUT") {
      const bytes = files.get(request.path)!;
      if (mismatch(bytes)) throw Object.assign(new Error("The file is not the object its name says."), { code: "transfer-mismatch" });
      return { status: transfers({ ...seen, body: bytes }).status, bytes: bytes.byteLength, sha256: sha256(bytes) };
    }
    const response = transfers(seen);
    if (response.status < 200 || response.status > 299) return { status: response.status, bytes: 0, sha256: "" };
    const bytes = response.bodyBytes ?? new Uint8Array();
    if (mismatch(bytes)) throw Object.assign(new Error("The downloaded file arrived damaged."), { code: "transfer-mismatch" });
    files.set(request.path, bytes);
    return { status: response.status, bytes: bytes.byteLength, sha256: sha256(bytes) };
  };
  const lfs = new LfsTransfer({
    repositoryUrl: "https://git.example/team/game.git",
    branch: "main",
    credential: fixedCredential(CREDENTIAL),
    http,
    storage,
    ...(transport === "native" ? { files: native } : {}),
  });
  return { lfs, requests, files, removed };
}

async function failure(promise: Promise<unknown>): Promise<SyncError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(isSyncError(error)).toBe(true);
  return error as SyncError;
}

const toPath = async () => PATH;

describe.each(["whole-body", "native"] as const)("LfsTransfer over %s transfers", (transport) => {
  it("adds the stored credential to an action on the repository's origin only when the action brings none", async () => {
    const { lfs, requests } = host(transport, () => ({
      objects: [{
        ...OBJECT,
        actions: {
          upload: { href: "https://git.example/team/game.git/lfs/objects/abc" },
          verify: { href: "https://verify.example/check", header: { "X-Verify": "1" } },
        },
      }],
    }));
    expect(await lfs.upload([OBJECT, OBJECT], toPath)).toBe(1);
    expect(requests.map((request) => [request.method, request.url, request.headers.Authorization ?? null, request.disableRedirects ?? false])).toEqual([
      ["POST", BATCH_URL, BASIC, true],
      ["PUT", "https://git.example/team/game.git/lfs/objects/abc", BASIC, true],
      ["POST", "https://verify.example/check", null, true],
    ]);
    expect(requests[2]!.headers["X-Verify"]).toBe("1");
    expect(JSON.parse(requests[0]!.body as string)).toEqual({
      operation: "upload",
      transfers: ["basic"],
      ref: { name: "refs/heads/main" },
      objects: [OBJECT],
      hash_algo: "sha256",
    });
  });

  it("uses an action's own Authorization, even on the repository's origin", async () => {
    const { lfs, requests, files } = host(transport, () => ({
      objects: [{ ...OBJECT, actions: { download: { href: "https://git.example/objects/abc", header: { Authorization: "Bearer temporary" } } } }],
    }), () => ({ status: 200, bodyText: "", bodyBytes: BYTES }));
    files.clear();
    await lfs.download([OBJECT], () => [PATH, `plugins/kit/assets/.blobs/${OID}`]);
    expect(files.get(PATH)).toEqual(BYTES);
    expect(files.get(`plugins/kit/assets/.blobs/${OID}`)).toEqual(BYTES);
    expect(requests[1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer temporary" }, disableRedirects: true });
  });

  // GitLab's upload actions name `Transfer-Encoding: chunked`; framing is the transport's, whether it sends a whole body or streams a file.
  it("sends an action's headers in place of its own, whatever their case, but never the transport's framing", async () => {
    const { lfs, requests } = host(transport, () => ({
      objects: [{
        ...OBJECT,
        actions: { upload: { href: "https://cdn.example/a", header: { authorization: "Basic action", "content-type": "application/x-custom", "Transfer-Encoding": "chunked", "Content-Length": "999" } } },
      }],
    }));
    await lfs.upload([OBJECT], toPath);
    expect(requests[1]!.headers).toEqual({ authorization: "Basic action", "content-type": "application/x-custom" });
  });

  it("refuses a damaged download, writing nothing, an object the server lacks and a transfer address that is not HTTPS", async () => {
    const download = async (actions: unknown, bodyBytes = BYTES) => {
      const server = host(transport, () => ({ objects: [{ ...OBJECT, actions }] }), () => ({ status: 200, bodyText: "", bodyBytes }));
      server.files.clear();
      const error = await failure(server.lfs.download([OBJECT], () => [PATH]));
      expect(server.files.size).toBe(0);
      return error;
    };
    expect((await download({ download: { href: "https://cdn.example/a" } }, new TextEncoder().encode("abd"))).code).toBe("lfs-object-corrupt");
    expect((await download({ download: { href: "https://cdn.example/a" } }, new Uint8Array(2))).code).toBe("lfs-object-corrupt");
    expect((await download({})).code).toBe("lfs-object-missing");
    expect((await download({ download: { href: "http://cdn.example/a" } })).kind).toBe("lfs");
    const missing = host(transport, () => ({ objects: [{ ...OBJECT, error: { code: 404, message: "Object does not exist" } }] }));
    expect((await failure(missing.lfs.download([OBJECT], () => [PATH]))).code).toBe("lfs-object-missing");
  });

  it("types a refused batch, a failed transfer and one that never reached the host", async () => {
    const batchRefused = new LfsTransfer({
      repositoryUrl: "https://git.example/team/game.git",
      branch: "main",
      credential: fixedCredential(CREDENTIAL),
      http: async () => ({ status: 403, bodyText: "" }),
      storage: memoryStorage(false, new Map()).storage,
    });
    expect((await failure(batchRefused.upload([OBJECT], toPath))).kind).toBe("auth");
    const failed = host(transport, () => ({ objects: [{ ...OBJECT, actions: { upload: { href: "https://cdn.example/a" } } }] }), () => ({ status: 500, bodyText: "" }));
    expect(await failure(failed.lfs.upload([OBJECT], toPath))).toMatchObject({ kind: "lfs", status: 500 });
    const offline = host(transport, () => ({ objects: [{ ...OBJECT, actions: { download: { href: "https://cdn.example/a" } } }] }), () => {
      throw new TypeError("Failed to fetch");
    });
    expect((await failure(offline.lfs.download([OBJECT], () => [PATH]))).kind).toBe("network");
  });

  it("hands over an object without leaving it in the working tree", async () => {
    const { lfs, files, removed } = host(transport, () => ({ objects: [{ ...OBJECT, actions: { download: { href: "https://cdn.example/a" } } }] }), () => ({ status: 200, bodyText: "", bodyBytes: BYTES }));
    files.clear();
    expect(await lfs.read(OBJECT, `.git/lfs/tmp/${OID}`)).toEqual(BYTES);
    expect([...files.keys()]).toEqual([]);
    expect(removed).toEqual(transport === "native" ? [`.git/lfs/tmp/${OID}`] : []);
  });
});

describe("LfsTransfer over a native file transfer", () => {
  it("streams each object between the server and its working file: no object byte crosses HTTP or storage in JavaScript", async () => {
    const stored = new Map<string, Uint8Array>();
    const { lfs, requests, files } = host("native", (operation) => ({
      objects: [{ ...OBJECT, actions: operation === "upload" ? { upload: { href: "https://cdn.example/up" } } : { download: { href: "https://cdn.example/down" } } }],
    }), (request) => {
      if (request.method === "PUT") stored.set(request.url, request.body as Uint8Array);
      return { status: 200, bodyText: "", ...(request.method === "GET" ? { bodyBytes: BYTES } : {}) };
    });
    expect(await lfs.upload([OBJECT], toPath)).toBe(1);
    files.clear();
    await lfs.download([OBJECT], () => [PATH]);
    // The host read and wrote the file; the storage guard throws for any `.blobs` read or write through JavaScript.
    expect(files.get(PATH)).toEqual(BYTES);
    expect(stored.get("https://cdn.example/up")).toEqual(BYTES);
    expect(requests.filter((request) => request.url !== BATCH_URL)).toEqual([
      { method: "PUT", url: "https://cdn.example/up", headers: { "Content-Type": "application/octet-stream" }, disableRedirects: true, path: PATH, expected: { size: 3, sha256: OID } },
      { method: "GET", url: "https://cdn.example/down", headers: {}, disableRedirects: true, path: PATH, expected: { size: 3, sha256: OID } },
    ]);
    expect(requests.every((request) => request.url === BATCH_URL || request.body === undefined)).toBe(true);
  });

  it("refuses to upload a working file that is not the object its name says, and verifies nothing", async () => {
    const { lfs, requests, files } = host("native", () => ({
      objects: [{ ...OBJECT, actions: { upload: { href: "https://cdn.example/up" }, verify: { href: "https://git.example/team/game.git/verify" } } }],
    }));
    files.set(PATH, new TextEncoder().encode("abd"));
    expect((await failure(lfs.upload([OBJECT], toPath))).code).toBe("lfs-object-corrupt");
    expect(requests.map((request) => request.url)).toEqual([BATCH_URL, "https://cdn.example/up"]);
  });

  it("removes the scratch file of a download that arrived damaged", async () => {
    const { lfs, files, removed } = host("native", () => ({ objects: [{ ...OBJECT, actions: { download: { href: "https://cdn.example/a" } } }] }), () => ({ status: 200, bodyText: "", bodyBytes: new Uint8Array(3) }));
    files.clear();
    expect((await failure(lfs.read(OBJECT, `.git/lfs/tmp/${OID}`))).code).toBe("lfs-object-corrupt");
    expect(removed).toEqual([`.git/lfs/tmp/${OID}`]);
    expect(files.size).toBe(0);
  });
});
