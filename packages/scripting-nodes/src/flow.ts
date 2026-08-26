import {
  pin,
  type NodeDefinition,
  type PinType,
  EXEC,
  BOOL,
  FLOAT,
  INT,
  STRING,
  VEC3,
  objectRef,
  actorRef,
  structRef,
  flowSwitchCasePinId,
  intSwitchCasesOf,
  stringSwitchCasesOf,
  arrayOf,
  mapOf,
  RESOLVING_WILDCARD,
  ENGINE_HIT_RESULT_STRUCT_ID,
} from "@babylonslate/scripting";
import {
  dataMemberPins,
  jsIdent,
  memberPinRows,
  objectLiteralKey,
  pinTypeForMember,
} from "./member-pins";

const MAP_K: PinType = { kind: "resolvingWildcard", group: "K" };
const MAP_V: PinType = { kind: "resolvingWildcard", group: "V" };
/** Runtime export names for catalog event entry nodes. */
const EVENT_EXPORT_BY_TYPE: Record<string, string> = {
  "flow.event.beginPlay": "onBeginPlay",
  "flow.event.tick": "onTick",
  "flow.event.destroyed": "onDestroyed",
  "flow.event.hit": "onHit",
  "flow.event.beginOverlap": "onBeginOverlap",
  "flow.event.endOverlap": "onEndOverlap",
  "flow.event.commandRun": "onCommandRun",
  "flow.event.editorBeginPlay": "onEditorBeginPlay",
  "flow.event.editorStartup": "onEditorStartup",
  "flow.event.sceneOpen": "onSceneOpen",
  "flow.event.sceneSaved": "onSceneSaved",
  "flow.event.editorShutdown": "onEditorShutdown",
  "flow.event.onMouseEnter": "onMouseEnter",
  "flow.event.onMouseLeave": "onMouseLeave",
  "flow.event.onClick": "onClick",
  "flow.event.onPressStart": "onPressStart",
  "flow.event.onPressEnd": "onPressEnd",
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
    id: "flow.event.destroyed",
    title: "Event On Actor Destroyed",
    category: "flow",
    pure: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "flow.event.hit",
    title: "Event On Hit",
    category: "flow",
    pure: true,
    pins: () => [
      pin("execOut", "then", "out", EXEC),
      pin("hitResult", "Hit Result", "out", structRef(ENGINE_HIT_RESULT_STRUCT_ID)),
      pin("otherActor", "Other Actor", "out", actorRef("Actor")),
      pin("location", "Location", "out", VEC3),
      pin("normal", "Normal", "out", VEC3),
    ],
    codegen: () => ({
      hitResult: "(ctx.args.hitResult)",
      otherActor: "(ctx.args.otherActor)",
      location: "(ctx.args.location)",
      normal: "(ctx.args.normal)",
    }),
  },
  {
    id: "flow.event.beginOverlap",
    title: "Event On Begin Overlap",
    category: "flow",
    pure: true,
    pins: () => [
      pin("execOut", "then", "out", EXEC),
      pin("instigator", "Instigator", "out", actorRef("Actor")),
    ],
    codegen: () => ({ instigator: "(ctx.args.instigator)" }),
  },
  {
    id: "flow.event.endOverlap",
    title: "Event On End Overlap",
    category: "flow",
    pure: true,
    pins: () => [
      pin("execOut", "then", "out", EXEC),
      pin("instigator", "Instigator", "out", actorRef("Actor")),
    ],
    codegen: () => ({ instigator: "(ctx.args.instigator)" }),
  },
  {
    id: "flow.event.onMouseEnter",
    title: "Event On Mouse Enter",
    category: "flow",
    pure: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "flow.event.onMouseLeave",
    title: "Event On Mouse Leave",
    category: "flow",
    pure: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "flow.event.onClick",
    title: "Event On Click",
    category: "flow",
    pure: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "flow.event.onPressStart",
    title: "Event On Press Start",
    category: "flow",
    pure: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "flow.event.onPressEnd",
    title: "Event On Press End",
    category: "flow",
    pure: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
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
      for (const pinDef of ctx.node.pins) {
        if (pinDef.kind === "exec" || pinDef.direction !== "in") continue;
        args.push(`${JSON.stringify(pinDef.name)}: ${ctx.input(pinDef.name)}`);
      }
      ctx.emit(
        `ctx.invokeEvent(${JSON.stringify(parentClassId)}, ${JSON.stringify(eventName)}, { ${args.join(", ")} });`,
      );
      for (const pinDef of ctx.node.pins) {
        if (pinDef.kind === "exec" || pinDef.direction !== "in") continue;
        ctx.emit(`${ctx.output(pinDef.name)} = ${ctx.input(pinDef.name)};`);
      }
    },
  },
  {
    id: "flow.event.editorBeginPlay",
    title: "Event Editor On Begin Play",
    category: "flow",
    pure: true,
    editorOnly: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
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
    id: "flow.switchInt",
    title: "Switch on Int",
    category: "flow",
    pins: (properties) => [
      pin("execIn", "exec", "in", EXEC),
      pin("value", "value", "in", INT),
      ...intSwitchCasesOf(properties).map((value) =>
        pin(flowSwitchCasePinId(String(value)), String(value), "out", EXEC),
      ),
      pin("default", "Default", "out", EXEC),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "switchOnInt",
      valuePin: "value",
      defaultPin: "default",
    },
  },
  {
    id: "flow.switchString",
    title: "Switch on String",
    category: "flow",
    pins: (properties) => [
      pin("execIn", "exec", "in", EXEC),
      pin("value", "value", "in", STRING),
      ...stringSwitchCasesOf(properties).map((value) =>
        pin(flowSwitchCasePinId(value), value, "out", EXEC),
      ),
      pin("default", "Default", "out", EXEC),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "switchOnString",
      valuePin: "value",
      defaultPin: "default",
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
  {
    id: "flow.forLoop",
    title: "For Loop",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("firstIndex", "firstIndex", "in", INT),
      pin("lastIndex", "lastIndex", "in", INT),
      pin("loopBody", "loopBody", "out", EXEC),
      pin("index", "index", "out", INT),
      pin("completed", "completed", "out", EXEC),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "forLoop",
      firstIndexPin: "firstIndex",
      lastIndexPin: "lastIndex",
      loopBodyPin: "loopBody",
      completedPin: "completed",
      indexPin: "index",
    },
  },
  {
    id: "flow.forLoopWithBreak",
    title: "For Loop With Break",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("firstIndex", "firstIndex", "in", INT),
      pin("lastIndex", "lastIndex", "in", INT),
      pin("loopBody", "loopBody", "out", EXEC),
      pin("index", "index", "out", INT),
      pin("completed", "completed", "out", EXEC),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "forLoopWithBreak",
      firstIndexPin: "firstIndex",
      lastIndexPin: "lastIndex",
      loopBodyPin: "loopBody",
      completedPin: "completed",
      indexPin: "index",
    },
  },
  {
    id: "flow.forEach",
    title: "For Each",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("array", "array", "in", arrayOf(RESOLVING_WILDCARD)),
      pin("loopBody", "loopBody", "out", EXEC),
      pin("element", "element", "out", RESOLVING_WILDCARD),
      pin("index", "index", "out", INT),
      pin("completed", "completed", "out", EXEC),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "forEach",
      arrayPin: "array",
      loopBodyPin: "loopBody",
      completedPin: "completed",
      elementPin: "element",
      indexPin: "index",
    },
  },
  {
    id: "flow.forEachWithBreak",
    title: "For Each With Break",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("array", "array", "in", arrayOf(RESOLVING_WILDCARD)),
      pin("loopBody", "loopBody", "out", EXEC),
      pin("element", "element", "out", RESOLVING_WILDCARD),
      pin("index", "index", "out", INT),
      pin("completed", "completed", "out", EXEC),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "forEachWithBreak",
      arrayPin: "array",
      loopBodyPin: "loopBody",
      completedPin: "completed",
      elementPin: "element",
      indexPin: "index",
    },
  },
  {
    id: "flow.forEachMap",
    title: "For Each Map",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("map", "map", "in", mapOf(MAP_K, MAP_V)),
      pin("loopBody", "loopBody", "out", EXEC),
      pin("key", "key", "out", MAP_K),
      pin("value", "value", "out", MAP_V),
      pin("index", "index", "out", INT),
      pin("completed", "completed", "out", EXEC),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "forEachMap",
      mapPin: "map",
      loopBodyPin: "loopBody",
      completedPin: "completed",
      keyPin: "key",
      valuePin: "value",
      indexPin: "index",
    },
  },
  {
    id: "flow.forEachMapWithBreak",
    title: "For Each Map With Break",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("map", "map", "in", mapOf(MAP_K, MAP_V)),
      pin("loopBody", "loopBody", "out", EXEC),
      pin("key", "key", "out", MAP_K),
      pin("value", "value", "out", MAP_V),
      pin("index", "index", "out", INT),
      pin("completed", "completed", "out", EXEC),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "forEachMapWithBreak",
      mapPin: "map",
      loopBodyPin: "loopBody",
      completedPin: "completed",
      keyPin: "key",
      valuePin: "value",
      indexPin: "index",
    },
  },
  {
    id: "flow.whileLoop",
    title: "While Loop",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("condition", "Condition", "in", BOOL),
      pin("loopBody", "Loop Body", "out", EXEC),
      pin("completed", "Completed", "out", EXEC),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "whileLoop",
      conditionPin: "condition",
      loopBodyPin: "loopBody",
      completedPin: "completed",
    },
  },
  {
    id: "flow.break",
    title: "Break",
    category: "flow",
    pins: () => [pin("execIn", "exec", "in", EXEC)],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: { kind: "break" },
  },
  {
    id: "flow.doOnce",
    title: "Do Once",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("reset", "reset", "in", EXEC),
      pin("then", "then", "out", EXEC),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "doOnce",
      execPin: "exec",
      resetPin: "reset",
      thenPin: "then",
    },
  },
  {
    id: "flow.doN",
    title: "Do N",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("n", "n", "in", INT),
      pin("reset", "reset", "in", EXEC),
      pin("then", "then", "out", EXEC),
      pin("counter", "counter", "out", INT),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "doN",
      execPin: "exec",
      nPin: "n",
      resetPin: "reset",
      thenPin: "then",
      counterPin: "counter",
    },
  },
  {
    id: "flow.flipFlop",
    title: "Flip Flop",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("a", "a", "out", EXEC),
      pin("b", "b", "out", EXEC),
      pin("isA", "isA", "out", BOOL),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "flipFlop",
      execPin: "exec",
      aPin: "a",
      bPin: "b",
      isAPin: "isA",
    },
  },
  {
    id: "flow.gate",
    title: "Gate",
    category: "flow",
    pins: () => [
      pin("enter", "enter", "in", EXEC),
      pin("open", "open", "in", EXEC),
      pin("close", "close", "in", EXEC),
      pin("toggle", "toggle", "in", EXEC),
      pin("exit", "exit", "out", EXEC),
    ],
    codegen: () => {
      /* structuredFlow: handled by compiler */
    },
    structuredFlow: {
      kind: "gate",
      enterPin: "enter",
      openPin: "open",
      closePin: "close",
      togglePin: "toggle",
      exitPin: "exit",
      startClosed: true,
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
