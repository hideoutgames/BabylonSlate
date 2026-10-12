import type { ControlMessage } from "@babylonslate/bridge";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";

type Result = { success: boolean; output: string };

/** The worker console replies in control-channel order, including while paused. */
export function createPlayerConsoleHost(options: {
  execute: () => ((line: string) => Result | Promise<Result>) | undefined;
  inspect?: () => (() => DebugInspectSnapshot) | undefined;
  post: (command: ControlMessage) => void;
  /** An unanswered worker inspection rejects after this long; the next one asks again. */
  inspectTimeoutMs?: number;
}) {
  const pending: Array<(result: Result) => void> = [];
  let inspection: {
    promise: Promise<DebugInspectSnapshot>;
    resolve: (snapshot: DebugInspectSnapshot) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let stopped = false;
  return {
    inspectWorld(): Promise<DebugInspectSnapshot> {
      if (stopped) return Promise.resolve({ tickIndex: 0, nodes: [] });
      const inspect = options.inspect?.();
      // A failed inspection is not an empty world; callers keep what they had.
      if (inspect) {
        try {
          return Promise.resolve(inspect());
        } catch (error) {
          return Promise.reject(error);
        }
      }
      if (inspection) return inspection.promise;
      let resolve!: (snapshot: DebugInspectSnapshot) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<DebugInspectSnapshot>((complete, fail) => {
        resolve = complete;
        reject = fail;
      });
      const timer = setTimeout(() => {
        if (inspection?.promise !== promise) return;
        inspection = null;
        reject(new Error("The game worker did not answer the inspection."));
      }, options.inspectTimeoutMs ?? 3000);
      inspection = { promise, resolve, timer };
      try {
        options.post({ type: "inspect" });
      } catch (error) {
        clearTimeout(timer);
        inspection = null;
        return Promise.reject(error);
      }
      return promise;
    },
    execute(line: string): Promise<Result> {
      if (stopped)
        return Promise.resolve({
          success: false,
          output: "Play session stopped",
        });
      const execute = options.execute();
      if (execute) {
        try {
          return Promise.resolve(execute(line)).catch(error => ({ success: false, output: String(error) }));
        } catch (error) {
          return Promise.resolve({ success: false, output: String(error) });
        }
      }
      return new Promise((resolve) => {
        pending.push(resolve);
        options.post({ type: "console", line });
      });
    },
    receive(command: { type: string } & Record<string, unknown>) {
      if (command.type === "inspectSnapshot" && inspection) {
        const request = inspection;
        inspection = null;
        clearTimeout(request.timer);
        request.resolve(command.snapshot as DebugInspectSnapshot);
      }
      if (command.type === "consoleResult")
        pending.shift()?.({
          success: command.success === true,
          output: String(command.output ?? ""),
        });
    },
    dispose() {
      stopped = true;
      if (inspection) clearTimeout(inspection.timer);
      inspection?.resolve({ tickIndex: 0, nodes: [] });
      inspection = null;
      for (const resolve of pending.splice(0))
        resolve({ success: false, output: "Play session stopped" });
    },
  };
}
