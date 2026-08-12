import { DEBUG_COMMAND_NAMES } from "./commands";
import { matchCommandName, tokenize } from "./parser";

export type ConsoleCommandDiagnostic = {
  severity: "warning";
  code: "console.debug_tier";
  message: string;
  assetGuid: string;
  graphId: string;
  nodeId: string;
};

export type ConsoleCommandGraph = {
  id: string;
  nodes: readonly {
    id: string;
    typeId: string;
    properties: Record<string, unknown>;
  }[];
};

/** Lint ExecuteConsoleCommand literals that name a debug-tier command. */
export function warnDebugTierConsoleCommands(
  graphs: readonly ConsoleCommandGraph[],
  ctx: { assetGuid: string },
): ConsoleCommandDiagnostic[] {
  const debugNames = new Set<string>(DEBUG_COMMAND_NAMES);
  const out: ConsoleCommandDiagnostic[] = [];
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (node.typeId !== "debug.executeConsoleCommand") continue;
      const raw = node.properties.command;
      if (typeof raw !== "string" || raw.trim() === "") continue;
      const { name } = matchCommandName(tokenize(raw), debugNames);
      if (!debugNames.has(name)) continue;
      out.push({
        severity: "warning",
        code: "console.debug_tier",
        message: `ExecuteConsoleCommand references debug-tier command '${name}', which is stripped from non-debug exports`,
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
        nodeId: node.id,
      });
    }
  }
  return out;
}
