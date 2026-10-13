import { NullEngine } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { presentationFencePending, submitPresentedFrame, whenPresentationFenceClear } from "./presented-frame";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A WebGL2 stand-in whose fence stays unsignaled until `state.signaled`; draws raise errors through `state.raised`. */
function fakeGl() {
  const state = { signaled: false, raised: [] as number[] };
  const calls: string[] = [];
  const fences = new Set<object>();
  const gl = {
    NO_ERROR: 0, INVALID_VALUE: 1281, INVALID_OPERATION: 1282, OUT_OF_MEMORY: 1285, CONTEXT_LOST_WEBGL: 37442,
    SYNC_GPU_COMMANDS_COMPLETE: 37143, WAIT_FAILED: 37149, ALREADY_SIGNALED: 37146, CONDITION_SATISFIED: 37148,
    getError: vi.fn(() => { calls.push("getError"); return state.raised.shift() ?? 0; }),
    isContextLost: () => false,
    fenceSync: vi.fn(() => { calls.push("fenceSync"); const fence = {}; fences.add(fence); return fence; }),
    clientWaitSync: vi.fn(() => {
      calls.push(state.signaled ? "clientWaitSync:signaled" : "clientWaitSync:pending");
      return state.signaled ? 37148 : 37147;
    }),
    deleteSync: vi.fn((fence: object) => { fences.delete(fence); }),
    flush: vi.fn(() => { calls.push("flush"); }),
  };
  return { gl, state, calls, fences };
}

