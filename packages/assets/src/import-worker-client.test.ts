import { describe, expect, it } from "vitest";
import { buildRadianceHdrFixture } from "@haptic/test-kit/environment-fixtures";
import { readEnvironmentTextureInfo } from "./environment-texture";
import { createImportWorkerClient, type ImportWorkerHandle } from "./import-worker-client";
import { runImportWorkerRequest, type ImportWorkerReply, type ImportWorkerRequest } from "./import-worker-protocol";
import { buildMinimalGlbFixture } from "./importers/glb-parse";
import { importByExtension } from "./importers";

/** Stands in for a module Worker: messages are structured-cloned both ways, as across a real thread. */
class FakeWorker implements ImportWorkerHandle {
  onmessage: ImportWorkerHandle["onmessage"] = null;
  onerror: ImportWorkerHandle["onerror"] = null;
  onmessageerror: ImportWorkerHandle["onmessageerror"] = null;
  terminated = false;
  readonly requests: ImportWorkerRequest[] = [];

  constructor(private readonly run: boolean) {}

  postMessage(message: unknown): void {
    const request = structuredClone(message) as ImportWorkerRequest;
    this.requests.push(request);
    if (this.run) void runImportWorkerRequest(request, (reply) => this.reply(reply));
  }

  reply(reply: ImportWorkerReply): void {
    if (this.terminated) return;
    this.onmessage?.call(this as unknown as Worker, { data: structuredClone(reply) } as MessageEvent);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function client(run = true) {
  const workers: FakeWorker[] = [];
  const { runImport, convertHdrEnvironment } = createImportWorkerClient(() => {
    const worker = new FakeWorker(run);
    workers.push(worker);
    return worker;
  });
  return { runImport, convertHdrEnvironment, workers };
}

const importOptions = (fileName: string) => ({ fileName, existingGuids: new Set<string>() });

describe("import worker client", () => {
  it("imports an HDR panorama on a worker with the same result as in-process, then ends the worker", async () => {
    const { runImport, workers } = client();
    const source = buildRadianceHdrFixture({ width: 64, height: 32, color: () => [0, 1, 0] });
    const progress: number[] = [];
    const [result] = await runImport("Sky.hdr", source, { ...importOptions("Sky.hdr"), hdrFaceSize: 128, onProgress: (fraction) => progress.push(fraction) });
    const [local] = await importByExtension("Sky.hdr", source, { ...importOptions("Sky.hdr"), hdrFaceSize: 128 });

    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(true);
    // The signal and progress callback stay behind; the Face Size crosses.
    expect(workers[0]!.requests[0]).toMatchObject({ type: "import", fileName: "Sky.hdr", options: { hdrFaceSize: 128 } });
    expect(workers[0]!.requests[0]).not.toHaveProperty("options.onProgress");
    expect({ ...result!, guid: "" }).toEqual({ ...local!, guid: "" });
    expect(progress.at(-1)).toBe(1);
    // The caller's bytes stay readable: a copy moved to the worker.
    expect(source.byteLength).toBeGreaterThan(0);
  });

  it("keeps several chunks that view one buffer intact across the worker", async () => {
    const { runImport } = client();
    const glb = buildMinimalGlbFixture();
    const results = await runImport("crate.glb", glb, importOptions("crate.glb"));
    const local = await importByExtension("crate.glb", glb, importOptions("crate.glb"));
    expect(results.map((result) => result.chunks.map((chunk) => [chunk.id, [...chunk.data]])))
      .toEqual(local.map((result) => result.chunks.map((chunk) => [chunk.id, [...chunk.data]])));
  });

  it("terminates the worker and rejects as aborted when the import is cancelled", async () => {
    const { runImport, workers } = client(false);
    const controller = new AbortController();
    const pending = runImport("Sky.hdr", new Uint8Array([0x23, 0x3f]), { ...importOptions("Sky.hdr"), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0]!.terminated).toBe(true);
  });

  it("reports a worker's import error and runs light importers without a worker", async () => {
    const { runImport, workers } = client();
    await expect(runImport("Sky.hdr", new Uint8Array([1, 2, 3]), importOptions("Sky.hdr"))).rejects.toThrow(/Radiance #\? signature/);
    expect(workers[0]!.terminated).toBe(true);

    const [texture] = await runImport("albedo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), importOptions("albedo.png"));
    expect(texture!.type).toBe("Texture");
    expect(workers).toHaveLength(1);
  });

  it("converts a kept panorama on a worker at the requested Face Size", async () => {
    const { convertHdrEnvironment, workers } = client();
    const source = buildRadianceHdrFixture({ width: 1024, height: 512, color: () => [1, 1, 1], runLength: true });
    const dds = await convertHdrEnvironment(source, { faceSize: 128 });
    expect(readEnvironmentTextureInfo(dds)).toMatchObject({ width: 128 });
    expect(workers[0]!.requests[0]).toMatchObject({ type: "convertHdr", faceSize: 128 });
  });
});
