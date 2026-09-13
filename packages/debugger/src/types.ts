import type { QualityGroup } from "@babylonslate/core";
export type CommandTier = "core" | "debug";

export type CommandParamType = "string" | "float" | "int" | "bool" | "enum";

export type ConsoleCompleteKind = "scenes" | "actors" | "commands";

export type CommandParameter = {
  name: string;
  type: CommandParamType;
  optional?: boolean;
  defaultValue?: unknown;
  enumValues?: readonly string[];
  complete?: ConsoleCompleteKind;
};

export type ConsoleCompletionContext = {
  scenes?: readonly string[];
  actors?: readonly string[];
  commands?: readonly string[];
};

export type CommandResult = {
  success: boolean;
  output: string;
};

export type ConsoleCommandHost = {
  changeScene(sceneAssetGuid: string): void;
  quality(group?: QualityGroup, choice?: string, value?: string): CommandResult;
  setFrameCap(fps: number): void;
  setVolume(volume: number): void;
  getFrameCap?(): number;
  getVolume?(): number;
  quit(): void;
  setShowFps?(enabled: boolean): void;
  setStat?(name: string, enabled: boolean): void;
  setShowCollision?(enabled: boolean): void;
  setShowBounds?(enabled: boolean): void;
  setWireframe?(enabled: boolean): void;
  setFreeCam?(enabled: boolean): void;
  setShowNav?(enabled: boolean): void;
  setShowPathfinding?(enabled: boolean): void;
  setShowNavAgent?(enabled: boolean): void;
  setBehaviourTreeDebug?(enabled: boolean): void;
  setShowAudioDebug?(enabled: boolean): void;
  setLightsDebug?(enabled: boolean): void;
  dumpActors?(): string;
  inspectActor?(query: string): string;
  possessActorCamera?(query: string): CommandResult;
  destroyActor?(query: string): CommandResult;
  getInspectSelection?(): string | null;
  pause?(): void;
  resume?(): void;
  step?(): void;
  setTimeDilation?(rate: number): void;
  getTimeDilation?(): number;
  dumpLog?(): string;
  startSnapshot?(): void;
  stopSnapshot?(): void;
};

export type RegisteredCommand = {
  name: string;
  tier: CommandTier;
  description: string;
  category?: string;
  parameters: readonly CommandParameter[];
  run(args: Record<string, unknown>, host: ConsoleCommandHost): CommandResult;
};

export type CommandRegistry = {
  register(command: RegisteredCommand): void;
  get(name: string): RegisteredCommand | undefined;
  list(): readonly RegisteredCommand[];
  execute(line: string, host: ConsoleCommandHost): CommandResult;
};
