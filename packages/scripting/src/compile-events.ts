import type { GraphNode } from "./ir";
import type { ScriptEventName } from "./compile-types";

export const EVENT_BY_TYPE_ID: Record<string, ScriptEventName> = {
  "flow.event.beginPlay": "onBeginPlay",
  "flow.event.scalabilityChanged": "onScalabilityChanged",
  "flow.event.gameLoaded": "onGameLoaded",
  "flow.event.saveMigration": "onSaveMigration",
  "flow.event.tick": "onTick",
  "flow.event.destroyed": "onDestroyed",
  "flow.event.init": "onInit",
  "flow.event.end": "onEnd",
  "flow.event.firstSceneLoaded": "onFirstSceneLoaded",
  "flow.event.sceneStartLoading": "onSceneStartLoading",
  "flow.event.sceneFinishLoading": "onSceneFinishLoading",
  "flow.event.sceneExit": "onSceneExit",
  "flow.event.sceneLoaded": "onSceneLoaded",
  "flow.event.streamedSceneLoaded": "onStreamedSceneLoaded",
  "flow.event.streamedSceneUnloaded": "onStreamedSceneUnloaded",
  "flow.event.sceneLayerAdded": "onSceneLayerAdded",
  "flow.event.sceneLayerRemoved": "onSceneLayerRemoved",
  "flow.event.sceneActorSpawned": "onSceneActorSpawned",
  "flow.event.sceneActorDestroyed": "onSceneActorDestroyed",
  "flow.event.hit": "onHit",
  "flow.event.beginOverlap": "onBeginOverlap",
  "flow.event.endOverlap": "onEndOverlap",
  "flow.event.commandRun": "onCommandRun",
  "flow.event.editorBeginPlay": "onEditorBeginPlay",
  "flow.event.editorStartup": "onEditorStartup",
  "flow.event.sceneOpen": "onSceneOpen",
  "flow.event.sceneSaved": "onSceneSaved",
  "flow.event.editorShutdown": "onEditorShutdown",
  "flow.event.onMouseEnter": "onMouseEnter",
  "flow.event.onMouseLeave": "onMouseLeave",
  "flow.event.onClick": "onClick",
  "flow.event.onPressStart": "onPressStart",
  "flow.event.onPressEnd": "onPressEnd",
  "flow.event.textChanged": "onTextChanged",
  "flow.event.focusEnter": "onFocusEnter",
  "flow.event.focusLeave": "onFocusLeave",
  "flow.event.focusActivate": "onFocusActivate",
  "flow.event.uiValueChanged": "onUIValueChanged",
  "flow.event.uiRangeChanged": "onUIRangeChanged",
  "flow.event.uiCheckedChanged": "onUICheckedChanged",
  "flow.event.uiTextChanged": "onUITextChanged",
  "flow.event.uiTextSubmitted": "onUITextSubmitted",
  "flow.event.uiSelectionChanged": "onUISelectionChanged",
  "flow.event.sceneLayerActorSwitching": "onSceneLayerActorSwitching",
  "flow.event.sceneLayerActorSwitched": "onSceneLayerActorSwitched",
  "flow.event.sceneLayerActorSwitchedTo": "onSceneLayerActorSwitchedTo",
  "flow.event.sceneLayerActorSwitchedFrom": "onSceneLayerActorSwitchedFrom",
  "flow.event.audioFinished": "onAudioFinished",
  "flow.event.movementStarted": "onMovementStarted",
  "flow.event.movementStopped": "onMovementStopped",
  "flow.event.movementJumped": "onMovementJumped",
  "flow.event.movementLeftGround": "onMovementLeftGround",
  "flow.event.movementLanded": "onMovementLanded",
  "bt.event.activate": "onActivate",
  "bt.event.tick": "onBtTick",
  "bt.event.abort": "onAbort",
  "bt.event.evaluate": "onEvaluate",
  "anim.event.initialize": "onInitializeAnimation",
  "anim.event.update": "onUpdateAnimation",
  // Input event entries gate internally; they run on the tick like Event Tick.
  "input.actionEvent": "onTick",
  "input.axisEvent": "onTick",
  "input.onAnyKeyPressed": "onTick",
  "input.onGamepadConnected": "onTick",
  "input.onGamepadDisconnected": "onTick",
  "input.onTouchBegan": "onTick",
  "input.onTouchMoved": "onTick",
  "input.onTouchEnded": "onTick",
};

/** Touch event nodes and the `engine:TouchPhase` records each one runs for. */
export const TOUCH_EVENT_PHASES: Readonly<Record<string, readonly string[]>> = {
  "input.onTouchBegan": ["Began"],
  "input.onTouchMoved": ["Moved"],
  "input.onTouchEnded": ["Ended", "Cancelled"],
};

/** On Touch Began, On Touch Moved and On Touch Ended. */
export function isTouchEventNodeType(typeId: string): boolean {
  return Object.hasOwn(TOUCH_EVENT_PHASES, typeId);
}

/** Custom events use the member name; catalog events use EVENT_BY_TYPE_ID. */
export function eventNameForEntry(
  entry: Pick<GraphNode, "typeId" | "properties">,
): ScriptEventName | undefined {
  if (entry.typeId === "flow.event.custom") {
    const raw = entry.properties.name;
    return typeof raw === "string" && raw.length > 0 ? jsIdent(raw) : undefined;
  }
  return EVENT_BY_TYPE_ID[entry.typeId];
}

export function jsIdent(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/**
 * Function-local `let` name, prefixed so authored names cannot collide with `ctx`.
 * Not injective: `Move Speed` and `Move_Speed` share one, which validation reports.
 */
export function localVariableIdent(name: string): string {
  return `__lv_${jsIdent(name)}`;
}

/**
 * Input events whose chain runs only on ticks where the input fired; the
 * trace reports their visit inside the gate, not on every tick.
 */
export const GATED_EVENT_TYPE_IDS: ReadonlySet<string> = new Set([
  "input.actionEvent",
  "input.axisEvent",
  "input.onAnyKeyPressed",
  "input.onGamepadConnected",
  "input.onGamepadDisconnected",
  ...Object.keys(TOUCH_EVENT_PHASES),
]);
