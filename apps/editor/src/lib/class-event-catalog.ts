import type { SerializedGraph } from "@haptic/core";
import {
  engineParentOf,
  formatEventTitle,
  walkAncestry,
} from "@haptic/editor-kit";
import {
  ENGINE_CLASS_SCRIPT_APIS,
  GAME_SUBSYSTEM_CLASS_ID,
  SCENE_SUBSYSTEM_CLASS_ID,
  engineNativeEventsFor,
} from "@haptic/object-model";
import { SUBSYSTEM_GET_NODE_ID } from "@haptic/scripting-nodes";

export const NATIVE_CLASS_EVENT_TYPES = [
  "flow.event.gameLoaded",
  "flow.event.scalabilityChanged",
  "flow.event.beginPlay",
  "flow.event.tick",
  "flow.event.destroyed",
] as const;

/** Default new graphs seed these Actor natives; Destroyed stays in Events +. */
const SEEDED_NATIVE_EVENT_TYPES = [
  "flow.event.beginPlay",
  "flow.event.tick",
  "flow.event.init",
] as const;

/** Subsystem classes seed On Init only; Tick and the rest stay in Events +. */
const SEEDED_SUBSYSTEM_EVENT_TYPES = ["flow.event.init"] as const;

/**
 * Self lifecycle events the engine catalog declares per lineage (Game
 * Instance, GameSubsystem, SceneSubsystem). Tick and Scalability Changed are
 * also Actor / component natives, so only the rest are lineage-gated.
 */
export const LINEAGE_NATIVE_EVENT_TYPES: ReadonlySet<string> = new Set(
  ENGINE_CLASS_SCRIPT_APIS.flatMap((api) =>
    (api.nativeEvents ?? []).map((event) => event.eventType),
  ).filter(
    (eventType) =>
      eventType !== "flow.event.tick" &&
      eventType !== "flow.event.scalabilityChanged" && eventType !== "flow.event.gameLoaded",
  ),
);

/** Get Game Instance: every runtime host, never editor utilities. */
export const GET_GAME_INSTANCE_NODE_ID = "gameInstance.get";

/**
 * Game Instance catalog getters and the lineages whose graphs may use them
 * (their implicit Self is the Game Instance or a subsystem).
 */
const LINEAGE_FUNCTION_NODE_BASES: Readonly<Record<string, readonly string[]>> = {
  "gameInstance.getSceneLoadingProgress": ["GameInstance", GAME_SUBSYSTEM_CLASS_ID],
  "gameInstance.getSceneReference": [
    "GameInstance",
    GAME_SUBSYSTEM_CLASS_ID,
    SCENE_SUBSYSTEM_CLASS_ID,
  ],
};

export const COLLISION_EVENT_TYPE_IDS = [
  "flow.event.hit",
  "flow.event.beginOverlap",
  "flow.event.endOverlap",
] as const;

