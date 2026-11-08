import type { CommandMessage } from "@haptic/bridge";
import {
  deprojectCursorRay,
  sceneDefaultCameraActor,
  sceneLayerCanvasToLayer,
  sceneLayerViewBounds,
  DEFAULT_LAYER_CAMERA_STATE,
  WORLD_LAYER_CAMERA_DISTANCE,
  WORLD_LAYER_CAMERA_FAR_CLIP,
  type LayerCameraState,
  type SerializedScene,
} from "@haptic/core";
import type { ResolvedInputTick } from "@haptic/input";
import type { Actor, ActorComponent, World } from "@haptic/object-model";
import { actorChainWorldTransform } from "./actor-world-transform";
import { actorFromIlluminationTarget } from "./runtime-host-render";
import type { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import type { SceneLayerOverlay } from "./scene-layer-overlay";

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
  /** The main Scene, for its Default Camera, per-camera possession options and Layer Camera bounds. */
  playScene(): SerializedScene | undefined;
  frameId(): number;
  /** The render slot this actor's own commands target. */
  slot(actor: Actor): number | undefined;
  /** The actor holding this render slot, if any. */
  slotOwner(slotId: number): Actor | undefined;
  /** The slot of the live actor with this guid. */
  guidSlot(guid: string): number | undefined;
  /** The cursor of the most recent resolved input tick. */
  cursor(): ResolvedInputTick["cursor"];
  /** The touches of the most recent resolved input tick. */
  touches(): ResolvedInputTick["touches"];
  overlay(): Pick<SceneLayerOverlay, "canvasSize" | "viewBounds">;
  physics(): Pick<RuntimePhysicsWorlds, "main" | "layer" | "kind">;
  /** False strips Project Cursor and Touch To Scene's debug lines whatever `drawDebug` says; true when omitted. */
  traceDebugDraw?: boolean;
  warn(message: string): void;
  emit(command: CommandMessage): void;
}

function liveCameraComponent(actor: Actor): ActorComponent | null {
  return actor.components.find((component) => component.classId === "CameraComponent" && !component.destroyed) ?? null;
}

/**
 * Camera possession and cursor projection for the runtime driver. The main
 * Scene's view is its Layer Camera until a camera actor is possessed: the
 * Scene's Default Camera when it starts (else an authored
 * `attemptPossessViewTarget` camera), or a script `Possess Camera`. Possess
 * Camera with None, or with an actor that has no Camera component, and a
 * possessed actor that goes away all return the view to the Layer Camera.
 * Also `Project Cursor To Scene` and `Project Touch To Scene` through
 * whichever camera is in view (through a Scene Layer's own camera for that
 * layer's scripts). Its `releaseSlot` hook forgets a possession whose slot was
 * released.
 */
export class RuntimeCamera implements RuntimeSubsystem {
  /** A script `Possess Camera` outranks the authored start camera. */
  private possessedByScript = false;
  private possessedSlotId: number | null = null;
  private readonly host: RuntimeCameraHost;

  constructor(host: RuntimeCameraHost) { this.host = host; }

  releaseSlot(slotId: number): void {
    if (this.possessedSlotId !== slotId) return;
    this.possessedSlotId = null;
  }

  /** A new main Scene owns its own camera choice. */
  resetPossession(): void {
    this.possessedByScript = false;
    this.possessedSlotId = null;
  }

  /**
   * The Scene's start camera, after every actor has spawned so the slots
   * exist: the Default Camera, else the first camera opted in with
   * `attemptPossessViewTarget`; neither leaves the Layer Camera in view. A
   * Possess Camera that already ran for this Scene wins.
   */
  possessStartCamera(): void {
    if (this.possessedByScript) return;
    const scene = this.host.playScene();
    if (!scene) return;
    const candidates: string[] = [];
    const defaultActor = sceneDefaultCameraActor(scene);
    if (defaultActor) candidates.push(defaultActor.id);
    for (const actor of scene.actors) {
      if (actor.components.some((component) =>
        component.classId === "CameraComponent" && component.properties.attemptPossessViewTarget === true)) candidates.push(actor.id);
    }
    for (const guid of candidates) {
      const slotId = this.host.guidSlot(guid);
      if (slotId === undefined) continue;
      const live = this.host.slotOwner(slotId);
      if (!live || !liveCameraComponent(live)) continue;
      this.possessedSlotId = slotId;
      this.host.emit({ type: "possessCamera", slotId });
      return;
    }
  }

