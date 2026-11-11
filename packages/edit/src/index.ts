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
  SetNodeDataCommand,
} from "./commands/graph";
export { diffGraphCommands, graphEditMergeKey } from "./commands/graph-diff";
export {
  RemoveActorCommand,
  SetActorTransformCommand,
  SetActorsTransformsCommand,
  SetSceneNameCommand,
  SetViewportModeCommand,
  SCENE_COMMAND_TYPES,
  type ActorFlags,
  type ActorTransformEntry,
  type SceneEditCommand,
} from "./commands/scene";
export { diffSceneCommands, planSceneChange } from "./commands/scene-diff";
export { ReplaceSceneCommand } from "./commands/replace-scene";
export {
  type JournalLine,
  JOURNAL_CHECKPOINT_TYPE,
  journalCheckpointLine,
  journalDiscardLine,
  journalRepathLine,
  parseJournalLine,
  reviveCommand,
  serializeJournalLine,
  commandToJournalPayload,
  coalesceJournalLines,
} from "./journal";
export {
  SetAssetDocumentCommand,
} from "./commands/asset-document";
export {
  PatchTilemapDocumentCommand,
  diffTilemapDocument,
  type TilemapChunkPatch,
  type TilemapDocumentDelta,
} from "./commands/tilemap-document";
export {
  replayJournalLines,
  resolveJournalLines,
  type JournalReplayResult,
  type ReplayableDocument,
} from "./journal-replay";
