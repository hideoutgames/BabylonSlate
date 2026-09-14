import type { AbstractEngine } from "@babylonjs/core";

type SubmissionDevice = {
  pushErrorScope: (filter: "validation" | "out-of-memory" | "internal") => void;
  popErrorScope: () => Promise<{ message: string } | null>;
  queue: { onSubmittedWorkDone: () => Promise<void> };
};

/** A single owner's synchronous draw; scopes never survive into another owner. */
export function submitPresentedFrame(engine: AbstractEngine, draw: () => void): {
  completed: Promise<void>;
  cancel: () => void;
} {
  const controller = new AbortController();
  // Pinned Babylon 9.20 owning-device boundary. NullEngine has neither device.
  const device = (engine as AbstractEngine & { _device?: SubmissionDevice })._device;
  const gl = (engine as AbstractEngine & { _gl?: WebGL2RenderingContext })._gl;
  if (!engine.isWebGPU && !gl) {
    draw();
    return { completed: Promise.resolve(), cancel: () => {} };
  }
  let work: Promise<void>;
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
      const results = await Promise.allSettled([...reports, device.queue.onSubmittedWorkDone()]);
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
    const previous = readErrors();
    if (previous.length) console.warn(`[render] Pre-existing WebGL errors before scene presentation: ${previous.join(", ")}`);
    draw();
    const errors = readErrors();
    if (errors.length) {
      const message = `Scene presentation WebGL errors: ${errors.join(", ")}`;
      console.warn(`[render] ${message}`);
      throw new Error(message);
    }
    if (gl?.fenceSync && gl.clientWaitSync) {
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!fence) throw new Error("The scene GPU completion fence could not be created.");
      try { gl.flush(); } catch (error) { gl.deleteSync(fence); throw error; }
      work = new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          controller.signal.removeEventListener("abort", abort);
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
            if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) finish();
            else timer = setTimeout(poll, 4);
          } catch (error) { finish(error); }
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        poll();
      });
    } else {
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
  return { completed, cancel: () => controller.abort(new Error("Scene presentation was cancelled.")) };
}
