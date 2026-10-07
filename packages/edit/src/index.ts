export type { EditCommand, StackEntry } from "./command";
export {
  DocumentEditStack,
  type ApplyResult,
  type DocumentEditStackOptions,
  type EditApplyResult,
  type HistoryAdmissionResult,
  type HistoryOutcome,
} from "./stack";
export { EditSession, DEFAULT_EDIT_BYTE_BUDGET } from "./session";
export {
  AddEdgeCommand,
  AddNodeCommand,
  MoveNodeCommand,
  RemoveEdgeCommand,
  RemoveNodeCommand,
  SetGraphMembersCommand,
  SetGraphComponentsCommand,
  SetGraphFunctionGraphsCommand,
  SetGraphActorDefaultsCommand,
  SetNodeDataCommand,
  createMoveNodeCommandFromJson,
  createAddEdgeCommandFromJson,
  createRemoveEdgeCommandFromJson,
  createSetNodeDataCommandFromJson,
  createAddNodeCommandFromJson,
  createRemoveNodeCommandFromJson,
  createSetGraphMembersCommandFromJson,
  createSetGraphComponentsCommandFromJson,
  createSetGraphFunctionGraphsCommandFromJson,
  createSetGraphActorDefaultsCommandFromJson,
} from "./commands/graph";
export { diffGraphCommands } from "./commands/graph-diff";
export {
  AddActorCommand,
  AddComponentCommand,
  RemoveActorCommand,
  RemoveComponentCommand,
  RenameActorCommand,
  ReorderActorCommand,
  ReorderComponentCommand,
  ReparentActorCommand,
  ReparentComponentCommand,
  SetActorFlagsCommand,
  SetActorTransformCommand,
  SetActorsTransformsCommand,
  SetComponentPropertyCommand,
  SetComponentLinkageCommand,
  SetComponentTransformCommand,
  SetSceneNameCommand,
  SetSceneSettingCommand,
  SetViewportModeCommand,
  AddFolderCommand,
  RemoveFolderCommand,
  RenameFolderCommand,
  ReparentFolderCommand,
  SetActorFolderCommand,
  SCENE_COMMAND_TYPES,
  type ActorFlags,
  type ActorTransformEntry,
  type SceneEditCommand,
} from "./commands/scene";
export { diffSceneCommands, planSceneChange } from "./commands/scene-diff";
export {
  ReorderFolderCommand,
  SetActorClassCommand,
  SetActorPropertiesCommand,
  SetComponentClassCommand,
  SetComponentTransformPresenceCommand,
  SetSceneOverlayEditorCommand,
} from "./commands/scene-fields";
export { ReplaceSceneCommand, createReplaceSceneCommandFromJson } from "./commands/replace-scene";
export { SetActorSuppressedComponentsCommand, SetComponentMaterialInstanceCommand } from "./commands/scene-instance";
export {
  type JournalLine,
  JOURNAL_REPATH_TYPE,
  JOURNAL_DISCARD_TYPE,
  JOURNAL_CHECKPOINT_TYPE,
  journalCheckpointLine,
  journalDiscardLine,
  journalRepathLine,
  parseJournalLine,
  registerCommandReviver,
  reviveCommand,
  serializeJournalLine,
  commandToJournalPayload,
  coalesceJournalLines,
  registerGraphCommandRevivers,
  registerSceneCommandRevivers,
  registerAssetDocumentCommandRevivers,
} from "./journal";
export {
  SetAssetDocumentCommand,
  createSetAssetDocumentCommandFromJson,
} from "./commands/asset-document";
export {
  replayJournalLines,
  resolveJournalLines,
  type JournalReplayResult,
  type ReplayableDocument,
} from "./journal-replay";
