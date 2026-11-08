import type { CommandMessage } from "@haptic/bridge";
import { Actor, ActorComponent, GameInstance, SceneLayer, type EngineObject, type World } from "@haptic/object-model";

/**
 * Game pause (Set Game Paused). Ticks keep running, but only what ticks on pause takes part: the
 * Game Instance with Tick On Pause, actors with Tick On Pause or in a Scene Layer with it, their
 * components, Delays and tweens, and those layers' SceneLayerScripts. Everything else holds:
 * physics, game time, timelines, animation graphs, behaviour trees, navigation and particles.
 * Sounds hold unless their owner ticks on pause.
 */

/** Whether `owner`'s ticks, Delays and tweens run while the game is paused. */
export function ticksWhilePaused(world: World, owner: EngineObject | null | undefined): boolean {
  if (!owner) return false;
  if (owner instanceof Actor) return world.ticksWhilePaused(owner);
  if (owner instanceof ActorComponent) return owner.owner ? world.ticksWhilePaused(owner.owner) : false;
  if (owner instanceof GameInstance) return owner.tickOnPause;
  if (owner instanceof SceneLayer) return owner.tickOnPause;
  return false;
}

/** The object a voice's emitter guid names: an actor, one of its components, the Game Instance or a Scene Layer. */
function voiceOwner(world: World, guid: string | null): EngineObject | null {
  if (!guid) return null;
  const actor = world.findActor(guid);
  if (actor) return actor;
  if (world.gameInstance?.guid === guid) return world.gameInstance;
  const layer = world.findSceneLayer(guid);
  if (layer) return layer;
  for (const candidate of world.getActors()) {
    const component = candidate.components.find((entry) => entry.guid === guid);
    if (component) return component;
  }
  return null;
}

export interface GamePauseHost {
  readonly world: World;
  /** The requested state, which `Is Game Paused` reads; applied at the start of the next tick. */
  readonly gamePaused: boolean;
  readonly timeDilation: number;
  liveVoiceOwners(): Iterable<[voiceId: string, ownerGuid: string | null]>;
  emit(command: CommandMessage): void;
}

/** Voices the game pause holds, released when it ends. One per session. */
export class GamePauseVoices {
  private readonly held = new Set<string>();

  /** Apply the requested pause before a tick: the World's gate, the render clocks and the voices. */
  sync(host: GamePauseHost): void {
    const world = host.world;
    if (world.gamePaused === host.gamePaused) return;
    world.gamePaused = host.gamePaused;
    // Particles and other render-side simulation clocks stand still with the game.
    host.emit({ type: "setSimulationTimeScale", scale: world.gamePaused ? 0 : host.timeDilation });
    if (world.gamePaused) {
      for (const [voiceId, ownerGuid] of host.liveVoiceOwners()) this.holdUnlessTicking(host, voiceId, ownerGuid);
      return;
    }
    for (const voiceId of this.held) host.emit({ type: "setVoicePaused", voiceId, paused: false });
    this.held.clear();
  }

  /** A sound that starts while the game is paused holds at once unless its owner ticks on pause. */
  started(host: GamePauseHost, command: CommandMessage): void {
    if (command.type !== "playSound" || !command.voiceId || !command.assetGuid) return;
    if (!host.world.gamePaused) return;
    this.holdUnlessTicking(host, command.voiceId, command.emitterActorGuid ?? null);
  }

  private holdUnlessTicking(host: GamePauseHost, voiceId: string, ownerGuid: string | null): void {
    const world = host.world;
    if (ticksWhilePaused(world, voiceOwner(world, ownerGuid))) return;
    if (this.held.has(voiceId)) return;
    this.held.add(voiceId);
    host.emit({ type: "setVoicePaused", voiceId, paused: true });
  }
}