describe("owned scene GPU submission", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { engines.splice(0).forEach((engine) => engine.dispose()); vi.restoreAllMocks(); vi.useRealTimers(); });
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

  it("drains popped scope reports when the queue completion API throws synchronously", async () => {
    const native = engine();
    vi.spyOn(native, "isWebGPU", "get").mockReturnValue(true);
    const reports = deferred();
    Object.assign(native, { _device: {
      pushErrorScope: () => {},
      popErrorScope: () => reports.promise.then(() => { throw new Error("Deferred validation failure"); }),
      queue: { onSubmittedWorkDone: () => { throw new Error("Device queue lost"); } },
    } });
    let settled = false;
    const submission = submitPresentedFrame(native, () => {});
    const rejected = expect(submission.completed).rejects.toThrow("GPU submission failed");
    void submission.completed.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    reports.resolve();
    await rejected;
    expect(settled).toBe(true);
  });

  it("cancels an unsignaled GL fence, releases it once, and accepts a later completed owner", async () => {
    const native = engine();
    const fake = fakeGl();
    Object.assign(native, { _gl: fake.gl });
    const pending = submitPresentedFrame(native, () => {});
    const rejected = expect(pending.completed).rejects.toThrow("cancelled");
    expect(fake.fences.size).toBe(1);
    pending.cancel();
    pending.cancel();
    await rejected;
    expect(fake.fences.size).toBe(0);
    expect(fake.gl.deleteSync).toHaveBeenCalledTimes(1);
    // Only the pre-draw read ran: abandoning a presentation never queries the GPU for errors.
    expect(fake.gl.getError).toHaveBeenCalledTimes(1);
    fake.state.signaled = true;
    await submitPresentedFrame(native, () => {}).completed;
    expect(fake.fences.size).toBe(0);
    expect(fake.gl.deleteSync).toHaveBeenCalledTimes(2);
    // NullEngine disposal has no owning GL context; remove the test boundary.
    Reflect.deleteProperty(native, "_gl");
  });

  it("rejects a draw that raised a WebGL error only once the fence signals, with no status query while it is pending", async () => {
    vi.useFakeTimers();
    const native = engine();
    const fake = fakeGl();
    Object.assign(native, { _gl: fake.gl });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const submission = submitPresentedFrame(native, () => { fake.calls.push("draw"); fake.state.raised.push(fake.gl.INVALID_OPERATION); });
    const rejected = expect(submission.completed).rejects.toThrow("Scene presentation WebGL errors: 1282");
    await vi.advanceTimersByTimeAsync(40);
    const afterDraw = () => fake.calls.slice(fake.calls.indexOf("draw") + 1);
    expect(afterDraw()).toContain("clientWaitSync:pending");
    expect(afterDraw()).not.toContain("getError");
    expect(warning).not.toHaveBeenCalled();
    fake.state.signaled = true;
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    const signalledAt = afterDraw().indexOf("clientWaitSync:signaled");
    expect(signalledAt).toBeGreaterThanOrEqual(0);
    expect(afterDraw().indexOf("getError")).toBeGreaterThan(signalledAt);
    expect(warning).toHaveBeenCalledWith("[render] Scene presentation WebGL errors: 1282");
    expect(fake.fences.size).toBe(0);
    Reflect.deleteProperty(native, "_gl");
  });

  it("only warns about errors that were already pending before the draw", async () => {
    const native = engine();
    const fake = fakeGl();
    fake.state.raised.push(fake.gl.INVALID_VALUE);
    fake.state.signaled = true;
    Object.assign(native, { _gl: fake.gl });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await submitPresentedFrame(native, () => {}).completed;
    expect(warning).toHaveBeenCalledWith("[render] Pre-existing WebGL errors before scene presentation: 1281");
    expect(warning).toHaveBeenCalledTimes(1);
    Reflect.deleteProperty(native, "_gl");
  });

  it("reads no errors for a later owner while an earlier fence is pending, and every waiting owner shares an error raised meanwhile", async () => {
    vi.useFakeTimers();
    const native = engine();
    const fake = fakeGl();
    Object.assign(native, { _gl: fake.gl });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = submitPresentedFrame(native, () => { fake.state.raised.push(fake.gl.OUT_OF_MEMORY); });
    const firstRejected = expect(first.completed).rejects.toThrow("Scene presentation WebGL errors: 1285");
    expect(fake.gl.getError).toHaveBeenCalledTimes(1);
    const second = submitPresentedFrame(native, () => {});
    const secondRejected = expect(second.completed).rejects.toThrow("Scene presentation WebGL errors: 1285");
    // Only the first owner's pre-draw read ran: the second would wait behind the first draw.
    expect(fake.gl.getError).toHaveBeenCalledTimes(1);
    expect(first.fenceWaiting()).toBe(true);
    expect(second.fenceWaiting()).toBe(true);
    fake.state.signaled = true;
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([firstRejected, secondRejected]);
    expect(first.fenceWaiting()).toBe(false);
    expect(fake.fences.size).toBe(0);
    Reflect.deleteProperty(native, "_gl");
  });

  it("skips the pre-draw read when the previous attempt left the error state clear, but still rejects a draw error at the fence", async () => {
    vi.useFakeTimers();
    const native = engine();
    const fake = fakeGl();
    Object.assign(native, { _gl: fake.gl });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const submission = submitPresentedFrame(native, () => { fake.state.raised.push(fake.gl.INVALID_OPERATION); }, { errorStateKnownClear: true });
    const rejected = expect(submission.completed).rejects.toThrow("Scene presentation WebGL errors: 1282");
    expect(fake.gl.getError).not.toHaveBeenCalled();
    fake.state.signaled = true;
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    Reflect.deleteProperty(native, "_gl");
  });

  it("keeps the synchronous error reads on a context without fences", () => {
    const native = engine();
    const fake = fakeGl();
    Object.assign(native, { _gl: { ...fake.gl, fenceSync: undefined, clientWaitSync: undefined, finish: () => { fake.calls.push("finish"); } } });
    const submission = submitPresentedFrame(native, () => { fake.calls.push("draw"); }, { errorStateKnownClear: true });
    expect(fake.calls).toEqual(["getError", "draw", "getError", "finish"]);
    expect(submission.fenceWaiting()).toBe(false);
    Reflect.deleteProperty(native, "_gl");
  });

  it("holds loading work until the fence is released", async () => {
    vi.useFakeTimers();
    const native = engine();
    const fake = fakeGl();
    Object.assign(native, { _gl: fake.gl });
    expect(presentationFencePending(native)).toBe(false);
    await expect(whenPresentationFenceClear(native)).resolves.toBe(0);
    const submission = submitPresentedFrame(native, () => {});
    expect(presentationFencePending(native)).toBe(true);
    let released = false;
    const cleared = whenPresentationFenceClear(native).then(() => { released = true; });
    await vi.advanceTimersByTimeAsync(40);
    expect(released).toBe(false);
    submission.cancel();
    await expect(submission.completed).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(10);
    await cleared;
    expect(presentationFencePending(native)).toBe(false);
    Reflect.deleteProperty(native, "_gl");
  });
});
