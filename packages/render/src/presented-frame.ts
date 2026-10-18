import type { AbstractEngine } from "@babylonjs/core";

type SubmissionDevice = {
  pushErrorScope: (filter: "validation" | "out-of-memory" | "internal") => void;
  popErrorScope: () => Promise<{ message: string } | null>;
  queue: { onSubmittedWorkDone: () => Promise<void> };
};

type FenceClaim = {
  /** Errors another owner's signal-time read found while this fence was still outstanding. */
  errors: number[];
  signalled: boolean;
  open: boolean;
};

/** Fence waits in flight per WebGL context, oldest first. */
const awaitingFence = new WeakMap<object, FenceClaim[]>();

/**
 * True while a scene presentation fence of this engine's WebGL context is still
 * outstanding. Any synchronous WebGL call made meanwhile (an error read, a
 * program link-status or uniform-block query) waits for all queued commands,
 * including the driver's compile of the presented draw, so loading work that
 * could issue one defers until this is false.
 */
export function presentationFencePending(engine: AbstractEngine): boolean {
  const gl = (engine as AbstractEngine & { _gl?: object })._gl;
  return gl !== undefined && (awaitingFence.get(gl)?.length ?? 0) > 0;
}

/**
 * Resolves once no presentation fence of this engine is outstanding, ticking
 * `tick` (cancellation checks) while it waits; returns the milliseconds waited
 * so a caller can credit them to its own deadline. Resolves at once, without
 * waiting a task, when nothing is pending.
 */
export async function whenPresentationFenceClear(engine: AbstractEngine, tick: () => void = () => {}): Promise<number> {
  if (!presentationFencePending(engine)) return 0;
  const start = performance.now();
  while (presentationFencePending(engine)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 4));
    tick();
  }
  return performance.now() - start;
}

/**
 * Resolves once the GPU has finished the work submitted so far (WebGPU); other
 * Engines only submit pending work. Test hooks settle the GPU with it before a
 * screenshot.
 */
export async function whenSubmittedWorkDone(engine: AbstractEngine): Promise<void> {
  engine.flushFramebuffer();
  const device = (engine as AbstractEngine & { _device?: Partial<SubmissionDevice> })._device;
  if (engine.isWebGPU && device?.queue?.onSubmittedWorkDone) await device.queue.onSubmittedWorkDone();
}

export type PresentedFrame = {
  completed: Promise<void>;
  cancel: () => void;
  /** True while this submission's WebGL fence is outstanding; always false on other paths. */
  fenceWaiting: () => boolean;
};

export type PresentedFrameOptions = {
  /**
   * The caller's previous attempt left the WebGL error state cleared when its
   * fence signalled, so the pre-draw read (a synchronous round trip) is skipped.
   * Ignored without a fence: the WebGL1 path keeps its synchronous reads.
   */
  errorStateKnownClear?: boolean;
};

