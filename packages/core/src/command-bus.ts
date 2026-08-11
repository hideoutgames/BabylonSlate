export type EngineCommand =
  | { type: "log"; message: string }
  | { type: "resize"; width: number; height: number };

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