export const NATIVE_EVENT_TITLES: Record<string, string> = {
  "flow.event.scalabilityChanged": "Event Scalability Changed",
  "flow.event.gameLoaded": "Event On Game Loaded",
  "flow.event.beginPlay": "Event Begin Play",
  "flow.event.tick": "Event Tick",
  "flow.event.destroyed": "Event On Actor Destroyed",
  "flow.event.init": "Event On Init",
  "flow.event.end": "Event On End",
  "flow.event.firstSceneLoaded": "Event On First Scene Loaded",
  "flow.event.sceneStartLoading": "Event On Scene Start Loading",
  "flow.event.sceneFinishLoading": "Event On Scene Finish Loading",
  "flow.event.sceneExit": "Event On Scene Exit",
  "flow.event.sceneLoaded": "Event On Scene Loaded",
  "flow.event.streamedSceneLoaded": "Event On Streamed Scene Loaded",
  "flow.event.streamedSceneUnloaded": "Event On Streamed Scene Unloaded",
  "flow.event.sceneLayerAdded": "Event On Scene Layer Added",
  "flow.event.sceneLayerRemoved": "Event On Scene Layer Removed",
  "flow.event.sceneLayerActorSwitching": "Event On Scene Layer Actor Switching",
  "flow.event.sceneLayerActorSwitched": "Event On Scene Layer Actor Switched",
  "flow.event.sceneLayerActorSwitchedTo": "Event On Scene Layer Actor Switched To",
  "flow.event.sceneLayerActorSwitchedFrom": "Event On Scene Layer Actor Switched From",
  "flow.event.sceneActorSpawned": "Event On Scene Actor Spawned",
  "flow.event.sceneActorDestroyed": "Event On Scene Actor Destroyed",
  "flow.event.hit": "Event On Hit",
  "flow.event.beginOverlap": "Event On Begin Overlap",
  "flow.event.endOverlap": "Event On End Overlap",
  "flow.event.onMouseEnter": "Event On Mouse Enter",
  "flow.event.onMouseLeave": "Event On Mouse Leave",
  "flow.event.onClick": "Event On Click",
  "flow.event.onPressStart": "Event On Press Start",
  "flow.event.onPressEnd": "Event On Press End",
  "flow.event.textChanged": "Event On Text Changed",
  "flow.event.audioFinished": "Event On Audio Finished",
  "flow.event.uiValueChanged": "Event On Value Changed",
  "flow.event.uiRangeChanged": "Event On Range Changed",
  "flow.event.uiCheckedChanged": "Event On Checked Changed",
  "flow.event.uiTextChanged": "Event On Text Changed",
  "flow.event.uiTextSubmitted": "Event On Text Submitted",
  "flow.event.uiSelectionChanged": "Event On Selection Changed",
  "flow.event.focusEnter": "Event On Focus Enter",
  "flow.event.focusLeave": "Event On Focus Leave",
  "flow.event.focusActivate": "Event On Focus Activate",
  "flow.event.movementStarted": "Event On Movement Started",
  "flow.event.movementStopped": "Event On Movement Stopped",
  "flow.event.movementJumped": "Event On Movement Jumped",
  "flow.event.movementLeftGround": "Event On Movement Left Ground",
  "flow.event.movementLanded": "Event On Movement Landed",
  "flow.event.commandRun": "Event On Command Run",
  "flow.event.editorBeginPlay": "Event Editor On Begin Play",
  "flow.event.editorStartup": "Event On Editor Startup",
  "flow.event.sceneOpen": "Event On Scene Open",
  "flow.event.sceneSaved": "Event On Scene Saved",
  "flow.event.editorShutdown": "Event On Editor Shutdown",
  "bt.event.activate": "On Activate",
  "bt.event.tick": "On Tick",
  "bt.event.abort": "On Abort",
  "bt.event.evaluate": "On Evaluate",
};

const EDITOR_UTILITY_EVENT_TYPES = [
  "flow.event.editorStartup",
  "flow.event.sceneOpen",
  "flow.event.sceneSaved",
  "flow.event.editorShutdown",
] as const;

const EDITOR_BEGIN_PLAY_EVENT = "flow.event.editorBeginPlay";

export const OVERLAY_MOUSE_EVENT_TYPE_IDS = [
  "flow.event.onMouseEnter",
  "flow.event.onMouseLeave",
  "flow.event.onClick",
  "flow.event.onPressStart",
  "flow.event.onPressEnd",
] as const;

const ACTOR_EVENT_TYPE_IDS = [
  "flow.event.beginPlay",
  "flow.event.tick",
  "flow.event.destroyed",
  "flow.event.commandRun",
  "flow.event.hit",
  "flow.event.beginOverlap",
  "flow.event.endOverlap",
  "flow.event.textChanged",
  "flow.event.audioFinished",
  "flow.event.movementStarted",
  "flow.event.movementStopped",
  "flow.event.movementJumped",
  "flow.event.movementLeftGround",
  "flow.event.movementLanded",
  ...OVERLAY_MOUSE_EVENT_TYPE_IDS,
] as const;

