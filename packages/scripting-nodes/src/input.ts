import {
  pin,
  type NodeDefinition,
  BOOL,
  FLOAT,
  VEC2,
  VEC3,
  EXEC,
  INT,
  actorRef,
  enumRef,
  structRef,
  ENGINE_COLLISION_CHANNEL_ENUM_ID,
  ENGINE_HIT_RESULT_STRUCT_ID,
  ENGINE_TOUCH_PHASE_ENUM_ID,
  ENGINE_TOUCH_STRUCT_ID,
} from "@babylonslate/scripting";
import { inputBindingNodes } from "./input-bindings";

const HIT_RESULT = structRef(ENGINE_HIT_RESULT_STRUCT_ID);
const COLLISION_CHANNEL = enumRef(ENGINE_COLLISION_CHANNEL_ENUM_ID);
const TOUCH = structRef(ENGINE_TOUCH_STRUCT_ID);
const TOUCH_PHASE = enumRef(ENGINE_TOUCH_PHASE_ENUM_ID);

/** On Touch Began / Moved / Ended: compiled as one gated run per matching touch record this tick. */
function touchEventPins(extra: ReturnType<typeof pin>[] = []) {
  return [
    pin("execOut", "Then", "out", EXEC),
    pin("touch", "Touch", "out", TOUCH),
    pin("finger", "Finger", "out", INT),
    pin("position", "Position", "out", VEC2),
    ...extra,
  ];
}

/** What Get Touch and Find Touch report when no touch matches. */
const NO_TOUCH = `{ Finger: -1, Position: { x: 0, y: 0 }, Delta: { x: 0, y: 0 }, StartPosition: { x: 0, y: 0 }, Pressure: 0, Phase: "Ended", Type: "Finger" }`;

/**
 * Outputs of a touch lookup: `lookup` yields the matching touch or undefined
 * and is read once per statement. Find Touch takes Finger as its input, so
 * only Get Touch outputs it.
 */
function touchLookupOutputs(
  ctx: Parameters<NonNullable<NodeDefinition["codegen"]>>[0],
  lookup: string,
  foundPin: string,
  withFinger: boolean,
): Record<string, string> {
  const found = ctx.shared?.(lookup) ?? lookup;
  const touch = `(${found} ?? ${NO_TOUCH})`;
  return {
    [foundPin]: `(${found} !== undefined)`,
    touch,
    ...(withFinger ? { finger: `${touch}.Finger` } : {}),
    position: `${touch}.Position`,
    delta: `${touch}.Delta`,
    pressure: `${touch}.Pressure`,
    phase: `${touch}.Phase`,
  };
}

function assetInputEventPins(valueType: unknown) {
  return [
    pin("started", "Started", "out", EXEC),
    pin("held", "Held", "out", EXEC),
    pin("released", "Released", "out", EXEC),
    pin("binding", "Input Binding", "in", structRef("engine:InputBinding")),
    pin(
      "value",
      "Value",
      "out",
      valueType === "2d" ? VEC2 : valueType === "1d" ? FLOAT : BOOL,
    ),
    pin("heldSeconds", "Held Seconds", "out", FLOAT),
    pin("lastHeldSeconds", "Last Held Seconds", "out", FLOAT),
  ];
}

/** A miss reports zero Location and Normal on the struct and on the exploded pins alike. */
function emitMappedHit(
  ctx: Parameters<NonNullable<NodeDefinition["codegen"]>>[0],
  expr: string,
): void {
  const hitResult = ctx.output("hitResult");
  const hit = ctx.output("hit");
  const location = ctx.output("location");
  const normal = ctx.output("normal");
  const distance = ctx.output("distance");
  const actor = ctx.output("actor");
  const worldOrigin = ctx.output("worldOrigin");
  const worldDirection = ctx.output("worldDirection");
  ctx.emit(
    `{ const __hit = ${expr}; ${hitResult} = { Hit: __hit.hit === true, Location: __hit.location ?? { x: 0, y: 0, z: 0 }, Normal: __hit.normal ?? { x: 0, y: 0, z: 0 }, Actor: __hit.actor ?? null, Distance: __hit.distance ?? 0 }; ${hit} = __hit.hit === true; ${location} = __hit.location ?? { x: 0, y: 0, z: 0 }; ${normal} = __hit.normal ?? { x: 0, y: 0, z: 0 }; ${distance} = __hit.distance ?? 0; ${actor} = __hit.actor ?? null; ${worldOrigin} = __hit.worldOrigin ?? { x: 0, y: 0, z: 0 }; ${worldDirection} = __hit.worldDirection ?? { x: 0, y: 0, z: 0 }; }`,
  );
}

