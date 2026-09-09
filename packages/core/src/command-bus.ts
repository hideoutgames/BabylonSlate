import type { SerializedTransform } from "./scene";

export const DEFAULT_EDITOR_DROP_DISTANCE = 10_000;

export interface EditorActorTransform extends SerializedTransform {
  actorId: string;
}

export type EngineCommand =
  | { type: "log"; message: string }
  | { type: "resize"; width: number; height: number }
  | {
      type: "editor.drop";
      viewportId: string;
      requestId: string;
      actorIds: readonly string[];
      maxDistance?: number;
    }
  | {
      type: "editor.drop.result";
      viewportId: string;
      requestId: string;
      transforms: readonly EditorActorTransform[];
    };

export type CommandHandler = (command: EngineCommand) => void;

export class CommandBus {
  private handlers = new Set<CommandHandler>();

  subscribe(handler: CommandHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  dispatch(command: EngineCommand): void {
    this.handlers.forEach((handler) => handler(command));
  }
}

export const engineCommandBus = new CommandBus();

let nextDropRequestId = 0;

/** Query the owning editor viewport synchronously without mutating its scene. */
export function requestEditorDrop(
  viewportId: string,
  actorIds: readonly string[],
  maxDistance = DEFAULT_EDITOR_DROP_DISTANCE,
): readonly EditorActorTransform[] {
  if (actorIds.length === 0) return [];
  const requestId = String(++nextDropRequestId);
  let transforms: readonly EditorActorTransform[] = [];
  const unsubscribe = engineCommandBus.subscribe((command) => {
    if (
      command.type === "editor.drop.result" &&
      command.viewportId === viewportId &&
      command.requestId === requestId
    ) {
      transforms = command.transforms;
    }
  });
  try {
    engineCommandBus.dispatch({ type: "editor.drop", viewportId, requestId, actorIds, maxDistance });
    return transforms;
  } finally {
    unsubscribe();
  }
}