const BT_LEAF_EVENT_TYPE_IDS = [
  "bt.event.activate",
  "bt.event.tick",
  "bt.event.abort",
  "bt.event.evaluate",
] as const;

const BT_TASK_EVENT_TYPE_IDS = [
  "bt.event.activate",
  "bt.event.tick",
  "bt.event.abort",
] as const;

const BT_DECORATOR_EVENT_TYPE_IDS = ["bt.event.evaluate"] as const;
const BT_SERVICE_EVENT_TYPE_IDS = ["bt.event.tick"] as const;

const BT_TASK_ONLY_NODE_IDS = ["bt.finish"] as const;
const BT_DECORATOR_ONLY_NODE_IDS = ["bt.returnCondition"] as const;
const BT_BLACKBOARD_NODE_IDS = ["bt.blackboard.get", "bt.blackboard.set"] as const;

export type ClassEventOptions = {
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
  /** Parent Class graphs keyed by class id (for inherited custom events). */
  parentGraphs?: Record<string, SerializedGraph>;
  assetType?: string | null;
  editorGraph?: boolean;
  /** Animation Object event graph vs nested transition-rule graph. */
  animationGraphHost?: "object" | "rule";
};

function ancestryChain(options?: ClassEventOptions): string[] {
  const parentOf =
    options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  return walkAncestry(options?.parentClass ?? "Actor", parentOf);
}

function isSubsystemChain(chain: readonly string[]): boolean {
  return (
    chain.includes(GAME_SUBSYSTEM_CLASS_ID) ||
    chain.includes(SCENE_SUBSYSTEM_CLASS_ID)
  );
}

/** Lineage lifecycle events (Game Instance / subsystem) a class chain handles. */
export function lineageNativeEventTypes(
  chain: readonly string[],
): ReadonlySet<string> {
  return new Set(engineNativeEventsFor(chain).map((event) => event.eventType));
}

/**
 * Whether a lineage-gated lifecycle event (On Init, the Game Instance scene
 * events, the SceneSubsystem events) is legal on this class chain. Other
 * events are not lineage-gated and always pass.
 */
export function isLineageNativeEventAllowed(
  eventType: string,
  chain: readonly string[],
): boolean {
  if (!LINEAGE_NATIVE_EVENT_TYPES.has(eventType)) return true;
  return lineageNativeEventTypes(chain).has(eventType);
}

/** Engine bases whose catalog declares a lineage lifecycle event, root order. */
export function lineageNativeEventBases(eventType: string): string[] {
  return ENGINE_CLASS_SCRIPT_APIS.filter((api) =>
    (api.nativeEvents ?? []).some((event) => event.eventType === eventType),
  ).map((api) => api.classId);
}

/** Title Case node title for a native event type (`Event On Scene Loaded`). */
export function nativeEventTitle(eventType: string): string {
  return NATIVE_EVENT_TITLES[eventType] ?? formatEventTitle(eventType);
}

/** Get Game Instance and Get <Subsystem> are runtime-only (no editor utilities). */
export function isEditorUtilityChain(chain: readonly string[]): boolean {
  return (
    chain.includes("EditorUtilityObject") ||
    chain.includes("EditorFunctionLibrary")
  );
}

/** Native events a new graph for this parent seeds (subsystems: On Init only). */
export function seededNativeEventTypes(
  options?: ClassEventOptions,
): readonly string[] {
  return isSubsystemChain(ancestryChain(options))
    ? SEEDED_SUBSYSTEM_EVENT_TYPES
    : SEEDED_NATIVE_EVENT_TYPES;
}

function eventStubsForTypes(types: readonly string[]): Array<{
  eventType: string;
  name: string;
}> {
  return types.map((eventType) => ({
    eventType,
    name: nativeEventTitle(eventType),
  }));
}