/** A single owner's synchronous draw; scopes never survive into another owner. */
export function submitPresentedFrame(engine: AbstractEngine, draw: () => void, options: PresentedFrameOptions = {}): PresentedFrame {
  const controller = new AbortController();
  // Pinned Babylon 9.29 owning-device boundary. NullEngine has neither device.
  const device = (engine as AbstractEngine & { _device?: SubmissionDevice })._device;
  const gl = (engine as AbstractEngine & { _gl?: WebGL2RenderingContext })._gl;
  if (!engine.isWebGPU && !gl) {
    draw();
    return { completed: Promise.resolve(), cancel: () => {}, fenceWaiting: () => false };
  }
  let work: Promise<void>;
  let fenceState: FenceClaim | undefined;
  if (engine.isWebGPU) {
    if (!device?.pushErrorScope || !device.popErrorScope || !device.queue?.onSubmittedWorkDone) {
      throw new Error("The WebGPU device cannot validate scene presentation.");
    }
    // Submit earlier shared-engine work outside our scopes. No global observer,
    // console interception, or delayed scope can attribute a sibling's error here.
    engine.flushFramebuffer();
    let scopes = 0;
    const failures: unknown[] = [];
    const reports: Array<Promise<{ message: string } | null>> = [];
    try {
      for (const filter of ["validation", "out-of-memory", "internal"] as const) {
        device.pushErrorScope(filter);
        scopes++;
      }
      draw();
    } catch (error) { failures.push(error); }
    finally {
      try { engine.flushFramebuffer(); } catch (error) { failures.push(error); }
      while (scopes-- > 0) {
        try { reports.push(device.popErrorScope()); }
        catch (error) { failures.push(error); }
      }
    }
    work = (async () => {
      const results = await Promise.allSettled([...reports, Promise.resolve().then(() => device.queue.onSubmittedWorkDone())]);
      const errors: unknown[] = [...failures];
      for (const result of results) {
        if (result.status === "rejected") errors.push(result.reason);
        else if (result.value) {
          // Error scopes consume uncaptured native warnings. Preserve their
          // diagnostic visibility while also rejecting this loading owner.
          console.warn(`[render] Scene presentation WebGPU error: ${result.value.message}`);
          errors.push(new Error(result.value.message));
        }
      }
      if (errors.length) throw new AggregateError(errors, "The scene GPU submission failed.", { cause: errors[0] });
    })();
  } else {
    const readErrors = () => {
      const errors: number[] = [];
      if (!gl?.getError) return errors;
      for (let count = 0; count < 16; count++) {
        const error = gl.getError();
        if (error === gl.NO_ERROR) return errors;
        errors.push(error);
        if (error === gl.CONTEXT_LOST_WEBGL) break;
      }
      throw new Error("The WebGL error state could not be cleared before scene presentation.");
    };
    // A WebGL status query is a synchronous round trip that waits for every
    // queued command. The driver compiles the draw's programs inside the draw's
    // submission (over 20 s cold on D3D11), so no query may sit between the draw
    // and its fence: the fence is created and flushed straight after the draw,
    // polled without blocking, and the sticky error state is read once it signals.
    const fenced = Boolean(gl?.fenceSync && gl.clientWaitSync);
    // The same holds for the read before the draw while an earlier fence of this
    // context is outstanding (another owner of the frame), or after an attempt
    // whose fence-time read already cleared the state.
    const claims = (fenced && gl && awaitingFence.get(gl)) || undefined;
    const previous = fenced && (options.errorStateKnownClear || claims?.length) ? [] : readErrors();
    if (previous.length) console.warn(`[render] Pre-existing WebGL errors before scene presentation: ${previous.join(", ")}`);
    draw();
    if (gl?.fenceSync && gl.clientWaitSync) {
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!fence) throw new Error("The scene GPU completion fence could not be created.");
      try { gl.flush(); } catch (error) { gl.deleteSync(fence); throw error; }
      const claim: FenceClaim = { errors: [], signalled: false, open: true };
      const outstanding = awaitingFence.get(gl) ?? [];
      outstanding.push(claim);
      awaitingFence.set(gl, outstanding);
      fenceState = claim;
      work = new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          claim.open = false;
          if (timer !== undefined) clearTimeout(timer);
          controller.signal.removeEventListener("abort", abort);
          outstanding.splice(outstanding.indexOf(claim), 1);
          try { gl.deleteSync(fence); } catch (cleanupError) { error = new AggregateError([error, cleanupError].filter((entry) => entry !== undefined), "Scene fence cleanup failed."); }
          if (error !== undefined) reject(error);
          else resolve();
        };
        const abort = () => finish(controller.signal.reason);
        const poll = () => {
          try {
            if (gl.isContextLost()) throw new Error("Rendering context was lost during scene presentation.");
            const status = gl.clientWaitSync(fence, 0, 0);
            if (status === gl.WAIT_FAILED) throw new Error("The scene GPU completion wait failed.");
            if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
              claim.signalled = true;
              // A fence queued after this one still has GPU work ahead of the read.
              if (outstanding.some((other) => !other.signalled)) { timer = setTimeout(poll, 4); return; }
              // The GPU is done with this draw, so the read no longer waits on it.
              const errors = [...claim.errors, ...readErrors()];
              if (errors.length) {
                // The read cannot tell which owner of a frame raised them: all still waiting share the fate.
                for (const other of outstanding) if (other !== claim) other.errors.push(...errors);
                const message = `Scene presentation WebGL errors: ${errors.join(", ")}`;
                console.warn(`[render] ${message}`);
                throw new Error(message);
              }
              finish();
            } else timer = setTimeout(poll, 4);
          } catch (error) { finish(error); }
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        poll();
      });
    } else {
      // No fence (WebGL1): finish() blocks until the draw completes anyway.
      const errors = readErrors();
      if (errors.length) {
        const message = `Scene presentation WebGL errors: ${errors.join(", ")}`;
        console.warn(`[render] ${message}`);
        throw new Error(message);
      }
      gl?.finish();
      work = Promise.resolve();
    }
  }
  // The caller owns the loading deadline. Cancellation releases polling work
  // immediately; WebGPU cannot cancel submitted work, so its promise is drained.
  const completed = new Promise<void>((resolve, reject) => {
    const abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
  });
  return { completed, cancel: () => controller.abort(new Error("Scene presentation was cancelled.")), fenceWaiting: () => fenceState?.open === true };
}
