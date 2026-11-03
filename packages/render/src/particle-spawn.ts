import {
  NodeParticleBlock,
  NodeParticleBlockConnectionPointTypes,
  Vector3,
  type NodeParticleBuildState,
  type NodeParticleConnectionPoint,
  type Particle,
  type ParticleSystem,
} from "@babylonjs/core";

/**
 * Where a Spawn Emitter's requests go: the world position and velocity of the particle that
 * fired, and the firing system's simulated seconds. The owner applies Limit and Min Interval;
 * the vectors are reused, so it copies what it keeps.
 */
export interface ParticleSpawnSink {
  fire(position: Vector3, velocity: Vector3, now: number): void;
}

type QueueItem = { process: (particle: Particle) => void; previousItem: QueueItem | null; nextItem: QueueItem | null };
/** Babylon 9.29 internals: the update queue and the system's simulated clock. */
type SpawnSystem = { _updateQueueStart: QueueItem | null; _actualFrame: number; isLocal: boolean };

/**
 * Spawn Emitter: an update-queue step, as Babylon's `ParticleTriggerBlock`, that fires while
 * Condition is not 0. Babylon's block clones a system with no Material binding or readiness
 * texture and spaces calls in wall-clock milliseconds; this one hands the particle's world
 * position and velocity, with the system's simulated time, to a `ParticleSpawnSink` instead.
 */
export class SlateSpawnBlock extends NodeParticleBlock {
  sink: ParticleSpawnSink | null = null;

  constructor(name: string) {
    super(name);
    this.registerInput("particle", NodeParticleBlockConnectionPointTypes.Particle);
    this.registerInput("condition", NodeParticleBlockConnectionPointTypes.Float, true, 0);
    this.registerOutput("output", NodeParticleBlockConnectionPointTypes.Particle);
  }

  override getClassName(): string {
    return "SlateSpawnBlock";
  }

  get particle(): NodeParticleConnectionPoint {
    return this._inputs[0]!;
  }

  get condition(): NodeParticleConnectionPoint {
    return this._inputs[1]!;
  }

  get output(): NodeParticleConnectionPoint {
    return this._outputs[0]!;
  }

  override _build(state: NodeParticleBuildState): void {
    const built = this.particle.getConnectedValue(state) as ParticleSystem;
    const system = built as unknown as SpawnSystem;
    const sink = this.sink;
    const position = new Vector3();
    const velocity = new Vector3();
    if (sink) {
      const item: QueueItem = {
        process: (particle) => {
          state.particleContext = particle;
          state.systemContext = built;
          if (Number(this.condition.getConnectedValue(state)) === 0) return;
          if (system.isLocal && state.emitterWorldMatrix) {
            Vector3.TransformCoordinatesToRef(particle.position, state.emitterWorldMatrix, position);
            Vector3.TransformNormalToRef(particle.direction, state.emitterWorldMatrix, velocity);
          } else {
            position.copyFrom(particle.position);
            velocity.copyFrom(particle.direction);
          }
          sink.fire(position, velocity, system._actualFrame);
        },
        previousItem: null,
        nextItem: null,
      };
      if (!system._updateQueueStart) system._updateQueueStart = item;
      else {
        let last = system._updateQueueStart;
        while (last.nextItem) last = last.nextItem;
        item.previousItem = last;
        last.nextItem = item;
      }
    }
    this.output._storedValue = built;
  }
}
