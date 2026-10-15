import { installMinimalProject } from "../../../../packages/assets/src/test-support/minimal-project";
import { describe, expect, it, vi } from "vitest";
import {
  decodeBabasset,
  encodeBabasset,
  readAssetDocumentHeader,
  sniffImageSize,
  textureEncodeChunkId,
  textureEncodeSize,
  type EncodeFn,
  type TextureEncodeSettings,
} from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { ProjectService } from "./project-service";

/** KTX2 identifier plus pixelWidth / pixelHeight. */
function ktx2Header(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  return bytes;
}

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

/** Stand-in encoder: a KTX2 header at the size the real encoders produce. */
const standInEncode: EncodeFn = async (source, settings) => {
  const size = sniffImageSize(source)!;
  const encoded = textureEncodeSize(size.width, size.height, settings);
  return { ktx2: ktx2Header(encoded.width, encoded.height), wallMs: 0 };
};

/** An encoder whose every encode waits for the test to finish it. */
function gatedEncode() {
  const calls: Array<{ settings: TextureEncodeSettings; finish: () => void }> = [];
  const encode: EncodeFn = (source, settings) =>
    new Promise((resolve) => {
      calls.push({ settings, finish: () => { void standInEncode(source, settings).then(resolve); } });
    });
  return { encode, calls };
}

/** A compressed 1x1 Texture whose encode predates alignment: committed 1x1, nothing recorded. */
async function writeLegacyOddTexture(storage: MemoryStorageAdapter, path: string, guid: string): Promise<void> {
  const chunkId = "ktx2:legacy";
  await storage.writeBinary(path, await encodeBabasset({
    header: {
      dependencyMetadataVersion: 1, requiredDependencies: [],
      guid, type: "Texture", name: guid, engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], parentClass: null,
      payload: { usage: "albedo", compressionState: "compressed", ktx2ChunkId: chunkId, width: 1, height: 1 },
    },
    chunks: [
      { id: "pixels", kind: "pixels", mime: "image/png", data: pngHeader(1, 1) },
      { id: chunkId, kind: "ktx2", mime: "image/ktx2", data: ktx2Header(1, 1) },
    ],
  }));
}

async function openService(encode: EncodeFn, seed?: (storage: MemoryStorageAdapter) => Promise<void>) {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("EncodeState.babproject");
  await installMinimalProject(storage);
  await seed?.(storage);
  const service = new ProjectService(storage, { encode });
  await service.loadCurrentProject();
  return { storage, service };
}

type TextureWrite = { state: unknown; error: unknown; chunk: unknown };

/** Every write of a Texture file from now on, as the state, error and committed encode it persisted. */
function recordTextureWrites(storage: MemoryStorageAdapter, path?: string): TextureWrite[] {
  const writes: TextureWrite[] = [];
  const write = storage.writeBinary.bind(storage);
  vi.spyOn(storage, "writeBinary").mockImplementation(async (target, bytes) => {
    if (target.endsWith(".babasset") && (path === undefined || target === path)) {
      const payload = readAssetDocumentHeader(bytes).payload;
      if (payload.compressionState !== undefined) {
        writes.push({ state: payload.compressionState, error: payload.encodeError, chunk: payload.ktx2ChunkId });
      }
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

  it("leaves a compressed Texture as it was when its background alignment re-encode fails", async () => {
    const path = "assets/odd.babasset";
    const { storage, service } = await openService(failingEncode, (seeded) => writeLegacyOddTexture(seeded, path, "odd"));
    const before = await storage.readBinary(path);
    const writes = recordTextureWrites(storage);

    expect(await service.reconcileTextureAlignment()).toBe(1);
    await writesSettled(service);

    // The pass writes nothing before its commit, so a failed pass has nothing to undo.
    expect(writes).toEqual([]);
    expect(await storage.readBinary(path)).toEqual(before);
    expect(service.registry!.getByGuid("odd")!.header.payload).toMatchObject({ compressionState: "compressed", ktx2ChunkId: "ktx2:legacy" });
    expect(service.registry!.getByGuid("odd")!.header.payload).not.toHaveProperty("encodeError");
    expect(service.sessionDiagnostics).toContain("Texture encode failed for odd (odd): BasisEncoder.encode returned 0");
  });

  it("lets a failure write that is already running finish before Close Project releases the folder", async () => {
    const { storage, service } = await openService(failingEncode);
    const write = storage.writeBinary.bind(storage);
    let resumeWrite!: () => void;
    const gate = new Promise<void>((resolve) => { resumeWrite = resolve; });
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    vi.spyOn(storage, "writeBinary").mockImplementation(async (path, bytes) => {
      if (path.endsWith(".babasset") && readAssetDocumentHeader(bytes).payload.compressionState === "encode_failed") {
        writeStarted();
        await gate;
      }
      return write(path, bytes);
    });
    const release = vi.spyOn(storage, "releaseFolder");
    const [texture] = await service.registry!.importFile("project", "", "odd.png", pngHeader(1, 1));
    await started;

    const closing = service.closeProject();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The next project reuses this storage, so a late write would land in its folder.
    expect(release).not.toHaveBeenCalled();
    resumeWrite();
    await closing;
    expect(release).toHaveBeenCalledTimes(1);

    await storage.openDocumentsProject("EncodeState.babproject");
    const saved = await decodeBabasset(await storage.readBinary(texture!.path));
    expect(saved.header.payload).toMatchObject({ compressionState: "encode_failed", encodeError: "BasisEncoder.encode returned 0" });
  });

  it("encodes once when a retry repeats the request an encode already has", async () => {
    const { encode, calls } = gatedEncode();
    const { service } = await openService(encode);
    const [texture] = await service.registry!.importFile("project", "", "odd.png", pngHeader(1, 1));
    const guid = texture!.header.guid;
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(await service.retryTextureEncoding(guid)).toBe(true);
    expect(await service.retryTextureEncoding(guid, { force: true })).toBe(true);
    calls[0]!.finish();
    await vi.waitFor(() => expect(service.registry!.getByGuid(guid)!.header.payload.compressionState).toBe("compressed"));
    // The write admission the encode held is back, however many requests asked for it.
    await writesSettled(service);
    expect(calls).toHaveLength(1);
  });

  it("commits only the newest request when the settings change while an encode runs", async () => {
    const { encode, calls } = gatedEncode();
    const { storage, service } = await openService(encode);
    const writes = recordTextureWrites(storage);
    const [texture] = await service.registry!.importFile("project", "", "odd.png", pngHeader(1, 1));
    const guid = texture!.header.guid;
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // A Details edit changes the Usage while the first encode runs.
    expect(await service.retryTextureEncoding(guid, { force: true, usage: "particle" })).toBe(true);
    calls[0]!.finish();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1]!.finish();
    await vi.waitFor(() => expect(service.registry!.getByGuid(guid)!.header.payload.compressionState).toBe("compressed"));
    await writesSettled(service);

    const newest = await textureEncodeChunkId(calls[1]!.settings, "particle");
    expect(writes.filter((write) => write.state === "compressed").map((write) => write.chunk)).toEqual([newest]);
    expect(service.registry!.getByGuid(guid)!.header.payload.ktx2ChunkId).toBe(newest);
  });
});
