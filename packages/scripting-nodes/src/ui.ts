import {
  pin,
  type NodeDefinition,
  EXEC,
  STRING,
  BOOL,
} from "@babylonslate/scripting";

export const uiNodes: NodeDefinition[] = [
  {
    id: "ui.applyToViewport",
    title: "Apply User Interface",
    category: "ui",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("asset", "asset", "in", STRING),
      pin("instance", "instance", "out", STRING),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("instance")} = ctx.applyUserInterface(${ctx.input("asset")});`,
      );
    },
  },
  {
    id: "ui.removeFromViewport",
    title: "Remove User Interface",
    category: "ui",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("instance", "instance", "in", STRING),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.removeUserInterface(${ctx.input("instance")});`);
    },
  },
  {
    id: "ui.setVisibility",
    title: "Set Widget Visibility",
    category: "ui",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("widget", "widget", "in", STRING),
      pin("visible", "visible", "in", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setWidgetVisible(${ctx.input("widget")}, ${ctx.input("visible")});`,
      );
    },
  },
];
