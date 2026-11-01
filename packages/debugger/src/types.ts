import type { QualityGroup } from "@haptic/core";
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
  /** Last parameter only: also takes the remaining positional tokens, joined by spaces. */
  rest?: boolean;
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
  /** Returns false when no loaded scene matches the guid. */
  changeScene(sceneAssetGuid: string): boolean | void;
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
  /** `showocclusion`: overlay the occlusion buffer and what it culls. */
  setShowOcclusion?(enabled: boolean): void;
  /** `freezeocclusion`: keep testing against the occlusion the view last drew while the camera moves. */
  setFreezeOcclusion?(enabled: boolean): void;
  setPostProcessing?(enabled: boolean): void;
  setRenderTargetCaptures?(enabled: boolean): void;
  /** Start (restart) or stop measuring GPU-busy time per frame; the Play view's diagnostics report it. */
  setGpuBusyProbe?(enabled: boolean): void;
  /** How many rendered frames the Engine may queue on the GPU; "off" lifts the limit (`framesinflight`). */
  setFramesInFlight?(mode: "off" | 2 | 3): void;
  /** Store whether the next project Engine keeps its drawing buffer (applies after an editor reload). */
  setPreserveDrawingBuffer?(enabled: boolean): void;
  dumpActors?(): string;
  inspectActor?(query: string): string;
  possessActorCamera?(query: string): CommandResult;
  destroyActor?(query: string): CommandResult;
  pause?(): void;
  resume?(): void;
  step?(): void;
  setTimeDilation?(rate: number): void;
  getTimeDilation?(): number;
  /** `gc`: request an object collection pass at the end of the current tick. */
  collectGarbage?(): void;
  /** `gc stats`: the collectable object count and the last pass. */
  garbageStats?(): string;
  dumpLog?(): string;
  startSnapshot?(): void | CommandResult;
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
