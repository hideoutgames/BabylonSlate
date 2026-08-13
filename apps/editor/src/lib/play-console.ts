import {
  createCommandRegistry,
  createUserCommand,
  type RegisteredCommand,
} from "@babylonslate/debugger";
import type { ScriptBundleEntry } from "@babylonslate/bridge";

/** Built-in registry plus user commands compiled from OnCommandRun graphs. */
export function playConsoleCommands(
  scripts: readonly ScriptBundleEntry[] = [],
): RegisteredCommand[] {
  const registry = createCommandRegistry({ includeDebug: true });
  for (const script of scripts) {
    if (!script.command) continue;
    registry.register(
      createUserCommand({
        ...script.command,
        run: () => ({ success: true, output: "" }),
      }),
    );
  }
  return [...registry.list()];
}
