import type { ControlMessage } from "@babylonslate/bridge";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";

type Result = { success: boolean; output: string };

/** The worker console replies in control-channel order, including while paused. */
export function createPlayerConsoleHost(options: {
  execute: () => ((line: string) => Result) | undefined;
  inspect?: () => (() => DebugInspectSnapshot) | undefined;
  post: (command: ControlMessage) => void;
}) {
  const pending: Array<(result: Result) => void> = [];
  let inspection: {
    promise: Promise<DebugInspectSnapshot>;
    resolve: (snapshot: DebugInspectSnapshot) => void;
  } | null = null;
  let stopped = false;
  return {
    inspectWorld(): Promise<DebugInspectSnapshot> {
      if (stopped) return Promise.resolve({ tickIndex: 0, nodes: [] });
      const inspect = options.inspect?.();
      if (inspect) {
        try {
          return Promise.resolve(inspect());
        } catch {
          return Promise.resolve({ tickIndex: 0, nodes: [] });
        }
      }
      if (inspection) return inspection.promise;
      let resolve!: (snapshot: DebugInspectSnapshot) => void;
      const promise = new Promise<DebugInspectSnapshot>((complete) => {
        resolve = complete;
      });
      inspection = { promise, resolve };
      options.post({ type: "inspect" });
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
          return Promise.resolve(execute(line));
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
      inspection?.resolve({ tickIndex: 0, nodes: [] });
      inspection = null;
      for (const resolve of pending.splice(0))
        resolve({ success: false, output: "Play session stopped" });
    },
  };
}
