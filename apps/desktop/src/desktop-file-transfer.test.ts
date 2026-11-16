import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeStorageAdapter } from "@haptic/vfs/node";
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

/** Main's `net.fetch`, with `https://store.test` routed to the loopback server. */
const fetchStore = (url: string, init: RequestInit) => fetch(url.replace("https://store.test", `http://127.0.0.1:${port}`), init);

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
    const progress: number[] = [];
    const result = await invoke(new DesktopFileTransfers(fetchStore), storage, folderId, request({ headers: { Authorization: "RemoteAuth store-token" } }), progress);

    expect(result).toEqual({ status: 200, bytes: SIZE, sha256: OBJECT_SHA });
    expect(sha256(readFileSync(join(dir, "assets/.blobs", OBJECT_SHA)))).toBe(OBJECT_SHA);
    expect(progress.at(-1)).toBe(SIZE);
    expect(progress.every((bytes, index) => index === 0 || bytes >= progress[index - 1]!)).toBe(true);
    // Staged beside the file and renamed: nothing else is left in the folder.
    expect(blobs(dir)).toEqual([OBJECT_SHA]);
  });

  // S3-style stores (GitHub's LFS storage) refuse chunked uploads, so the length must be known up front.
  it("uploads the project file with its length, no chunked framing and exactly the caller's headers", async () => {
    const { storage, folderId, dir } = await project();
    writeFileSync(join(dir, "assets/.blobs", OBJECT_SHA), OBJECT);
    const result = await invoke(new DesktopFileTransfers(fetchStore), storage, folderId, request({ method: "PUT", url: "https://store.test/upload", headers: { Authorization: "RemoteAuth store-token", "Content-Type": "application/octet-stream" } }));

    expect(result).toEqual({ status: 200, bytes: SIZE, sha256: OBJECT_SHA });
    expect(uploads).toEqual([{ contentLength: String(SIZE), transferEncoding: undefined, authorization: "RemoteAuth store-token", sha256: OBJECT_SHA, bytes: SIZE }]);
  });

  it("refuses a body or a file that is not the expected object, leaving the project file as it was", async () => {
    const { storage, folderId, dir } = await project();
    const target = join(dir, "assets/.blobs", OBJECT_SHA);
    writeFileSync(target, "previous");
    const wrongSha = "0".repeat(64);
    const transfers = new DesktopFileTransfers(fetchStore);

    expect(await invoke(transfers, storage, folderId, request({ expected: { size: SIZE, sha256: wrongSha } }))).toMatchObject({ errorCode: "transfer-mismatch" });
    expect(await invoke(transfers, storage, folderId, request({ expected: { size: SIZE - 1, sha256: OBJECT_SHA } }))).toMatchObject({ errorCode: "transfer-mismatch" });
    expect(readFileSync(target, "utf8")).toBe("previous");
    expect(blobs(dir)).toEqual([OBJECT_SHA]);

    expect(await invoke(transfers, storage, folderId, request({ method: "PUT", url: "https://store.test/upload" }))).toMatchObject({ errorCode: "transfer-mismatch" });
    expect(requests.filter((line) => line.startsWith("PUT"))).toEqual([]);
  });

  it("cancels a running download, removing its temporary file, and a closing window cancels its own", async () => {
    const { storage, folderId, dir } = await project();
    const transfers = new DesktopFileTransfers(fetchStore);
    let started: () => void = () => {};
    const progressed = new Promise<void>((resolve) => (started = resolve));
    const first = transfers.transfer(OWNER, storage, folderId, request({ url: "https://store.test/slow" }), () => started());
    await progressed;
    expect(readdirSync(join(dir, "assets/.blobs")).some((name) => name.endsWith(".tmp"))).toBe(true);
    // Another window cannot cancel it; its own can.
    transfers.cancel(OWNER + 1, "t-1");
    transfers.cancel(OWNER, "t-1");
    expect(await first).toMatchObject({ errorCode: "transfer-cancelled" });
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
    const transfers = new DesktopFileTransfers(fetchStore);
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

  it("never follows a redirect and writes nothing for an error status", async () => {
    const { storage, folderId, dir } = await project();
    const transfers = new DesktopFileTransfers(fetchStore);
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
