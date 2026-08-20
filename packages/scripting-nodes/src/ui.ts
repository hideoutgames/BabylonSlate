import {
  USER_INTERFACE_ENGINE_CLASS_ID,
  WIDGET_ENGINE_CLASS_ID,
  widgetClassIdForKind,
} from "@babylonslate/core";
import {
  pin,
  type NodeDefinition,
  type PinType,
  EXEC,
  BOOL,
  classRef,
  objectRef,
} from "@babylonslate/scripting";

export const uiGetWidgetNodeId = "ui.getWidget";

export type BoundWidgetRef = {
  id: string;
  name: string;
  kind: string;
};

export type BoundGetWidgetEntry = {
  id: string;
  nodeType: typeof uiGetWidgetNodeId;
  title: string;
  widgetId: string;
  widgetName: string;
  widgetKind: string;
  classId: string;
  pinType: PinType;
  defaultData: {
    widgetId: string;
    widgetName: string;
    widgetKind: string;
    title: string;
  };
};

function widgetNameOf(properties: Record<string, unknown>): string {
  return typeof properties.widgetName === "string" && properties.widgetName.trim()
    ? properties.widgetName.trim()
    : "Widget";
}

function widgetKindOf(properties: Record<string, unknown>): string {
  return typeof properties.widgetKind === "string" && properties.widgetKind.trim()
    ? properties.widgetKind.trim()
    : WIDGET_ENGINE_CLASS_ID;
}

function widgetIdOf(properties: Record<string, unknown>): string {
  return typeof properties.widgetId === "string" ? properties.widgetId : "";
}

export function boundGetWidgetEntries(
  widgets: readonly BoundWidgetRef[],
): BoundGetWidgetEntry[] {
  return widgets.map((widget) => {
    const classId = widgetClassIdForKind(widget.kind);
    const title = `Get ${widget.name}`;
    return {
      id: `${uiGetWidgetNodeId}:${widget.id}`,
      nodeType: uiGetWidgetNodeId,
      title,
      widgetId: widget.id,
      widgetName: widget.name,
      widgetKind: widget.kind,
      classId,
      pinType: objectRef(classId),
      defaultData: {
        widgetId: widget.id,
        widgetName: widget.name,
        widgetKind: widget.kind,
        title,
      },
    };
  });
}

export type BoundWidgetVariableEntry = {
  id: string;
  nodeType: "variables.get";
  title: string;
  widgetId: string;
  widgetName: string;
  widgetKind: string;
  classId: string;
  pinType: PinType;
  defaultData: {
    variableName: string;
    typeId: "object";
    typeClassId: string;
    implicitSelf: true;
    scope: "member";
    title: string;
  };
};

/** Get Variable rows for hierarchy widgets. Bindings are not assignable — no Set. */
export function boundWidgetVariableEntries(
  widgets: readonly BoundWidgetRef[],
): BoundWidgetVariableEntry[] {
  return widgets.map((widget) => {
    const classId = widgetClassIdForKind(widget.kind);
    const title = `Get ${widget.name}`;
    return {
      id: `variables.get:widget:${widget.id}`,
      nodeType: "variables.get",
      title,
      widgetId: widget.id,
      widgetName: widget.name,
      widgetKind: widget.kind,
      classId,
      pinType: objectRef(classId),
      defaultData: {
        variableName: widget.name,
        typeId: "object",
        typeClassId: classId,
        implicitSelf: true,
        scope: "member",
        title,
      },
    };
  });
}

export const uiNodes: NodeDefinition[] = [
  {
    id: "ui.applyToViewport",
    title: "Apply User Interface",
    category: "ui",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("asset", "asset", "in", classRef(USER_INTERFACE_ENGINE_CLASS_ID)),
      pin("instance", "instance", "out", objectRef(USER_INTERFACE_ENGINE_CLASS_ID)),
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
      pin("instance", "instance", "in", objectRef(USER_INTERFACE_ENGINE_CLASS_ID)),
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
      pin("widget", "widget", "in", objectRef(WIDGET_ENGINE_CLASS_ID)),
      pin("visible", "visible", "in", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setWidgetVisible(${ctx.input("widget")}, ${ctx.input("visible")});`,
      );
    },
  },
  {
    id: uiGetWidgetNodeId,
    title: "Get Widget",
    category: "ui",
    pure: true,
    pins: (properties) => {
      const name = widgetNameOf(properties);
      const kind = widgetKindOf(properties);
      const classId =
        kind === WIDGET_ENGINE_CLASS_ID
          ? WIDGET_ENGINE_CLASS_ID
          : widgetClassIdForKind(kind);
      return [pin("widget", name, "out", objectRef(classId))];
    },
    codegen: (ctx) => {
      const name = widgetNameOf(ctx.node.properties);
      return {
        [name]: `ctx.getWidget(${JSON.stringify(widgetIdOf(ctx.node.properties))})`,
      };
    },
  },
];
