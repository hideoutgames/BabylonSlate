import type { ScalabilityTransaction, ScalabilityAcknowledgement, RenderPathStatus, RenderProjectSettings, ScenePostProcessEntry, MaterialParameterCatalog, MaterialParameterValue, SceneLayerCamera } from "@haptic/core";
/** Reliable ordered channel message types (never through the snapshot buffer). */

import type { ActorDefaults, CollisionTriangleMesh, SerializedComponent, SerializedScene, SerializedSceneLayer } from "@haptic/core";

/** Rest-pose Complex Collision triangles for one Model; typed arrays clone as one memcpy. */
export type CookedCollisionMeshEntry = { guid: string } & CollisionTriangleMesh;

/** Serializable runtime override of one named Material Graph parameter. */
export type { MaterialParameterValue } from "@haptic/core";

export type GameSessionMode = "play" | "simulate" | "preview";
/** `rendering`: the view holds its last image while WebGPU render pipelines it needs compile. */
export type SessionPauseReason = "user" | "lifecycle" | "loading" | "rendering";
/**
 * What a Simulation paused on: the diagnostic that first came from its node (`pauseOnErrors`), or a
 * breakpoint (code `BREAKPOINT_PAUSE_CODE`).
 */
export type SessionPauseCause = {
  code: string;
  message: string;
  assetGuid?: string;
  graphId?: string;
  nodeId?: string;
  btNodeId?: string;
  bodyLine?: number;
  /** A breakpoint's event or function entry node, in the same graph. */
  entryNodeId?: string;
  /** The object a breakpoint stopped on, and its name as the Debug Instance list shows it. */
  instanceId?: string;
  instanceLabel?: string;
};
/** `SessionPauseCause.code` of a breakpoint stop. */
export const BREAKPOINT_PAUSE_CODE = "runtime.breakpoint";
/** A node breakpoint: editor state sent to the session, never stored in the asset. */
export type BreakpointLocation = { assetGuid: string; graphId: string; nodeId: string };
export type SessionBoundaryRequest = {
  sessionGeneration: number;
  /** Strictly increasing within this session; acknowledgments never use FIFO correlation. */
  requestId: number;
  /** `step` runs one tick of a session paused only by the user, which stays paused after it. */
  action: { kind: "pause"; reason: SessionPauseReason; paused: boolean } | { kind: "resetInput" } | { kind: "step" };
};
export type SessionBoundaryResult = {
  sessionGeneration: number;
  requestId: number;
  success: boolean;
  reason?: string;
  paused: boolean;
  pauseReasons: SessionPauseReason[];
  tickIndex: number;
  sceneAssetGuid: string;
  sceneLoadId: number;
  commandRevision: number;
};

export interface PlayLightProperties {
  color: [number, number, number];
  intensity: number;
  enabled: boolean;
  range?: number;
  innerAngle?: number;
  outerAngle?: number;
  castShadows?: boolean;
  shadowPriority?: number;
  groundColor?: [number, number, number];
}

export interface PlayCameraProperties {
  projectionMode?: "perspective" | "orthographic";
  fieldOfView?: number;
  orthographicSize?: number;
  nearClip?: number;
  farClip?: number;
  isDefault?: boolean;
}

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
  /** Owning catalog asset identity, independent of the source's authoring path. */
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
    typeClassId?: string;
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
  /** Omitted flags inherit from the parent Class; engine bases are enabled. */
  actorDefaults?: ActorDefaults;
  /** Effective prefab component templates for runtime Spawn Actor. */
  components?: SerializedComponent[];
};

/** Complete currently owned source metadata; omitted collections become empty. */
export interface RuntimeSceneContent {
  assetGuids: string[];
  sceneLayers?: Array<{ guid: string; layer: SerializedSceneLayer }>;
  sceneNavmeshBytes?: Record<string, Uint8Array>;
  dataAssets?: import("@haptic/core").DataAssetCatalogEntry[];
  audioAssetGuids?: string[];
  materialParameterCatalog?: MaterialParameterCatalog;
  materialTextureAssetGuids?: string[];
  renderTargets?: Record<string, import("@haptic/core").RenderTargetPayload>;
  renderTargetTextures?: Record<string, import("@haptic/core").RenderTargetTexturePayload>;
  animClipCatalog?: Array<{ guid: string; type: string; name: string; clipName?: string; durationMs?: number; skeletonGuid?: string | null; modelGuid?: string }>;
}

