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
  setRenderQuality(level: string): void;
  setShadowQuality(level: string): void;
  setResolutionScale(scale: number): void;
  setFrameCap(fps: number): void;
  setVolume(volume: number): void;
  getRenderQuality?(): string;
  getShadowQuality?(): string;
  getResolutionScale?(): number;
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
  setShowAudioDebug?(enabled: boolean): void;
  dumpActors?(): string;
  inspectActor?(query: string): string;
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
