import type { EditCommand } from "./command";
import { CommandBatch } from "./session";
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
  createSetActorsTransformsCommandFromJson,
  createSetComponentPropertyCommandFromJson,
  createSetComponentLinkageCommandFromJson,
  createSetComponentTransformCommandFromJson,
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
import { createReplaceSceneCommandFromJson } from "./commands/replace-scene";
import { createSetActorSuppressedComponentsCommandFromJson, createSetComponentMaterialInstanceCommandFromJson } from "./commands/scene-instance";
import {
  createReorderFolderCommandFromJson,
  createSetActorClassCommandFromJson,
  createSetActorPropertiesCommandFromJson,
  createSetComponentClassCommandFromJson,
  createSetComponentTransformPresenceCommandFromJson,
  createSetSceneOverlayEditorCommandFromJson,
} from "./commands/scene-fields";

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
  if (payload.type === JOURNAL_CHECKPOINT_TYPE && payload.content && typeof payload.content === "object") {
    return createSetAssetDocumentCommandFromJson({ from: {}, to: payload.content });
  }
  if (payload.type === "edit.batch") {
    if (!Array.isArray(payload.commands)) return null;
    const commands: EditCommand<unknown>[] = [];
    for (const child of payload.commands) {
      if (!child || typeof child !== "object" || typeof child.type !== "string") return null;
      const command = reviveCommand(child);
      if (!command) return null;
      commands.push(command);
    }
    return new CommandBatch(commands);
  }
  const reviver = commandRevivers.get(payload.type);
  if (!reviver) {
    return null;
  }
  return reviver(payload);
}

/**
 * Journal-only marker, not an `EditCommand`: an open document moved from
 * `command.from` to `docId`. Replay gives the earlier lines under `from` to the
 * renamed document, so its unsaved edits and a later Undo replay together.
 */
export const JOURNAL_REPATH_TYPE = "document.repath";
export const JOURNAL_DISCARD_TYPE = "document.discard";
export const JOURNAL_CHECKPOINT_TYPE = "document.checkpoint";

/** One recoverable snapshot superseding every earlier edit to this document. */
export function journalCheckpointLine(docId: string, content: unknown, at: string): JournalLine {
  return { v: 1, docId, at, command: { type: JOURNAL_CHECKPOINT_TYPE, content } };
}

/** Ends recovery for earlier edits to this document, without clearing others. */
export function journalDiscardLine(docId: string, at: string): JournalLine {
  return { v: 1, docId, at, command: { type: JOURNAL_DISCARD_TYPE } };
}

export function journalRepathLine(
  oldId: string,
  newId: string,
  at: string,
): JournalLine {
  return { v: 1, docId: newId, at, command: { type: JOURNAL_REPATH_TYPE, from: oldId } };
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
    case "edit.batch":
      return {
        type: command.type,
        commands: (command as CommandBatch<unknown>).commands.map(commandToJournalPayload),
      };
    case "graph.moveNode": {
      const move = command as MoveNodeCommand;
      return {
        type: move.type,
        nodeId: move.nodeId,
        from: move.from,
        to: move.to,
        mergeKey: move.mergeKey,
      };
    }
    case "graph.addEdge": {
      const add = command as AddEdgeCommand;
      return {
        type: add.type,
        edge: add.edge,
        index: add.index,
      };
    }
    case "graph.removeEdge": {
      const remove = command as RemoveEdgeCommand;
      return {
        type: remove.type,
        edge: remove.edge,
        index: remove.index,
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
        index: add.index,
      };
    }
    case "graph.removeNode": {
      const remove = command as RemoveNodeCommand;
      return {
        type: remove.type,
        node: remove.node,
        index: remove.index,
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
        // Undo bookkeeping is not target identity; snapshot sizes vary during a scrub.
        const { byteSize: _byteSize, ...payload } = command;
        void _byteSize;
        return payload;
      }
      return { type: command.type };
    }
  }
}

/**
 * Commands whose `apply` writes only `to` onto the target named by their other
 * payload fields, so a later record for the same target supersedes an earlier one.
 */
const SUPERSEDING_COMMAND_TYPES = new Set([
  "asset.setDocument",
  "graph.moveNode",
  "graph.setNodeData",
  "scene.setActorTransform",
  "scene.setActorProperties",
  "scene.setComponentProperty",
  "scene.setComponentTransform",
  "scene.setSceneSetting",
  "scene.renameActor",
  "scene.renameFolder",
]);

/**
 * Fold two consecutive journal records of one continuous gesture (same
 * document, command type, merge key and target) into one record carrying the
 * first `from` and the last `to`. Replay applies only `to` for these commands,
 * so recovering the folded record gives the same document as recovering both.
 * Returns null when the records must stay separate.
 */
export function coalesceJournalLines(
  previous: JournalLine,
  next: JournalLine,
): JournalLine | null {
  const earlier = previous.command;
  const later = next.command;
  if (
    previous.v !== next.v ||
    previous.docId !== next.docId ||
    earlier.type !== later.type ||
    !SUPERSEDING_COMMAND_TYPES.has(later.type) ||
    typeof later.mergeKey !== "string" ||
    later.mergeKey.length === 0
  ) {
    return null;
  }
  const { from, to: _earlierTo, ...earlierTarget } = earlier;
  const { from: _laterFrom, to: _laterTo, ...laterTarget } = later;
  void _earlierTo;
  void _laterFrom;
  void _laterTo;
  if (JSON.stringify(earlierTarget) !== JSON.stringify(laterTarget)) return null;
  return { ...next, command: { ...later, from } };
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
  registerCommandReviver("scene.setActorSuppressedComponents", createSetActorSuppressedComponentsCommandFromJson);
  registerCommandReviver("scene.setComponentMaterialInstance", createSetComponentMaterialInstanceCommandFromJson);
  registerCommandReviver("scene.setActorProperties", createSetActorPropertiesCommandFromJson);
  registerCommandReviver("scene.setActorClass", createSetActorClassCommandFromJson);
  registerCommandReviver("scene.setComponentClass", createSetComponentClassCommandFromJson);
  registerCommandReviver("scene.setComponentTransformPresence", createSetComponentTransformPresenceCommandFromJson);
  registerCommandReviver("scene.reorderFolder", createReorderFolderCommandFromJson);
  registerCommandReviver("scene.setOverlayEditor", createSetSceneOverlayEditorCommandFromJson);
  registerCommandReviver("scene.replace", createReplaceSceneCommandFromJson);
  registerCommandReviver("scene.setComponentLinkage", createSetComponentLinkageCommandFromJson);
  registerCommandReviver("scene.addActor", createAddActorCommandFromJson);
  registerCommandReviver("scene.removeActor", createRemoveActorCommandFromJson);
  registerCommandReviver(
    "scene.setActorTransform",
    createSetActorTransformCommandFromJson,
  );
  registerCommandReviver(
    "scene.setActorsTransforms",
    createSetActorsTransformsCommandFromJson,
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
    "scene.setComponentTransform",
    createSetComponentTransformCommandFromJson,
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
