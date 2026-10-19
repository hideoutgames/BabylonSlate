import {
  pin,
  type NodeDefinition,
  EXEC,
  objectRef,
  pinTypeForVariable,
} from "@babylonslate/scripting";
import { localVariableIdent } from "./member-pins";
import { subject } from "./self-pin";

function variablePinType(properties: Record<string, unknown>) {
  return pinTypeForVariable({
    typeId:
      typeof properties.typeId === "string" ? properties.typeId : "float",
    typeClassId:
      typeof properties.typeClassId === "string"
        ? properties.typeClassId
        : undefined,
    container:
      typeof properties.container === "string"
        ? properties.container
        : undefined,
    keyTypeId:
      typeof properties.keyTypeId === "string"
        ? properties.keyTypeId
        : undefined,
    keyTypeClassId:
      typeof properties.keyTypeClassId === "string"
        ? properties.keyTypeClassId
        : undefined,
  });
}

function variableNameOf(properties: Record<string, unknown>): string {
  return typeof properties.variableName === "string" &&
    properties.variableName.trim()
    ? properties.variableName.trim()
    : "Value";
}

/** A variable of the graph's own class has no Target: it is Self. Another class's needs an object. */
function targetPins(properties: Record<string, unknown>) {
  if (properties.implicitSelf === true) return [];
  const classId =
    typeof properties.classId === "string" && properties.classId.trim()
      ? properties.classId.trim()
      : "BObject";
  return [subject(pin("target", "target", "in", objectRef(classId)))];
}

function usesImplicitSelf(
  ctx: Parameters<NonNullable<NodeDefinition["codegen"]>>[0],
): boolean {
  return !ctx.node.pins.some(
    (entry) => entry.id === "target" && entry.direction === "in",
  );
}

function storeKeyOf(properties: Record<string, unknown>, name: string): string {
  const propertyKey = properties.propertyKey;
  return typeof propertyKey === "string" && propertyKey.length > 0
    ? propertyKey
    : name;
}

function memberGetExpr(
  ctx: Parameters<NonNullable<NodeDefinition["codegen"]>>[0],
  name: string,
): string {
  const componentId = ctx.node.properties.componentId;
  const target = usesImplicitSelf(ctx) ? "ctx.self" : ctx.input("target");
  if (typeof componentId === "string" && componentId.length > 0) {
    return `ctx.getComponentById(${target}, ${JSON.stringify(componentId)})`;
  }
  const quoted = JSON.stringify(storeKeyOf(ctx.node.properties, name));
  if (usesImplicitSelf(ctx)) return `ctx.getVariable(${quoted})`;
  return `ctx.getVariableFrom(${target}, ${quoted})`;
}

export const variableNodes: NodeDefinition[] = [
  {
    id: "variables.get",
    title: "Get Variable",
    category: "variables",
    pure: true,
    pins: (properties) => {
      const name = variableNameOf(properties);
      return [
        ...targetPins(properties),
        { ...pin(
          "value",
          name,
          "out",
          variablePinType(properties),
        ), ...(!properties.getOnly && !properties.componentId
          ? { reference: "writable" as const } : {}) },
      ];
    },
    codegen: (ctx) => {
      const name = variableNameOf(ctx.node.properties);
      const expr =
        ctx.node.properties.scope === "local"
          ? localVariableIdent(name)
          : memberGetExpr(ctx, name);
      return { value: expr };
    },
  },
  {
    id: "variables.set",
    title: "Set Variable",
    category: "variables",
    pins: (properties) => {
      const name = variableNameOf(properties);
      const type = variablePinType(properties);
      return [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
        ...targetPins(properties),
        pin("value", name, "in", type),
        pin("out", name, "out", type),
      ];
    },
    codegen: (ctx) => {
      const name = variableNameOf(ctx.node.properties);
      // Pin names follow the variable name, which may equal a fixed pin's
      // name or id (`exec`, `then`, `target`); look up by id.
      const value = ctx.input("value");
      const out = ctx.output("out");
      if (ctx.node.properties.scope === "local") {
        const ident = localVariableIdent(name);
        ctx.emit(`${ident} = ${value};`);
        ctx.emit(`${out} = ${ident};`);
        return;
      }
      const quoted = JSON.stringify(storeKeyOf(ctx.node.properties, name));
      // Evaluate the value once: the stored value and the output are one sample.
      ctx.emit(`${out} = ${value};`);
      if (usesImplicitSelf(ctx)) {
        ctx.emit(`ctx.setVariable(${quoted}, ${out});`);
      } else {
        ctx.emit(
          `ctx.setVariableOn(${ctx.input("target")}, ${quoted}, ${out});`,
        );
      }
    },
  },
  {
    id: "variables.getValidated",
    title: "Validated Get",
    category: "variables",
    pins: (properties) => {
      const name = variableNameOf(properties);
      return [
        pin("execIn", "exec", "in", EXEC),
        pin("isValid", "Is Valid", "out", EXEC),
        pin("notValid", "Not Valid", "out", EXEC),
        ...targetPins(properties),
        pin("value", name, "out", variablePinType(properties)),
      ];
    },
    codegen: (ctx) => {
      const name = variableNameOf(ctx.node.properties);
      const value = ctx.output("value");
      const expr =
        ctx.node.properties.scope === "local"
          ? localVariableIdent(name)
          : memberGetExpr(ctx, name);
      ctx.emit(`${value} = ${expr};`);
    },
  },
];
