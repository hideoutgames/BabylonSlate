import type { CommandMessage } from "@babylonslate/bridge";
import { deprojectCursorRay, sceneLayerCanvasToLayer, SCENE_LAYER_DEFAULT_CAMERA, type SerializedScene } from "@babylonslate/core";
import type { ResolvedInputTick } from "@babylonslate/input";
import type { Actor, World } from "@babylonslate/object-model";
import { actorChainWorldTransform } from "./actor-world-transform";
import { actorFromIlluminationTarget } from "./runtime-host-render";
import type { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import type { SceneLayerOverlay } from "./scene-layer-overlay";
import type { SceneStreams } from "./scene-streams";
import { componentOwners } from "./world-component-index";

/** The Scene Layer camera's distance in front of the layer plane (`SceneLayerCompositor`'s HUD camera at z = -10). */
const SCENE_LAYER_CAMERA_DISTANCE = 10;

function noTouchProjection() {
  return {
    hit: false, location: null, normal: null, distance: 0, actorId: null, bodyId: null,
    worldOrigin: { x: 0, y: 0, z: 0 }, worldDirection: { x: 0, y: 0, z: 0 },
  };
}

interface RuntimeCameraHost {
  world(): World;
  /** The main Scene, for its default camera and per-camera possession options. */
  playScene(): SerializedScene | undefined;
  frameId(): number;
  /** The render slot this actor's own commands target. */
  slot(actor: Actor): number | undefined;
  /** The actor holding this render slot, if any. */
  slotOwner(slotId: number): Actor | undefined;
  /** The slot of the live actor with this guid. */
  guidSlot(guid: string): number | undefined;
  streams(): Pick<SceneStreams, "isStreamActor">;
  /** The cursor of the most recent resolved input tick. */
  cursor(): ResolvedInputTick["cursor"];
  /** The touches of the most recent resolved input tick. */
  touches(): ResolvedInputTick["touches"];
  overlay(): Pick<SceneLayerOverlay, "canvasSize" | "viewBounds">;
  physics(): Pick<RuntimePhysicsWorlds, "main" | "layer">;
  /** False strips Project Cursor and Touch To Scene's debug lines whatever `drawDebug` says; true when omitted. */
  traceDebugDraw?: boolean;
  emit(command: CommandMessage): void;
}

/**
 * Camera possession and cursor projection for the runtime driver: the
 * script `Possess Camera` choice and the possessed slot, the authored
 * `attemptPossessViewTarget` fallback the Scene realizer runs after a
 * Scene's actors spawn, the Play camera actor the snapshot and cursor
 * projection read, and `Project Cursor To Scene` and `Project Touch To
 * Scene` (through a Scene Layer's own camera for that layer's scripts). Its `releaseSlot` hook
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
      // A slot has one owner, so ask the table instead of scanning the World:
      // it counts while it is still a live World actor and the slot is its own.
      const actor = this.host.slotOwner(this.possessedSlotId);
      if (actor && !actor.destroyed && this.host.slot(actor) === this.possessedSlotId && world.findActor(actor.guid) === actor) {
        return actor;
      }
    }
    const mainId = this.host.playScene()?.settings.mainCameraActorId;
    if (mainId) {
      const actor = world.findActor(mainId);
      if (actor && !actor.destroyed) return actor;
    }
    // Only camera owners can qualify; the index lists them in world order.
    for (const actor of componentOwners(world, "CameraComponent")) {
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
    return this.projectPointToScene(this.host.cursor(), channel, options);
  }

  /** A finger that is not down this tick hits nothing and casts no ray. */
  projectTouchToScene(
    finger: number,
    channel?: string,
    options?: { drawDebug?: boolean; duration?: number },
  ) {
    const touch = this.touch(finger);
    return touch ? this.projectPointToScene(touch.Position, channel, options) : noTouchProjection();
  }

  private touch(finger: number) {
    return this.host.touches().find((touch) => touch.Finger === finger);
  }

  /** A ray from the Play camera through `point`, in game view CSS pixels. */
  private projectPointToScene(
    point: { x: number; y: number },
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
      point,
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
    const drawDebug = this.host.traceDebugDraw !== false && options?.drawDebug !== false;
    if (drawDebug) {
      const duration =
        typeof options?.duration === "number" && Number.isFinite(options.duration)
          ? options.duration
          : 0;
      const end =
        hit.hit === true && hit.location ? hit.location : ray.end;
      // The script receives these vectors too; copy them so the queued command
      // keeps this call's values (commands are cloned when the worker flushes).
      this.host.emit({
        type: "debugDraw",
        kind: "line",
        start: { ...ray.origin },
        end: { ...end },
        thickness: 1,
        color: { x: 1, y: 0, z: 0, w: 1 },
        duration,
        frameId: this.host.frameId(),
      });
      if (hit.hit === true && hit.location) {
        this.host.emit({
          type: "debugDraw",
          kind: "square",
          center: { ...hit.location },
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

  /**
   * `Project Cursor To Scene` (and `Project Touch To Scene`, with the
   * finger's position) from a Scene Layer's script: the cursor through
   * that layer's orthographic camera (z = -10 looking along +Z, Layer Width ×
   * Height widened to the Play canvas aspect, then the camera's zoom, roll and
   * centre, as the compositor draws and picks it) to a point on the layer
   * plane, answered by the first collider of the layer's own 2D world there.
   * No hit when the layer has no physics. It draws no debug line: debug draws
   * render in the main Scene, not in layers.
   */
  projectCursorToSceneLayer(layerGuid: string, channel?: string) {
    return this.projectPointToSceneLayer(layerGuid, this.host.cursor(), channel);
  }

  projectTouchToSceneLayer(layerGuid: string, finger: number, channel?: string) {
    const touch = this.touch(finger);
    return touch ? this.projectPointToSceneLayer(layerGuid, touch.Position, channel) : noTouchProjection();
  }

  private projectPointToSceneLayer(layerGuid: string, screen: { x: number; y: number }, channel?: string) {
    const layer = this.host.world().findSceneLayer(layerGuid);
    const bounds = this.host.overlay().viewBounds(layer);
    const canvas = this.host.overlay().canvasSize();
    const point = {
      ...sceneLayerCanvasToLayer(screen.x, screen.y, canvas.width, canvas.height, bounds, layer?.camera ?? SCENE_LAYER_DEFAULT_CAMERA),
      z: 0,
    };
    const worldOrigin = { x: point.x, y: point.y, z: -SCENE_LAYER_CAMERA_DISTANCE };
    const worldDirection = { x: 0, y: 0, z: 1 };
    // A 2D world has no depth to cast along: the colliders containing the point answer.
    const overlap = this.host.physics().layer(layerGuid)?.sphereOverlap(point, 0, { channel });
    const actorId = overlap?.actorIds[0];
    if (!overlap || !actorId) {
      return { hit: false, location: null, normal: null, distance: 0, actorId: null, bodyId: null, worldOrigin, worldDirection };
    }
    return {
      hit: true,
      location: point,
      normal: { x: 0, y: 0, z: -1 },
      distance: SCENE_LAYER_CAMERA_DISTANCE,
      actorId,
      bodyId: overlap.bodyIds[0] ?? null,
      worldOrigin,
      worldDirection,
    };
  }
}
