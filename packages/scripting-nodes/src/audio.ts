import {
  pin,
  type NodeDefinition,
  EXEC,
  FLOAT,
  assetRef,
} from "@haptic/scripting";

/** Volume pins default to 1; codegen clamps the value to 0..1. */
function volumeExpr(ctx: Parameters<NodeDefinition["codegen"]>[0]): string {
  return `Math.min(1, Math.max(0, Number(${ctx.input("volume")})))`;
}

const volumePin = () => pin("volume", "volume", "in", FLOAT, "data", true, 1);

export const audioNodes: NodeDefinition[] = [
  {
    id: "audio.play",
    title: "Play Sound",
    category: "audio",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("asset", "asset", "in", assetRef("Audio")),
      volumePin(),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.playSound(${ctx.input("asset")}, ${volumeExpr(ctx)});`,
      );
    },
  },
  {
    id: "audio.setChannelVolume",
    title: "Set Channel Volume",
    category: "audio",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("channel", "channel", "in", assetRef("AudioChannel")),
      volumePin(),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setChannelVolume(${ctx.input("channel")}, ${volumeExpr(ctx)});`,
      );
    },
  },
  {
    id: "audio.setGlobalVolume",
    title: "Set Global Volume",
    category: "audio",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      volumePin(),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setGlobalVolume(${volumeExpr(ctx)});`);
    },
  },
];
