import type { EditCommand } from "./command";
import {
  AddEdgeCommand,
  AddNodeCommand,
  MoveNodeCommand,
  RemoveEdgeCommand,
  RemoveNodeCommand,
  SetNodeDataCommand,
  createAddEdgeCommandFromJson,
  createAddNodeCommandFromJson,
  createMoveNodeCommandFromJson,
  createRemoveEdgeCommandFromJson,
  createRemoveNodeCommandFromJson,
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
  createSetActorFlagsCommandFromJson,
  createSetActorTransformCommandFromJson,
  createSetComponentPropertyCommandFromJson,
  createSetSceneNameCommandFromJson,
  createSetSceneSettingCommandFromJson,
  createSetViewportModeCommandFromJson,
} from "./commands/scene";

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
    default: {
      if (command.type.startsWith("scene.")) {
        // Scene commands keep every payload field as an own property, so a
        // shallow copy is the full journal payload; revivers ignore the
        // derived mergeKey and byteSize fields.
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
}

registerGraphCommandRevivers();
registerSceneCommandRevivers();
