import {
  pin,
  type NodeDefinition,
  BOOL,
  FLOAT,
  VEC2,
  STRING,
  EXEC,
  INT,
} from "@babylonslate/scripting";

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
];
