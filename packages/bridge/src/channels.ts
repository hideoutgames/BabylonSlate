/** Reliable ordered channel message types (never through the snapshot buffer). */

import type { SerializedScene, SerializedSceneLayer } from "@babylonslate/core";

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
    componentId?: string;
  }>;
  /** Present when the graph is a BDebugCommand OnCommandRun handler. */
  command?: ScriptConsoleCommand;
  /** Class registry parent; omitted scripts default to Actor at load. */
  parentClassId?: string;
  /** ScriptInterface asset guids this class implements. */
  implementedInterfaces?: string[];
  /** Class variable defaults applied at spawn when the caller omits them. */
  variables?: Array<{
    name: string;
    type: string;
    defaultValue?: unknown;
    container?: "single" | "array" | "map";
    keyTypeId?: string;
    keyTypeClassId?: string;
  }>;
  /** Function exports that implement ScriptInterface methods. */
  interfaceImplementations?: Array<{
    interfaceGuid: string;
    method: string;
    exportName: string;
  }>;
  /** Omitted flags default to true at spawn. */
  actorDefaults?: {
    generateHitEvents?: boolean;
    generateOverlapEvents?: boolean;
  };
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
      /** Overlay documents the session compositor can instantiate by guid or name. */
      sceneLayers?: Array<{ guid: string; layer: SerializedSceneLayer }>;
      /** When false, debug-tier console commands are stripped in the player. */
      includeDebugCommands?: boolean;
      infiniteLoopDetection?: boolean;
      loopCount?: number;
      /** Audio asset guids in the Play library (BT PlaySound fail-on-missing). */
      audioAssetGuids?: string[];
      /** Animation / Sprite Animation clip metadata for BT Play Animation. */
      animClipCatalog?: Array<{
        guid: string;
        type: string;
        name: string;
        clipName?: string;
        durationMs?: number;
        skeletonGuid?: string | null;
        modelGuid?: string;
      }>;
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
  | { type: "play" }
  | { type: "pause" }
  | { type: "step" }
  | { type: "stop" }
  | { type: "setPaused"; paused: boolean }
  | { type: "console"; line: string }
  | { type: "inspect" }
  | {
      type: "sceneLayerPointer";
      layerId: string;
      actorGuid: string;
      event:
        | "onMouseEnter"
        | "onMouseLeave"
        | "onClick"
        | "onPressStart"
        | "onPressEnd";
    }
  | {
      type: "sceneLayerResize";
      frustumWidth: number;
      frustumHeight: number;
    };

export type DebugColliderPrimitive = {
  id: string;
  shape: "box" | "sphere" | "circle" | "polyline" | "capsule";
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  halfExtents?: { x: number; y: number; z: number };
  radius?: number;
  halfHeight?: number;
  points?: Array<{ x: number; y: number; z: number }>;
};

export type DebugDrawVec3 = { x: number; y: number; z: number };
export type DebugDrawColor = { x: number; y: number; z: number; w: number };
export type DebugDrawRotator = { pitch: number; yaw: number; roll: number };

export type DebugDrawKind =
  | "line"
  | "point"
  | "box"
  | "sphere"
  | "circle"
  | "rectangle"
  | "square"
  | "cone"
  | "cylinder"
  | "arrow"
  | "frustum"
  | "coordinateSystem";

export type DebugDrawCommand = {
  type: "debugDraw";
  kind: DebugDrawKind;
  duration: number;
  color: DebugDrawColor;
  frameId: number;
  start?: DebugDrawVec3;
  end?: DebugDrawVec3;
  thickness?: number;
  position?: DebugDrawVec3;
  size?: number;
  center?: DebugDrawVec3;
  extent?: DebugDrawVec3;
  rotation?: DebugDrawRotator;
  radius?: number;
  segments?: number;
  width?: number;
  height?: number;
  origin?: DebugDrawVec3;
  direction?: DebugDrawVec3;
  length?: number;
  angle?: number;
  fov?: number;
  aspect?: number;
  near?: number;
  far?: number;
  scale?: number;
};

export type CommandMessage =
  | {
      type: "spawn";
      slotId: number;
      actorGuid: string;
      classId: string;
      /** Live overlay instance id when this actor belongs to a SceneLayer. */
      sceneLayerId?: string | null;
    }
  | { type: "despawn"; slotId: number; actorGuid: string }
  | {
      type: "assignMesh";
      slotId: number;
      meshAssetGuid: string | null;
      /** Overlay actor guid for HitTest / pointer events. */
      actorGuid?: string | null;
      /** Overlay HitTest for the actor visual (`ignore` is not pickable). */
      hitTest?: "ignore" | "block" | "passThrough";
      /** Overlay actor has a `2DButtonComponent`. */
      hasButton?: boolean;
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
        hitTest?: "ignore" | "block" | "passThrough";
        text3d?: {
          text: string;
          size: number;
          depth: number;
          color: [number, number, number];
          fontAssetGuid: string | null;
        };
        text2d?: {
          text: string;
          size: number;
          color: [number, number, number];
          fontAssetGuid: string | null;
          renderer: "bitmap" | "msdf";
          outline: number;
          outlineColor: [number, number, number];
          alignment: "left" | "center" | "right";
          bold: boolean;
          italic: boolean;
          underline: boolean;
          wrapWidth: number;
        };
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
      text3d?: {
        text: string;
        size: number;
        depth: number;
        color: [number, number, number];
        fontAssetGuid: string | null;
      };
      text2d?: {
        text: string;
        size: number;
        color: [number, number, number];
        fontAssetGuid: string | null;
        renderer: "bitmap" | "msdf";
        outline: number;
        outlineColor: [number, number, number];
        alignment: "left" | "center" | "right";
        bold: boolean;
        italic: boolean;
        underline: boolean;
        wrapWidth: number;
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
  | DebugDrawCommand
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
      sortingLayer?: string;
      orderInLayer?: number;
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
  | { type: "sessionPaused"; paused: boolean }
  | { type: "setRenderQuality"; level: string }
  | { type: "setResolutionScale"; scale: number }
  | { type: "setFrameCap"; fps: number }
  | { type: "setFreeCam"; enabled: boolean }
  | { type: "setShowFps"; enabled: boolean }
  | { type: "setStat"; name: string; enabled: boolean }
  | { type: "setWireframe"; enabled: boolean }
  | { type: "setShowBounds"; enabled: boolean }
  | { type: "setShowCollision"; enabled: boolean }
  | { type: "setShowNav"; enabled: boolean }
  | { type: "setShowAudioDebug"; enabled: boolean }
  | {
      type: "debugColliders";
      colliders: readonly DebugColliderPrimitive[];
    }
  | {
      type: "sceneLayerCreate";
      layerId: string;
      assetGuid: string;
      zOrder: number;
      ownerSceneGuid: string | null;
      postProcessStack: Array<{ materialGuid: string; enabled: boolean }>;
    }
  | { type: "sceneLayerRemove"; layerId: string }
  | { type: "sceneLayerClear" }
  | {
      type: "sceneLayerPostProcess";
      layerId: string;
      postProcessStack: Array<{ materialGuid: string; enabled: boolean }>;
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
