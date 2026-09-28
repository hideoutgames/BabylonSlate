export type EngineScriptPin = {
  name: string;
  typeId: string;
  direction: "in" | "out";
  typeClassId?: string;
};

export type EngineScriptVariable = {
  name: string;
  typeId: string;
  typeClassId?: string;
  /** Extra Content Browser types the pin picker accepts (e.g. Mesh + Model). */
  typeClassIds?: readonly string[];
  container?: "single" | "array" | "map";
  propertyKey: string;
  /** When true, the palette injects Get only (no Set). */
  getOnly?: boolean;
};

export type EngineScriptFunction = {
  name: string;
  pins: EngineScriptPin[];
  runtime: string;
};

export type EngineScriptEvent = {
  name: string;
  eventType: string;
  exportName: string;
};

export type EngineClassScriptApi = {
  classId: string;
  variables?: readonly EngineScriptVariable[];
  functions?: readonly EngineScriptFunction[];
  /** Component-bound events (Add Event on an attached component). */
  events?: readonly EngineScriptEvent[];
  /**
   * Lifecycle events a class of this lineage handles on Self. Never
   * component-bound, so they stay out of `engineEventTypeClassIds()`.
   */
  nativeEvents?: readonly EngineScriptEvent[];
};

const EXEC_IN: EngineScriptPin = {
  name: "exec",
  typeId: "exec",
  direction: "in",
};
const EXEC_OUT: EngineScriptPin = {
  name: "then",
  typeId: "exec",
  direction: "out",
};

const SET_TEXT: EngineScriptFunction = {
  name: "Set Text",
  runtime: "setText",
  pins: [EXEC_IN, EXEC_OUT, { name: "text", typeId: "string", direction: "in" }],
};

const HIT_TEST: EngineScriptVariable = {
  name: "Hit Test",
  typeId: "string",
  propertyKey: "hitTest",
};

const SORTING_VARIABLES: readonly EngineScriptVariable[] = [
  { name: "Sorting Layer", typeId: "string", propertyKey: "sortingLayer" },
  { name: "Order In Layer", typeId: "int", propertyKey: "orderInLayer" },
];

const TEXT_VARIABLES: readonly EngineScriptVariable[] = [
  { name: "Text", typeId: "string", propertyKey: "text" },
  { name: "Size", typeId: "float", propertyKey: "size" },
  { name: "Color", typeId: "color", propertyKey: "color" },
  { name: "Font", typeId: "asset", typeClassId: "Font", propertyKey: "fontAssetGuid" },
];

const TEXT2D_VARIABLES: readonly EngineScriptVariable[] = [
  ...TEXT_VARIABLES,
  HIT_TEST,
  { name: "Renderer", typeId: "string", propertyKey: "renderer" },
  { name: "Outline", typeId: "float", propertyKey: "outline" },
  { name: "Outline Color", typeId: "color", propertyKey: "outlineColor" },
  { name: "Alignment", typeId: "string", propertyKey: "alignment" },
  { name: "Vertical Alignment", typeId: "string", propertyKey: "verticalAlignment" },
  { name: "Bold", typeId: "bool", propertyKey: "bold" },
  { name: "Italic", typeId: "bool", propertyKey: "italic" },
  { name: "Underline", typeId: "bool", propertyKey: "underline" },
  { name: "Wrap Width", typeId: "float", propertyKey: "wrapWidth" },
  { name: "Wrap Height", typeId: "float", propertyKey: "wrapHeight" },
];

const TEXT_CHANGED: EngineScriptEvent = {
  name: "On Text Changed",
  eventType: "flow.event.textChanged",
  exportName: "onTextChanged",
};

const AUDIO_FINISHED: EngineScriptEvent = {
  name: "On Audio Finished",
  eventType: "flow.event.audioFinished",
  exportName: "onAudioFinished",
};

