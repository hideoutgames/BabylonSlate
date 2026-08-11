import {
  identityTransform,
  newGuid,
  type Guid,
  type GuidFactory,
  type Transform,
} from "@babylonslate/core";

export type TickContext = {
  dt: number;
  tickIndex: number;
  world: WorldLike;
};

export interface WorldLike {
  rngNextFloat(): number;
}

export type LifecycleHooks<T extends BObject = BObject> = {
  onCreation?: (self: T) => void;
  onTick?: (self: T, ctx: TickContext) => void;
  onDestroyed?: (self: T) => void;
};

export class BObject {
  readonly guid: Guid;
  readonly classId: string;
  readonly variables: Map<string, unknown>;
  implementedInterfaces: string[] = [];
  interfaceHandlers = new Map<
    string,
    (args: Record<string, unknown>) => Record<string, unknown>
  >();
  private readonly hooks: LifecycleHooks;
  destroyed = false;

  constructor(options: {
    classId: string;
    guid?: Guid;
    guidFactory?: GuidFactory;
    variables?: Record<string, unknown>;
    hooks?: LifecycleHooks;
    implementedInterfaces?: string[];
  }) {
    this.guid = options.guid ?? newGuid(options.guidFactory);
    this.classId = options.classId;
    this.variables = new Map(Object.entries(options.variables ?? {}));
    this.hooks = options.hooks ?? {};
    this.implementedInterfaces = [...(options.implementedInterfaces ?? [])];
  }

  callOnCreation(): void {
    this.hooks.onCreation?.(this);
  }

  callOnTick(ctx: TickContext): void {
    if (this.destroyed) return;
    this.hooks.onTick?.(this, ctx);
  }

  callOnDestroyed(): void {
    this.hooks.onDestroyed?.(this);
  }

  getVariable(name: string): unknown {
    return this.variables.get(name);
  }

  setVariable(name: string, value: unknown): void {
    this.variables.set(name, value);
  }
}

export class Actor extends BObject {
  transform: Transform;
  readonly components: ActorComponent[] = [];
  world: WorldLike | null = null;
  /** Stable spawn index assigned by World. */
  spawnIndex = -1;

  constructor(
    options: {
      classId: string;
      guid?: Guid;
      guidFactory?: GuidFactory;
      variables?: Record<string, unknown>;
      hooks?: LifecycleHooks<Actor>;
      implementedInterfaces?: string[];
      transform?: Transform;
    },
  ) {
    super({
      ...options,
      hooks: options.hooks as LifecycleHooks | undefined,
    });
    this.transform = options.transform
      ? {
          position: { ...options.transform.position },
          rotation: { ...options.transform.rotation },
          scale: { ...options.transform.scale },
        }
      : identityTransform();
  }

  attachComponent(component: ActorComponent): void {
    if (component.owner) {
      throw new Error(`component ${component.guid} already attached`);
    }
    component.owner = this;
    this.components.push(component);
    component.callOnCreation();
  }
}

export class ActorComponent extends BObject {
  owner: Actor | null = null;
  /** Optional asset reference stub for engine components. */
  assetGuid: Guid | null = null;

  constructor(
    options: {
      classId: string;
      guid?: Guid;
      guidFactory?: GuidFactory;
      variables?: Record<string, unknown>;
      hooks?: LifecycleHooks<ActorComponent>;
      implementedInterfaces?: string[];
      assetGuid?: Guid | null;
    },
  ) {
    super({
      ...options,
      hooks: options.hooks as LifecycleHooks | undefined,
    });
    this.assetGuid = options.assetGuid ?? null;
  }
}

export type GameInstanceHooks = LifecycleHooks<GameInstance> & {
  onGameStart?: (self: GameInstance) => void;
  onGameEnd?: (self: GameInstance) => void;
  onSceneLoaded?: (self: GameInstance, sceneName: string) => void;
};

export class GameInstance extends BObject {
  private readonly gameHooks: GameInstanceHooks;

  constructor(
    options: {
      classId: string;
      guid?: Guid;
      guidFactory?: GuidFactory;
      variables?: Record<string, unknown>;
      hooks?: GameInstanceHooks;
      implementedInterfaces?: string[];
    },
  ) {
    super({
      ...options,
      hooks: options.hooks as LifecycleHooks | undefined,
    });
    this.gameHooks = options.hooks ?? {};
  }

  callOnGameStart(): void {
    this.gameHooks.onGameStart?.(this);
  }

  callOnGameEnd(): void {
    this.gameHooks.onGameEnd?.(this);
  }

  callOnSceneLoaded(sceneName: string): void {
    this.gameHooks.onSceneLoaded?.(this, sceneName);
  }
}
