import { beforeEach, describe, expect, it, vi } from "vitest";
import { isStorageNotFound, SourceRevisionChangedError } from "@haptic/core";
import type { BabylonSlateScopedStoragePlugin } from "./capacitor-scoped-storage";
import { DocumentsStorageAdapter } from "./documents-adapter";
import { NativeBinaryBridge, nativeBinaryBridge, type NativeBinaryBridgeConfig } from "./native-binary-bridge";
import { ScopedStorageAdapter } from "./scoped-storage-adapter";
import { createFakeDocumentsFs } from "./test-support/fake-documents-fs";

vi.mock("@capacitor/preferences", () => ({
  Preferences: { get: vi.fn(async () => ({ value: null })), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
}));

const MiB = 1 << 20;

/**
 * The native side of the transport as the wire format describes it: files by
 * location, a revision per write, GET (whole or ranged) and POST answers, and
 * chunked sessions that touch the file only on commit.
 */
function createNativeHost(config: Omit<NativeBinaryBridgeConfig, "token"> = { baseUrl: "haptic-storage://bridge", writes: "body" }) {
  const files = new Map<string, { bytes: Uint8Array; revision: string }>();
  const sessions = new Map<string, { key: string; parts: Uint8Array[] }>();
  let revisions = 0;
  let sessionIds = 0;
  const token = "launch-token";
  const keyOf = (query: URLSearchParams | Record<string, string>) => {
    const get = (name: string) => query instanceof URLSearchParams ? query.get(name) : query[name];
    return `${get("directory") ?? `folder:${get("folder")}`}|${get("path")}`;
  };
  const answer = (status: number, body: BodyInit | null, headers: Record<string, string> = {}) => new Response(body, { status, headers });
  const decode = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const requests: Array<{ url: string; method: string }> = [];

  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ url: input, method });
    const prefix = `${config.baseUrl}/${token}/file?`;
    if (!input.startsWith(prefix)) return answer(403, "Refused", { "X-Haptic-Error": "UNREACHABLE" });
    const query = new URLSearchParams(input.slice(prefix.length));
    const key = keyOf(query);
    if (method === "POST") {
      const body = new Uint8Array(init?.body as Uint8Array);
      if (body.byteLength !== Number(query.get("size"))) return answer(400, "Body missing", { "X-Haptic-Error": "BODY_MISSING" });
      files.set(key, { bytes: body.slice(), revision: `r${++revisions}` });
      return answer(204, null);
    }
    const file = files.get(key);
    if (!file) return answer(404, "File not found", { "X-Haptic-Error": "NOT_FOUND" });
    if (!query.has("offset")) return answer(200, file.bytes.slice());
    const offset = Number(query.get("offset"));
    const length = Number(query.get("length"));
    const expected = query.get("revision");
    if (expected !== null && expected !== file.revision) {
      return answer(409, "Source revision changed", { "X-Haptic-Error": "REVISION_CHANGED", "X-Haptic-Actual-Bytes": "0" });
    }
    return answer(200, file.bytes.slice(offset, offset + length), {
      "X-Haptic-Revision": file.revision,
      "X-Haptic-Total-Bytes": String(file.bytes.byteLength),
      "X-Haptic-Actual-Bytes": String(length),
    });
  });

  const plugin = {
    getBinaryBridgeConfig: vi.fn(async () => ({ ...config, token })),
    beginWrite: vi.fn(async (location: Record<string, string>) => {
      const writeId = `w${++sessionIds}`;
      sessions.set(writeId, { key: keyOf(location), parts: [] });
      return { writeId };
    }),
    appendWriteChunk: vi.fn(async ({ writeId, data }: { writeId: string; data: string }) => {
      const session = sessions.get(writeId);
      if (!session) throw Object.assign(new Error("No write"), { code: "UNREACHABLE" });
      session.parts.push(decode(data));
    }),
    commitWrite: vi.fn(async ({ writeId, data, size }: { writeId: string; data: string; size: number }) => {
      const session = sessions.get(writeId);
      sessions.delete(writeId);
      if (!session) throw Object.assign(new Error("No write"), { code: "UNREACHABLE" });
      session.parts.push(decode(data));
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of session.parts) { bytes.set(part, offset); offset += part.byteLength; }
      if (offset !== size) throw new Error("Short write");
      files.set(session.key, { bytes, revision: `r${++revisions}` });
    }),
    abortWrite: vi.fn(async ({ writeId }: { writeId: string }) => { sessions.delete(writeId); }),
  };
  const bridge = new NativeBinaryBridge({ ...config, token }, plugin, fetch);
  return { files, sessions, fetch, requests, plugin, bridge, token };
}

function documents(host: ReturnType<typeof createNativeHost>) {
  const fs = createFakeDocumentsFs();
  return { fs, storage: new DocumentsStorageAdapter({ fs, platform: "ios", bridge: host.bridge }) };
}

