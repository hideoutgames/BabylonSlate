/** Reliable ordered channel message types (never through the snapshot buffer). */

import type { SerializedScene } from "@babylonslate/core";

/** Slim widget rows the worker needs to spawn typed Widget objects. */
export type UserInterfaceWidgetMeta = {
  id: string;
  name?: string;
  kind: string;
  nestedUiGuid?: string;
};

/** UserInterface document metadata shipped on `loadUserInterfaces`. */
export type UserInterfaceRuntimeDocument = {
  guid: string;
  widgets: UserInterfaceWidgetMeta[];
};

export type UiWidgetEventKind =
  | "click"
  | "value"
  | "checked"
  | "text"
  | "pointerEnter"
  | "pointerExit"
  | "pointerDown"
  | "pointerUp";

/** ScriptHost export invoked for a main-thread widget event. */
export function uiWidgetEventExport(kind: UiWidgetEventKind): string {
  if (kind === "pointerEnter") return "onMouseEnter";
  if (kind === "pointerExit") return "onMouseExit";
  if (kind === "pointerDown") return "onMousePress";
  if (kind === "pointerUp") return "onMouseRelease";
  if (kind === "value") return "onWidgetValue";
  if (kind === "checked") return "onWidgetChecked";
  if (kind === "text") return "onWidgetText";
  return "onWidgetClick";
}

/** Main-thread widget input routed to the owning UserInterface object. */
export type UiWidgetEventControl = {
  type: "uiWidgetEvent";
  instanceId: string;
  widgetId: string;
  kind: UiWidgetEventKind;
  value?: unknown;
};

/** Source anchor mapping a generated line back to a graph node. */
export type ScriptAnchorPayload = {
  line: number;
  column: number;
  assetGuid: string;
  graphId: string;
  nodeId: string;
  bodyLine?: number;
};

export type ScriptConsoleCommand = {
  name: string;
  description: string;
  category: string;
  parameters: Array<{
    name: string;
    type: "string" | "float" | "int" | "bool" | "enum";
    optional?: boolean;
    defaultValue?: unknown;
    enumValues?: string[];
  }>;
};

/** One compiled graph asset shipped to the runtime for a class. */
export type ScriptBundleEntry = {
  assetGuid: string;
  classId: string;
  source: string;
  anchors: ScriptAnchorPayload[];
  entryPoints: Array<{
    name: string;
    event?: string;
    isAsync: boolean;
  }>;
  /** Present when the graph is a BDebugCommand OnCommandRun handler. */
  command?: ScriptConsoleCommand;
  /** Class registry parent; omitted scripts default to Actor at load. */
  parentClassId?: string;
  /** ScriptInterface asset guids this class implements. */
  implementedInterfaces?: string[];
  /** Class variable defaults applied at spawn when the caller omits them. */
  variables?: Array<{ name: string; type: string; defaultValue?: unknown }>;
  /** Function exports that implement ScriptInterface methods. */
  interfaceImplementations?: Array<{
    interfaceGuid: string;
    method: string;
    exportName: string;
  }>;
};

export type ControlMessage =
  | {
      type: "load";
      sceneAssetGuid: string;
      /** Authored scene document. When present, Play instantiates these actors. */
      scene?: SerializedScene;
      seed?: number;
      /** Scene physics world; defaults to 3d when omitted. */
      physicsWorld?: "3d" | "2d";
      gravity?: [number, number, number];
      /** Worker-resolvable URL for HavokPhysics.wasm (3d Play). */
      havokWasmUrl?: string;
      /** Session GameInstance class id from the scene/project picker. */
      gameInstanceClass?: string;
      /** Extra authored scenes `changescene` can instantiate by guid or name. */
      scenes?: Array<{ guid: string; scene: SerializedScene }>;
      /** When false, debug-tier console commands are stripped in the player. */
      includeDebugCommands?: boolean;
      infiniteLoopDetection?: boolean;
      loopCount?: number;
      /** Audio asset guids in the Play library (BT PlaySound fail-on-missing). */
      audioAssetGuids?: string[];
    }
  | {
      type: "loadScripts";
      scripts: ScriptBundleEntry[];
      /** Actors to spawn once the scripts are loaded. */
      spawn?: Array<{ classId: string; variables?: Record<string, unknown> }>;
    }
  | {
      type: "loadAnimGraphs";
      graphs: Array<{ guid: string; document: unknown }>;
    }
  | {
      type: "loadBehaviourTrees";
      trees: Array<{ guid: string; document: unknown }>;
      blackboards?: Array<{ guid: string; document: unknown }>;
    }
  | {
      type: "loadTilemaps";
      tilemaps: Array<{ guid: string; document: unknown }>;
      tilesets: Array<{ guid: string; document: unknown }>;
      pixelsPerUnit?: number;
    }
  | {
      type: "loadSprites";
      sprites: Array<{ guid: string; document: unknown }>;
      spriteAnimations: Array<{ guid: string; document: unknown }>;
      pixelsPerUnit?: number;
    }
  | { type: "loadNavMesh"; bytes: ArrayBuffer }
  | {
      type: "loadUserInterfaces";
      documents: UserInterfaceRuntimeDocument[];
    }
  | UiWidgetEventControl
  | { type: "play" }
  | { type: "pause" }
  | { type: "step" }
  | { type: "stop" }
  | { type: "setPaused"; paused: boolean }
  | { type: "console"; line: string }
  | { type: "inspect" };

