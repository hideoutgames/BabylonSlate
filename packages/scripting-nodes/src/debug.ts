import {
  pin,
  type NodeDefinition,
  EXEC,
  STRING,
  FLOAT,
  COLOR,
  BOXED_WILDCARD,
  BOOL,
  RESOLVING_WILDCARD,
  defaultValueLiteral,
  objectRef,
  type PinType,
} from "@haptic/scripting";

const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "enum",
  "await",
  // Reserved in strict-mode code, which compiled modules are.
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "static",
  // Literals and strict-mode restricted bindings.
  "null",
  "true",
  "false",
  "eval",
  "arguments",
  "ctx",
]);

/**
 * True when `name` can be an Execute JavaScript parameter or output `let`
 * in the generated strict-mode function.
 */
export function isValidJsIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !RESERVED.has(name);
}

/**
 * The first input or output name the generated function cannot declare:
 * an invalid identifier, or a name used twice across inputs and outputs.
 */
export function executeJavaScriptNameError(
  names: readonly string[],
): string | undefined {
  const seen = new Set<string>();
  for (const name of names) {
    if (!isValidJsIdentifier(name)) return `Invalid JS identifier: ${name}`;
    if (seen.has(name)) return `Duplicate JS identifier: ${name}`;
    seen.add(name);
  }
  return undefined;
}

type PinRow = { name: string; type: PinType };

function readPinRows(
  properties: Record<string, unknown>,
  key: string,
): PinRow[] {
  const raw = properties[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const r = row as { name?: unknown; type?: unknown };
      if (typeof r.name !== "string") return null;
      return { name: r.name, type: (r.type as PinType) ?? STRING };
    })
    .filter((x): x is PinRow => x !== null);
}

const PRINT_COLOR_DEFAULT = { x: 1, y: 1, z: 1, w: 1 };

function printHudPins(
  valuePin: ReturnType<typeof pin>,
): ReturnType<typeof pin>[] {
  return [
    pin("execIn", "exec", "in", EXEC),
    pin("execOut", "then", "out", EXEC),
    valuePin,
    pin("key", "Key", "in", STRING, "data", true, ""),
    pin("duration", "Duration", "in", FLOAT, "data", true, 2),
    pin("color", "Color", "in", COLOR, "data", true, PRINT_COLOR_DEFAULT),
  ];
}