describe("binary storage transport", () => {
  let host: ReturnType<typeof createNativeHost>;
  beforeEach(() => {
    host = createNativeHost();
  });

  it("reads and writes Documents files as raw bodies addressed by directory and encoded path", async () => {
    const { fs, storage } = documents(host);
    await storage.openDocumentsProject("My Game");
    const readFile = vi.spyOn(fs, "readFile");
    const writeFile = vi.spyOn(fs, "writeFile");
    const bytes = Uint8Array.from({ length: 300 }, (_, index) => index % 256);

    await storage.writeBinary("assets/a b+c.bin", bytes);
    expect(await storage.readBinary("assets/a b+c.bin")).toEqual(bytes);

    expect(host.requests.map((request) => request.url)).toEqual([
      "haptic-storage://bridge/launch-token/file?directory=DOCUMENTS&path=Projects%2FMy%20Game%2Fassets%2Fa%20b%2Bc.bin&size=300",
      "haptic-storage://bridge/launch-token/file?directory=DOCUMENTS&path=Projects%2FMy%20Game%2Fassets%2Fa%20b%2Bc.bin",
    ]);
    expect(host.requests.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(storage.getReadMetrics()).toMatchObject({ fullReads: 1, actualBytesRead: 300 });
  });

  it("writes text through the transport too, so it replaces the file atomically", async () => {
    const { fs, storage } = documents(host);
    await storage.openDocumentsProject("Game");
    await storage.writeText("project.json", "{\"name\":\"Ünïcode\"}");
    expect(new TextDecoder().decode(host.files.get("DOCUMENTS|Projects/Game/project.json")!.bytes)).toBe("{\"name\":\"Ünïcode\"}");
    expect(fs.tree.has("Projects/Game/project.json")).toBe(false);
  });

  it("maps range answers to revisions and statuses to the port's errors", async () => {
    const { storage } = documents(host);
    await storage.openDocumentsProject("Game");
    await storage.writeBinary("asset.hasset", new Uint8Array([1, 2, 3, 4, 5]));

    const first = await storage.readBinaryRange("asset.hasset", 1, 3);
    expect(first).toMatchObject({ bytes: new Uint8Array([2, 3, 4]), totalSize: 5, revision: "r1", actualBytesRead: 3 });
    expect(host.requests.at(-1)!.url).toMatch(/&offset=1&length=3$/);

    await storage.writeBinary("asset.hasset", new Uint8Array([9, 9, 9, 9, 9]));
    await expect(storage.readBinaryRange("asset.hasset", 1, 3, first.revision)).rejects.toBeInstanceOf(SourceRevisionChangedError);
    expect(host.requests.at(-1)!.url).toMatch(/&revision=r1$/);

    const missing = await storage.readBinary("gone.bin").catch((error: unknown) => error);
    expect(isStorageNotFound(missing)).toBe(true);
    const missingRange = await storage.readBinaryRange("gone.bin", 0, 1).catch((error: unknown) => error);
    expect(isStorageNotFound(missingRange)).toBe(true);
  });

  it("refuses a range answer without a revision or with the wrong length", async () => {
    const { storage } = documents(host);
    await storage.openDocumentsProject("Game");
    host.fetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { "X-Haptic-Total-Bytes": "4", "X-Haptic-Actual-Bytes": "2" } }));
    await expect(storage.readBinaryRange("asset", 0, 2)).rejects.toThrow(/revision/i);
    host.fetch.mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { "X-Haptic-Revision": "r", "X-Haptic-Total-Bytes": "4", "X-Haptic-Actual-Bytes": "2" } }));
    await expect(storage.readBinaryRange("asset", 0, 2)).rejects.toThrow(/Invalid storage range response/);
  });

  it("writes through the plugin, staged and renamed, once the web view proves it drops request bodies", async () => {
    const { fs, storage } = documents(host);
    await storage.openDocumentsProject("Game");
    host.fetch.mockImplementation(async () => new Response("Body missing", { status: 400, headers: { "X-Haptic-Error": "BODY_MISSING" } }));
    const rename = vi.spyOn(fs, "rename");

    await storage.writeBinary("a.bin", new Uint8Array([1, 2]));
    await storage.writeBinary("b.bin", new Uint8Array([3]));

    expect(host.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fs.tree.get("Projects/Game/a.bin")?.data).toEqual(new Uint8Array([1, 2]));
    expect(fs.tree.get("Projects/Game/b.bin")?.data).toEqual(new Uint8Array([3]));
    // Each new file: its staged copy moved into place (nothing to set aside).
    expect(rename.mock.calls.filter(([{ from }]) => /\/\.haptic-[0-9a-f-]{36}\.tmp$/.test(from)).map(([{ to }]) => to))
      .toEqual(["Projects/Game/a.bin", "Projects/Game/b.bin"]);
  });

  it("splits Android writes into 1 MiB chunks and commits the last one with the total size", async () => {
    host = createNativeHost({ baseUrl: "https://localhost/_haptic_storage", writes: "chunks" });
    const { storage } = documents(host);
    await storage.openDocumentsProject("Game");
    const bytes = new Uint8Array(2 * MiB + 5);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 7) % 251;

    await storage.writeBinary("big.bin", bytes);

    expect(host.plugin.beginWrite).toHaveBeenCalledWith({ directory: "DOCUMENTS", path: "Projects/Game/big.bin" });
    expect(host.plugin.appendWriteChunk).toHaveBeenCalledTimes(2);
    expect(host.plugin.appendWriteChunk.mock.calls.map(([call]) => atob(call.data).length)).toEqual([MiB, MiB]);
    expect(host.plugin.commitWrite).toHaveBeenCalledWith(expect.objectContaining({ writeId: "w1", size: 2 * MiB + 5 }));
    expect(atob(host.plugin.commitWrite.mock.calls[0]![0].data).length).toBe(5);
    // Element-wise equality of megabytes is slow; compare the bytes directly.
    expect(Buffer.compare(host.files.get("DOCUMENTS|Projects/Game/big.bin")!.bytes, bytes)).toBe(0);
    expect(host.requests).toEqual([]);
  });

  it("aborts a failed chunked write, leaving the original file and no open session", async () => {
    host = createNativeHost({ baseUrl: "https://localhost/_haptic_storage", writes: "chunks" });
    const { storage } = documents(host);
    await storage.openDocumentsProject("Game");
    await storage.writeBinary("big.bin", new Uint8Array([1, 2, 3]));
    const broken = new Error("Disk full");
    host.plugin.appendWriteChunk.mockRejectedValueOnce(broken);

    await expect(storage.writeBinary("big.bin", new Uint8Array(MiB + 1))).rejects.toBe(broken);

    expect(host.plugin.abortWrite).toHaveBeenCalledWith({ writeId: "w2" });
    expect(host.plugin.commitWrite).toHaveBeenCalledTimes(1);
    expect(host.sessions.size).toBe(0);
    expect(host.files.get("DOCUMENTS|Projects/Game/big.bin")!.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("addresses chosen folders by id and read scope, and maps their errors", async () => {
    const plugin = {
      ...host.plugin,
      pickFolder: vi.fn().mockResolvedValue({ folder: { id: "folder-1", name: "Game", supportsReadScope: true } }),
      beginReadScope: vi.fn().mockResolvedValue({ readScope: "scan" }),
      endReadScope: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
      writeFile: vi.fn(),
    } as unknown as BabylonSlateScopedStoragePlugin;
    const storage = new ScopedStorageAdapter(plugin, host.bridge);
    await storage.pickProjectFolder();

    await storage.writeBinary("assets/a.bin", new Uint8Array([4, 5]));
    const read = await storage.withReadScope((reader) => reader.readBinary("assets/a.bin"));
    expect(read).toEqual(new Uint8Array([4, 5]));
    expect(host.requests.map((request) => request.url)).toEqual([
      "haptic-storage://bridge/launch-token/file?folder=folder-1&path=assets%2Fa.bin&size=2",
      "haptic-storage://bridge/launch-token/file?folder=folder-1&readScope=scan&path=assets%2Fa.bin",
    ]);
    expect(plugin.readFile).not.toHaveBeenCalled();
    expect(plugin.writeFile).not.toHaveBeenCalled();

    host.fetch.mockResolvedValueOnce(new Response("Folder access has been revoked", { status: 403, headers: { "X-Haptic-Error": "ACCESS_REVOKED" } }));
    await expect(storage.readBinary("assets/a.bin")).rejects.toMatchObject({ code: "ACCESS_REVOKED", message: "Folder access has been revoked" });
    expect(await storage.needsReconnect()).toBe(true);
  });

  it("keeps the plugin's own calls where the host offers no transport", async () => {
    const plugin = {
      getBinaryBridgeConfig: vi.fn().mockResolvedValue({}),
      pickFolder: vi.fn().mockResolvedValue({ folder: { id: "folder-1", name: "Game" } }),
      readFile: vi.fn().mockResolvedValue({ data: btoa("\u0001\u0002") }),
      writeFile: vi.fn().mockResolvedValue(undefined),
    } as unknown as BabylonSlateScopedStoragePlugin;
    const storage = new ScopedStorageAdapter(plugin);
    await storage.pickProjectFolder();
    expect(await storage.readBinary("a.bin")).toEqual(new Uint8Array([1, 2]));
    await storage.writeBinary("a.bin", new Uint8Array([3]));
    expect(plugin.writeFile).toHaveBeenCalledWith({ folder: "folder-1", path: "a.bin", data: btoa("\u0003"), encoding: "base64" });
    expect(plugin.getBinaryBridgeConfig).toHaveBeenCalledTimes(1);
  });

  it("asks a plugin for its transport once and treats a rejection as none", async () => {
    const plugin = { getBinaryBridgeConfig: vi.fn().mockRejectedValue(new Error("not implemented on web")) };
    expect(await nativeBinaryBridge(plugin)).toBeNull();
    expect(await nativeBinaryBridge(plugin)).toBeNull();
    expect(plugin.getBinaryBridgeConfig).toHaveBeenCalledTimes(1);
  });
});
