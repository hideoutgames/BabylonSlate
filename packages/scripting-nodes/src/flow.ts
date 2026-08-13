import {
  pin,
  type NodeDefinition,
  type PinType,
  EXEC,
  BOOL,
  FLOAT,
  INT,
  STRING,
} from "@babylonslate/scripting";

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
];

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
