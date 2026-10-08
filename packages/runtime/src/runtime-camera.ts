import type { CommandMessage } from "@babylonslate/bridge";
import { deprojectCursorRay, type SerializedScene } from "@babylonslate/core";
import type { ResolvedInputTick } from "@babylonslate/input";
import type { Actor, World } from "@babylonslate/object-model";
import { actorChainWorldTransform } from "./actor-world-transform";
import { actorFromIlluminationTarget } from "./runtime-host-render";
import type { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import type { SceneLayerOverlay } from "./scene-layer-overlay";
import type { SceneStreams } from "./scene-streams";

interface RuntimeCameraHost {
  world(): World;
  /** The main Scene, for its default camera and per-camera possession options. */
  playScene(): SerializedScene | undefined;
  frameId(): number;
  /** The render slot this actor's own commands target. */
  slot(actor: Actor): number | undefined;
  /** The slot of a guid's first-spawned live actor. */
  guidSlot(guid: string): number | undefined;
  streams(): Pick<SceneStreams, "isStreamActor">;
  /** The cursor of the most recent resolved input tick. */
  cursor(): ResolvedInputTick["cursor"];
  overlay(): Pick<SceneLayerOverlay, "canvasSize">;
  physics(): Pick<RuntimePhysicsWorlds, "main">;
  emit(command: CommandMessage): void;
}

/**
 * Camera possession and cursor projection for the runtime driver: the
 * script `Possess Camera` choice and the possessed slot, the authored
 * `attemptPossessViewTarget` fallback the Scene realizer runs after a
 * Scene's actors spawn, the Play camera actor the snapshot and cursor
 * projection read, and `Project Cursor To Scene`. Its `releaseSlot` hook
 * forgets a possession whose slot was released.
 */
export class RuntimeCamera implements RuntimeSubsystem {
  /** A script `Possess Camera` outranks the authored per-camera option. */
  private possessedByScript = false;
  private possessedSlotId: number | null = null;
  private readonly host: RuntimeCameraHost;

  constructor(host: RuntimeCameraHost) { this.host = host; }

  releaseSlot(slotId: number): void {
    if (this.possessedSlotId !== slotId) return;
    this.possessedSlotId = null;
    this.possessedByScript = false;
  }

  /** A new main Scene owns its own camera choice. */
  resetPossession(): void {
    this.possessedByScript = false;
    this.possessedSlotId = null;
  }

  /**
   * Opt-in per camera (`attemptPossessViewTarget`). Runs after every actor has
   * spawned so the slot exists, and yields to a Begin Play `Possess Camera`
   * because an explicit script choice outranks the authored default.
   */
  possessViewTarget(): void {
    if (this.possessedByScript) return;
    const scene = this.host.playScene();
    const defaultActor = scene?.actors.find((actor) => actor.id === scene.settings.mainCameraActorId);
    if (defaultActor?.components.some((component) =>
      component.id === scene?.settings.mainCameraComponentId && component.classId === "CameraComponent",
    ) && this.host.guidSlot(defaultActor.id) !== undefined) return;
    for (const actor of this.host.playScene()?.actors ?? []) {
      const opted = actor.components.some(
        (component) =>
          component.classId === "CameraComponent" &&
          component.properties.attemptPossessViewTarget === true,
      );
      if (!opted) continue;
      const slotId = this.host.guidSlot(actor.id);
      if (slotId === undefined) continue;
      this.host.emit({ type: "possessCamera", slotId });
      this.possessedSlotId = slotId;
      return;
    }
  }

  /** Script and console `Possess Camera`. */
  possess(target: unknown): void {
    const actor = actorFromIlluminationTarget(target);
    if (!actor) return;
    const slotId = this.host.slot(actor);
    if (slotId === undefined) return;
    this.possessedByScript = true;
    this.possessedSlotId = slotId;
    this.host.emit({ type: "possessCamera", slotId });
  }

  /** The possessed camera's actor, else the Scene's main camera, else the first main-Scene camera. */
  cameraActor(): Actor | null {
    const world = this.host.world();
    if (this.possessedSlotId != null) {
      for (const actor of world.getActors()) {
        if (actor.destroyed) continue;
        if (this.host.slot(actor) === this.possessedSlotId) {
          return actor;
        }
      }
    }
    const mainId = this.host.playScene()?.settings.mainCameraActorId;
    if (mainId) {
      const actor = world.findActor(mainId);
      if (actor && !actor.destroyed) return actor;
    }
    for (const actor of world.getActors()) {
      if (actor.destroyed || actor.sceneLayerId || this.host.streams().isStreamActor(actor)) continue;
      if (
        actor.components.some(
          (component) =>
            component.classId === "CameraComponent" && !component.destroyed,
        )
      ) {
        return actor;
      }
    }
    return null;
  }

  projectCursorToScene(
    channel?: string,
    options?: { drawDebug?: boolean; duration?: number },
  ) {
    const miss = {
      hit: false,
      location: null,
      normal: null,
      distance: 0,
      actorId: null,
      bodyId: null,
      worldOrigin: { x: 0, y: 0, z: 0 },
      worldDirection: { x: 0, y: 0, z: 1 },
    };
    const camera = this.cameraActor();
    const component = camera?.components.find(
      (entry) => entry.classId === "CameraComponent" && !entry.destroyed,
    );
    if (!camera || !component) return miss;
    const projection = component.getVariable("projectionMode");
    // Cast from the camera's world pose at call time; a parented camera's
    // local transform is relative to its parent.
    const pose = actorChainWorldTransform(camera, (guid) => this.host.world().findActor(guid)) ?? camera.transform;
    const ray = deprojectCursorRay(
      this.host.cursor(),
      this.host.overlay().canvasSize(),
      {
        position: pose.position,
        rotation: pose.rotation,
        lens: {
          projectionMode:
            projection === "orthographic" ? "orthographic" : "perspective",
          fieldOfView: Number(component.getVariable("fieldOfView") ?? 60),
          orthographicSize: Number(
            component.getVariable("orthographicSize") ?? 5,
          ),
          nearClip: Number(component.getVariable("nearClip") ?? 0.1),
          farClip: Number(component.getVariable("farClip") ?? 1000),
        },
      },
    );
    // Same freshness as Line Trace: bodies as of the last step plus call-time
    // pose writes and component refreshes. Actors spawned, destroyed or
    // reparented earlier this tick reach the ray after the next step, so a
    // script aiming every tick does not pay a whole-world pass per call.
    const hit = this.host.physics().main.lineTrace(ray.origin, ray.end, { channel });
    const drawDebug = options?.drawDebug !== false;
    if (drawDebug) {
      const duration =
        typeof options?.duration === "number" && Number.isFinite(options.duration)
          ? options.duration
          : 0;
      const end =
        hit.hit === true && hit.location ? hit.location : ray.end;
      this.host.emit({
        type: "debugDraw",
        kind: "line",
        start: ray.origin,
        end,
        thickness: 1,
        color: { x: 1, y: 0, z: 0, w: 1 },
        duration,
        frameId: this.host.frameId(),
      });
      if (hit.hit === true && hit.location) {
        this.host.emit({
          type: "debugDraw",
          kind: "square",
          center: hit.location,
          size: 0.16,
          color: { x: 0, y: 1, z: 0, w: 1 },
          duration,
          frameId: this.host.frameId(),
        });
      }
    }
    return {
      ...hit,
      worldOrigin: ray.origin,
      worldDirection: ray.direction,
    };
  }
}
