import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeStorageAdapter } from "@haptic/vfs/node";
import type { TransferIncomingMessage, TransferRequest, TransferRequestOptions } from "@haptic/vfs/node-file-transfer";
import { netRequest } from "@haptic/vfs/net-request";
import { DesktopFileTransfers, type DesktopTransferRequest } from "./desktop-file-transfer";
import { validateIpcArguments } from "./packaged-security";

/** More than one network read and one progress report, so the body has to stream. */
const SIZE = 3 * 1024 * 1024 + 17;
const OBJECT = Uint8Array.from({ length: SIZE }, (_value, index) => (index * 31 + 7) & 0xff);
const OBJECT_SHA = sha256(OBJECT);
const OWNER = 7;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Upload {
  contentLength: string | undefined;
  transferEncoding: string | undefined;
  authorization: string | undefined;
  sha256: string;
  bytes: number;
}

let root: string;
let server: Server;
let port: number;
let uploads: Upload[];
let requests: string[];
/** Lets a slow download send its next part. */
let release: () => void;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "haptic-transfer-"));
  uploads = [];
  requests = [];
  release = () => {};
  server = createServer((request: IncomingMessage, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "PUT") {
      const hash = createHash("sha256");
      let bytes = 0;
      request.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        bytes += chunk.byteLength;
      });
      request.on("end", () => {
        uploads.push({
          contentLength: request.headers["content-length"],
          transferEncoding: request.headers["transfer-encoding"],
          authorization: request.headers.authorization,
          sha256: hash.digest("hex"),
          bytes,
        });
        response.writeHead(200).end();
      });
      return;
    }
    if (request.url === "/object") {
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(SIZE) }).end(Buffer.from(OBJECT));
    } else if (request.url === "/slow") {
      // The first megabyte, then the rest once the test lets it go (or never).
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(Buffer.from(OBJECT.subarray(0, 1024 * 1024)));
      release = () => response.end(Buffer.from(OBJECT.subarray(1024 * 1024)));
    } else if (request.url === "/moved") {
      response.writeHead(302, { Location: "/object" }).end();
    } else {
      response.writeHead(404).end("missing");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  release();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

/**
 * Electron's `net.request` as main passes it, played by the stand-in that
 * keeps Electron's framing (a non-chunked body is sent with its length, an
 * app's `Content-Length` fails the request, `redirect: "error"` fails on a
 * 3xx), with `https://store.test` routed to the loopback server. It records
 * what the transfer did with each request: the options, the headers it set,
 * its writes (whose callbacks it delays, so a writer that does not wait for
 * them would have several in flight), aborts, and any body chunk delivered
 * while the transfer had paused the response.
 */
function electronNet(hooks: { onWrite?: () => void } = {}) {
  const log = {
    options: [] as TransferRequestOptions[],
    headers: [] as string[],
    writes: 0,
    inFlight: 0,
    mostInFlight: 0,
    chunked: false,
    aborts: 0,
    pauses: 0,
    dataWhilePaused: 0,
  };
  const inner = netRequest((url) => url.replace("https://store.test", `http://127.0.0.1:${port}`));
  const request: TransferRequest = (options) => {
    log.options.push(options);
    const client = inner(options) as ReturnType<TransferRequest> & { chunkedEncoding: boolean };
    const { setHeader, write, abort, on } = client;
    return Object.assign(client, {
      setHeader(name: string, value: string) {
        log.headers.push(name);
        setHeader.call(client, name, value);
      },
      write(chunk: Buffer, encoding: undefined, callback: () => void) {
        log.writes += 1;
        hooks.onWrite?.();
        log.chunked ||= client.chunkedEncoding;
        log.mostInFlight = Math.max(log.mostInFlight, (log.inFlight += 1));
        write.call(client, chunk, encoding, () => setTimeout(() => {
          log.inFlight -= 1;
          callback();
        }, 2));
      },
      abort() {
        log.aborts += 1;
        abort.call(client);
      },
      on(event: string, listener: (...args: never[]) => void) {
        if (event !== "response") return on.call(client, event, listener);
        return on.call(client, event, ((response: TransferIncomingMessage) => {
          let paused = false;
          const { pause, resume, on: onBody } = response;
          (listener as (response: TransferIncomingMessage) => void)(Object.assign(response, {
            pause: () => {
              log.pauses += 1;
              paused = true;
              return pause.call(response);
            },
            resume: () => {
              paused = false;
              return resume.call(response);
            },
            on: (name: string, handler: (...args: never[]) => void) => onBody.call(response, name, name !== "data" ? handler : ((chunk: Buffer) => {
              if (paused) log.dataWhilePaused += 1;
              (handler as (chunk: Buffer) => void)(chunk);
            }) as (...args: never[]) => void),
          }));
        }) as (...args: never[]) => void);
      },
    });
  };
  return { request, log };
}

async function project(name = "Game"): Promise<{ storage: NodeStorageAdapter; folderId: string; dir: string }> {
  const storage = new NodeStorageAdapter(join(root, "projects"));
  const folder = await storage.openDocumentsProject(name);
  const dir = folder.id.slice("node:".length);
  mkdirSync(join(dir, "assets/.blobs"), { recursive: true });
  return { storage, folderId: folder.id, dir };
}

function request(overrides: Partial<DesktopTransferRequest> = {}): DesktopTransferRequest {
  return { id: "t-1", method: "GET", url: "https://store.test/object", headers: {}, path: `assets/.blobs/${OBJECT_SHA}`, expected: { size: SIZE, sha256: OBJECT_SHA }, ...overrides };
}

/** As main's `handle`: the IPC arguments are validated first. */
async function invoke(transfers: DesktopFileTransfers, storage: NodeStorageAdapter, folderId: string, body: DesktopTransferRequest, progress: number[] = []) {
  validateIpcArguments("files:transfer", [folderId, body]);
  return transfers.transfer(OWNER, storage, folderId, body, (_id, bytes) => progress.push(bytes));
}

const blobs = (dir: string) => readdirSync(join(dir, "assets/.blobs")).sort();

describe("desktop native file transfer (main process)", () => {
  it("downloads a body larger than one read straight into the project file, hashed as it streams and reported as it goes", async () => {
    const { storage, folderId, dir } = await project();
    const net = electronNet();
    const progress: number[] = [];
    const result = await invoke(new DesktopFileTransfers(net.request), storage, folderId, request({ headers: { Authorization: "RemoteAuth store-token" } }), progress);

    expect(result).toEqual({ status: 200, bytes: SIZE, sha256: OBJECT_SHA });
    expect(sha256(readFileSync(join(dir, "assets/.blobs", OBJECT_SHA)))).toBe(OBJECT_SHA);
    expect(progress.at(-1)).toBe(SIZE);
    expect(progress.every((bytes, index) => index === 0 || bytes >= progress[index - 1]!)).toBe(true);
    // Staged beside the file and renamed: nothing else is left in the folder.
    expect(blobs(dir)).toEqual([OBJECT_SHA]);
    // Redirects refused, no session cookie or credential, no cache; the response paused while each chunk is written.
    expect(net.log.options).toEqual([{ method: "GET", url: "https://store.test/object", redirect: "error", credentials: "omit", cache: "no-store" }]);
    expect(net.log.pauses).toBeGreaterThan(1);
    expect(net.log.dataWhilePaused).toBe(0);
  });

  // S3-style stores (GitHub's LFS storage) refuse chunked uploads, so the length must be known up front.
  it("uploads the project file with its length, no chunked framing and the caller's headers, one write at a time", async () => {
    const { storage, folderId, dir } = await project();
    writeFileSync(join(dir, "assets/.blobs", OBJECT_SHA), OBJECT);
    const net = electronNet();
    // Framing is the transport's: Electron fails a request whose app set Content-Length or Transfer-Encoding.
    const headers = { Authorization: "RemoteAuth store-token", "Content-Type": "application/octet-stream", "Content-Length": "1", "Transfer-Encoding": "chunked" };
    const result = await invoke(new DesktopFileTransfers(net.request), storage, folderId, request({ method: "PUT", url: "https://store.test/upload", headers }));

    expect(result).toEqual({ status: 200, bytes: SIZE, sha256: OBJECT_SHA });
    expect(uploads).toEqual([{ contentLength: String(SIZE), transferEncoding: undefined, authorization: "RemoteAuth store-token", sha256: OBJECT_SHA, bytes: SIZE }]);
    expect(net.log.headers).toEqual(["Authorization", "Content-Type"]);
    expect(net.log.chunked).toBe(false);
    expect(net.log.options[0]).toMatchObject({ method: "PUT", redirect: "error", credentials: "omit" });
    // Read and written in chunks, each only once the last one's write was taken.
    expect(net.log.writes).toBeGreaterThan(1);
    expect(net.log.mostInFlight).toBe(1);
  });

  it("refuses a body or a file that is not the expected object, leaving the project file as it was", async () => {
    const { storage, folderId, dir } = await project();
    const target = join(dir, "assets/.blobs", OBJECT_SHA);
    writeFileSync(target, "previous");
    const wrongSha = "0".repeat(64);
    const transfers = new DesktopFileTransfers(electronNet().request);

    expect(await invoke(transfers, storage, folderId, request({ expected: { size: SIZE, sha256: wrongSha } }))).toMatchObject({ errorCode: "transfer-mismatch" });
    expect(await invoke(transfers, storage, folderId, request({ expected: { size: SIZE - 1, sha256: OBJECT_SHA } }))).toMatchObject({ errorCode: "transfer-mismatch" });
    expect(readFileSync(target, "utf8")).toBe("previous");
    expect(blobs(dir)).toEqual([OBJECT_SHA]);

    const net = electronNet();
    expect(await invoke(new DesktopFileTransfers(net.request), storage, folderId, request({ method: "PUT", url: "https://store.test/upload" }))).toMatchObject({ errorCode: "transfer-mismatch" });
    expect(net.log.options).toEqual([]);
    expect(requests.filter((line) => line.startsWith("PUT"))).toEqual([]);
  });

  it("cancels a running download, removing its temporary file, and a closing window cancels its own", async () => {
    const { storage, folderId, dir } = await project();
    const net = electronNet();
    const transfers = new DesktopFileTransfers(net.request);
    let started: () => void = () => {};
    const progressed = new Promise<void>((resolve) => (started = resolve));
    const first = transfers.transfer(OWNER, storage, folderId, request({ url: "https://store.test/slow" }), () => started());
    await progressed;
    expect(readdirSync(join(dir, "assets/.blobs")).some((name) => name.endsWith(".tmp"))).toBe(true);
    // Another window cannot cancel it; its own can.
    transfers.cancel(OWNER + 1, "t-1");
    transfers.cancel(OWNER, "t-1");
    expect(await first).toMatchObject({ errorCode: "transfer-cancelled" });
    expect(net.log.aborts).toBeGreaterThan(0);
    expect(blobs(dir)).toEqual([]);

    const second = invoke(transfers, storage, folderId, request({ id: "t-2", url: "https://store.test/slow" }));
    await expect.poll(() => readdirSync(join(dir, "assets/.blobs")).length).toBe(1);
    transfers.releaseOwner(OWNER);
    expect(await second).toMatchObject({ errorCode: "transfer-cancelled" });
    expect(blobs(dir)).toEqual([]);
  });

  it("transfers only inside the window's open project", async () => {
    const { storage, folderId, dir } = await project();
    const other = await project("Other");
    const transfers = new DesktopFileTransfers(electronNet().request);
    // A folder the window no longer has open.
    expect(await transfers.transfer(OWNER, storage, other.folderId, request(), () => {})).toMatchObject({ errorCode: "transfer-refused" });
    // A link inside the project that leads out of it.
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(dir, "assets/linked"));
    expect(await transfers.transfer(OWNER, storage, folderId, request({ path: "assets/linked/escape" }), () => {})).toMatchObject({ errorCode: "transfer-refused" });
    expect(readdirSync(outside)).toEqual([]);
    expect(await transfers.transfer(OWNER, storage, folderId, request({ path: "../Other/assets/.blobs/x" }), () => {})).toMatchObject({ errorCode: "transfer-refused" });
    expect(requests).toEqual([]);
  });

  it("cancels an upload while it is still being written, and the store never sees it", async () => {
    const { storage, folderId, dir } = await project();
    writeFileSync(join(dir, "assets/.blobs", OBJECT_SHA), OBJECT);
    let transfers: DesktopFileTransfers | null = null;
    // Cancelled as the second chunk is written, before the body is complete.
    const net = electronNet({ onWrite: () => net.log.writes === 2 && transfers?.cancel(OWNER, "t-1") });
    transfers = new DesktopFileTransfers(net.request);
    const pending = transfers.transfer(OWNER, storage, folderId, request({ method: "PUT", url: "https://store.test/upload" }), () => {});
    expect(await pending).toMatchObject({ errorCode: "transfer-cancelled" });
    expect(net.log.writes).toBe(2);
    expect(net.log.aborts).toBe(1);
    expect(uploads).toEqual([]);
  });

  it("never follows a redirect and writes nothing for an error status", async () => {
    const { storage, folderId, dir } = await project();
    const transfers = new DesktopFileTransfers(electronNet().request);
    const redirected = await invoke(transfers, storage, folderId, request({ url: "https://store.test/moved" }));
    expect(redirected).toHaveProperty("error");
    expect(redirected).not.toHaveProperty("status");
    expect(await invoke(transfers, storage, folderId, request({ url: "https://store.test/gone" }))).toEqual({ status: 404, bytes: 0, sha256: "" });
    expect(requests).toEqual(["GET /moved", "GET /gone"]);
    expect(blobs(dir)).toEqual([]);
  });
});

