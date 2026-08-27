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
  events?: readonly EngineScriptEvent[];
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
  { name: "Bold", typeId: "bool", propertyKey: "bold" },
  { name: "Italic", typeId: "bool", propertyKey: "italic" },
  { name: "Underline", typeId: "bool", propertyKey: "underline" },
  { name: "Wrap Width", typeId: "float", propertyKey: "wrapWidth" },
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

export const ENGINE_CLASS_SCRIPT_APIS: readonly EngineClassScriptApi[] = [
  {
    classId: "GameInstance",
    functions: [
      {
        name: "Get Scene Loading Progress",
        runtime: "getSceneLoadingProgress",
        pins: [{ name: "progress", typeId: "float", direction: "out" }],
      },
      {
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
      },
    ],
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
    ],
  },
  {
    classId: "Text3DComponent",
    variables: TEXT_VARIABLES,
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

export function engineScriptVariablesFor(
  classId: string,
): readonly EngineScriptVariable[] {
  return engineScriptApiFor(classId)?.variables ?? [];
}

export function engineScriptFunctionsFor(
  classId: string,
): readonly EngineScriptFunction[] {
  return engineScriptApiFor(classId)?.functions ?? [];
}

export function engineScriptEventsFor(
  classId: string,
): readonly EngineScriptEvent[] {
  return engineScriptApiFor(classId)?.events ?? [];
}
