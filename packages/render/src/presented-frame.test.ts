import { NullEngine } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitPresentedFrame } from "./presented-frame";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("owned scene GPU submission", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { engines.splice(0).forEach((engine) => engine.dispose()); vi.restoreAllMocks(); });
  const engine = () => { const value = new NullEngine(); engines.push(value); return value; };

  it("waits for submitted WebGPU work and rejects validation errors without retaining scopes for a later owner", async () => {
    const native = engine();
    vi.spyOn(native, "isWebGPU", "get").mockReturnValue(true);
    const submitted = deferred();
    const scopes: Array<{ filter: string; error: { message: string } | null }> = [];
    const device = {
      pushErrorScope: (filter: string) => { scopes.push({ filter, error: null }); },
      popErrorScope: () => Promise.resolve(scopes.pop()!.error),
      queue: { onSubmittedWorkDone: () => submitted.promise },
    };
    Object.assign(native, { _device: device });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let ready = false;
    const good = submitPresentedFrame(native, () => {});
    void good.completed.then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(scopes).toHaveLength(0);
    const invalid = submitPresentedFrame(native, () => {
      scopes.find((scope) => scope.filter === "validation")!.error = { message: "Invalid owner uniform binding" };
    });
    const rejected = expect(invalid.completed).rejects.toThrow("GPU submission failed");
    expect(scopes).toHaveLength(0);
    submitted.resolve();
    await good.completed;
    await rejected;
    expect(ready).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Invalid owner uniform binding"));
    await submitPresentedFrame(native, () => {}).completed;
  });

  it("flushes and closes every WebGPU scope when the owning draw throws", async () => {
    const native = engine();
    vi.spyOn(native, "isWebGPU", "get").mockReturnValue(true);
    const scopes: string[] = [];
    let submittedOwnWork = false;
    Object.assign(native, { _device: {
      pushErrorScope: (filter: string) => { scopes.push(filter); },
      popErrorScope: () => { scopes.pop(); return Promise.resolve(null); },
      queue: { onSubmittedWorkDone: async () => {} },
    } });
    vi.spyOn(native, "flushFramebuffer").mockImplementation(() => { if (scopes.length) submittedOwnWork = true; });
    const failed = submitPresentedFrame(native, () => { throw new Error("Draw allocation failed"); });
    await expect(failed.completed).rejects.toMatchObject({ cause: expect.objectContaining({ message: "Draw allocation failed" }) });
    expect(submittedOwnWork).toBe(true);
    expect(scopes).toHaveLength(0);
  });

  it("cancels an unsignaled GL fence, releases it once, and accepts a later completed owner", async () => {
    const native = engine();
    let signaled = false;
    const fences = new Set<object>();
    const gl = {
      NO_ERROR: 0, CONTEXT_LOST_WEBGL: 37442, SYNC_GPU_COMMANDS_COMPLETE: 37143,
      WAIT_FAILED: 37149, ALREADY_SIGNALED: 37146, CONDITION_SATISFIED: 37148,
      getError: () => 0, isContextLost: () => false,
      fenceSync: () => { const fence = {}; fences.add(fence); return fence; },
      clientWaitSync: () => signaled ? 37148 : 37147,
      deleteSync: vi.fn((fence: object) => { fences.delete(fence); }),
      flush: () => {},
    };
    Object.assign(native, { _gl: gl });
    const pending = submitPresentedFrame(native, () => {});
    const rejected = expect(pending.completed).rejects.toThrow("cancelled");
    expect(fences.size).toBe(1);
    pending.cancel();
    pending.cancel();
    await rejected;
    expect(fences.size).toBe(0);
    expect(gl.deleteSync).toHaveBeenCalledTimes(1);
    signaled = true;
    await submitPresentedFrame(native, () => {}).completed;
    expect(fences.size).toBe(0);
    expect(gl.deleteSync).toHaveBeenCalledTimes(2);
    // NullEngine disposal has no owning GL context; remove the test boundary.
    Reflect.deleteProperty(native, "_gl");
  });
});