describe("files:transfer and files:cancel IPC", () => {
  const good = { id: "4f9c2d1e-0b7a-4c3e-9d2f-1a2b3c4d5e6f", method: "PUT", url: "https://lfs.example.com/objects/1", headers: { Authorization: "Bearer x" }, path: "assets/.blobs/abc", expected: { size: 3, sha256: "a".repeat(64) } };

  it("accepts a transfer of a project file over HTTPS with its object's size and hash", () => {
    expect(() => validateIpcArguments("files:transfer", ["node:/projects/Game", good])).not.toThrow();
    expect(() => validateIpcArguments("files:transfer", ["node:/projects/Game", { ...good, method: "GET", expected: undefined }])).not.toThrow();
    expect(() => validateIpcArguments("files:cancel", [good.id])).not.toThrow();
  });

  it("refuses anything else before the main process touches a file or the network", () => {
    for (const [folderId, body] of [
      ["/projects/Game", good],
      ["node:/projects/Game", { ...good, url: "http://lfs.example.com/objects/1" }],
      ["node:/projects/Game", { ...good, url: "https://user:pass@lfs.example.com/objects/1" }],
      ["node:/projects/Game", { ...good, url: "file:///etc/passwd" }],
      ["node:/projects/Game", { ...good, method: "POST" }],
      ["node:/projects/Game", { ...good, path: "../escape" }],
      ["node:/projects/Game", { ...good, path: "/etc/passwd" }],
      ["node:/projects/Game", { ...good, path: "" }],
      ["node:/projects/Game", { ...good, path: "assets\\x" }],
      ["node:/projects/Game", { ...good, headers: undefined }],
      ["node:/projects/Game", { ...good, headers: { "Bad Name": "x" } }],
      ["node:/projects/Game", { ...good, headers: { Authorization: "a\r\nInjected: b" } }],
      ["node:/projects/Game", { ...good, expected: { size: -1, sha256: "a".repeat(64) } }],
      ["node:/projects/Game", { ...good, expected: { size: 3, sha256: "A".repeat(64) } }],
      ["node:/projects/Game", { ...good, id: "../x" }],
      ["node:/projects/Game", { ...good, body: new ArrayBuffer(3) }],
    ] as Array<[string, unknown]>) {
      expect(() => validateIpcArguments("files:transfer", [folderId, body])).toThrow("Invalid desktop request");
    }
    expect(() => validateIpcArguments("files:transfer", ["node:/projects/Game"])).toThrow();
    expect(() => validateIpcArguments("files:cancel", ["x y"])).toThrow();
    expect(() => validateIpcArguments("files:cancel", [])).toThrow();
  });
});
