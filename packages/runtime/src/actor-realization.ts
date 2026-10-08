import type { CommandMessage } from "@babylonslate/bridge";
import { createDefaultRenderTargetCaptureProperties, resolveActorDefaults, type Transform } from "@babylonslate/core";
import { isInfiniteLoopError } from "@babylonslate/debugger";
import {
  attachSerializedComponents,
  isLockedEngineClassId,
  type Actor,
  type ActorComponent,
  type BObject,
  type LifecycleHooks,
  type SceneActorHooks,
  type World,
} from "@babylonslate/object-model";
import { parseColliderProperties, type PhysicsWorldKind } from "@babylonslate/physics";
import { actorLabel, breakParentCycles } from "./actor-world-transform";
import type { AudioParticleEmitter } from "./audio-particle-emitter";
import type { DynamicRuntimeMeshSync } from "./dynamic-runtime-mesh";
import type { LogSeverity } from "./log-ring";
import type { MovementWorldSync } from "./movement";
import type { OwnerAdmission } from "./owner-admission";
import type { RenderCommandEmitter } from "./render-command-emitter";
import type { RenderSlots } from "./render-slots";
import { captureComponent } from "./render-targets";
import type { RuntimeSubsystems } from "./runtime-subsystems";
import type { SceneLayerOverlay } from "./scene-layer-overlay";
import type { SceneStreams } from "./scene-streams";
import type { ScriptHost } from "./script-host";
import type { ScriptRuntime } from "./script-runtime";
import type { SessionBoundaries } from "./session-boundaries";
import type { Text2DAppearRuntime } from "./text2d-appear-runtime";

interface ActorRealizationHost {
  world(): World;
  stopped(): boolean;
  scripts(): ScriptHost;
  scriptRuntime(): Pick<ScriptRuntime, "canSpawnActorClass">;
  streams(): Pick<SceneStreams, "canSpawnFor" | "adoptSpawned" | "actorInstance">;
  boundaries(): Pick<SessionBoundaries, "markSpawned" | "trackRealized">;
  /** The main Scene's physics world kind; Scene Layer actors always validate as 2D. */
  physicsKind(): PhysicsWorldKind;
  renderSlots(): RenderSlots;
  renderEmitter(): Pick<RenderCommandEmitter, "emitMeshAssignment">;
  audioParticles(): Pick<AudioParticleEmitter, "emitAudio" | "emitParticles" | "stopAudio" | "stopParticles">;
  overlay(): Pick<SceneLayerOverlay, "retireSwitcher" | "forgetActor">;
  movement(): Pick<MovementWorldSync, "initialize">;
  dynamicMeshes(): Pick<DynamicRuntimeMeshSync, "remove">;
  textAppear(): Pick<Text2DAppearRuntime, "remove">;
  subsystems(): Pick<RuntimeSubsystems, "retireActor">;
  cancelInvalidTweens(): void;
  /** The tick's live actor index by guid while behaviour trees and the crowd run, else null. */
  frameActors(): Map<string, Actor> | null;
  reportLog(message: string, severity: LogSeverity, category: string): void;
  emit(command: CommandMessage): void;
}

/** Options for `ActorRealization.spawnScripted` (the driver's `spawnScriptedActor`). */
export interface ScriptedActorSpawn {
  classId: string;
  variables?: Record<string, unknown>;
  implementedInterfaces?: string[];
  transform?: Transform;
  streamOwner?: BObject | null;
}

/**
 * Actor realization and removal for the runtime driver: the script lifecycle
 * hooks of scene, spawned and component objects (every hook dispatches through
 * `OwnerAdmission`), Class actor defaults, loaded parent-cycle repair, render
 * slot assignment with its `spawn` command, the realization sequence (render,
 * audio and particle commands, World spawn, deferred owner work, the tick's
 * frame index), script spawns, the demo actors of an empty Preview, and actor
 * removal (`despawn`, slot release and the subsystems' `retireActor` hooks).
 * It reads the driver's subsystems through lazy host callbacks and is not a
 * registered subsystem.
 */
export class ActorRealization {
  private readonly admission: OwnerAdmission;
  private readonly host: ActorRealizationHost;
  private readonly removingActors = new WeakSet<Actor>();

  constructor(admission: OwnerAdmission, host: ActorRealizationHost) {
    this.admission = admission;
    this.host = host;
  }