export function nativeEventStubs(
  options?: ClassEventOptions,
): Array<{ eventType: string; name: string }> {
  const chain = ancestryChain(options);
  if (chain.includes("EditorUtilityObject")) {
    return eventStubsForTypes([
      EDITOR_BEGIN_PLAY_EVENT,
      ...EDITOR_UTILITY_EVENT_TYPES,
    ]);
  }
  if (chain.includes("BTTask")) return eventStubsForTypes(BT_TASK_EVENT_TYPE_IDS);
  if (chain.includes("BTDecorator")) {
    return eventStubsForTypes(BT_DECORATOR_EVENT_TYPE_IDS);
  }
  if (chain.includes("BTService")) {
    return eventStubsForTypes(BT_SERVICE_EVENT_TYPE_IDS);
  }
  if (chain.includes("BTComposite")) return [];
  if (
    chain.includes("FunctionLibrary") ||
    chain.includes("EditorFunctionLibrary")
  ) {
    return [];
  }
  const types: string[] = [];
  if (chain.includes("Actor") || chain.includes("ActorComponent")) {
    types.push(...NATIVE_CLASS_EVENT_TYPES);
  }
  // Game Instance, GameSubsystem and SceneSubsystem lifecycles come from the
  // engine catalog so the editor and runtime share one table.
  types.push(...lineageNativeEventTypes(chain));
  if (chain.includes("DebugCommand")) {
    types.push("flow.event.commandRun");
  }
  return eventStubsForTypes(types).map((stub) => chain.includes("ActorComponent") && stub.eventType === "flow.event.destroyed" ? { ...stub, name: "Event Destroyed" } : stub);
}

/** Whether a script catalog node is legal on a Class graph for this parent. */
function isAnimCatalogNode(nodeId: string): boolean {
  return nodeId.startsWith("anim.");
}

function isAnimCatalogNodeAllowed(
  nodeId: string,
  host: ClassEventOptions["animationGraphHost"],
  options?: ClassEventOptions,
): boolean {
  if (host === "object") {
    return nodeId.startsWith("anim.event.");
  }
  if (host === "rule") {
    return nodeId.startsWith("anim.state.");
  }
  if (nodeId.startsWith("anim.actor.")) {
    return ancestryChain(options).includes("Actor");
  }
  return false;
}

