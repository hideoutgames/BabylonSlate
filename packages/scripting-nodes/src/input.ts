import {
  pin,
  type NodeDefinition,
  BOOL,
  FLOAT,
  VEC2,
  VEC3,
  STRING,
  EXEC,
  INT,
  actorRef,
  enumRef,
  structRef,
  ENGINE_COLLISION_CHANNEL_ENUM_ID,
  ENGINE_HIT_RESULT_STRUCT_ID,
} from "@babylonslate/scripting";

const HIT_RESULT = structRef(ENGINE_HIT_RESULT_STRUCT_ID);
const COLLISION_CHANNEL = enumRef(ENGINE_COLLISION_CHANNEL_ENUM_ID);

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
    id: "input.isActionHeld",
    title: "Is Action Held",
    category: "input",
    pure: true,
    pins: () => [
      pin("action", "action", "in", STRING),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(ctx.isActionHeld?.(${ctx.input("action")}) ?? false)`,
    }),
  },
  {
    id: "input.getAxis",
    title: "Get Axis",
    category: "input",
    pure: true,
    pins: () => [
      pin("axis", "axis", "in", STRING),
      pin("out", "out", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `(ctx.getAxis?.(${ctx.input("axis")}) ?? 0)`,
    }),
  },
  {
    id: "input.getAxis2D",
    title: "Get Axis 2D",
    category: "input",
    pure: true,
    pins: () => [
      pin("axis", "axis", "in", STRING),
      pin("out", "out", "out", VEC2),
    ],
    codegen: (ctx) => ({
      out: `(ctx.getAxis2D?.(${ctx.input("axis")}) ?? { x: 0, y: 0 })`,
    }),
  },
  {
    id: "input.onAction",
    title: "On Action",
    category: "input",
    pins: () => [
      pin("execOut", "then", "out", EXEC),
      pin("action", "action", "in", STRING),
      pin("phase", "phase", "in", STRING),
    ],
    // Compiled specially in packages/scripting so the then-chain stays gated.
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
    codegen: (ctx) => ({
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
