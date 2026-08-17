import {
  pin,
  type NodeDefinition,
  type PinType,
  EXEC,
  BOOL,
  FLOAT,
  INT,
  STRING,
  objectRef,
} from "@babylonslate/scripting";
import {
  dataMemberPins,
  jsIdent,
  memberPinRows,
  objectLiteralKey,
  pinTypeForMember,
} from "./member-pins";

/** Runtime export names for catalog event entry nodes. */
const EVENT_EXPORT_BY_TYPE: Record<string, string> = {
  "flow.event.beginPlay": "onBeginPlay",
  "flow.event.tick": "onTick",
  "flow.event.commandRun": "onCommandRun",
  "flow.event.editorStartup": "onEditorStartup",
  "flow.event.sceneOpen": "onSceneOpen",
  "flow.event.sceneSaved": "onSceneSaved",
  "flow.event.editorShutdown": "onEditorShutdown",
  "bt.event.activate": "onActivate",
  "bt.event.tick": "onBtTick",
  "bt.event.abort": "onAbort",
  "bt.event.evaluate": "onEvaluate",
};

export const flowNodes: NodeDefinition[] = [
  {
    id: "flow.event.beginPlay",
    title: "Event Begin Play",
    category: "flow",
    pure: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "flow.event.tick",
    title: "Event Tick",
    category: "flow",
    pure: true,
    pins: () => [
      pin("execOut", "then", "out", EXEC),
      pin("deltaSeconds", "deltaSeconds", "out", FLOAT),
    ],
    codegen: () => ({ deltaSeconds: "ctx.deltaSeconds" }),
  },
  {
    id: "flow.event.commandRun",
    title: "Event On Command Run",
    category: "flow",
    pure: true,
    pins: (properties) => {
      const params = Array.isArray(properties.parameters)
        ? (properties.parameters as Array<{ name: string; type?: string }>)
        : [];
      return [
        pin("execOut", "then", "out", EXEC),
        ...params.map((param) =>
          pin(param.name, param.name, "out", pinTypeForCommandParam(param.type)),
        ),
      ];
    },
    codegen: (ctx) => {
      const params = Array.isArray(ctx.node.properties.parameters)
        ? (ctx.node.properties.parameters as Array<{ name: string }>)
        : [];
      const out: Record<string, string> = {};
      for (const param of params) {
        out[param.name] = `(ctx.commandArgs[${JSON.stringify(param.name)}])`;
      }
      if (Object.keys(out).length === 0) return;
      return out;
    },
  },
  {
    id: "flow.event.custom",
    title: "Event Custom",
    category: "flow",
    pure: true,
    pins: (properties) => [
      pin("execOut", "then", "out", EXEC),
      ...dataMemberPins(properties, "out"),
    ],
    codegen: (ctx) => {
      const out: Record<string, string> = {};
      for (const pinDef of ctx.node.pins) {
        if (pinDef.kind === "exec" || pinDef.direction !== "out") continue;
        out[pinDef.name] = `(ctx.commandArgs[${JSON.stringify(pinDef.name)}])`;
      }
      if (Object.keys(out).length === 0) return;
      return out;
    },
  },
  {
    id: "flow.event.call",
    title: "Call Custom Event",
    category: "flow",
    pins: (properties) => {
      const classId =
        typeof properties.classId === "string" && properties.classId.trim()
          ? properties.classId.trim()
          : "BObject";
      const targetPin =
        properties.implicitSelf === true
          ? []
          : [pin("target", "target", "in", objectRef(classId))];
      return [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
        ...targetPin,
        ...dataMemberPins(properties, "in"),
      ];
    },
    codegen: (ctx) => {
      const raw =
        typeof ctx.node.properties.name === "string"
          ? ctx.node.properties.name
          : "Custom";
      const eventName = jsIdent(raw);
      const targetPin = ctx.node.pins.find(
        (entry) => entry.name === "target" && entry.direction === "in",
      );
      const targetConnected =
        !!targetPin &&
        ctx.graph.edges.some(
          (edge) =>
            edge.targetNodeId === ctx.node.id &&
            edge.targetPinId === targetPin.id,
        );
      const targetExpr =
        !targetPin || (!targetConnected && ctx.node.properties.implicitSelf === true)
          ? "ctx.self"
          : ctx.input("target");
      const args: string[] = [];
      for (const pinDef of ctx.node.pins) {
        if (
          pinDef.direction !== "in" ||
          pinDef.kind === "exec" ||
          pinDef.name === "target"
        ) {
          continue;
        }
        args.push(`${JSON.stringify(pinDef.name)}: ${ctx.input(pinDef.name)}`);
      }
      ctx.emit(
        `ctx.invokeCustomEvent(${targetExpr}, ${JSON.stringify(eventName)}, { ${args.join(", ")} });`,
      );
    },
  },
  {
    id: "flow.event.callParent",
    title: "Call Parent Event",
    category: "flow",
    pins: (properties) => {
      const rows = memberPinRows(properties);
      const dataPins = rows.flatMap((row) => {
        if (!row || typeof row.name !== "string" || row.name.length === 0) {
          return [];
        }
        if (row.typeId === "exec") return [];
        const type = pinTypeForMember(row.typeId, row.typeClassId);
        return [
          pin(row.name, row.name, "in", type),
          pin(`${row.name}__out`, row.name, "out", type),
        ];
      });
      return [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
        ...dataPins,
      ];
    },
    codegen: (ctx) => {
      const parentClassId =
        typeof ctx.node.properties.parentClassId === "string" &&
        ctx.node.properties.parentClassId.trim()
          ? ctx.node.properties.parentClassId.trim()
          : "BObject";
      const eventType =
        typeof ctx.node.properties.eventType === "string"
          ? ctx.node.properties.eventType
          : "";
      const rawName =
        typeof ctx.node.properties.eventName === "string"
          ? ctx.node.properties.eventName
          : typeof ctx.node.properties.name === "string"
            ? ctx.node.properties.name
            : "Custom";
      const catalogEvent =
        eventType && EVENT_EXPORT_BY_TYPE[eventType]
          ? EVENT_EXPORT_BY_TYPE[eventType]
          : undefined;
      const eventName = catalogEvent ?? jsIdent(rawName);
      const args: string[] = [];
      const outs: Record<string, string> = {};
      for (const pinDef of ctx.node.pins) {
        if (pinDef.kind === "exec" || pinDef.direction !== "in") continue;
        args.push(`${JSON.stringify(pinDef.name)}: ${ctx.input(pinDef.name)}`);
        outs[pinDef.name] = ctx.input(pinDef.name);
      }
      ctx.emit(
        `ctx.invokeEvent(${JSON.stringify(parentClassId)}, ${JSON.stringify(eventName)}, { ${args.join(", ")} });`,
      );
      if (Object.keys(outs).length === 0) return;
      return outs;
    },
  },
  {
    id: "flow.event.editorStartup",
    title: "Event On Editor Startup",
    category: "flow",
    pure: true,
    editorOnly: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "flow.event.sceneOpen",
    title: "Event On Scene Open",
    category: "flow",
    pure: true,
    editorOnly: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "flow.event.sceneSaved",
    title: "Event On Scene Saved",
    category: "flow",
    pure: true,
    editorOnly: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "flow.event.editorShutdown",
    title: "Event On Editor Shutdown",
    category: "flow",
    pure: true,
    editorOnly: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "flow.entry",
    title: "Entry",
    category: "flow",
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry is a no-op marker */
    },
  },
  {
    id: "flow.branch",
    title: "Branch",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("condition", "condition", "in", BOOL),
      pin("true", "true", "out", EXEC),
      pin("false", "false", "out", EXEC),
    ],
    codegen: () => {
      /* handled specially by compiler */
    },
  },
  {
    id: "flow.sequence",
    title: "Sequence",
    category: "flow",
    pins: (properties) => {
      const count = Math.max(1, Number(properties.count ?? 2));
      const pins = [pin("execIn", "exec", "in", EXEC)];
      for (let i = 0; i < count; i++) {
        pins.push(pin(`then${i}`, `then_${i}`, "out", EXEC));
      }
      return pins;
    },
    codegen: () => {
      /* handled specially by compiler */
    },
  },
  {
    id: "flow.function.input",
    title: "Input",
    category: "flow",
    pure: true,
    pins: (properties) =>
      functionEndpointPins(properties, "input"),
    codegen: (ctx) => {
      const out: Record<string, string> = {};
      for (const pinDef of ctx.node.pins) {
        if (pinDef.kind === "exec") continue;
        out[pinDef.name] = `ctx.args[${JSON.stringify(pinDef.name)}]`;
      }
      if (Object.keys(out).length === 0) return;
      return out;
    },
  },
  {
    id: "flow.function.output",
    title: "Output",
    category: "flow",
    pins: (properties) =>
      functionEndpointPins(properties, "output"),
    codegen: (ctx) => {
      const fields: string[] = [];
      for (const pinDef of ctx.node.pins) {
        if (pinDef.direction !== "in" || pinDef.kind === "exec") continue;
        fields.push(
          `${objectLiteralKey(pinDef.name)}: ${ctx.input(pinDef.name)}`,
        );
      }
      ctx.emit(`return { ${fields.join(", ")} };`);
    },
  },
];

function functionEndpointPins(
  properties: Record<string, unknown>,
  endpoint: "input" | "output",
) {
  const rows = Array.isArray(properties.pins)
    ? (properties.pins as Array<{
        name?: string;
        typeId?: string;
        typeClassId?: string;
        direction?: string;
      }>)
    : [];
  const want = endpoint === "input" ? "in" : "out";
  const asDirection = endpoint === "input" ? "out" : "in";
  const mapped = rows.flatMap((row) => {
    if (!row || typeof row.name !== "string" || row.name.length === 0) {
      return [];
    }
    if (row.direction !== want) return [];
    return [
      pin(
        row.name,
        row.name,
        asDirection,
        pinTypeForMember(row.typeId, row.typeClassId),
      ),
    ];
  });
  if (mapped.length > 0) return mapped;
  return endpoint === "input"
    ? [pin("exec", "then", "out", EXEC)]
    : [pin("then", "then", "in", EXEC)];
}

function pinTypeForCommandParam(type: string | undefined): PinType {
  switch (type) {
    case "bool":
      return BOOL;
    case "int":
      return INT;
    case "string":
    case "enum":
      return STRING;
    default:
      return FLOAT;
  }
}
