import {
  CONCRETE_WILDCARD_TARGETS,
  pinTypeTag,
  type PinType,
  BOOL,
  INT,
  FLOAT,
  STRING,
} from "./types";
import { pin, type NodeDefinition } from "./node-registry";
import { BOXED_WILDCARD, EXEC } from "./types";

export type BoxedWildcard = { tag: string; value: unknown };

export function boxValue(type: PinType, value: unknown): BoxedWildcard {
  return { tag: pinTypeTag(type), value };
}

export function wildcardConverterNodeId(target: PinType): string {
  const tag = pinTypeTag(target);
  const suffix = tag
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `wildcard.to_${suffix}`;
}

function converterCodegen(target: PinType): NodeDefinition["codegen"] {
  return (ctx) => {
    const input = ctx.input("in");
    const success = ctx.output("success");
    const value = ctx.output("value");
    const fallback = ctx.input("fallback");
    const expected = JSON.stringify(pinTypeTag(target));
    ctx.emit(
      `(() => { const __w = ${input}; if (__w && __w.tag === ${expected}) { ${success} = true; ${value} = __w.value; } else { ${success} = false; ${value} = ${fallback}; } })();`,
    );
  };
}

/** Generated WildcardTo* family + typeof/is helpers. */
export function createWildcardNodes(): NodeDefinition[] {
  const nodes: NodeDefinition[] = [];

  for (const target of CONCRETE_WILDCARD_TARGETS) {
    const id = wildcardConverterNodeId(target);
    const title = `Wildcard To ${pinTypeTag(target)}`;
    nodes.push({
      id,
      title,
      category: "casting",
      pure: false,
      pins: () => [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
        pin("in", "in", "in", BOXED_WILDCARD),
        pin("fallback", "fallback", "in", target, "data", true),
        pin("success", "success", "out", BOOL),
        pin("value", "value", "out", target),
      ],
      codegen: converterCodegen(target),
    });
  }

  // WildcardToString never fails — uses formatValue via ctx.formatValue.
  nodes.push({
    id: "wildcard.to_string",
    title: "Wildcard To String",
    category: "casting",
    pure: true,
    pins: () => [
      pin("in", "in", "in", BOXED_WILDCARD),
      pin("out", "out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `ctx.formatValue(${ctx.input("in")})`,
    }),
  });

  nodes.push({
    id: "wildcard.typeOf",
    title: "Wildcard Type Of",
    category: "casting",
    pure: true,
    pins: () => [
      pin("in", "in", "in", BOXED_WILDCARD),
      pin("out", "out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("in")})?.tag ?? "null")`,
    }),
  });

  nodes.push({
    id: "wildcard.is",
    title: "Wildcard Is",
    category: "casting",
    pure: true,
    pins: () => [
      pin("in", "in", "in", BOXED_WILDCARD),
      pin("tag", "tag", "in", STRING),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("in")})?.tag === ${ctx.input("tag")})`,
    }),
  });

  // Keep INT/FLOAT/BOOL referenced for tree-shaking clarity in tests.
  void INT;
  void FLOAT;

  return nodes;
}

export function assertEveryConcreteTypeHasConverter(
  registeredIds: ReadonlySet<string>,
): string[] {
  const missing: string[] = [];
  for (const target of CONCRETE_WILDCARD_TARGETS) {
    const id = wildcardConverterNodeId(target);
    if (!registeredIds.has(id)) missing.push(id);
  }
  if (!registeredIds.has("wildcard.to_string")) {
    missing.push("wildcard.to_string");
  }
  return missing;
}
