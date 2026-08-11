import {
  ClassRegistry,
  GameInstance,
  World,
  createWorldSnapshot,
  stringifyWorldSnapshot,
  type WorldSnapshot,
} from "@babylonslate/object-model";

export interface DeterministicScenarioOptions {
  seed: number;
  dt?: number;
  ticks: number;
  /**
   * Optional builder that mutates the world after GameInstance is set and
   * before ticks run (spawn actors, attach components, etc.).
   */
  setup?: (world: World) => void;
}

export interface DeterministicScenarioResult {
  snapshot: WorldSnapshot;
  snapshotText: string;
  world: World;
}

/**
 * Run an in-process deterministic world scenario (seeded RNG, fixed dt, N ticks).
 * Worker / SAB comparison is P4 — this path stays headless and in-process.
 */
export function runDeterministicScenario(
  options: DeterministicScenarioOptions,
): DeterministicScenarioResult {
  const dt = options.dt ?? 1 / 60;
  let guidSeq = 0;
  const registry = new ClassRegistry();
  registry.register({
    id: "Enemy",
    parentClassId: "Actor",
    kind: "actor",
    variables: [{ name: "speed", type: "float", defaultValue: 1 }],
    implementedInterfaces: [],
  });

  const world = new World({
    seed: options.seed,
    dt,
    classRegistry: registry,
    guidFactory: () => `h-${++guidSeq}`,
  });

  world.setGameInstance(
    new GameInstance({
      classId: "GameInstance",
      guid: "harness-gi",
      variables: { ticks: 0, acc: 0 },
      hooks: {
        onTick: (self, ctx) => {
          self.setVariable("ticks", Number(self.getVariable("ticks")) + 1);
          self.setVariable(
            "acc",
            Number(self.getVariable("acc")) + ctx.world.rngNextFloat(),
          );
        },
      },
    }),
  );

  if (options.setup) {
    options.setup(world);
  } else {
    defaultSetup(world);
  }

  world.start();
  for (let i = 0; i < options.ticks; i++) {
    world.tick();
  }

  const snapshot = createWorldSnapshot(world);
  return {
    snapshot,
    snapshotText: stringifyWorldSnapshot(snapshot),
    world,
  };
}

function defaultSetup(world: World): void {
  const actor = world.createActor({
    classId: "Enemy",
    variables: { speed: 1, n: 0 },
    hooks: {
      onTick: (self, ctx) => {
        const speed = Number(self.getVariable("speed") ?? 1);
        const bump = ctx.world.rngNextFloat() * speed;
        self.setVariable("n", Number(self.getVariable("n")) + bump);
        self.transform.position.x += bump;
        self.transform.position.y += bump * 0.5;
      },
    },
  });
  const mesh = world.createComponent({
    classId: "MeshComponent",
    assetGuid: "mesh-stub",
    variables: { frames: 0 },
    hooks: {
      onTick: (self) => {
        self.setVariable("frames", Number(self.getVariable("frames")) + 1);
      },
    },
  });
  actor.attachComponent(mesh);
  world.spawnActorNow(actor);

  const second = world.createActor({
    classId: "Actor",
    variables: { tag: "follower" },
    hooks: {
      onTick: (self, ctx) => {
        self.transform.position.z += ctx.world.rngNextFloat() * 0.1;
      },
    },
  });
  world.spawnActorNow(second);
}