export const BUTTON_MOUSE_EVENTS: readonly EngineScriptEvent[] = [
  {
    name: "On Mouse Enter",
    eventType: "flow.event.onMouseEnter",
    exportName: "onMouseEnter",
  },
  {
    name: "On Mouse Leave",
    eventType: "flow.event.onMouseLeave",
    exportName: "onMouseLeave",
  },
  {
    name: "On Click",
    eventType: "flow.event.onClick",
    exportName: "onClick",
  },
  {
    name: "On Press Start",
    eventType: "flow.event.onPressStart",
    exportName: "onPressStart",
  },
  {
    name: "On Press End",
    eventType: "flow.event.onPressEnd",
    exportName: "onPressEnd",
  },
];

export const COLLIDER_EVENTS: readonly EngineScriptEvent[] = [
  { name: "On Hit", eventType: "flow.event.hit", exportName: "onHit" },
  {
    name: "On Begin Overlap",
    eventType: "flow.event.beginOverlap",
    exportName: "onBeginOverlap",
  },
  {
    name: "On End Overlap",
    eventType: "flow.event.endOverlap",
    exportName: "onEndOverlap",
  },
];

const INIT_EVENT: EngineScriptEvent = {
  name: "On Init",
  eventType: "flow.event.init",
  exportName: "onInit",
};
const TICK_EVENT: EngineScriptEvent = {
  name: "Tick",
  eventType: "flow.event.tick",
  exportName: "onTick",
};
const END_EVENT: EngineScriptEvent = {
  name: "On End",
  eventType: "flow.event.end",
  exportName: "onEnd",
};

/** Game Instance lifecycle; GameSubsystem shares it for parity. */
const GAME_INSTANCE_EVENTS: readonly EngineScriptEvent[] = [
  {
    name: "Scalability Changed",
    eventType: "flow.event.scalabilityChanged",
    exportName: "onScalabilityChanged",
  },
  INIT_EVENT,
  TICK_EVENT,
  END_EVENT,
  {
    name: "On First Scene Loaded",
    eventType: "flow.event.firstSceneLoaded",
    exportName: "onFirstSceneLoaded",
  },
  {
    name: "On Scene Start Loading",
    eventType: "flow.event.sceneStartLoading",
    exportName: "onSceneStartLoading",
  },
  {
    name: "On Scene Finish Loading",
    eventType: "flow.event.sceneFinishLoading",
    exportName: "onSceneFinishLoading",
  },
  {
    name: "On Scene Exit",
    eventType: "flow.event.sceneExit",
    exportName: "onSceneExit",
  },
];

const SCENE_SUBSYSTEM_EVENTS: readonly EngineScriptEvent[] = [
  INIT_EVENT,
  TICK_EVENT,
  END_EVENT,
  {
    name: "On Scene Loaded",
    eventType: "flow.event.sceneLoaded",
    exportName: "onSceneLoaded",
  },
  {
    name: "On Streamed Scene Loaded",
    eventType: "flow.event.streamedSceneLoaded",
    exportName: "onStreamedSceneLoaded",
  },
  {
    name: "On Streamed Scene Unloaded",
    eventType: "flow.event.streamedSceneUnloaded",
    exportName: "onStreamedSceneUnloaded",
  },
  {
    name: "On Scene Layer Added",
    eventType: "flow.event.sceneLayerAdded",
    exportName: "onSceneLayerAdded",
  },
  {
    name: "On Scene Layer Removed",
    eventType: "flow.event.sceneLayerRemoved",
    exportName: "onSceneLayerRemoved",
  },
  {
    name: "On Scene Actor Spawned",
    eventType: "flow.event.sceneActorSpawned",
    exportName: "onSceneActorSpawned",
  },
  {
    name: "On Scene Actor Destroyed",
    eventType: "flow.event.sceneActorDestroyed",
    exportName: "onSceneActorDestroyed",
  },
];

const GET_SCENE_LOADING_PROGRESS: EngineScriptFunction = {
  name: "Get Scene Loading Progress",
  runtime: "getSceneLoadingProgress",
  pins: [{ name: "progress", typeId: "float", direction: "out" }],
};

const GET_SCENE_REFERENCE: EngineScriptFunction = {
  name: "Get Scene Reference",
  runtime: "getSceneReference",
  pins: [
    {
      name: "scene",
      typeId: "object",
      typeClassId: "Scene",
      direction: "out",
    },
  ],
};