export type ControlMessage =
  | ({ type: "quiesceSimulation" } & import("./simulation-capture").SimulationQuiesceRequest)
  | ({ type: "captureSimulationState" } & import("./simulation-capture").SimulationCaptureRequest)
  | ({ type: "runtimeMaterialEditPrepared" | "runtimeMaterialEditApplied" } & import("./runtime-material-edit").RuntimeMaterialEditResponse)
  | ({ type: "diagnosticOperation" } & import("./diagnostic-operation").DiagnosticOperationRequest)
  | ({ type: "runtimeInspector" } & import("./runtime-inspector").RuntimeInspectorRequest)
  | { type: "cancelRuntimeInspector"; sessionGeneration: number; requestId: number }
  | ({ type: "sessionBoundary" } & SessionBoundaryRequest)
  | ({ type: "loadSceneContent" } & RuntimeSceneContent)
  | { type: "saveStorageResponse"; response: import("@haptic/core").SaveStorageResponse }
  | { type: "ragdollPoseCaptured"; slotId: number; requestId: string; bones?: import("@haptic/core").RagdollBonePose[]; error?: string }
  | {
      type: "load";
      sessionGeneration?: number;
      sessionMode?: GameSessionMode;
      deferMaterialEdits?: boolean;
      simulationAssetGuids?: string[];
      saveGame?: import("@haptic/core").SaveGameConfiguration;
      dataAssets?: import("@haptic/core").DataAssetCatalogEntry[];
      /** Packaged authored assets for the Asset Registry nodes, snapshotted when the session starts. */
      assetCatalog?: import("@haptic/core").RuntimeAssetCatalogEntry[];
      /** Initial session render cap, shared with the renderer for console readback. */
      frameCap?: number;
      /** Serialized trace retention budget in bytes for this session. */
      traceByteBudget?: number;
  renderSettings?: Partial<RenderProjectSettings>;
      project?: { name: string; version: string };
      sceneAssetGuid: string;
      /** Authored Input Action / Input Axis assets; omitted loads use the starter controls. */
      inputAssets?: import("@haptic/core").InputAssetDefinition[];
      focusNavigation?: import("@haptic/core").FocusNavigationSettings;
      pixelsPerUnit?: number;
      texturePixelSizes?: Record<string, { width: number; height: number }>;
      /** Authored scene document. When present, Play instantiates these actors. */
      scene?: SerializedScene;
      seed?: number;
      /** Scene physics world; defaults to 3d when omitted. */
      physicsWorld?: "3d" | "2d";
      gravity?: [number, number, number];
      /** Project Collision Presets (`PhysicsProjectSettings.collisionPresets`). */
      collisionPresets?: import("@haptic/core").CollisionPreset[];
      /** Worker-resolvable URL for HavokPhysics.wasm (3d Play). */
      havokWasmUrl?: string;
      /** Session GameInstance class id from the scene/project picker. */
      gameInstanceClass?: string;
      /** Extra authored scenes `changescene` can instantiate by guid or name. */
      scenes?: Array<{ guid: string; scene: SerializedScene }>;
      /** Metadata-only scene catalog. Documents and dependencies are acquired from the host on demand. */
      sceneCatalog?: Array<{ guid: string; name: string }>;
      classAssetGuids?: Record<string, string>;
      consoleCommands?: Array<import("@haptic/core").ConsoleCommandMetadata & { classId: string; assetGuid: string }>;
      /** Baked navigation by canonical scene guid, selected before Begin Play. */
      sceneNavmeshBytes?: Record<string, Uint8Array>;
      /** Overlay documents the session compositor can instantiate by guid or name. */
      sceneLayers?: Array<{ guid: string; layer: SerializedSceneLayer }>;
      /** When false, debug-tier console commands are stripped in the player. */
      includeDebugCommands?: boolean;
      /** False strips the debug lines of Line Trace and Project Cursor To Scene, even for an explicit `drawDebug: true`. True when omitted; release players send false. */
      traceDebugDraw?: boolean;
      infiniteLoopDetection?: boolean;
      loopCount?: number;
      /** Simulation: pause the first time each node reports an error, and send `sessionPaused` with its cause. */
      pauseOnErrors?: boolean;
      /** Node breakpoints set when the session starts; scripts must be compiled with `instrumentBreakpoints`. */
      breakpoints?: BreakpointLocation[];
      /** Audio asset guids in the Play library (BT PlaySound fail-on-missing). */
      audioAssetGuids?: string[];
      /** Fully lowered root parameter metadata, generated by the content host. */
      materialParameterCatalog?: MaterialParameterCatalog;
      /** Loaded 2D Texture assets; environment containers are excluded. */
      materialTextureAssetGuids?: string[];
      renderTargets?: Record<string, import("@haptic/core").RenderTargetPayload>;
      renderTargetTextures?: Record<string, import("@haptic/core").RenderTargetTexturePayload>;
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
      /**
       * Play overlay / player: hold OnSceneFinishLoading until the host posts
       * `sceneModelsReady`. Headless tests omit this so finish is synchronous.
       */
      deferSceneModelsReady?: boolean;
      /** Acquire/paint host Loading UI before departing Scene teardown. */
      deferSceneLoadingPaint?: boolean;
    }
  | {
      type: "loadScripts";
      scripts: ScriptBundleEntry[];
      /** Complete source union, including every surviving owner. */
      replace?: boolean;
      /** Request readiness only after evaluation and class registration finish. */
      requestId?: number;
      /** Explicit boot spawn requests. Omitted or empty only loads the classes. */
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
      type: "loadWater";
      waters: Array<{ guid: string; document: unknown }>;
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
  | {
      type: "loadModels";
      models: Array<{ guid: string; document: unknown }>;
      /** Up-front cooked meshes for Models the content scan marks as Complex Collision. */
      complexMeshes?: CookedCollisionMeshEntry[];
    }
  | {
      /** Host answer to `requestComplexCollision`; kept beside `loadModels` meshes for the session. */
      type: "loadComplexCollision";
      meshes: CookedCollisionMeshEntry[];
      /** Requested Models the host could not cook (source not loaded, or no triangles). */
      unavailable?: string[];
    }
  | {
      type: "loadNavMesh";
      /**
       * The Play scene's baked navmesh. A host may transfer it, so it must be a private
       * copy. Omit it when `load.sceneNavmeshBytes` already carries the Play
       * scene's mesh: the worker then imports that catalog entry instead of a second copy.
       */
      bytes?: ArrayBuffer;
    }
  | { type: "play" }
  | { type: "step" }
  | { type: "stop" }
  /**
   * Pauses the game, or resumes it. `reason: "rendering"` is the host's render hold (the view waits for
   * GPU work): it stops time only, so held input stays held; omitted, the pause also resets input.
   */
  | { type: "setPaused"; paused: boolean; reason?: "rendering" }
  /**
   * The editor's graph debugger watches `target` (null stops) and follows `instanceId` (null follows
   * nothing). The runtime publishes `debugRoster` for the target and, only for the followed instance,
   * a per-tick `executionTrace` (and, for a Behaviour Tree, its `btState`). Each message replaces the
   * previous request.
   */
  | { type: "debugObserve"; target: DebugObserveTarget | null; instanceId: string | null }
  /** Replaces the session's node breakpoints. */
  | { type: "setBreakpoints"; breakpoints: BreakpointLocation[] }
  | { type: "console"; line: string }
  | { type: "inspect" }
  | { type: "sceneLayerFocusNavigate"; reverse: boolean }
  | {
      type: "sceneLayerControl";
      layerId: string;
      actorGuid: string;
      componentId: string;
      action: "change" | "commit" | "focus" | "blur" | "activate";
      value?: number | boolean | string;
      /** Range slider's upper value; value carries its lower value. */
      secondaryValue?: number;
    }
  | { type: "sceneLayerScroll"; layerId: string; actorId: string; componentId: string; deltaX: number; deltaY: number }
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
      componentId?: string;
    }
  | {
      type: "sceneLayerResize";
      frustumWidth: number;
      frustumHeight: number;
      canvasWidth?: number;
      canvasHeight?: number;
      /** Browser safe-area insets in CSS pixels. */
      safeAreaInsets?: Partial<import("@haptic/core").OverlaySafeAreaInsets>;
    }
  | { type: "audioVoiceEnded"; voiceId: string }
  | { type: "assetPreloadResult"; preloadId: string; success: boolean; error?: string; progress?: number }
  | { type: "assetLoadStates"; states: Array<{ guid: string; state: import("@haptic/core").RuntimeAssetLoadState }> }
  | { type: "sceneLoadingPainted"; sceneAssetGuid: string; sceneLoadId: number }
  | { type: "sceneLayerLoadingPainted"; layerId: string; layerLoadId: number }
  | { type: "sceneLayerReady"; layerId: string; layerLoadId: number }
  | { type: "sceneModelsReady"; sceneAssetGuid: string; sceneLoadId: number }
  | { type: "sceneStreamReady"; actorGuid: string; streamLoadId: number }
  | { type: "sceneStreamProgress"; actorGuid: string; streamLoadId: number; progress: number }
  | { type: "sceneStreamFailed"; actorGuid: string; streamLoadId: number; message: string }
  | { type: "sceneSourceResponse"; requestId: number; scene?: SerializedScene; error?: string }
  /** Engine-reported render path status for `renderpath` console readback. */
  | ({ type: "renderPathStatus" } & RenderPathStatus)
  | { type: "scalabilityStatus"; acknowledgement: ScalabilityAcknowledgement };

