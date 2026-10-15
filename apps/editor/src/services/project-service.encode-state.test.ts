import { installMinimalProject } from "../../../../packages/assets/src/test-support/minimal-project";
import { describe, expect, it, vi } from "vitest";
import { readAssetDocumentHeader, type EncodeFn } from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { ProjectService } from "./project-service";

/** PNG signature + IHDR size (enough for size sniffing). */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const failingEncode: EncodeFn = async () => {
  throw new Error("BasisEncoder.encode returned 0");
};

async function openService(encode: EncodeFn) {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("EncodeState.babproject");
  await installMinimalProject(storage);
  const service = new ProjectService(storage, { encode });
  await service.loadCurrentProject();
  return { storage, service };
}

type TextureWrite = { state: unknown; error: unknown };

/** Every write of a Texture file from now on, as the state and error it persisted. */
function recordTextureWrites(storage: MemoryStorageAdapter, path?: string): TextureWrite[] {
  const writes: TextureWrite[] = [];
  const write = storage.writeBinary.bind(storage);
  vi.spyOn(storage, "writeBinary").mockImplementation(async (target, bytes) => {
    if (target.endsWith(".babasset") && (path === undefined || target === path)) {
      const payload = readAssetDocumentHeader(bytes).payload;
      if (payload.compressionState !== undefined) writes.push({ state: payload.compressionState, error: payload.encodeError });
    }
    return write(target, bytes);
  });
  return writes;
}

/** Resolves once no admitted write (an encode's follow-up writes included) is still running. */
async function writesSettled(service: ProjectService): Promise<void> {
  await vi.waitFor(() => expect(service.textureEncodeQueue.depth).toBe(0));
  const lease = service.lockAuthoringWrites("Checking for unfinished writes");
  try {
    expect(await lease.ready).toBe(true);
  } finally {
    lease.release();
  }
}

describe("texture encode state writes", () => {
  it("records a failed encode with one write that carries the error", async () => {
    const { storage, service } = await openService(failingEncode);
    const writes = recordTextureWrites(storage);
    const [texture] = await service.registry!.importFile("project", "", "odd.png", pngHeader(1, 1));
    await vi.waitFor(() => expect(service.registry!.getByGuid(texture!.header.guid)!.header.payload.compressionState).toBe("encode_failed"));
    await writesSettled(service);

    const failures = writes.filter((write) => write.state === "encode_failed");
    expect(failures).toEqual([{ state: "encode_failed", error: "BasisEncoder.encode returned 0" }]);
    expect(service.registry!.getByGuid(texture!.header.guid)!.header.payload.encodeError).toBe("BasisEncoder.encode returned 0");
  });
});
