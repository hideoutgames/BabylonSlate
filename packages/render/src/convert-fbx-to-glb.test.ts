import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertFbxImportBatch } from "./convert-fbx-to-glb";

type Posted = { message: { type: string; [key: string]: unknown }; transfer: Transferable[] };

/**
 * A worker that converts every FBX to `<name>.converted` bytes, or fails per scripted outcome.
 * "late-error" replies, then raises an error the worker could not attribute to the finished request.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static outcomes: Array<"ok" | "error" | "crash" | "late-error"> = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: Posted[] = [];
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Posted["message"], transfer: Transferable[] = []) {
    this.posted.push({ message, transfer });
    if (message.type !== "convert") return;
    const file = message.file as { name: string };
    const outcome = FakeWorker.outcomes.shift() ?? "ok";
    queueMicrotask(() => {
      if (outcome === "crash") this.onerror?.({ message: "worker crashed" } as ErrorEvent);
      else if (outcome === "error") this.onmessage?.({ data: { error: `cannot parse ${file.name}` } } as MessageEvent);
      else {
        this.onmessage?.({
          data: { bytes: new TextEncoder().encode(`${file.name}.converted`), consumedSidecars: ["albedo.png"] },
        } as MessageEvent);
        if (outcome === "late-error") this.onerror?.({ message: "late callback failed" } as ErrorEvent);
      }
    });
  }
  terminate() {
    this.terminated = true;
  }
}

const file = (name: string, bytes = new Uint8Array([1, 2, 3])) => ({ name, bytes });
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.outcomes = [];
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe("convertFbxImportBatch", () => {
  it("sends each sidecar image to one worker once however many FBX files the batch holds", async () => {
    const albedo = file("albedo.png", new Uint8Array([9, 9]));
    const result = await convertFbxImportBatch([file("a.fbx"), albedo, file("b.fbx")]);

    expect(FakeWorker.instances).toHaveLength(1);
    const [worker] = FakeWorker.instances;
    expect(worker!.posted.map(({ message }) => message.type)).toEqual(["sidecars", "convert", "convert"]);
    expect(worker!.posted[0]!.message.sidecars).toEqual([albedo]);
    expect(worker!.terminated).toBe(true);
    expect(result.files.map((entry) => entry.name)).toEqual(["a.glb", "albedo.png", "b.glb"]);
    expect(text(result.files[0]!.bytes)).toBe("a.fbx.converted");
    expect(text(result.files[2]!.bytes)).toBe("b.fbx.converted");
    // The image stays available for import unless an FBX consumed it.
    expect(result.files[1]).toBe(albedo);
    expect(result.consumedSidecars).toEqual(["albedo.png"]);
    expect(result.errors).toEqual([]);
  });

  it("starts no worker for a batch without FBX files", async () => {
    const result = await convertFbxImportBatch([file("model.glb"), file("albedo.png")]);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(result.files.map((entry) => entry.name)).toEqual(["model.glb", "albedo.png"]);
  });

  it("moves a file's own buffer to the worker but clones a file that views part of a larger buffer", async () => {
    const own = file("own.fbx", new Uint8Array([1, 2, 3, 4]));
    const storage = new Uint8Array([0, 1, 2, 3, 0]);
    const view = file("view.fbx", storage.subarray(1, 4));
    await convertFbxImportBatch([own, view]);

    const transfers = FakeWorker.instances[0]!.posted.map(({ transfer }) => transfer);
    expect(transfers).toHaveLength(2);
    expect(transfers[0]).toHaveLength(1);
    expect(transfers[0]![0]).toBe(own.bytes.buffer);
    expect(transfers[1]).toEqual([]);
    // The unmoved storage still belongs to whoever else views it.
    expect([...storage]).toEqual([0, 1, 2, 3, 0]);
  });

  it("reports a failed FBX and keeps converting the rest of the batch on the same worker", async () => {
    FakeWorker.outcomes = ["error", "ok"];
    const result = await convertFbxImportBatch([file("bad.fbx"), file("good.fbx")]);

    expect(FakeWorker.instances).toHaveLength(1);
    expect(result.errors).toEqual(["bad.fbx: cannot parse bad.fbx"]);
    expect(result.files.map((entry) => entry.name)).toEqual(["good.glb"]);
  });

  it("replaces a crashed worker, sending the sidecars to its successor", async () => {
    FakeWorker.outcomes = ["crash", "ok"];
    const albedo = file("albedo.png", new Uint8Array([9]));
    const result = await convertFbxImportBatch([file("a.fbx"), albedo, file("b.fbx")]);

    expect(result.errors).toEqual(["a.fbx: worker crashed"]);
    expect(result.files.map((entry) => entry.name)).toEqual(["albedo.png", "b.glb"]);
    expect(FakeWorker.instances.map((worker) => worker.terminated)).toEqual([true, true]);
    expect(FakeWorker.instances[1]!.posted[0]!.message).toEqual({ type: "sidecars", sidecars: [albedo] });
  });

  it("replaces a worker that errors after its request replied without failing that file or the next", async () => {
    FakeWorker.outcomes = ["late-error", "ok"];
    const albedo = file("albedo.png", new Uint8Array([9]));
    const result = await convertFbxImportBatch([file("a.fbx"), albedo, file("b.fbx")]);

    expect(result.errors).toEqual([]);
    expect(result.files.map((entry) => entry.name)).toEqual(["a.glb", "albedo.png", "b.glb"]);
    expect(FakeWorker.instances.map((worker) => worker.terminated)).toEqual([true, true]);
    expect(FakeWorker.instances[1]!.posted[0]!.message).toEqual({ type: "sidecars", sidecars: [albedo] });
  });
});