export function isScriptCatalogNodeAllowed(
  nodeId: string,
  options?: ClassEventOptions,
): boolean {
  if (nodeId === "flow.function.input" || nodeId === "flow.function.output") {
    return false;
  }
  if (nodeId === "flow.event.call" || nodeId === "functions.call") {
    return false;
  }
  if (nodeId === "flow.event.callParent") {
    return false;
  }
  if (nodeId === "interface.call") {
    return false;
  }
  if (
    nodeId === "variables.get" ||
    nodeId === "variables.set" ||
    nodeId === "variables.getValidated"
  ) {
    return false;
  }
  if (nodeId === "component.getNamed") {
    return false;
  }
  if (nodeId === "casting.cast") {
    return false;
  }
  // One Get <Subsystem> row per project subsystem class is injected instead.
  if (nodeId === SUBSYSTEM_GET_NODE_ID) {
    return false;
  }
  if (nodeId === "struct.break") {
    return false;
  }
  if (isAnimCatalogNode(nodeId)) {
    return isAnimCatalogNodeAllowed(
      nodeId,
      options?.animationGraphHost,
      options,
    );
  }
  const isEditorEvent = (EDITOR_UTILITY_EVENT_TYPES as readonly string[]).includes(
    nodeId,
  );
  const isEditorBeginPlay = nodeId === EDITOR_BEGIN_PLAY_EVENT;
  if (isEditorBeginPlay) {
    return ancestryChain(options).includes("EditorUtilityObject");
  }
  if (
    isEditorEvent &&
    !ancestryChain(options).includes("EditorUtilityObject")
  ) {
    return false;
  }
  const chain = ancestryChain(options);
  const lineageEvents = lineageNativeEventTypes(chain);
  if (nodeId === GET_GAME_INSTANCE_NODE_ID) return !isEditorUtilityChain(chain);
  if (nodeId === "flow.event.scalabilityChanged") return !options?.animationGraphHost && (chain.includes("Actor") || chain.includes("ActorComponent") || lineageEvents.has(nodeId));
  if (nodeId === "flow.event.gameLoaded") return !options?.animationGraphHost && !isEditorUtilityChain(chain) &&
    (chain.includes("Actor") || chain.includes("ActorComponent") || chain.includes("Scene") || chain.includes("SceneSubsystem") || lineageEvents.has(nodeId));
  const isActorEvent = (ACTOR_EVENT_TYPE_IDS as readonly string[]).includes(nodeId);
  if (LINEAGE_NATIVE_EVENT_TYPES.has(nodeId)) {
    return lineageEvents.has(nodeId);
  }
  const functionBases = LINEAGE_FUNCTION_NODE_BASES[nodeId];
  if (functionBases) {
    return functionBases.some((base) => chain.includes(base));
  }
  const isBtLeafEvent = (BT_LEAF_EVENT_TYPE_IDS as readonly string[]).includes(
    nodeId,
  );
  const isFinish = (BT_TASK_ONLY_NODE_IDS as readonly string[]).includes(nodeId);
  const isReturn = (BT_DECORATOR_ONLY_NODE_IDS as readonly string[]).includes(
    nodeId,
  );
  const isBlackboard = (BT_BLACKBOARD_NODE_IDS as readonly string[]).includes(
    nodeId,
  );
  if (options?.animationGraphHost) {
    return (
      !isActorEvent &&
      !isEditorEvent &&
      !isBtLeafEvent &&
      !isFinish &&
      !isReturn &&
      !isBlackboard
    );
  }
  if (
    chain.includes("FunctionLibrary") ||
    chain.includes("EditorFunctionLibrary")
  ) {
    return (
      !isActorEvent &&
      !isEditorEvent &&
      !isBtLeafEvent &&
      !isFinish &&
      !isReturn &&
      !isBlackboard
    );
  }
  if (chain.includes("EditorUtilityObject")) {
    return !isActorEvent && !isBtLeafEvent && !isFinish && !isReturn && !isBlackboard;
  }
  if (chain.includes("BTTask")) {
    return (
      !isActorEvent &&
      !isEditorEvent &&
      nodeId !== "bt.event.evaluate" &&
      !isReturn
    );
  }
  if (chain.includes("BTDecorator")) {
    return (
      !isActorEvent &&
      !isEditorEvent &&
      !isFinish &&
      nodeId !== "bt.event.activate" &&
      nodeId !== "bt.event.tick" &&
      nodeId !== "bt.event.abort"
    );
  }
  if (chain.includes("BTService")) {
    return (
      !isActorEvent &&
      !isEditorEvent &&
      !isFinish &&
      !isReturn &&
      nodeId !== "bt.event.activate" &&
      nodeId !== "bt.event.abort" &&
      nodeId !== "bt.event.evaluate"
    );
  }
  if (chain.includes("BTComposite")) {
    return (
      !isActorEvent &&
      !isEditorEvent &&
      !isBtLeafEvent &&
      !isFinish &&
      !isReturn &&
      !isBlackboard
    );
  }
  if ((COLLISION_EVENT_TYPE_IDS as readonly string[]).includes(nodeId)) {
    return chain.includes("Actor");
  }
  if ((OVERLAY_MOUSE_EVENT_TYPE_IDS as readonly string[]).includes(nodeId)) {
    return chain.includes("SceneLayerActor");
  }
  if (
    nodeId === "flow.event.beginPlay" ||
    nodeId === "flow.event.destroyed"
  ) {
    return chain.includes("Actor") || chain.includes("ActorComponent");
  }
  if (nodeId === "flow.event.tick") {
    return chain.includes("Actor") || chain.includes("ActorComponent") || lineageEvents.has(nodeId);
  }
  if (nodeId === "flow.event.commandRun") {
    return chain.includes("Actor") || chain.includes("DebugCommand");
  }
  return !isBtLeafEvent && !isFinish && !isReturn && !isBlackboard;
}

export function nativeStubId(eventType: string): string {
  return `native:${eventType}`;
}
