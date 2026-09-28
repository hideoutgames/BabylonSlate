import {
  CONCRETE_WILDCARD_TARGETS,
  pinTypeTag,
  type PinType,
  BOOL,
  STRING,
} from "./types";
import { pin, type CodegenContext, type NodeDefinition } from "./node-registry";
import { BOXED_WILDCARD, EXEC } from "./types";

/*
 * Values are never boxed on the wire. The conversion nodes decide the tag:
 * a source with a concrete static type supplies its pinTypeTag at compile
 * time; an untyped source (another boxed wildcard, an unresolved generic, or
 * a disconnected pin) is tagged from its runtime value.
 */

/** Tag fixed by the wired source's static type, if it is not a wildcard. */
function staticInputTag(ctx: CodegenContext, pinName: string): string | undefined {
  const type = ctx.inputType?.(pinName);
  if (!type || type.kind === "boxedWildcard" || type.kind === "resolvingWildcard") {
    return undefined;
  }
  return pinTypeTag(type);
}

/** JS test for a value already carried as `{ tag, value }`. */
function boxedTest(value: string): string {
  return `(${value} !== null && typeof ${value} === "object" && typeof ${value}.tag === "string" && "value" in ${value} && Object.keys(${value}).length === 2)`;
}

/**
 * JS expression for the runtime tag of an untyped value. A `{ tag, value }`
 * box keeps its tag. Other values are tagged by shape, conservatively: a
 * whole number reads as `int`; Quat and Color share Vec4's `{ x, y, z, w }`
 * shape and read as `vec4`; arrays, maps and structs read as `unknown`.
 */
function runtimeTagExpr(value: string): string {
  return `((v) => { if (v === null || v === undefined) return "null"; if (typeof v === "boolean") return "bool"; if (typeof v === "number") return Number.isInteger(v) ? "int" : "float"; if (typeof v === "string") return "string"; if (typeof v !== "object") return "unknown"; if (${boxedTest("v")}) return v.tag; if (typeof v.classId === "string" && v.classId) return (ctx.isA(v, "Actor") ? "actorRef:" : "objectRef:") + v.classId; const n = (k) => typeof v[k] === "number"; if (n("pitch") && n("yaw") && n("roll")) return "rotator"; if (v.position && v.rotation && v.scale) return "transform"; if (n("x") && n("y")) return n("z") ? (n("w") ? "vec4" : "vec3") : "vec2"; return "unknown"; })(${value})`;
}

/**
 * JS test for whether tag `tag` converts to `target`: the same tag, Int into
 * Float (the type system's widening), or any class into the Object / Actor
 * roots.
 */
function tagConvertsExpr(target: PinType, tag: string): string {
  if (target.kind === "float") return `(${tag} === "float" || ${tag} === "int")`;
  if (target.kind === "objectRef" && target.classId === "BObject") {
    return `(${tag}.startsWith("objectRef:") || ${tag}.startsWith("actorRef:"))`;
  }
  if (target.kind === "actorRef" && target.classId === "Actor") {
    return `${tag}.startsWith("actorRef:")`;
  }
  return `(${tag} === ${JSON.stringify(pinTypeTag(target))})`;
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
    const typed = staticInputTag(ctx, "in");
    const tag = typed === undefined ? runtimeTagExpr("__w") : JSON.stringify(typed);
    const unboxed = typed === undefined ? `(${boxedTest("__w")} ? __w.value : __w)` : "__w";
    ctx.emit(
      `(() => { const __w = ${input}; const __t = ${tag}; if (${tagConvertsExpr(target, "__t")}) { ${success} = true; ${value} = ${unboxed}; } else { ${success} = false; ${value} = ${fallback}; } })();`,
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
    codegen: (ctx) => {
      const typed = staticInputTag(ctx, "in");
      return {
        out: typed === undefined ? runtimeTagExpr(ctx.input("in")) : JSON.stringify(typed),
      };
    },
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
    codegen: (ctx) => {
      const typed = staticInputTag(ctx, "in");
      const tag = typed === undefined ? runtimeTagExpr(ctx.input("in")) : JSON.stringify(typed);
      return { out: `(${tag} === ${ctx.input("tag")})` };
    },
  });

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
