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
  propertyKey: string;
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

const TEXT_VARIABLES: readonly EngineScriptVariable[] = [
  { name: "Text", typeId: "string", propertyKey: "text" },
  { name: "Size", typeId: "float", propertyKey: "size" },
  { name: "Color", typeId: "color", propertyKey: "color" },
  { name: "Font", typeId: "asset", typeClassId: "Font", propertyKey: "fontAssetGuid" },
];

const TEXT_CHANGED: EngineScriptEvent = {
  name: "On Text Changed",
  eventType: "flow.event.textChanged",
  exportName: "onTextChanged",
};

const HIT_TEST: EngineScriptVariable = {
  name: "Hit Test",
  typeId: "string",
  propertyKey: "hitTest",
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
    classId: "Text3DComponent",
    variables: TEXT_VARIABLES,
    functions: [SET_TEXT],
    events: [TEXT_CHANGED],
  },
  {
    classId: "2DTextComponent",
    variables: TEXT_VARIABLES,
    functions: [SET_TEXT],
    events: [TEXT_CHANGED],
  },
  {
    classId: "2DRichTextComponent",
    variables: TEXT_VARIABLES,
    functions: [SET_TEXT],
    events: [TEXT_CHANGED],
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
    ],
  },
  {
    classId: "LightComponent",
    variables: [
      { name: "Enabled", typeId: "bool", propertyKey: "enabled" },
      { name: "Color", typeId: "color", propertyKey: "color" },
      { name: "Intensity", typeId: "float", propertyKey: "intensity" },
    ],
  },
  {
    classId: "AudioComponent",
    variables: [
      { name: "Volume", typeId: "float", propertyKey: "volume" },
      { name: "Loop", typeId: "bool", propertyKey: "loop" },
    ],
    functions: [
      { name: "Play", runtime: "playAudio", pins: [EXEC_IN, EXEC_OUT] },
      { name: "Stop", runtime: "stopAudio", pins: [EXEC_IN, EXEC_OUT] },
    ],
  },
  {
    classId: "ParticleComponent",
    functions: [
      { name: "Play", runtime: "playParticles", pins: [EXEC_IN, EXEC_OUT] },
      { name: "Stop", runtime: "stopParticles", pins: [EXEC_IN, EXEC_OUT] },
    ],
  },
  {
    classId: "ColliderComponent",
    variables: [{ name: "Is Trigger", typeId: "bool", propertyKey: "isTrigger" }],
    events: COLLIDER_EVENTS,
  },
  {
    classId: "RigidBodyComponent",
    variables: [
      { name: "Mass", typeId: "float", propertyKey: "mass" },
      { name: "Gravity Scale", typeId: "float", propertyKey: "gravityScale" },
      { name: "Motion Type", typeId: "string", propertyKey: "motionType" },
    ],
  },
  {
    classId: "SpriteComponent",
    variables: [
      { name: "Sorting Layer", typeId: "string", propertyKey: "sortingLayer" },
      { name: "Order In Layer", typeId: "int", propertyKey: "orderInLayer" },
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
];

const BY_CLASS_ID = new Map(
  ENGINE_CLASS_SCRIPT_APIS.map((api) => [api.classId, api]),
);

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