export const ENGINE_CLASS_SCRIPT_APIS: readonly EngineClassScriptApi[] = [
  {
    classId: "RenderTargetCaptureComponent",
    variables: [
      { name: "Render Target", typeId: "asset", typeClassId: "RenderTarget", propertyKey: "renderTargetGuid" },
      { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
      { name: "Capture Every Frame", typeId: "bool", propertyKey: "captureEveryFrame" },
      { name: "Capture Only Actors", typeId: "bool", propertyKey: "captureOnlyActors" },
      { name: "Capture Actors", typeId: "actor", typeClassId: "Actor", container: "array", propertyKey: "actorIds" },
      { name: "Field Of View", typeId: "float", propertyKey: "fieldOfView" },
      { name: "Near Clip", typeId: "float", propertyKey: "nearClip" },
      { name: "Far Clip", typeId: "float", propertyKey: "farClip" },
    ],
  },
  ...["GlobalWaterVolumeComponent", "WaterOceanComponent", "WaterLakeComponent", "WaterRiverComponent", "WaterPuddleComponent"].map((classId): EngineClassScriptApi => ({
    classId,
    variables: [
      { name: "Water", typeId: "asset", typeClassId: "Water", propertyKey: "assetGuid" },
      { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
      ...[["Width", "width"], ["Length", "length"], ["Depth", "depth"], ["Wave Scale", "waveScale"], ["Flow Speed", "flowSpeed"], ["Flow Direction", "flowDirection"]].map(([name, propertyKey]) => ({ name: name!, propertyKey: propertyKey!, typeId: "float" })),
    ],
  })),
  { classId: "WaterRemovalVolumeComponent", variables: [
    { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
    ...[["Width", "width"], ["Height", "height"], ["Length", "length"]].map(([name, propertyKey]) => ({ name: name!, propertyKey: propertyKey!, typeId: "float" })),
  ] },
  { classId: "WaterBuoyancyComponent", variables: [
    { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
    ...[["Volume", "volume"], ["Width", "width"], ["Length", "length"], ["Height", "height"], ["Drag", "drag"], ["Angular Drag", "angularDrag"]].map(([name, propertyKey]) => ({ name: name!, propertyKey: propertyKey!, typeId: "float" })),
    { name: "Offset", typeId: "vec3", propertyKey: "offset" },
  ] },
  {
    classId: "GameInstance",
    functions: [GET_SCENE_LOADING_PROGRESS, GET_SCENE_REFERENCE],
    nativeEvents: GAME_INSTANCE_EVENTS,
  },
  // Subsystems reach Get Scene Loading Progress / Get Scene Reference through
  // the lineage-gated `gameInstance.*` nodes; catalog `functions` would add
  // Call rows to every host.
  {
    classId: "GameSubsystem",
    nativeEvents: GAME_INSTANCE_EVENTS,
  },
  {
    classId: "SceneSubsystem",
    nativeEvents: SCENE_SUBSYSTEM_EVENTS,
  },
  {
    classId: "Scene",
    variables: [
      {
        name: "Scene Name",
        typeId: "string",
        propertyKey: "sceneName",
        getOnly: true,
      },
      {
        name: "Asset Guid",
        typeId: "string",
        propertyKey: "assetGuid",
        getOnly: true,
      },
      {
        name: "Gravity",
        typeId: "vec3",
        propertyKey: "gravity",
      },
    ],
  },
  {
    classId: "Text3DComponent",
    variables: [
      ...TEXT_VARIABLES,
      { name: "Alignment", typeId: "string", propertyKey: "alignment" },
    ],
    functions: [SET_TEXT],
    events: [TEXT_CHANGED],
  },
  {
    classId: "2DTextComponent",
    variables: TEXT2D_VARIABLES,
    functions: [SET_TEXT],
    events: [TEXT_CHANGED],
  },
  {
    classId: "2DRichTextComponent",
    variables: TEXT2D_VARIABLES,
    functions: [SET_TEXT],
    events: [TEXT_CHANGED],
  },
  {
    classId: "MeshComponent",
    variables: [
      { name: "Mesh Kind", typeId: "string", propertyKey: "meshKind" },
      { name: "Cast Shadows", typeId: "bool", propertyKey: "castShadows" },
      { name: "Receive Shadows", typeId: "bool", propertyKey: "receiveShadows" },
      {
        name: "Mesh",
        typeId: "asset",
        typeClassId: "Model",
        typeClassIds: ["Mesh", "Model"],
        propertyKey: "assetGuid",
      },
      {
        name: "Material",
        typeId: "asset",
        typeClassId: "Material",
        propertyKey: "materialGuid",
      },
      {
        name: "Material Object",
        typeId: "object",
        typeClassId: "MaterialObject",
        propertyKey: "materialObject",
        getOnly: true,
      },
      { name: "Collision Mode", typeId: "string", propertyKey: "collisionMode" },
      { name: "Layer", typeId: "int", propertyKey: "layer" },
      { name: "Mask", typeId: "int", propertyKey: "mask" },
    ],
  },
  {
    classId: "SpriteComponent",
    variables: [
      {
        name: "Sprite",
        typeId: "asset",
        typeClassId: "Sprite",
        propertyKey: "assetGuid",
      },
      ...SORTING_VARIABLES,
    ],
  },
  {
    classId: "TilemapComponent",
    variables: [
      {
        name: "Tilemap",
        typeId: "asset",
        typeClassId: "Tilemap",
        propertyKey: "assetGuid",
      },
      ...SORTING_VARIABLES,
    ],
  },
  {
    classId: "SkyboxComponent",
    variables: [{ name: "Size", typeId: "float", propertyKey: "size" }],
  },
  {
    classId: "CameraComponent",
    variables: [
      { name: "Field Of View", typeId: "float", propertyKey: "fieldOfView" },
      {
        name: "Orthographic Size",
        typeId: "float",
        propertyKey: "orthographicSize",
      },
      { name: "Projection Mode", typeId: "string", propertyKey: "projectionMode" },
      { name: "Near Clip", typeId: "float", propertyKey: "nearClip" },
      { name: "Far Clip", typeId: "float", propertyKey: "farClip" },
    ],
    functions: [
      { name: "Possess", runtime: "possessCamera", pins: [EXEC_IN, EXEC_OUT] },
    ],
  },
  {
    classId: "LightComponent",
    variables: [
      { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
      { name: "Color", typeId: "color", propertyKey: "color" },
      { name: "Intensity", typeId: "float", propertyKey: "intensity" },
      { name: "Kind", typeId: "string", propertyKey: "lightKind" },
      { name: "Range", typeId: "float", propertyKey: "range" },
      { name: "Inner Angle", typeId: "float", propertyKey: "innerAngle" },
      { name: "Outer Angle", typeId: "float", propertyKey: "outerAngle" },
      { name: "Cast Shadows", typeId: "bool", propertyKey: "castShadows" },
      { name: "Shadow Priority", typeId: "float", propertyKey: "shadowPriority" },
    ],
  },
  {
    classId: "HemisphericFillLightComponent",
    variables: [
      { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
      { name: "Color", typeId: "color", propertyKey: "color" },
      { name: "Ground Color", typeId: "color", propertyKey: "groundColor" },
      { name: "Intensity", typeId: "float", propertyKey: "intensity" },
    ],
  },
  {
    classId: "OutlineComponent",
    variables: [
      { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
      { name: "Color", typeId: "color", propertyKey: "color" },
      { name: "Width", typeId: "float", propertyKey: "width" },
      { name: "Render Through Meshes", typeId: "bool", propertyKey: "throughMeshes" },
    ],
  },
  {
    classId: "CableComponent",
    variables: [
      { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
      { name: "Cable Length", typeId: "float", propertyKey: "cableLength" },
      { name: "Segments", typeId: "int", propertyKey: "numSegments" },
      { name: "Cable Width", typeId: "float", propertyKey: "cableWidth" },
      { name: "Sides", typeId: "int", propertyKey: "numSides" },
      { name: "Tile Material", typeId: "float", propertyKey: "tileMaterial" },
      { name: "Material", typeId: "asset", typeClassId: "Material", propertyKey: "materialGuid" },
      { name: "Attach Start", typeId: "bool", propertyKey: "attachStart" },
      { name: "Attach End", typeId: "bool", propertyKey: "attachEnd" },
      { name: "End Position", typeId: "vec3", propertyKey: "endPosition" },
      { name: "Target Actor ID", typeId: "string", propertyKey: "targetActorId" },
      { name: "Target Component ID", typeId: "string", propertyKey: "targetComponentId" },
      { name: "Solver Iterations", typeId: "int", propertyKey: "solverIterations" },
      { name: "Enable Stiffness", typeId: "bool", propertyKey: "enableStiffness" },
      { name: "Gravity Scale", typeId: "float", propertyKey: "gravityScale" },
      { name: "Cable Force", typeId: "vec3", propertyKey: "cableForce" },
      { name: "Damping", typeId: "float", propertyKey: "damping" },
      { name: "Substep Time", typeId: "float", propertyKey: "substepTime" },
      { name: "Max Substeps", typeId: "int", propertyKey: "maxSubsteps" },
      { name: "Enable Collision", typeId: "bool", propertyKey: "enableCollision" },
      { name: "Collision Friction", typeId: "float", propertyKey: "collisionFriction" },
      { name: "Sleep Threshold", typeId: "float", propertyKey: "sleepThreshold" },
      { name: "Sleep Delay", typeId: "float", propertyKey: "sleepDelay" },
    ],
  },
  {
    classId: "SpringArmComponent",
    variables: [
      { name: "Arm Length", typeId: "float", propertyKey: "armLength" },
      { name: "Enable Location Lag", typeId: "bool", propertyKey: "enableLocationLag" },
      { name: "Location Lag Speed", typeId: "float", propertyKey: "locationLagSpeed" },
      { name: "Max Location Lag Distance", typeId: "float", propertyKey: "maxLocationLagDistance" },
      { name: "Enable Rotation Lag", typeId: "bool", propertyKey: "enableRotationLag" },
      { name: "Rotation Lag Speed", typeId: "float", propertyKey: "rotationLagSpeed" },
      { name: "Draw Debug Lag", typeId: "bool", propertyKey: "drawDebugLag" },
    ],
  },
  {
    classId: "FogVolumeComponent",
    variables: [
      { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
      { name: "Shape", typeId: "string", propertyKey: "shape" },
      { name: "Size", typeId: "vec3", propertyKey: "size" },
      { name: "Density", typeId: "float", propertyKey: "density" },
      { name: "Edge Falloff", typeId: "float", propertyKey: "edgeFalloff" },
    ],
  },
  {
    classId: "AreaRectLightComponent",
    variables: [
      { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
      { name: "Width", typeId: "float", propertyKey: "width" },
      { name: "Height", typeId: "float", propertyKey: "height" },
      { name: "Color", typeId: "color", propertyKey: "color" },
      { name: "Intensity", typeId: "float", propertyKey: "intensity" },
      { name: "Emission Texture", typeId: "asset", typeClassId: "Texture", propertyKey: "textureGuid" },
    ],
  },
  {
    classId: "AudioComponent",
    variables: [
      { name: "Volume", typeId: "float", propertyKey: "volume" },
      { name: "Loop", typeId: "bool", propertyKey: "loop" },
      {
        name: "Audio",
        typeId: "asset",
        typeClassId: "Audio",
        propertyKey: "audioAssetGuid",
      },
    ],
    functions: [
      { name: "Play", runtime: "playAudio", pins: [EXEC_IN, EXEC_OUT] },
      { name: "Stop", runtime: "stopAudio", pins: [EXEC_IN, EXEC_OUT] },
    ],
    events: [AUDIO_FINISHED],
  },
  {
    classId: "ParticleComponent",
    variables: [
      {
        name: "Particle System",
        typeId: "asset",
        typeClassId: "ParticleSystem",
        propertyKey: "particleSystemGuid",
      },
      ...SORTING_VARIABLES,
    ],
    functions: [
      { name: "Play", runtime: "playParticles", pins: [EXEC_IN, EXEC_OUT] },
      { name: "Stop", runtime: "stopParticles", pins: [EXEC_IN, EXEC_OUT] },
    ],
  },
  {
    classId: "ColliderComponent",
    variables: [
      { name: "Is Trigger", typeId: "bool", propertyKey: "isTrigger" },
      { name: "Friction", typeId: "float", propertyKey: "friction" },
      { name: "Restitution", typeId: "float", propertyKey: "restitution" },
      { name: "Layer", typeId: "int", propertyKey: "layer" },
      { name: "Mask", typeId: "int", propertyKey: "mask" },
      { name: "Render In Game", typeId: "bool", propertyKey: "renderInGame" },
    ],
    events: COLLIDER_EVENTS,
  },
  {
    classId: "RigidBodyComponent",
    variables: [
      { name: "Mass", typeId: "float", propertyKey: "mass" },
      { name: "Gravity Scale", typeId: "float", propertyKey: "gravityScale" },
      { name: "Motion Type", typeId: "string", propertyKey: "motionType" },
      { name: "Linear Damping", typeId: "float", propertyKey: "linearDamping" },
      { name: "Angular Damping", typeId: "float", propertyKey: "angularDamping" },
    ],
    functions: [
      {
        name: "Add Impulse",
        runtime: "addImpulse",
        pins: [
          EXEC_IN,
          EXEC_OUT,
          { name: "impulse", typeId: "vec3", direction: "in" },
          { name: "strength", typeId: "float", direction: "in" },
        ],
      },
    ],
  },
  {
    classId: "PhysicsConstraintComponent",
    variables: [
      { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
      { name: "Kind", typeId: "string", propertyKey: "kind" },
      { name: "Target Actor ID", typeId: "string", propertyKey: "targetActorId" },
      { name: "Collide Connected", typeId: "bool", propertyKey: "collideConnected" },
      { name: "Anchor A", typeId: "vec3", propertyKey: "anchorA" },
      { name: "Anchor B", typeId: "vec3", propertyKey: "anchorB" },
      { name: "Axis A", typeId: "vec3", propertyKey: "axisA" },
      { name: "Axis B", typeId: "vec3", propertyKey: "axisB" },
      { name: "Reference Axis A", typeId: "vec3", propertyKey: "referenceAxisA" },
      { name: "Reference Axis B", typeId: "vec3", propertyKey: "referenceAxisB" },
      { name: "Frame A", typeId: "quat", propertyKey: "frameA" },
      { name: "Frame B", typeId: "quat", propertyKey: "frameB" },
      { name: "Limits Enabled", typeId: "bool", propertyKey: "limitsEnabled" },
      { name: "Minimum Angle", typeId: "float", propertyKey: "minAngle" },
      { name: "Maximum Angle", typeId: "float", propertyKey: "maxAngle" },
      { name: "Distance", typeId: "float", propertyKey: "distance" },
    ],
    functions: [{
      name: "Set Connected Actor",
      runtime: "setConstraintTarget",
      pins: [EXEC_IN, EXEC_OUT, { name: "actor", typeId: "object", typeClassId: "Actor", direction: "in" }],
    }],
  },
  {
    classId: "RagdollComponent",
    variables: [
      { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
      { name: "Status", typeId: "string", propertyKey: "status", getOnly: true },
      { name: "Total Mass", typeId: "float", propertyKey: "totalMass" },
      { name: "Radius", typeId: "float", propertyKey: "radius" },
      { name: "Angular Limit", typeId: "float", propertyKey: "angularLimit" },
      { name: "Linear Damping", typeId: "float", propertyKey: "linearDamping" },
      { name: "Angular Damping", typeId: "float", propertyKey: "angularDamping" },
      { name: "Friction", typeId: "float", propertyKey: "friction" },
      { name: "Restitution", typeId: "float", propertyKey: "restitution" },
      { name: "Layer", typeId: "int", propertyKey: "layer" },
      { name: "Mask", typeId: "int", propertyKey: "mask" },
    ],
    functions: [{
      name: "Add Impulse", runtime: "addImpulse",
      pins: [EXEC_IN, EXEC_OUT, { name: "impulse", typeId: "vec3", direction: "in" }, { name: "strength", typeId: "float", direction: "in" }],
    }],
  },
  {
    classId: "NavAgentComponent",
    variables: [
      { name: "Radius", typeId: "float", propertyKey: "radius" },
      { name: "Height", typeId: "float", propertyKey: "height" },
      { name: "Max Speed", typeId: "float", propertyKey: "maxSpeed" },
      { name: "Max Acceleration", typeId: "float", propertyKey: "maxAcceleration" },
    ],
    functions: [
      {
        name: "Move To",
        runtime: "moveTo",
        pins: [
          EXEC_IN,
          EXEC_OUT,
          { name: "destination", typeId: "vec3", direction: "in" },
        ],
      },
      {
        name: "Stop Movement",
        runtime: "stopMovement",
        pins: [EXEC_IN, EXEC_OUT],
      },
    ],
  },
  {
    classId: "2DButtonComponent",
    variables: [HIT_TEST],
    events: BUTTON_MOUSE_EVENTS,
  },
  {
    classId: "2DAnchorComponent",
    variables: [
      { name: "Anchor", typeId: "string", propertyKey: "anchor" },
      { name: "Offset X", typeId: "float", propertyKey: "offsetX" },
      { name: "Offset Y", typeId: "float", propertyKey: "offsetY" },
    ],
  },
  {
    classId: "2DTextureComponent",
    variables: [
      {
        name: "Texture",
        typeId: "asset",
        typeClassId: "Texture",
        propertyKey: "textureGuid",
      },
      HIT_TEST,
    ],
  },
  {
    classId: "2DMaterialComponent",
    variables: [
      {
        name: "Material",
        typeId: "asset",
        typeClassId: "Material",
        propertyKey: "materialGuid",
      },
      HIT_TEST,
    ],
  },
  {
    classId: "2DPanelComponent",
    variables: [
      { name: "Source", typeId: "string", propertyKey: "source" },
      {
        name: "Texture",
        typeId: "asset",
        typeClassId: "Texture",
        propertyKey: "textureGuid",
      },
      {
        name: "Material",
        typeId: "asset",
        typeClassId: "Material",
        propertyKey: "materialGuid",
      },
      { name: "Margin Left", typeId: "float", propertyKey: "marginLeft" },
      { name: "Margin Right", typeId: "float", propertyKey: "marginRight" },
      { name: "Margin Top", typeId: "float", propertyKey: "marginTop" },
      { name: "Margin Bottom", typeId: "float", propertyKey: "marginBottom" },
      HIT_TEST,
    ],
  },
];

const BY_CLASS_ID = new Map(
  ENGINE_CLASS_SCRIPT_APIS.map((api) => [api.classId, api]),
);

/** Event node type ids → class ids that expose them (e.g. onClick → 2DButton). */
export function engineEventTypeClassIds(): Readonly<
  Record<string, readonly string[]>
> {
  const map = new Map<string, string[]>();
  for (const api of ENGINE_CLASS_SCRIPT_APIS) {
    for (const event of api.events ?? []) {
      const list = map.get(event.eventType) ?? [];
      list.push(api.classId);
      map.set(event.eventType, list);
    }
  }
  return Object.fromEntries(map);
}

export function engineScriptApiFor(
  classId: string,
): EngineClassScriptApi | undefined {
  return BY_CLASS_ID.get(classId);
}

export function engineScriptEventsFor(
  classId: string,
): readonly EngineScriptEvent[] {
  return engineScriptApiFor(classId)?.events ?? [];
}

/**
 * Native lifecycle events for a class, from the nearest engine class in its
 * ancestry (class first, root last) that declares them.
 */
export function engineNativeEventsFor(
  ancestry: readonly string[],
): readonly EngineScriptEvent[] {
  for (const classId of ancestry) {
    const events = engineScriptApiFor(classId)?.nativeEvents;
    if (events) return events;
  }
  return [];
}