export type CommandMessage =
  | {
      type: "spawn";
      slotId: number;
      actorGuid: string;
      classId: string;
    }
  | { type: "despawn"; slotId: number; actorGuid: string }
  | {
      type: "assignMesh";
      slotId: number;
      meshAssetGuid: string | null;
      /** Primitive mesh kind from MeshComponent (`box`, `sphere`, …). */
      meshKind?: string | null;
      light?: {
        color: [number, number, number];
        intensity: number;
        enabled: boolean;
        range?: number;
        innerAngle?: number;
        outerAngle?: number;
        castShadows?: boolean;
      };
      camera?: {
        projectionMode?: "perspective" | "orthographic";
        fieldOfView?: number;
        orthographicSize?: number;
        nearClip?: number;
        farClip?: number;
        isDefault?: boolean;
      };
      /** Extra renderable components parented to the actor origin mesh. */
      parts?: Array<{
        componentId: string;
        meshKind?: string | null;
        meshAssetGuid?: string | null;
        parentId?: string | null;
        position: [number, number, number];
        rotation: [number, number, number, number];
        scale: [number, number, number];
      }>;
      skybox?: {
        size: number;
        faces: {
          px: string | null;
          py: string | null;
          pz: string | null;
          nx: string | null;
          ny: string | null;
          nz: string | null;
        };
      };
    }
  | { type: "possessCamera"; slotId: number }
  | { type: "setShadowQuality"; level: string }
  | {
      /** Canonical scene after `changescene` / `ctx.changeScene`. */
      type: "activeScene";
      sceneAssetGuid: string;
    }
  | {
      /**
       * Bind a Material asset to a spawned actor. `componentId` targets one
       * visual component; omitting it overrides the whole actor.
       */
      type: "assignMaterial";
      slotId: number;
      materialAssetGuid: string | null;
      componentId?: string | null;
    }
  | {
      type: "log";
      severity: "verbose" | "log" | "warning" | "error";
      category: string;
      message: string;
      frameId: number;
    }
  | {
      type: "diagnostic";
      code: string;
      message: string;
      assetGuid?: string;
      graphId?: string;
      nodeId?: string;
      btNodeId?: string;
      bodyLine?: number;
      stack?: string;
      frameId: number;
      severity: "error" | "warning";
    }
  | {
      type: "stats";
      frameId: number;
      tickIndex: number;
      scriptMs: number;
      physicsMs: number;
      fps?: number;
    }
  | {
      type: "print";
      message: string;
      key: string;
      duration: number;
      color: { x: number; y: number; z: number; w: number };
      frameId: number;
    }
  | {
      type: "consoleResult";
      success: boolean;
      output: string;
    }
  | {
      type: "inspectSnapshot";
      snapshot: {
        tickIndex: number;
        nodes: Array<{
          id: string;
          kind: "gameInstance" | "actor" | "component";
          label: string;
          classId: string;
          parentId: string | null;
          transform?: {
            position: [number, number, number];
            rotation: [number, number, number, number];
            scale: [number, number, number];
          };
          variables: Record<string, unknown>;
          variableTypes?: Record<string, string>;
        }>;
      };
    }
  | {
      type: "trace";
      payload: Record<string, unknown>;
    }
    | {
      type: "uiSetVisible";
      instanceId: string;
      widgetId: string;
      visible: boolean;
    }
    | {
      type: "uiApply";
      instanceId: string;
      classId: string;
      assetGuid: string;
    }
    | {
      type: "uiRemove";
      instanceId: string;
    }
  | {
      type: "animState";
      slotId: number;
      stateId: string;
      normalisedTime: number;
      blendWeights: Record<string, number>;
      clipName?: string;
      clipKind?: "animation" | "sprite";
      clipAssetGuid?: string;
      justFinished?: boolean;
      justLooped?: boolean;
      layers?: Array<{
        stateId: string;
        clipAssetGuid: string;
        clipName: string;
        clipKind: "animation" | "sprite";
        normalisedTime: number;
        weight: number;
      }>;
    }
  | {
      type: "btState";
      slotId: number;
      status: "success" | "failure" | "running";
      btNodeId: string | null;
      lastResults: Record<string, string>;
      blackboard: Record<string, unknown>;
      stack: Array<{ nodeId: string; childIndex: number; opened: boolean }>;
    }
  | {
      type: "playSound";
      assetGuid: string;
      volume: number;
      frameId: number;
      emitterActorGuid?: string | null;
      loop?: boolean;
      voiceId?: string;
    }
  | { type: "stopSound"; voiceId: string }
  | { type: "setChannelVolume"; channelGuid: string; volume: number }
  | { type: "setGlobalVolume"; volume: number }
  | {
      type: "assignParticle";
      slotId: number;
      actorGuid: string;
      componentId: string;
      particleSystemGuid: string | null;
      play?: boolean;
    }
  | {
      type: "setParticlePlaying";
      actorGuid: string;
      componentId?: string;
      playing: boolean;
    }
  | {
      type: "setRenderResolution";
      width: number;
      height: number;
    }
  | {
      type: "setInputMode";
      mode: "All" | "Interface" | "Game";
    };

export type BridgeHostMessage =
  | { channel: "control"; payload: ControlMessage }
  | { channel: "input"; payload: ArrayBuffer | SharedArrayBuffer }
  | { channel: "rpc"; payload: unknown }
  /** Hands a consumed transferable snapshot buffer back for reuse (no per-frame alloc). */
  | { channel: "recycleSnapshot"; payload: ArrayBuffer };

export type BridgeWorkerMessage =
  | { channel: "command"; payload: CommandMessage }
  | { channel: "snapshot"; payload: ArrayBuffer; transferable?: true }
  | { channel: "rpc"; payload: unknown };