export type DebugColliderPrimitive = {
  id: string;
  shape: "box" | "sphere" | "circle" | "polyline" | "capsule" | "capsule2d" | "cylinder" | "convex" | "mesh";
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  halfExtents?: { x: number; y: number; z: number };
  radius?: number;
  halfHeight?: number;
  height?: number;
  points?: Array<{ x: number; y: number; z: number }>;
  indices?: number[];
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

export type DebugNavAgent = {
  actorGuid: string;
  actorName: string;
  position: DebugDrawVec3;
  velocity: DebugDrawVec3;
  radius: number;
  height: number;
  target: DebugDrawVec3 | null;
  /** Current crowd corridor corners in scene coordinates, starting at the agent. */
  path: DebugDrawVec3[];
  state: string;
};

export type DebugBehaviourTree = {
  actorGuid: string;
  actorName: string;
  treeGuid: string;
  treeName: string;
  slotId: number;
  status: "success" | "failure" | "running" | "idle";
  btNodeId: string | null;
  lastResults: Record<string, string>;
  blackboard: Record<string, unknown>;
  /** Declared types preserve Tag identities and collection shapes in inspection. */
  blackboardTypes?: Record<string, string>;
  stack: Array<{ nodeId: string; childIndex: number; opened: boolean }>;
  nodes: Array<{
    id: string;
    kind: string;
    classId: string;
    children: string[];
    decorators: Array<{ id: string; classId: string }>;
    services: Array<{ id: string; classId: string }>;
  }>;
};

/**
 * What the editor's graph debugger watches while a Simulation runs.
 * - `class`: the live instances whose class is exactly `classId`.
 * - `behaviourTree`: the Behaviour Tree components that run the tree asset `assetGuid`.
 * - `animationGraph`: the Animation Graph components that run the graph asset `assetGuid`; the same
 *   instances serve its State Machine and its Animation Object graph.
 */
export type DebugObserveTarget =
  | { kind: "class"; classId: string }
  | { kind: "behaviourTree"; assetGuid: string }
  | { kind: "animationGraph"; assetGuid: string };

/** One live object a graph can be debugged against. */
export type DebugInstance = {
  /** Guid of the actor, component, Game Instance or subsystem. */
  id: string;
  kind: "actor" | "component" | "gameInstance" | "subsystem";
  /** The object's name, else its class id. */
  label: string;
  /** A component's owning actor, by the same rule. */
  ownerLabel?: string;
};

/**
 * What ran in one graph for the observed instance during one tick. A compiled graph names its asset
 * as script diagnostics do (a Class or Animation Graph asset path). A graph the runtime evaluates
 * itself names its asset by guid.
 */
export type DebugGraphTrace = {
  assetGuid: string;
  /** `event-graph`, a function graph's export name, `animation-object`, `state-machine` or `behaviour-tree`. */
  graphId: string;
  /**
   * Nodes that ran, in first-visit order. A Behaviour Tree reports the nodes its evaluation entered,
   * resumed or ticked; an Animation Graph's State Machine the states it sampled, including one a
   * blend is leaving.
   */
  nodes: string[];
  /**
   * Wires taken: exec wires, the parent-child links a Behaviour Tree evaluation went down, or an
   * Animation Graph transition (as the id of the edge the canvas draws for it).
   */
  edges: string[];
  /** Values that changed since the last report: node id, pin id, whether read or produced, display text. */
  values: Array<[nodeId: string, pinId: string, direction: "in" | "out", text: string]>;
};

export type CommandMessage =
  | { type: "simulationRetentionUnavailable"; sessionGeneration: number; reason: string }
  | ({ type: "simulationQuiesced" } & SessionBoundaryResult)
  | { type: "simulationCaptureChunk"; sessionGeneration: number; requestId: number; sequence: number; bytes: Uint8Array }
  | { type: "simulationCaptureResult"; sessionGeneration: number; requestId: number; result: import("./simulation-capture").SimulationCaptureSummary }
  | ({ type: "prepareRuntimeMaterialEdit" } & import("./runtime-material-edit").RuntimeMaterialEditPreparation)
  | { type: "releaseRuntimeMaterialPreparation"; sessionGeneration: number; editToken: string; committed: boolean }
  | ({ type: "diagnosticOperationResult" } & import("./diagnostic-operation").DiagnosticOperationResult)
  | ({ type: "performanceTicks" } & import("./diagnostic-operation").PerformanceTickChunk)
  | { type: "diagnosticOperationStopped"; sessionGeneration: number; recordingId: string; kind: "profile" | "frame"; reason: "requested" | "duration" | "budget" | "session-ended" }
  | ({ type: "runtimeInspectorResult" } & import("./runtime-inspector").RuntimeInspectorResult)
  | ({ type: "sessionBoundaryResult" } & SessionBoundaryResult)
  | { type: "saveStorageRequest"; request: import("@haptic/core").SaveStorageRequest }
  | { type: "setUIControl2D"; slotId: number; componentId: string; uiControl: { classId: string; properties: import("@haptic/core").UIControl2DProperties }; focused?: boolean; beginEditing?: boolean }
  | { type: "setPainter2D"; slotId: number; componentId: string; painter: import("@haptic/core").Painter2DProperties }
  | { type: "dynamicMeshUpdate"; meshId: number; update: import("@haptic/core").DynamicMeshUpdate }
  /** Cable records: ID, count, start/end actor slots, two actor-local anchors, world xyz particles. */
  | { type: "cableFrame"; frameId: number; data: Float32Array }
  | { type: "captureRenderTarget"; actorGuid: string }
  | {
      type: "configureRenderTargetCapture";
      actorGuid: string;
      slotId: number;
      settings: import("@haptic/core").RenderTargetCaptureProperties | null;
      transform?: import("@haptic/core").Transform;
    }
  | { type: "captureRagdollPose"; slotId: number; requestId: string; boneNames: string[] }
  | { type: "setRagdollPose"; slotId: number; requestId: string; bones: import("@haptic/core").RagdollBonePose[] }
  | { type: "clearRagdollPose"; slotId: number; requestId: string }
  /** Simulated water time the main physics step evaluated, for the snapshot frame that step publishes. */
  | { type: "waterTime"; seconds: number; frameId: number }
  | { type: "setActorOutlines"; slotId: number; actorId: string; outlines: import("@haptic/core").OutlineBinding[] }
  | { type: "setActorDeformers"; slotId: number; actorId: string; revision: number; deformers: import("@haptic/core").DeformerBinding[] }
  | { type: "setFogVolumes"; slotId: number; actorId: string; volumes: import("@haptic/core").FogVolumeBinding[] }
  | { type: "setAreaLights"; slotId: number; lights: import("@haptic/core").AreaRectLightBinding[] }
  | { type: "snapshotLayout"; capacity: number; generation: number }
  | {
      type: "spawn";
      runtimeIdentity?: import("./runtime-inspector").RuntimeObjectIdentity;
      slotId: number;
      actorGuid: string;
      classId: string;
      /** Live overlay instance id when this actor belongs to a SceneLayer. */
      sceneLayerId?: string | null;
      /** Loading stream ownership is available before asynchronous visual assignment. */
      sceneStreamActorGuid?: string;
      streamLoadId?: number;
    }
  | { type: "despawn"; slotId: number; actorGuid: string }
  | {
      /** Update component poses without recreating their visual resources. */
      type: "setComponentTransforms";
      slotId: number;
      parts: Array<{
        componentId: string;
        parentId?: string | null;
        transform: import("@haptic/core").Transform;
        /** Nonvisual ancestors, nearest first, as in assignMesh. */
        parentTransforms?: import("@haptic/core").Transform[];
      }>;
    }
  | {
      /** Render the actor's local TRS relative to a target bone; null clears it. */
      type: "attachToBone";
      slotId: number;
      targetSlotId: number | null;
      boneName: string;
    }
  | {
      type: "assignMesh";
      runtimeComponentTokens?: Array<{ componentGuid: string; componentToken: number }>;
      slotId: number;
      meshAssetGuid: string | null;
      /** SceneLayer instance id; tags the slot as HUD overlay before spawn. */
      sceneLayerId?: string | null;
      /** Overlay actor guid for HitTest / pointer events. */
      actorGuid?: string | null;
      /** Stable component identity when one visual uses the optimized actor mesh. */
      primaryComponentId?: string;
      overlayStyle?: import("@haptic/core").OverlayVisualStyle;
      /** Overlay HitTest for the actor visual (`ignore` is not pickable). */
      hitTest?: "ignore" | "block" | "passThrough";
      /** Overlay actor has a `2DButtonComponent`. */
      hasButton?: boolean;
      /** Prefab / live guid of the sole `2DButtonComponent` when there is one. */
      buttonComponentId?: string;
      /** Primitive mesh kind from MeshComponent (`box`, `sphere`, …). */
      meshKind?: string | null;
      /** Sprite / tilemap sorting layer name (project `twoD.sortingLayers`). */
      sortingLayer?: string;
      /** Sprite / tilemap order within that sorting layer. */
      orderInLayer?: number;
      light?: PlayLightProperties;
      camera?: PlayCameraProperties;
      /** Extra renderable components parented to the actor origin mesh. */
      parts?: Array<{
        light?: PlayLightProperties;
        camera?: PlayCameraProperties;
        joystick?: import("@haptic/core").Joystick2DProperties;
        uiControl?: { classId: string; properties: import("@haptic/core").UIControl2DProperties };
        painter?: import("@haptic/core").Painter2DProperties;
        dynamicMesh?: { meshId: number; update: import("@haptic/core").DynamicMeshUpdate };
        /** Nonvisual ancestors between this component and its nearest visual parent, nearest first. */
        parentTransforms?: import("@haptic/core").Transform[];
        cable?: import("@haptic/core").CableProperties & { simulationId?: number };
        water?: import("@haptic/core").WaterBodyProperties;
        /** Water Removal Volume shape; Play keeps an invisible mesh that cuts water. */
        waterRemoval?: import("@haptic/core").WaterRemovalProperties;
        landscape?: import("@haptic/core").LandscapeProperties;
        foliage?: import("@haptic/core").FoliageProperties;
        componentId: string;
        overlayStyle?: import("@haptic/core").OverlayVisualStyle;
        castShadows?: boolean;
        receiveShadows?: boolean;
        meshKind?: string | null;
        meshAssetGuid?: string | null;
        parentId?: string | null;
        position: [number, number, number];
        rotation: [number, number, number, number];
        scale: [number, number, number];
        hitTest?: "ignore" | "block" | "passThrough";
        /** Present on `springarm` parts; children attach to the arm socket. */
        springArm?: {
          armLength: number;
          enableLocationLag: boolean;
          locationLagSpeed: number;
          maxLocationLagDistance: number;
          enableRotationLag: boolean;
          rotationLagSpeed: number;
          drawDebugLag: boolean;
        };
        text3d?: {
          text: string;
          size: number;
          color: [number, number, number];
          fontAssetGuid: string | null;
          alignment: "left" | "center" | "right";
        };
        text2d?: {
          appearModes?: import("@haptic/core").Text2DProperties["appearModes"];
          appearTransition?: import("@haptic/core").Text2DProperties["appearTransition"];
          appearInterval?: number;
          appearDuration?: number;
          appearStart?: import("@haptic/core").Text2DProperties["appearStart"];
          appearProgress?: number;
          text: string;
          materialGuid?: string | null;
          materialUv?: "text" | "glyph";
          size: number;
          color: [number, number, number];
          fontAssetGuid: string | null;
          renderer: "bitmap" | "msdf";
          outline: number;
          outlineColor: [number, number, number];
          alignment: "left" | "center" | "right";
          verticalAlignment: "top" | "center" | "bottom";
          bold: boolean;
          italic: boolean;
          underline: boolean;
          wrapWidth: number;
          wrapHeight: number;
        };
        sortingLayer?: string;
        orderInLayer?: number;
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
        color: [number, number, number];
        fontAssetGuid: string | null;
        alignment: "left" | "center" | "right";
      };
      text2d?: {
        appearModes?: import("@haptic/core").Text2DProperties["appearModes"];
        appearTransition?: import("@haptic/core").Text2DProperties["appearTransition"];
        appearInterval?: number;
        appearDuration?: number;
        appearStart?: import("@haptic/core").Text2DProperties["appearStart"];
        appearProgress?: number;
        text: string;
        materialGuid?: string | null;
        materialUv?: "text" | "glyph";
        size: number;
        color: [number, number, number];
        fontAssetGuid: string | null;
        renderer: "bitmap" | "msdf";
        outline: number;
        outlineColor: [number, number, number];
        alignment: "left" | "center" | "right";
        verticalAlignment: "top" | "center" | "bottom";
        bold: boolean;
        italic: boolean;
        underline: boolean;
        wrapWidth: number;
        wrapHeight: number;
      };
      overlayPanel?: {
        source: "texture" | "material";
        textureGuid: string | null;
        materialGuid: string | null;
        marginLeft: number;
        marginRight: number;
        marginTop: number;
        marginBottom: number;
        hitTest?: "ignore" | "block" | "passThrough";
        destWidth?: number;
        destHeight?: number;
      };
    }
  | { type: "possessCamera"; slotId: number }
  | { type: "sceneLoading"; sceneAssetGuid: string; sceneLoadId: number }
  | { type: "sceneStreamLoading"; actorGuid: string; streamLoadId: number }
  /** A blocking Scene load or asset load holds the simulation; the host pauses render game time to match. */
  | { type: "simulationBlocking"; blocking: boolean }
  /** `priority` orders the host's source and native preparation work. */
  | { type: "assetPreload"; preloadId: string; ownerId: string; assetGuids: string[]; priority: import("@haptic/core").RuntimeAssetSchedulerPriority }
  | { type: "assetPreloadRelease"; preloadId: string }
  | { type: "assetSourcesReady"; requestId: number; success: boolean; error?: string }
  /** A Complex Collision Model had no cooked mesh; the host answers with `loadComplexCollision`. */
  | { type: "requestComplexCollision"; assetGuid: string }
  | { type: "sceneStreamRealized"; actorGuid: string; streamLoadId: number; slotIds: number[] }
  | { type: "sceneStreamRemoved"; actorGuid: string; streamLoadId: number }
  | { type: "sceneSourceRequested"; requestId: number; assetGuid: string; consumer: string; streamActorGuid?: string; streamLoadId?: number }
  | { type: "sceneSourceReleased"; requestId: number }
  | { type: "sceneLoadFailed"; sceneAssetGuid: string; sceneLoadId: number; message: string }
  | { type: "sceneLayerLoading"; layerId: string; assetGuid: string; layerLoadId: number }
  | { type: "sceneLayerLoadFailed"; layerId: string; layerLoadId: number; message: string }
  | { type: "sceneLayerRealized"; layerId: string; layerLoadId: number }
  | {
      /** Canonical scene after `changescene` / `ctx.changeScene`. */
      type: "activeScene";
      sceneAssetGuid: string;
      /** Positive monotonically increasing ID, unique within this runtime session. */
      sceneLoadId: number;
    }
  | {
      /** All world/owned-layer resource commands for this load have been emitted. */
      type: "sceneRealized";
      sceneAssetGuid: string;
      sceneLoadId: number;
    }
  | {
      /**
       * Bind a Material asset to a spawned actor. `componentId` targets one
       * visual component; omitting it overrides the whole actor.
       */
      type: "assignMaterial";
      preparedEditToken?: string;
      slotId: number;
      materialAssetGuid: string | null;
      componentId?: string | null;
    }
  | {
      type: "setMaterialParameter";
      preparedEditToken?: string;
      slotId: number;
      componentId?: string | null;
      /** Captured assignment prevents stale writes reaching a replacement. */
      materialAssetGuid: string;
      parameterName: string;
      parameter: MaterialParameterValue;
    }
  | {
      type: "setPostProcessMaterialParameter";
      owner: { kind: "scene"; sceneAssetGuid: string; sceneLoadId: number }
        | { kind: "sceneLayer"; layerId: string; layerLoadId: number };
      entryId: string;
      materialAssetGuid: string;
      parameterName: string;
      parameter: MaterialParameterValue;
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
      /** Most recent snapshot publish: overlay layout and removal pass, world composition and buffer write. */
      publishMs?: number;
      fps?: number;
      liveActors?: number;
      snapshotCapacity?: number;
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
      type: "setCursorVisible";
      visible: boolean;
      frameId: number;
    }
  /** The worker finished its `stop` phase (End Play, On Game End and their save writes). */
  | { type: "runtimeStopped" }
  /** The runtime stopped itself (console `quit`); the host ends the session as its Stop control does. */
  | { type: "sessionEnded" }
  /** Rumble a pad by its Gamepad API index: intensity 0..1; zero intensity or duration stops it. */
  | {
      type: "setGamepadRumble";
      gamepadIndex: number;
      intensity: number;
      durationMs: number;
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
          kind: "gameInstance" | "subsystem" | "actor" | "component";
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
      type: "setText2DAppear";
      slotId: number;
      componentId: string;
      progress: number;
    }
  | {
      type: "setOverlayVisualStyle";
      slotId: number;
      componentId: string;
      style: import("@haptic/core").OverlayVisualStyle;
    }
  | {
      type: "tilemapAnimationTime";
      elapsedMs: number;
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
  /**
   * The followed Behaviour Tree's live state: sent when it changes, and once as the follow starts.
   * A debug view like `executionTrace`: it carries no scene state.
   */
  | {
      type: "btState";
      /** The followed Behaviour Tree component. */
      instanceId: string;
      slotId: number;
      status: "success" | "failure" | "running";
      btNodeId: string | null;
      lastResults: Record<string, string>;
      blackboard: Record<string, unknown>;
      stack: Array<{ nodeId: string; childIndex: number; opened: boolean }>;
    }
  /**
   * The live instances of an observed target: the whole list when `reset`, else the changes. An
   * `added` entry replaces any entry with its id. The list is capped; later instances join as earlier ones go.
   */
  | { type: "debugRoster"; target: DebugObserveTarget; reset: boolean; added: DebugInstance[]; removed: string[] }
  /** What the followed instance ran during one tick; sent only when something ran. */
  | { type: "executionTrace"; target: DebugObserveTarget; instanceId: string; tickIndex: number; graphs: DebugGraphTrace[] }
  | {
      type: "playSound";
      assetGuid: string;
      volume: number;
      frameId: number;
      emitterActorGuid?: string | null;
      loop?: boolean;
      voiceId?: string;
      /** Seconds of the voice already played (trace restore); omitted starts at the beginning. */
      startOffsetSeconds?: number;
      /**
       * The runtime's uniform [0, 1) draws for the weighted clip and the random pitch, so a trace
       * restore plays the same clip at the same pitch. Omitted draws are random on the host.
       */
      clipRoll?: number;
      pitchRoll?: number;
      /**
       * Trace restore only: the runtime's audio clock (undilated simulation time, excluding pauses)
       * when it issued the voice. A restored voice that waits for the audio unlock starts later by
       * the audio clock time it waited.
       */
      restoredAtSeconds?: number;
    }
  /** Runtime audio clock (undilated simulation seconds, excluding pauses); sent each tick while trace-restored voices are live. */
  | { type: "audioSimTime"; seconds: number }
  | { type: "stopSound"; voiceId: string }
  | { type: "setVoiceGain"; voiceId: string; volume: number }
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
  | { type: "sessionPaused"; paused: boolean; cause?: SessionPauseCause }
  | { type: "setScalability"; transaction: ScalabilityTransaction }
  | { type: "setLightsDebug"; enabled: boolean }
  /** Session fixed-shape forward lighting (console `fixedlights`); the Play Engine restores its own state when Play ends. */
  | { type: "setFixedShapeLighting"; enabled: boolean; guard: "multiply" | "branch" }
  | { type: "setFreeCam"; enabled: boolean }
  | { type: "setShowFps"; enabled: boolean }
  | { type: "setStat"; name: string; enabled: boolean }
  | { type: "setWireframe"; enabled: boolean }
  | { type: "setShowBounds"; enabled: boolean }
  | { type: "setShowCollision"; enabled: boolean }
  | { type: "setShowNav"; enabled: boolean }
  | { type: "setShowPathfinding"; enabled: boolean }
  | { type: "setShowNavAgent"; enabled: boolean }
  | { type: "debugNavigation"; agents: readonly DebugNavAgent[]; world: "2d" | "3d" }
  | { type: "setBehaviourTreeDebug"; enabled: boolean }
  | { type: "behaviourTreeSnapshot"; trees: readonly DebugBehaviourTree[] }
  | { type: "setShowAudioDebug"; enabled: boolean }
  | {
      type: "debugColliders";
      colliders: readonly DebugColliderPrimitive[];
      /** The Scene Layer instance whose own world (and overlay scene) these colliders belong to; absent for the main world. */
      layerId?: string;
    }
  | {
      type: "sceneLayerCreate";
      layerId: string;
      assetGuid: string;
      zOrder: number;
      ownerSceneGuid: string | null;
      postProcessStack: ScenePostProcessEntry[];
      layerBounds?: { width: number; height: number };
    }
  | { type: "sceneLayerRemove"; layerId: string }
  | { type: "sceneLayerClear" }
  | { type: "sceneLayerLayout"; layerId: string; entries: Array<import("@haptic/core").OverlayLayoutEntry & { slotId: number; transform?: import("@haptic/core").SerializedTransform }> }
  | {
      type: "sceneLayerPostProcess";
      layerId: string;
      postProcessStack: ScenePostProcessEntry[];
    }
  /** A Scene Layer instance's camera moved, turned or zoomed (scripts only; every layer is created with the default camera). */
  | { type: "sceneLayerCamera"; layerId: string; camera: SceneLayerCamera };

export type BridgeHostMessage =
  | { channel: "control"; payload: ControlMessage }
  | { channel: "input"; payload: ArrayBuffer | SharedArrayBuffer }
  | { channel: "snapshotLayoutAck"; generation: number }
  /** Hands a consumed transferable snapshot buffer back for reuse (no per-frame alloc). */
  | { channel: "recycleSnapshot"; payload: ArrayBuffer };

export type BridgeWorkerMessage =
  | { channel: "command"; payload: CommandMessage }
  /** Plain commands emitted since the worker's last post, in emission order; hosts dispatch each as a lone `command`. */
  | { channel: "commands"; payload: CommandMessage[] }
  | { channel: "snapshot"; payload: ArrayBuffer; generation: number };
