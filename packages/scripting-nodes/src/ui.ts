import {
  USER_INTERFACE_ENGINE_CLASS_ID,
  WIDGET_ENGINE_CLASS_ID,
  widgetClassIdForKind,
} from "@babylonslate/core";
import {
  pin,
  type CodegenContext,
  type NodeDefinition,
  type PinType,
  EXEC,
  BOOL,
  FLOAT,
  STRING,
  INT,
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
  {
    id: "ui.addWidget",
    title: "Add Widget",
    category: "ui",
    pins: (properties) => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      ...(properties.implicitSelf === true
        ? []
        : [
            pin(
              "target",
              "Target",
              "in",
              objectRef(USER_INTERFACE_ENGINE_CLASS_ID),
            ),
          ]),
      pin("kind", "Kind", "in", classRef(WIDGET_ENGINE_CLASS_ID)),
      pin("name", "Name", "in", STRING),
      pin("parent", "Parent", "in", objectRef("BObject"), "data", true),
      pin("widget", "Widget", "out", objectRef(WIDGET_ENGINE_CLASS_ID)),
    ],
    codegen: (ctx) => {
      const kind = ctx.input("kind");
      const name = ctx.input("name");
      const parent = ctx.input("parent");
      const out = ctx.output("widget");
      if (ctx.node.properties.implicitSelf === true) {
        ctx.emit(`${out} = ctx.addWidget(${kind}, ${name}, ${parent});`);
        return;
      }
      ctx.emit(
        `${out} = ctx.addWidgetOn(${ctx.input("target")}, ${kind}, ${name}, ${parent});`,
      );
    },
  },
  {
    id: "ui.setWidgetParent",
    title: "Set Widget Parent",
    category: "ui",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("widget", "Widget", "in", objectRef(WIDGET_ENGINE_CLASS_ID)),
      pin("parent", "Parent", "in", objectRef("BObject")),
      pin("index", "Index", "in", INT, "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setWidgetParent(${ctx.input("widget")}, ${ctx.input("parent")}, ${ctx.input("index")});`,
      );
    },
  },
  {
    id: "ui.removeWidget",
    title: "Remove Widget",
    category: "ui",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("widget", "Widget", "in", objectRef(WIDGET_ENGINE_CLASS_ID)),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.removeWidget(${ctx.input("widget")});`);
    },
  },
  {
    id: "ui.setWidgetLayout",
    title: "Set Widget Layout",
    category: "ui",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("widget", "Widget", "in", objectRef(WIDGET_ENGINE_CLASS_ID)),
      ...layoutPatchPins(),
    ],
    codegen: (ctx) => {
      const fields = layoutPatchFields(ctx);
      ctx.emit(
        `ctx.setWidgetLayout(${ctx.input("widget")}, { ${fields.join(", ")} });`,
      );
    },
  },
  {
    id: "ui.getWidgetLayout",
    title: "Get Widget Layout",
    category: "ui",
    pure: true,
    pins: () => [
      pin("widget", "Widget", "in", objectRef(WIDGET_ENGINE_CLASS_ID)),
      pin("left", "Left", "out", FLOAT),
      pin("top", "Top", "out", FLOAT),
      pin("width", "Width", "out", FLOAT),
      pin("height", "Height", "out", FLOAT),
      pin("rotation", "Rotation", "out", FLOAT),
      pin("scaleX", "Scale X", "out", FLOAT),
      pin("scaleY", "Scale Y", "out", FLOAT),
      pin("horizontalAlignment", "Horizontal Alignment", "out", STRING),
      pin("verticalAlignment", "Vertical Alignment", "out", STRING),
      pin("leftUnit", "Left Unit", "out", STRING),
      pin("topUnit", "Top Unit", "out", STRING),
      pin("widthUnit", "Width Unit", "out", STRING),
      pin("heightUnit", "Height Unit", "out", STRING),
    ],
    codegen: (ctx) => {
      const expr = `ctx.getWidgetLayout(${ctx.input("widget")})`;
      return {
        left: `${expr}?.left`,
        top: `${expr}?.top`,
        width: `${expr}?.width`,
        height: `${expr}?.height`,
        rotation: `${expr}?.rotation`,
        scaleX: `${expr}?.scaleX`,
        scaleY: `${expr}?.scaleY`,
        horizontalAlignment: `${expr}?.horizontalAlignment`,
        verticalAlignment: `${expr}?.verticalAlignment`,
        leftUnit: `${expr}?.leftUnit`,
        topUnit: `${expr}?.topUnit`,
        widthUnit: `${expr}?.widthUnit`,
        heightUnit: `${expr}?.heightUnit`,
      };
    },
  },
];

const LAYOUT_PATCH_PIN_IDS = [
  "left",
  "top",
  "width",
  "height",
  "rotation",
  "scaleX",
  "scaleY",
  "leftUnit",
  "topUnit",
  "widthUnit",
  "heightUnit",
  "horizontalAlignment",
  "verticalAlignment",
] as const;

function layoutPatchPins() {
  return [
    pin("left", "Left", "in", FLOAT, "data", true),
    pin("top", "Top", "in", FLOAT, "data", true),
    pin("width", "Width", "in", FLOAT, "data", true),
    pin("height", "Height", "in", FLOAT, "data", true),
    pin("rotation", "Rotation", "in", FLOAT, "data", true),
    pin("scaleX", "Scale X", "in", FLOAT, "data", true),
    pin("scaleY", "Scale Y", "in", FLOAT, "data", true),
    pin("leftUnit", "Left Unit", "in", STRING, "data", true),
    pin("topUnit", "Top Unit", "in", STRING, "data", true),
    pin("widthUnit", "Width Unit", "in", STRING, "data", true),
    pin("heightUnit", "Height Unit", "in", STRING, "data", true),
    pin("horizontalAlignment", "Horizontal Alignment", "in", STRING, "data", true),
    pin("verticalAlignment", "Vertical Alignment", "in", STRING, "data", true),
  ];
}

function pinWired(ctx: CodegenContext, pinId: string): boolean {
  return ctx.graph.edges.some(
    (edge) =>
      edge.targetNodeId === ctx.node.id && edge.targetPinId === pinId,
  );
}

function layoutPatchFields(ctx: CodegenContext): string[] {
  return LAYOUT_PATCH_PIN_IDS.filter((id) => pinWired(ctx, id)).map(
    (id) => `${id}: ${ctx.input(id)}`,
  );
}
