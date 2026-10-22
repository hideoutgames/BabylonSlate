import {
  pin,
  type NodeDefinition,
  EXEC,
} from "@haptic/scripting";
import {
  CALL_PIN_IDS,
  assignResultFields,
  memberArgPinId,
  memberPinRows,
  memberTargetPin,
  objectLiteralKey,
  pinTypeForMember,
  type MemberPinRow,
} from "./member-pins";

/** A method signature row that becomes a Call Interface pin. */
export function isCallInterfaceMethodPin(row: MemberPinRow | undefined): boolean {
  return !!row && typeof row.name === "string" && row.name.length > 0;
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
    return [pin(memberArgPinId(row.name!, CALL_PIN_IDS), row.name!, direction, EXEC)];
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
          memberArgPinId(row.name!, CALL_PIN_IDS),
          row.name!,
          direction,
          pinTypeForMember(row.typeId, row.typeClassId),
        ),
      ];
    }),
  );
  return [
    ...exec,
    memberTargetPin(properties, "Target", classId),
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
      const targetExpr = ctx.input("target");
      const args: string[] = [];
      for (const pinDef of ctx.node.pins) {
        if (
          pinDef.direction !== "in" ||
          pinDef.kind === "exec" ||
          pinDef.id === "target"
        ) {
          continue;
        }
        args.push(`${objectLiteralKey(pinDef.name)}: ${ctx.input(pinDef.id)}`);
      }
      const call = `ctx.callInterface(${targetExpr}, ${jsonProp(properties, "interfaceGuid")}, ${jsonProp(properties, "method")}, { ${args.join(", ")} })`;
      const outPins = ctx.node.pins.filter(
        (pinDef) => pinDef.direction === "out" && pinDef.kind === "data",
      );
      if (outPins.length === 0) {
        ctx.emit(`${call};`);
        return;
      }
      ctx.emit(assignResultFields(
        outPins.map((pinDef) => ({ key: pinDef.name, slot: ctx.output(pinDef.id), type: pinDef.type })),
        call,
      ));
    },
  },
];