export const debugNodes: NodeDefinition[] = [
  {
    id: "debug.assert",
    title: "Assert",
    category: "debug",
    developmentOnlyByDefault: true,
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("condition", "Condition", "in", BOOL),
      pin("message", "Message", "in", STRING, "data", true, ""),
    ],
    codegen: (ctx) => {
      ctx.emit(`if (!(${ctx.input("condition")})) ctx.assertFailed(${ctx.input("message")});`);
    },
  },
  {
    id: "debug.assertEqual",
    title: "Assert Equal",
    category: "debug",
    developmentOnlyByDefault: true,
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("actual", "Actual", "in", RESOLVING_WILDCARD),
      pin("expected", "Expected", "in", RESOLVING_WILDCARD),
      pin("message", "Message", "in", STRING, "data", true, ""),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.assertEqual(${ctx.input("actual")}, ${ctx.input("expected")}, ${ctx.input("message")});`);
    },
  },
  {
    id: "debug.assertIsValid",
    title: "Assert Is Valid",
    category: "debug",
    developmentOnlyByDefault: true,
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("object", "Object", "in", objectRef("Object")),
      pin("message", "Message", "in", STRING, "data", true, ""),
    ],
    codegen: (ctx) => {
      ctx.emit(`if ((${ctx.input("object")}) == null) ctx.assertFailed(${ctx.input("message")}, "the object is not valid");`);
    },
  },
  {
    id: "debug.log",
    title: "Log",
    category: "debug",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("message", "message", "in", STRING, "data", true),
    ],
    codegen: (ctx) => {
      const severity = JSON.stringify(ctx.node.properties.severity ?? "log");
      const category = JSON.stringify(
        ctx.node.properties.category ?? "Script",
      );
      ctx.emit(
        `ctx.log(${severity}, ${category}, ctx.formatValue(${ctx.input("message")}));`,
      );
    },
  },
  {
    id: "debug.print",
    title: "Print",
    category: "debug",
    developmentOnlyByDefault: true,
    pins: () =>
      printHudPins(
        pin("value", "Value", "in", BOXED_WILDCARD, "data", true, ""),
      ),
    codegen: (ctx) => {
      ctx.emit(
        `ctx.print(ctx.formatValue(${ctx.input("value")}), ${ctx.input("key")}, ${ctx.input("duration")}, ${ctx.input("color")});`,
      );
    },
  },
  {
    id: "debug.printString",
    title: "Print String",
    category: "debug",
    developmentOnlyByDefault: true,
    pins: () =>
      printHudPins(pin("inString", "In String", "in", STRING, "data", true, "")),
    codegen: (ctx) => {
      ctx.emit(
        `ctx.print(${ctx.input("inString")}, ${ctx.input("key")}, ${ctx.input("duration")}, ${ctx.input("color")});`,
      );
    },
  },
  {
    id: "debug.executeJavaScript",
    title: "Execute JavaScript",
    category: "debug",
    latent: false,
    pins: (properties) => {
      const inputs = readPinRows(properties, "inputs");
      const outputs = readPinRows(properties, "outputs");
      const pins = [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
      ];
      for (const row of inputs) {
        pins.push(pin(`in_${row.name}`, row.name, "in", row.type));
      }
      for (const row of outputs) {
        pins.push(pin(`out_${row.name}`, row.name, "out", row.type));
      }
      return pins;
    },
    codegen: (ctx) => {
      const inputs = readPinRows(ctx.node.properties, "inputs");
      const outputs = readPinRows(ctx.node.properties, "outputs");
      const nameError = executeJavaScriptNameError(
        [...inputs, ...outputs].map((row) => row.name),
      );
      if (nameError) {
        ctx.emit(`throw new Error(${JSON.stringify(nameError)});`);
        return;
      }
      const fnName = `execJs_${ctx.node.id.replace(/[^A-Za-z0-9_$]/g, "_")}`;
      const isAsync = Boolean(ctx.node.properties.async);
      const body = String(ctx.node.properties.body ?? "");
      const outDecls = outputs
        .map((o) => `  let ${o.name} = ${defaultValueLiteral(o.type)};`)
        .join("\n");
      const outReturn = `{ ${outputs.map((o) => o.name).join(", ")} }`;
      const params = ["ctx", ...inputs.map((i) => i.name)].join(", ");
      const asyncKw = isAsync ? "async " : "";
      const header = `${asyncKw}function ${fnName}(${params}) {\n${outDecls}\n  // --- user body ---`;
      const footer = `  // --- end user body ---\n  return ${outReturn};\n}`;
      const bodyLines = body.split("\n");
      const source = `${header}\n${bodyLines.join("\n")}\n${footer}`;
      const headerLineCount = header.split("\n").length;
      ctx.hoist(
        source,
        bodyLines.map((_, index) => ({
          relativeLine: headerLineCount + index + 1,
          bodyLine: index + 1,
        })),
      );
      // Row names can equal the exec pins' names, so look up the prefixed ids.
      const args = ["ctx", ...inputs.map((i) => ctx.input(`in_${i.name}`))].join(", ");
      if (isAsync) ctx.requestAsync();
      const call = isAsync ? `await ${fnName}(${args})` : `${fnName}(${args})`;
      if (outputs.length === 0) {
        ctx.emit(`${call};`);
        return;
      }
      const bindings = outputs
        .map((o) => `${o.name}: ${ctx.output(`out_${o.name}`)}`)
        .join(", ");
      ctx.emit(`({ ${bindings} } = ${call});`);
    },
  },
  {
    id: "debug.executeConsoleCommand",
    latent: true,
    title: "Execute Console Command",
    category: "debug",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("command", "command", "in", STRING),
      pin("success", "success", "out", BOOL),
      pin("output", "output", "out", STRING),
    ],
    codegen: (ctx) => {
      const success = ctx.output("success");
      const output = ctx.output("output");
      ctx.emit(
        `({ success: ${success}, output: ${output} } = await ctx.executeConsoleCommandAsync(${ctx.input("command")}));`,
      );
    },
  },
  {
    id: "debug.reportCommand",
    title: "Report Command",
    category: "debug",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("success", "success", "in", BOOL),
      pin("output", "output", "in", STRING),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.reportCommand(${ctx.input("success")}, ${ctx.input("output")});`,
      );
    },
  },
];
