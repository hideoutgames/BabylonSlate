import { describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ readDocumentsRange: vi.fn() }));

// Capacitor plugin proxies answer every property name and reject methods the
// platform does not implement, so a method's presence proves nothing.
vi.mock("@capacitor/filesystem", async () => {
  const { createFakeDocumentsFs } = await import("./test-support/fake-documents-fs");
  const fake = createFakeDocumentsFs();
  delete fake.readFileRange;
  const Filesystem = new Proxy(fake, {
    get: (target, name) => Reflect.get(target, name) ?? (() => Promise.reject(new Error(`"Filesystem.${String(name)}()" is not implemented on ios`))),
  });
  return { Directory: { Documents: "DOCUMENTS", Data: "DATA" }, Filesystem };
});
vi.mock("./capacitor-scoped-storage", async (original) => ({
  ...(await original<typeof import("./capacitor-scoped-storage")>()),
  BabylonSlateScopedStorage: native,
}));

const { DocumentsStorageAdapter } = await import("./documents-adapter");

describe("DocumentsStorageAdapter on the Capacitor Filesystem plugin", () => {
  it("reads ranges through the native storage plugin, not the Filesystem proxy", async () => {
    const storage = new DocumentsStorageAdapter();
    await storage.openDocumentsProject("Game");
    native.readDocumentsRange.mockResolvedValue({ data: btoa("ab"), totalSize: 4, revision: "one", actualBytesRead: 2 });
    const read = await storage.readBinaryRange("asset.hasset", 1, 2);
    expect(read.bytes).toEqual(new Uint8Array([97, 98]));
    expect(native.readDocumentsRange).toHaveBeenCalledWith(expect.objectContaining({ offset: 1, length: 2 }));
  });
});
