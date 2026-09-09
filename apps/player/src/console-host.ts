import type { CommandMessage, ControlMessage } from "@babylonslate/bridge";

type Result = { success: boolean; output: string };

/** The worker console replies in control-channel order, including while paused. */
export function createPlayerConsoleHost(options: {
  execute: () => ((line: string) => Result) | undefined;
  post: (command: ControlMessage) => void;
}) {
  const pending: Array<(result: Result) => void> = [];
  let stopped = false;
  return {
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
    receive(command: Pick<CommandMessage, "type"> & Record<string, unknown>) {
      if (command.type === "consoleResult")
        pending.shift()?.({
          success: command.success === true,
          output: String(command.output ?? ""),
        });
    },
    dispose() {
      stopped = true;
      for (const resolve of pending.splice(0))
        resolve({ success: false, output: "Play session stopped" });
    },
  };
}