  /** Script hooks for actors instantiated from Scene, stream, Scene Layer and Save Game data. */
  readonly sceneActorHooks: SceneActorHooks = (classId) => {
    const hooks = this.host.scripts().hooksFor(classId);
    return {
      onCreation: (self) => this.admission.runCreation(self, () => hooks?.onCreation?.(self)),
      // Logic-free actors (Prefabs, scriptless classes) add no per-frame call.
      onTick: hooks?.onTick
        ? (self, ctx) => this.admission.guard(() => hooks.onTick?.(self, ctx))
        : undefined,
      onDestroyed: (self) => {
        this.host.overlay().retireSwitcher(self);
        this.admission.runDestroyed(self, () => hooks?.onDestroyed?.(self));
      },
    };
  };

  /** World `componentHooksFor`: script hooks plus the component runtimes' creation and teardown. */
  componentHooks(classId: string): LifecycleHooks<ActorComponent> | undefined {
    if (!this.host.world().classRegistry.isA(classId, "ActorComponent")) return undefined;
    return {
      onCreation: (self) => {
        this.host.movement().initialize(self);
        this.host.scripts().bindInterfaceHandlers(self);
        this.admission.runCreation(self, () => this.host.scripts().hooksFor(classId)?.onCreation?.(self));
      },
      // Engine component classes never carry scripts, so they skip the
      // per-frame script lookup; project components keep it for reloads.
      onTick: isLockedEngineClassId(classId)
        ? undefined
        : (self, ctx) =>
            this.admission.guard(() => this.host.scripts().hooksFor(classId)?.onTick?.(self, ctx)),
      onDestroyed: (self) => {
        this.admission.runDestroyed(self, () => this.host.scripts().hooksFor(classId)?.onDestroyed?.(self));
        this.host.dynamicMeshes().remove(self);
        this.host.textAppear().remove(self);
      },
    };
  }

  /** True while `remove` runs for this actor instance. */
  removing(actor: Actor): boolean {
    return this.removingActors.has(actor);
  }

  spawnScripted(options: ScriptedActorSpawn): Actor | null {
    if (this.host.stopped()) return null;
    const streams = this.host.streams();
    if (!streams.canSpawnFor(options.streamOwner)) return null;
    if (!this.host.scriptRuntime().canSpawnActorClass(options.classId)) return null;
    const scripts = this.host.scripts();
    const world = this.host.world();
    const hooks = scripts.hooksFor(options.classId) ??
      (world.classRegistry.isA(options.classId, "RenderTargetCapture") ? {} : undefined);
    if (!hooks) return null;
    const actor = world.createActor({
      classId: options.classId,
      variables: options.variables,
      implementedInterfaces: options.implementedInterfaces,
      transform: options.transform,
      hooks: {
        onCreation: (self) => this.admission.runCreation(self, () => hooks.onCreation?.(self)),
        onTick: (self, ctx) =>
          this.admission.guard(() => hooks.onTick?.(self, ctx)),
        onDestroyed: (self) =>
          this.admission.runDestroyed(self, () => hooks.onDestroyed?.(self)),
      },
    });
    streams.adoptSpawned(options.streamOwner, actor);
    scripts.bindInterfaceHandlers(actor);
    const components = scripts.scriptsFor(options.classId)
      .find((script) => script.components !== undefined)?.components;
    if (components) attachSerializedComponents(world, actor, components, { freshIds: true });
    this.host.boundaries().markSpawned(actor);
    try {
      this.realize(actor);
    } catch (error) {
      if (!isInfiniteLoopError(error)) throw error;
    }
    return actor;
  }

  applyDefaults(actor: Actor): void {
    const scripts = this.host.scripts();
    for (const component of actor.components) {
      scripts.bindInterfaceHandlers(component);
    }
    const resolved = resolveActorDefaults(
      this.host.world().classRegistry.ancestry(actor.classId)
        .map((classId) => scripts.scriptsFor(classId)[0]?.actorDefaults),
    );
    actor.generateHitEvents = resolved.generateHitEvents;
    actor.generateOverlapEvents = resolved.generateOverlapEvents;
    actor.tickEnabled = resolved.eventTick;
  }

