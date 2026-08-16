import type { EditCommand } from "./command";
import {
  AddEdgeCommand,
  AddNodeCommand,
  MoveNodeCommand,
  RemoveEdgeCommand,
  RemoveNodeCommand,
  SetGraphMembersCommand,
  SetGraphComponentsCommand,
  SetGraphFunctionGraphsCommand,
  SetNodeDataCommand,
  createAddEdgeCommandFromJson,
  createAddNodeCommandFromJson,
  createMoveNodeCommandFromJson,
  createRemoveEdgeCommandFromJson,
  createRemoveNodeCommandFromJson,
  createSetGraphMembersCommandFromJson,
  createSetGraphComponentsCommandFromJson,
  createSetGraphFunctionGraphsCommandFromJson,
  createSetNodeDataCommandFromJson,
} from "./commands/graph";
import {
  createAddActorCommandFromJson,
  createAddComponentCommandFromJson,
  createRemoveActorCommandFromJson,
  createRemoveComponentCommandFromJson,
  createRenameActorCommandFromJson,
  createReorderActorCommandFromJson,
  createReorderComponentCommandFromJson,
  createReparentActorCommandFromJson,
  createReparentComponentCommandFromJson,
  createSetActorFlagsCommandFromJson,
  createSetActorTransformCommandFromJson,
  createSetComponentPropertyCommandFromJson,
  createSetSceneNameCommandFromJson,
  createSetSceneSettingCommandFromJson,
  createSetViewportModeCommandFromJson,
  createAddFolderCommandFromJson,
  createRemoveFolderCommandFromJson,
  createRenameFolderCommandFromJson,
  createReparentFolderCommandFromJson,
  createSetActorFolderCommandFromJson,
} from "./commands/scene";
import {
  createSetAssetDocumentCommandFromJson,
} from "./commands/asset-document";

export interface JournalLine {
  v: 1;
  docId: string;
  at: string;
  command: { type: string; [key: string]: unknown };
}

export type CommandReviver = (
  payload: Record<string, unknown>,
) => EditCommand<unknown>;

const commandRevivers = new Map<string, CommandReviver>();

export function registerCommandReviver(
  type: string,
  reviver: CommandReviver,
): void {
  commandRevivers.set(type, reviver);
}

export function reviveCommand(
  payload: { type: string; [key: string]: unknown },
): EditCommand<unknown> | null {
  const reviver = commandRevivers.get(payload.type);
  if (!reviver) {
    return null;
  }
  return reviver(payload);
}

export function serializeJournalLine(line: JournalLine): string {
  return JSON.stringify(line);
}

export function parseJournalLine(line: string): JournalLine {
  const parsed: unknown = JSON.parse(line);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("v" in parsed) ||
    parsed.v !== 1 ||
    !("docId" in parsed) ||
    typeof parsed.docId !== "string" ||
    !("at" in parsed) ||
    typeof parsed.at !== "string" ||
    !("command" in parsed) ||
    typeof parsed.command !== "object" ||
    parsed.command === null ||
    !("type" in parsed.command) ||
    typeof parsed.command.type !== "string"
  ) {
    throw new Error("Invalid journal line");
  }

  return parsed as JournalLine;
}

export function commandToJournalPayload(
  command: EditCommand<unknown>,
): { type: string; [key: string]: unknown } {
  switch (command.type) {
    case "graph.moveNode": {
      const move = command as MoveNodeCommand;
      return {
        type: move.type,
        nodeId: move.nodeId,
        from: move.from,
        to: move.to,
      };
    }
    case "graph.addEdge": {
      const add = command as AddEdgeCommand;
      return {
        type: add.type,
        edge: add.edge,
      };
    }
    case "graph.removeEdge": {
      const remove = command as RemoveEdgeCommand;
      return {
        type: remove.type,
        edge: remove.edge,
      };
    }
    case "graph.setNodeData": {
      const setData = command as SetNodeDataCommand;
      return {
        type: setData.type,
        nodeId: setData.nodeId,
        from: setData.from,
        to: setData.to,
        mergeKey: setData.mergeKey,
      };
    }
    case "graph.addNode": {
      const add = command as AddNodeCommand;
      return {
        type: add.type,
        node: add.node,
      };
    }
    case "graph.removeNode": {
      const remove = command as RemoveNodeCommand;
      return {
        type: remove.type,
        node: remove.node,
      };
    }
    case "graph.setMembers": {
      const members = command as SetGraphMembersCommand;
      return {
        type: members.type,
        from: members.from,
        to: members.to,
      };
    }
    case "graph.setComponents": {
      const components = command as SetGraphComponentsCommand;
      return {
        type: components.type,
        from: components.from,
        to: components.to,
      };
    }
    case "graph.setFunctionGraphs": {
      const functionGraphs = command as SetGraphFunctionGraphsCommand;
      return {
        type: functionGraphs.type,
        from: functionGraphs.from,
        to: functionGraphs.to,
      };
    }
    default: {
      if (
        command.type.startsWith("scene.") ||
        command.type.startsWith("asset.")
      ) {
        return { ...(command as object) } as { type: string };
      }
      return { type: command.type };
    }
  }
}