/** Input category: mappings resolve through the runtime ctx (engineplan §11). */
export const inputNodes: NodeDefinition[] = [
  {
    id: "input.actionEvent",
    title: "Event Input Action",
    category: "input",
    pins: () => assetInputEventPins("button"),
    codegen: () => {},
  },
  {
    id: "input.axisEvent",
    title: "Event Input Axis",
    category: "input",
    pins: (properties) =>
      assetInputEventPins(properties.valueType === "2d" ? "2d" : "1d"),
    codegen: () => {},
  },
  ...inputBindingNodes,
  {
    id: "input.onAnyKeyPressed",
    title: "On Any Key Pressed",
    category: "input",
    pins: () => [
      pin("execOut", "Then", "out", EXEC),
      pin("key", "Key", "out", enumRef("engine:Key")),
    ],
    // Compiled as one gated execution per key pressed during the current tick.
    codegen: () => {},
  },
  {
    id: "input.onGamepadConnected",
    title: "On Gamepad Connected",
    category: "input",
    pins: () => [
      pin("execOut", "then", "out", EXEC),
      pin("index", "index", "out", INT),
    ],
    codegen: () => {},
  },
  {
    id: "input.onGamepadDisconnected",
    title: "On Gamepad Disconnected",
    category: "input",
    pins: () => [
      pin("execOut", "then", "out", EXEC),
      pin("index", "index", "out", INT),
    ],
    codegen: () => {},
  },
  {
    id: "input.setGamepadRumble",
    title: "Set Gamepad Rumble",
    category: "input",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("index", "index", "in", INT),
      pin("intensity", "intensity", "in", FLOAT),
      pin("durationMs", "duration", "in", FLOAT),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setGamepadRumble?.(${ctx.input("index")}, ${ctx.input("intensity")}, ${ctx.input("durationMs")});`,
      );
    },
  },
  {
    id: "input.getCursorPosition",
    title: "Get Cursor Position",
    category: "input",
    pure: true,
    pins: () => [
      pin("out", "Position", "out", VEC2),
      pin("pressed", "Pressed", "out", BOOL, "data", true),
    ],
    codegen: () => ({
      out: `(ctx.getCursorPosition?.() ?? { x: 0, y: 0, pressed: false })`,
      pressed: `(ctx.getCursorPosition?.()?.pressed ?? false)`,
    }),
  },
  {
    id: "input.onTouchBegan",
    title: "On Touch Began",
    category: "input",
    pins: () => touchEventPins(),
    codegen: () => {},
  },
  {
    id: "input.onTouchMoved",
    title: "On Touch Moved",
    category: "input",
    pins: () => touchEventPins([pin("delta", "Delta", "out", VEC2)]),
    codegen: () => {},
  },
  {
    id: "input.onTouchEnded",
    title: "On Touch Ended",
    category: "input",
    pins: () => touchEventPins([pin("cancelled", "Cancelled", "out", BOOL)]),
    codegen: () => {},
  },
  {
    id: "input.getTouchCount",
    title: "Get Touch Count",
    category: "input",
    pure: true,
    pins: () => [pin("count", "Count", "out", INT)],
    codegen: () => ({ count: `(ctx.getTouches?.() ?? []).length` }),
  },
  {
    id: "input.getTouch",
    title: "Get Touch",
    category: "input",
    pure: true,
    pins: () => [
      pin("index", "Index", "in", INT, "data", true, 0),
      pin("valid", "Valid", "out", BOOL),
      pin("touch", "Touch", "out", TOUCH),
      pin("finger", "Finger", "out", INT),
      pin("position", "Position", "out", VEC2),
      pin("delta", "Delta", "out", VEC2),
      pin("pressure", "Pressure", "out", FLOAT),
      pin("phase", "Phase", "out", TOUCH_PHASE),
    ],
    codegen: (ctx) =>
      touchLookupOutputs(ctx, `(ctx.getTouches?.() ?? [])[${ctx.input("index")}]`, "valid", true),
  },
  {
    id: "input.findTouch",
    title: "Find Touch",
    category: "input",
    pure: true,
    pins: () => [
      pin("finger", "Finger", "in", INT, "data", true, 0),
      pin("found", "Found", "out", BOOL),
      pin("touch", "Touch", "out", TOUCH),
      pin("position", "Position", "out", VEC2),
      pin("delta", "Delta", "out", VEC2),
      pin("pressure", "Pressure", "out", FLOAT),
      pin("phase", "Phase", "out", TOUCH_PHASE),
    ],
    codegen: (ctx) =>
      touchLookupOutputs(
        ctx,
        `((f) => (ctx.getTouches?.() ?? []).find((t) => t.Finger === f))(${ctx.input("finger")})`,
        "found",
        false,
      ),
  },
  {
    id: "input.projectTouchToScene",
    title: "Project Touch To Scene",
    category: "input",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("finger", "Finger", "in", INT, "data", true, 0),
      pin("channel", "Channel", "in", COLLISION_CHANNEL, "data", true),
      pin("drawDebug", "Draw Debug", "in", BOOL, "data", true, true),
      pin("duration", "Duration", "in", FLOAT, "data", true, 0),
      pin("hitResult", "Hit Result", "out", HIT_RESULT),
      pin("hit", "Hit", "out", BOOL),
      pin("location", "Location", "out", VEC3),
      pin("normal", "Normal", "out", VEC3),
      pin("distance", "Distance", "out", FLOAT),
      pin("actor", "Actor", "out", actorRef("Actor")),
      pin("worldOrigin", "World Origin", "out", VEC3),
      pin("worldDirection", "World Direction", "out", VEC3),
    ],
    codegen: (ctx) => {
      emitMappedHit(
        ctx,
        `ctx.projectTouchToScene(${ctx.input("finger")}, ${ctx.input("channel")}, { drawDebug: ${ctx.input("drawDebug")}, duration: ${ctx.input("duration")} })`,
      );
    },
  },
  {
    id: "input.projectCursorToScene",
    title: "Project Cursor To Scene",
    category: "input",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("channel", "Channel", "in", COLLISION_CHANNEL, "data", true),
      pin("drawDebug", "Draw Debug", "in", BOOL, "data", true, true),
      pin("duration", "Duration", "in", FLOAT, "data", true, 0),
      pin("hitResult", "Hit Result", "out", HIT_RESULT),
      pin("hit", "Hit", "out", BOOL),
      pin("location", "Location", "out", VEC3),
      pin("normal", "Normal", "out", VEC3),
      pin("distance", "Distance", "out", FLOAT),
      pin("actor", "Actor", "out", actorRef("Actor")),
      pin("worldOrigin", "World Origin", "out", VEC3),
      pin("worldDirection", "World Direction", "out", VEC3),
    ],
    codegen: (ctx) => {
      emitMappedHit(
        ctx,
        `ctx.projectCursorToScene(${ctx.input("channel")}, { drawDebug: ${ctx.input("drawDebug")}, duration: ${ctx.input("duration")} })`,
      );
    },
  },
  {
    id: "input.showCursor",
    title: "Show Cursor",
    category: "input",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setCursorVisible?.(true);`);
    },
  },
  {
    id: "input.hideCursor",
    title: "Hide Cursor",
    category: "input",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setCursorVisible?.(false);`);
    },
  },
];
