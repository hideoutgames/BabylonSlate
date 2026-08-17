import {
  pin,
  type NodeDefinition,
  EXEC,
  FLOAT,
  assetRef,
} from "@babylonslate/scripting";

function volumeExpr(
  ctx: Parameters<NodeDefinition["codegen"]>[0],
  pinName = "volume",
): string {
  const volumePin = ctx.node.pins.find(
    (entry) => entry.name === pinName && entry.direction === "in",
  );
  const connected = Boolean(
    volumePin &&
      ctx.graph.edges.some(
        (edge) =>
          edge.targetNodeId === ctx.node.id && edge.targetPinId === volumePin.id,
      ),
  );
  const stored =
    ctx.node.properties[`default:${pinName}`] ?? ctx.node.properties[pinName];
  const raw = connected || stored !== undefined ? ctx.input(pinName) : "1";
  return `Math.min(1, Math.max(0, Number(${raw})))`;
}

export const audioNodes: NodeDefinition[] = [
  {
    id: "audio.play",
    title: "Play Sound",
    category: "audio",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("asset", "asset", "in", assetRef("Audio")),
      pin("volume", "volume", "in", FLOAT, "data", true),
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
      pin("volume", "volume", "in", FLOAT, "data", true),
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
      pin("volume", "volume", "in", FLOAT, "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setGlobalVolume(${volumeExpr(ctx)});`);
    },
  },
];
