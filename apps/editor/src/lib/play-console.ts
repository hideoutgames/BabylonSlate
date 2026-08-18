import {
  createCommandRegistry,
  createUserCommand,
  type ConsoleCompletionContext,
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

function pushUnique(target: string[], value: string | undefined): void {
  const next = value?.trim();
  if (!next) return;
  if (target.some((entry) => entry.toLowerCase() === next.toLowerCase())) {
    return;
  }
  target.push(next);
}

export function playConsoleCompletionContext(options: {
  commands: readonly RegisteredCommand[];
  sceneAssetGuid?: string;
  scene?: { name?: string };
  scenes?: ReadonlyArray<{ guid: string; scene: { name?: string } }>;
  inspectNodes?: ReadonlyArray<{
    kind: string;
    label: string;
    id: string;
  }>;
}): ConsoleCompletionContext {
  const sceneNames: string[] = [];
  pushUnique(sceneNames, options.scene?.name);
  pushUnique(sceneNames, options.sceneAssetGuid);
  for (const entry of options.scenes ?? []) {
    pushUnique(sceneNames, entry.scene.name);
    pushUnique(sceneNames, entry.guid);
  }
  const actors: string[] = [];
  for (const node of options.inspectNodes ?? []) {
    if (node.kind !== "actor") continue;
    pushUnique(actors, node.label);
    pushUnique(actors, node.id);
  }
  return {
    scenes: sceneNames,
    actors,
    commands: options.commands.map((command) => command.name),
  };
}

