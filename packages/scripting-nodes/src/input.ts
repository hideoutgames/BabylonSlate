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
} from "@babylonslate/scripting";
import { inputBindingNodes } from "./input-bindings";

const HIT_RESULT = structRef(ENGINE_HIT_RESULT_STRUCT_ID);
const COLLISION_CHANNEL = enumRef(ENGINE_COLLISION_CHANNEL_ENUM_ID);

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
    `{ const __hit = ${expr}; ${hitResult} = { Hit: __hit.hit === true, Location: __hit.location ?? { x: 0, y: 0, z: 0 }, Normal: __hit.normal ?? { x: 0, y: 0, z: 0 }, Actor: __hit.actor ?? null, Distance: __hit.distance ?? 0 }; ${hit} = __hit.hit === true; ${location} = __hit.location ?? null; ${normal} = __hit.normal ?? null; ${distance} = __hit.distance ?? 0; ${actor} = __hit.actor ?? null; ${worldOrigin} = __hit.worldOrigin ?? { x: 0, y: 0, z: 0 }; ${worldDirection} = __hit.worldDirection ?? { x: 0, y: 0, z: 0 }; }`,
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