/** @deprecated Prefer commandToJournalPayload */
export const serializeCommand = commandToJournalPayload;

export function reviveGraphCommand(
  payload: Record<string, unknown> & { type: string },
): EditCommand<unknown> {
  const revived = reviveCommand(payload);
  if (!revived) {
    throw new Error(`Unknown journal command type: ${payload.type}`);
  }
  return revived;
}

export function registerGraphCommandRevivers(): void {
  registerCommandReviver("graph.moveNode", createMoveNodeCommandFromJson);
  registerCommandReviver("graph.addEdge", createAddEdgeCommandFromJson);
  registerCommandReviver("graph.removeEdge", createRemoveEdgeCommandFromJson);
  registerCommandReviver("graph.setNodeData", createSetNodeDataCommandFromJson);
  registerCommandReviver("graph.addNode", createAddNodeCommandFromJson);
  registerCommandReviver("graph.removeNode", createRemoveNodeCommandFromJson);
  registerCommandReviver(
    "graph.setMembers",
    createSetGraphMembersCommandFromJson,
  );
  registerCommandReviver(
    "graph.setComponents",
    createSetGraphComponentsCommandFromJson,
  );
  registerCommandReviver(
    "graph.setFunctionGraphs",
    createSetGraphFunctionGraphsCommandFromJson,
  );
}

export function registerSceneCommandRevivers(): void {
  registerCommandReviver("scene.addActor", createAddActorCommandFromJson);
  registerCommandReviver("scene.removeActor", createRemoveActorCommandFromJson);
  registerCommandReviver(
    "scene.setActorTransform",
    createSetActorTransformCommandFromJson,
  );
  registerCommandReviver("scene.renameActor", createRenameActorCommandFromJson);
  registerCommandReviver(
    "scene.reparentActor",
    createReparentActorCommandFromJson,
  );
  registerCommandReviver(
    "scene.reorderActor",
    createReorderActorCommandFromJson,
  );
  registerCommandReviver(
    "scene.setActorFlags",
    createSetActorFlagsCommandFromJson,
  );
  registerCommandReviver(
    "scene.addComponent",
    createAddComponentCommandFromJson,
  );
  registerCommandReviver(
    "scene.removeComponent",
    createRemoveComponentCommandFromJson,
  );
  registerCommandReviver(
    "scene.reorderComponent",
    createReorderComponentCommandFromJson,
  );
  registerCommandReviver(
    "scene.reparentComponent",
    createReparentComponentCommandFromJson,
  );
  registerCommandReviver(
    "scene.setComponentProperty",
    createSetComponentPropertyCommandFromJson,
  );
  registerCommandReviver(
    "scene.setSceneSetting",
    createSetSceneSettingCommandFromJson,
  );
  registerCommandReviver(
    "scene.setViewportMode",
    createSetViewportModeCommandFromJson,
  );
  registerCommandReviver(
    "scene.setSceneName",
    createSetSceneNameCommandFromJson,
  );
  registerCommandReviver("scene.addFolder", createAddFolderCommandFromJson);
  registerCommandReviver(
    "scene.removeFolder",
    createRemoveFolderCommandFromJson,
  );
  registerCommandReviver(
    "scene.renameFolder",
    createRenameFolderCommandFromJson,
  );
  registerCommandReviver(
    "scene.reparentFolder",
    createReparentFolderCommandFromJson,
  );
  registerCommandReviver(
    "scene.setActorFolder",
    createSetActorFolderCommandFromJson,
  );
}

export function registerAssetDocumentCommandRevivers(): void {
  registerCommandReviver(
    "asset.setDocument",
    createSetAssetDocumentCommandFromJson,
  );
}

registerGraphCommandRevivers();
registerSceneCommandRevivers();
registerAssetDocumentCommandRevivers();