  /**
   * Loaded data can hold parent cycles that script writes would refuse. Once a
   * scene, streamed scene or SceneLayer batch has spawned (before readiness,
   * Begin Play, physics or the crowd see it), clear the link that closes each
   * cycle in spawn order and warn once per cleared link. `detach` gives the
   * actor the parent a root of its batch has (default: none).
   */
  breakLoadedParentCycles(batch: Iterable<Actor>, detach?: (child: Actor) => void): void {
    const world = this.host.world();
    for (const { child, parent } of breakParentCycles(batch, (guid) => world.findActor(guid), detach)) {
      this.host.reportLog(
        `Loaded parent cycle broken: ${actorLabel(child)} is no longer parented to ${actorLabel(parent)}.`,
        "warning",
        "actor",
      );
    }
  }

  realize(actor: Actor, checkpoint: () => void = () => {}): void {
    checkpoint();
    this.host.boundaries().trackRealized(actor);
    const world = this.host.world();
    if (world.classRegistry.isA(actor.classId, "RenderTargetCapture") && !captureComponent(actor) && !actor.sceneLayerId) {
      attachSerializedComponents(world, actor, [{
        id: `${actor.guid}:capture`, classId: "RenderTargetCaptureComponent", properties: createDefaultRenderTargetCaptureProperties(),
      }]);
    }
    this.applyDefaults(actor);
    // Reject invalid draft primitives while the host still owns the Scene load.
    // Deferring this until native physics boot left the host at Realizing Scene.
    for (const component of actor.components) {
      if (component.classId !== "ColliderComponent" || component.destroyed) continue;
      const shape = component.getVariable("shape");
      const kind = shape && typeof shape === "object" ? (shape as { kind?: unknown }).kind : undefined;
      if (kind === "convex" || kind === "mesh" || kind === "polygon" || kind === "chain") continue;
      try {
        parseColliderProperties({ shape }, actor.sceneLayerId ? "2d" : this.host.physicsKind());
      } catch (error) {
        throw new Error(`${actorLabel(actor)} / ${component.guid}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    const slotId = this.assignSlot(actor);
    checkpoint();
    this.host.renderEmitter().emitMeshAssignment(actor, slotId);
    checkpoint();
    this.host.audioParticles().emitAudio(actor);
    checkpoint();
    this.host.audioParticles().emitParticles(actor);
    checkpoint();
    world.spawnActorNow(actor);
    checkpoint();
    this.admission.flushSpawned(actor);
    checkpoint();
    // A spawn queued mid-tick joins the frame index once it commits, next frame.
    if (world.findActor(actor.guid) === actor) this.host.frameActors()?.set(actor.guid, actor);
  }

  /** Allocate the actor's render slot and announce it (`spawn`). */
  assignSlot(actor: Actor): number {
    const slotId = this.host.renderSlots().allocate(actor);
    const stream = this.host.streams().actorInstance(actor);
    this.host.emit({
      type: "spawn",
      slotId,
      actorGuid: actor.guid,
      classId: actor.classId,
      ...(actor.sceneLayerId ? { sceneLayerId: actor.sceneLayerId } : {}),
      ...(stream ? { sceneStreamActorGuid: stream.actor.guid, streamLoadId: stream.loadId } : {}),
    });
    return slotId;
  }

  remove(actor: Actor): void {
    if (this.removingActors.has(actor)) return;
    this.removingActors.add(actor);
    this.host.overlay().retireSwitcher(actor);
    this.host.subsystems().retireActor(actor);
    this.admission.dropActor(actor);
    const slots = this.host.renderSlots();
    const slotId = slots.actorSlot(actor);
    const ownsSlot = () => slotId !== undefined && slots.owner(slotId) === actor;
    try {
      if (ownsSlot()) this.host.audioParticles().stopAudio(actor);
      if (ownsSlot()) this.host.audioParticles().stopParticles(actor);
      if (ownsSlot()) this.host.emit({ type: "despawn", slotId: slotId!, actorGuid: actor.guid });
    } finally {
      if (ownsSlot()) slots.release(slotId!);
      this.host.overlay().forgetActor(actor);
      this.host.world().destroyActorInstance(actor);
      this.host.cancelInvalidTweens();
      this.removingActors.delete(actor);
    }
  }

  /** Demo actors so an empty project still shows motion in Preview. */
  seedDemoActors(): void {
    const world = this.host.world();
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
    world.spawnActorNow(actor);
    this.assignSlot(actor);

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
    this.assignSlot(second);
  }
}
