import {
  pin,
  type NodeDefinition,
  EXEC,
  objectRef,
  pinTypeForVariable,
} from "@babylonslate/scripting";
import { localVariableIdent } from "./member-pins";

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

function targetPins(properties: Record<string, unknown>) {
  if (properties.implicitSelf === true) return [];
  const classId =
    typeof properties.classId === "string" && properties.classId.trim()
      ? properties.classId.trim()
      : "BObject";
  return [pin("target", "target", "in", objectRef(classId))];
}

function targetConnected(
  ctx: Parameters<NonNullable<NodeDefinition["codegen"]>>[0],
): boolean {
  const targetPin = ctx.node.pins.find(
    (entry) => entry.name === "target" && entry.direction === "in",
  );
  if (!targetPin) return false;
  return ctx.graph.edges.some(
    (edge) =>
      edge.targetNodeId === ctx.node.id && edge.targetPinId === targetPin.id,
  );
}

function usesImplicitSelf(
  ctx: Parameters<NonNullable<NodeDefinition["codegen"]>>[0],
): boolean {
  const hasTarget = ctx.node.pins.some(
    (entry) => entry.name === "target" && entry.direction === "in",
  );
  return !hasTarget || (!targetConnected(ctx) && ctx.node.properties.implicitSelf === true);
}

function memberGetExpr(
  ctx: Parameters<NonNullable<NodeDefinition["codegen"]>>[0],
  name: string,
): string {
  const quoted = JSON.stringify(name);
  if (usesImplicitSelf(ctx)) return `ctx.getVariable(${quoted})`;
  return `ctx.getVariableFrom(${ctx.input("target")}, ${quoted})`;
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
        pin(
          "value",
          name,
          "out",
          variablePinType(properties),
        ),
      ];
    },
    codegen: (ctx) => {
      const name = variableNameOf(ctx.node.properties);
      const expr =
        ctx.node.properties.scope === "local"
          ? localVariableIdent(name)
          : memberGetExpr(ctx, name);
      return { [name]: expr };
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
      const value = ctx.input(name);
      const out = ctx.output(name);
      if (ctx.node.properties.scope === "local") {
        const ident = localVariableIdent(name);
        ctx.emit(`${ident} = ${value};`);
        ctx.emit(`${out} = ${ident};`);
        return;
      }
      const quoted = JSON.stringify(name);
      if (usesImplicitSelf(ctx)) {
        ctx.emit(`ctx.setVariable(${quoted}, ${value});`);
      } else {
        ctx.emit(
          `ctx.setVariableOn(${ctx.input("target")}, ${quoted}, ${value});`,
        );
      }
      ctx.emit(`${out} = ${value};`);
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
