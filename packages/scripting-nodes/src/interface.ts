import {
  pin,
  type NodeDefinition,
  EXEC,
  objectRef,
} from "@babylonslate/scripting";
import {
  memberPinRows,
  objectLiteralKey,
  pinTypeForMember,
  type MemberPinRow,
} from "./member-pins";

const CALL_INTERFACE_RESERVED_PINS = new Set([
  "interfaceGuid",
  "method",
  "result",
  "target",
]);

export function isCallInterfaceMethodPin(row: MemberPinRow | undefined): boolean {
  if (!row || typeof row.name !== "string" || row.name.length === 0) {
    return false;
  }
  return !CALL_INTERFACE_RESERVED_PINS.has(row.name);
}

function signaturePins(properties: Record<string, unknown>) {
  const classId =
    typeof properties.classId === "string" && properties.classId.trim()
      ? properties.classId.trim()
      : "BObject";
  const rows = memberPinRows(properties).filter(isCallInterfaceMethodPin);
  const execPins = rows.flatMap((row) => {
    if (row.typeId !== "exec") return [];
    const direction = row.direction === "out" ? "out" : "in";
    return [pin(row.name!, row.name!, direction, EXEC)];
  });
  const exec =
    execPins.length > 0
      ? execPins
      : [
          pin("execIn", "exec", "in", EXEC),
          pin("execOut", "then", "out", EXEC),
        ];
  const dataPins = (["in", "out"] as const).flatMap((direction) =>
    rows.flatMap((row) => {
      if (row.typeId === "exec") return [];
      const rowDir = row.direction === "out" ? "out" : "in";
      if (rowDir !== direction) return [];
      return [
        pin(
          row.name!,
          row.name!,
          direction,
          pinTypeForMember(row.typeId, row.typeClassId),
        ),
      ];
    }),
  );
  return [
    ...exec,
    pin("target", "Target", "in", objectRef(classId)),
    ...dataPins,
  ];
}

function jsonProp(
  properties: Record<string, unknown>,
  key: string,
): string {
  const value = properties[key];
  return JSON.stringify(typeof value === "string" ? value : "");
}

export function callInterfaceTitle(methodName: string): string {
  const trimmed = methodName.trim();
  return trimmed ? `Call Interface ${trimmed}` : "Call Interface";
}

export const interfaceNodes: NodeDefinition[] = [
  {
    id: "interface.call",
    title: "Call",
    category: "interface",
    pins: (properties) => signaturePins(properties),
    codegen: (ctx) => {
      const properties = ctx.node.properties;
      const targetPin = ctx.node.pins.find(
        (entry) => entry.id === "target" && entry.direction === "in",
      );
      const targetConnected =
        !!targetPin &&
        ctx.graph.edges.some(
          (edge) =>
            edge.targetNodeId === ctx.node.id &&
            edge.targetPinId === targetPin.id,
        );
      const targetExpr =
        !targetPin ||
        (!targetConnected && properties.implicitSelf !== false)
          ? "ctx.self"
          : ctx.input("target");
      const args: string[] = [];
      for (const pinDef of ctx.node.pins) {
        if (
          pinDef.direction !== "in" ||
          pinDef.kind === "exec" ||
          pinDef.id === "target"
        ) {
          continue;
        }
        args.push(`${objectLiteralKey(pinDef.name)}: ${ctx.input(pinDef.name)}`);
      }
      const call = `ctx.callInterface(${targetExpr}, ${jsonProp(properties, "interfaceGuid")}, ${jsonProp(properties, "method")}, { ${args.join(", ")} })`;
      const outPins = ctx.node.pins.filter(
        (pinDef) => pinDef.direction === "out" && pinDef.kind === "data",
      );
      if (outPins.length === 0) {
        ctx.emit(`${call};`);
        return;
      }
      const assigns = outPins
        .map(
          (pinDef) =>
            `${objectLiteralKey(pinDef.name)}: ${ctx.output(pinDef.name)}`,
        )
        .join(", ");
      ctx.emit(`({ ${assigns} } = ${call} ?? {});`);
    },
  },
];
