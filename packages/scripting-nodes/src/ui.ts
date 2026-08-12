import {
  pin,
  type NodeDefinition,
  EXEC,
  STRING,
  BOOL,
} from "@babylonslate/scripting";

export const uiNodes: NodeDefinition[] = [
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