  /**
   * Script and console `Possess Camera`. None returns the view to the Scene's
   * Layer Camera; so does an actor without a Camera component (with a warning).
   */
  possess(target: unknown, blend?: { seconds: number; curve: string }): void {
    const actor = actorFromIlluminationTarget(target);
    this.possessedByScript = true;
    // Possess Camera With Blend: only a positive blend time eases; anything else cuts like Possess Camera.
    const eased = blend && Number.isFinite(blend.seconds) && blend.seconds > 0 ? { blend: { seconds: blend.seconds, curve: String(blend.curve) } } : {};
    if (actor && !actor.destroyed && liveCameraComponent(actor)) {
      const slotId = this.host.slot(actor);
      if (slotId === undefined) return;
      this.possessedSlotId = slotId;
      this.host.emit({ type: "possessCamera", slotId, ...eased });
      return;
    }
    if (actor) this.host.warn(`Possess Camera: "${actor.getVariable("name") ?? actor.guid}" has no Camera component, so the view returns to the Layer Camera.`);
    if (this.possessedSlotId === null) return;
    this.possessedSlotId = null;
    this.host.emit({ type: "possessCamera", slotId: null, ...eased });
  }

  /** The possessed actor the main Scene's view looks through, or null while the Layer Camera is in view. */
  cameraActor(): Actor | null {
    if (this.possessedSlotId == null) return null;
    // A slot has one owner, so ask the table instead of scanning the World:
    // it counts while it is still a live World actor and the slot is its own.
    const actor = this.host.slotOwner(this.possessedSlotId);
    if (!actor || actor.destroyed || this.host.slot(actor) !== this.possessedSlotId || this.host.world().findActor(actor.guid) !== actor) return null;
    return liveCameraComponent(actor) ? actor : null;
  }

  /** The Camera component the view looks through: the possessed actor's first; null while the Layer Camera is in view. */
  cameraComponent(): ActorComponent | null {
    const actor = this.cameraActor();
    return actor ? liveCameraComponent(actor) : null;
  }

  /** The main Scene's Layer Camera pose, the default before a Scene exists. */
  private layerCameraState(): Readonly<LayerCameraState> {
    return this.host.world().currentScene?.camera.state ?? DEFAULT_LAYER_CAMERA_STATE;
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

  /** A ray from the camera in view through `point`, in game view CSS pixels. */
  private projectPointToScene(
    point: { x: number; y: number },
    channel?: string,
    options?: { drawDebug?: boolean; duration?: number },
  ) {
    const camera = this.cameraActor();
    const component = camera ? liveCameraComponent(camera) : null;
    let ray: { origin: { x: number; y: number; z: number }; end: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } };
    if (!camera || !component) {
      const layer = this.layerCameraRay(point);
      if (this.host.physics().kind === "2d") return this.layerCameraOverlap(layer, channel);
      ray = layer;
    } else {
      const projection = component.getVariable("projectionMode");
      // Cast from the camera's world pose at call time; a parented camera's
      // local transform is relative to its parent.
      const pose = actorChainWorldTransform(camera, (guid) => this.host.world().findActor(guid)) ?? camera.transform;
      ray = deprojectCursorRay(
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
    }
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
   * The ray through `screen` from the Scene's Layer Camera: the point under it
   * on the XY plane (Layer Camera Width × Height widened to the canvas aspect,
   * then the camera's zoom, roll and centre, as Play draws it), cast along +Z
   * from the camera's depth to its far clip.
   */
  private layerCameraRay(screen: { x: number; y: number }) {
    const canvas = this.host.overlay().canvasSize();
    const bounds = sceneLayerViewBounds(this.host.playScene()?.settings.cameraBounds2D, canvas.width / Math.max(1, canvas.height));
    const point = sceneLayerCanvasToLayer(screen.x, screen.y, canvas.width, canvas.height, bounds, this.layerCameraState());
    return {
      origin: { x: point.x, y: point.y, z: -WORLD_LAYER_CAMERA_DISTANCE },
      end: { x: point.x, y: point.y, z: WORLD_LAYER_CAMERA_FAR_CLIP - WORLD_LAYER_CAMERA_DISTANCE },
      direction: { x: 0, y: 0, z: 1 },
    };
  }

  /** A 2D world has no depth to cast along: the colliders containing the Layer Camera's point answer. */
  private layerCameraOverlap(ray: ReturnType<RuntimeCamera["layerCameraRay"]>, channel?: string) {
    const point = { x: ray.origin.x, y: ray.origin.y, z: 0 };
    const overlap = this.host.physics().main.sphereOverlap(point, 0, { channel });
    const actorId = overlap.actorIds[0];
    if (!actorId) {
      return { hit: false, location: null, normal: null, distance: 0, actorId: null, bodyId: null, worldOrigin: ray.origin, worldDirection: ray.direction };
    }
    return {
      hit: true,
      location: point,
      normal: { x: 0, y: 0, z: -1 },
      distance: WORLD_LAYER_CAMERA_DISTANCE,
      actorId,
      bodyId: overlap.bodyIds[0] ?? null,
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
      ...sceneLayerCanvasToLayer(screen.x, screen.y, canvas.width, canvas.height, bounds, layer?.camera.state ?? DEFAULT_LAYER_CAMERA_STATE),
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
