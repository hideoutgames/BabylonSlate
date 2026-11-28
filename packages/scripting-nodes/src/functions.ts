import {
  BY_REFERENCE_ARGS_KEY,
  defaultValueLiteral,
  jsIdent,
  pin,
  type NodeDefinition,
  EXEC,
} from "@haptic/scripting";
import {
  CALL_PIN_IDS,
  assignResultFields,
  isByReferenceRow,
  memberArgPinId,
  memberPinRows,
  memberPinUnit,
  memberTargetPin,
  objectLiteralKey,
  type MemberPinRow,
  pinTypeForVariable,
} from "./member-pins";

/** A Call of a Pure function (`pure` copied from its member): no exec pins, evaluated where its outputs are read. */
function isPureCall(properties: Record<string, unknown>): boolean {
  return properties.pure === true;
}

export const functionCallNodes: NodeDefinition[] = [
  {
    id: "functions.call",
    title: "Call",
    category: "functions",
    declaredPinOrder: true,
    pureWhen: isPureCall,
    pins: (properties) => {
      const classId =
        typeof properties.classId === "string" && properties.classId.trim()
          ? properties.classId.trim()
          : "Object";
      // A Function Library call names its class, so it has no Target.
      const targetPin =
        properties.static === true
          ? []
          : [memberTargetPin(properties, "target", classId)];
      const rows = memberPinRows(properties).filter(
        (row): row is MemberPinRow & { name: string } =>
          Boolean(row) && typeof row.name === "string" && row.name.length > 0,
      );
      const pure = isPureCall(properties);
      const hasExec = rows.some((row) => row.typeId === "exec");
      // Signature order per side, so reordering in the Inspector moves pins
      // on the Call node too. Target follows any leading exec inputs.
      const sidePins = (direction: "in" | "out") =>
        rows
          .filter((row) => (row.direction === "out" ? "out" : "in") === direction)
          // A Pure function's exec pins run its own graph; its Calls have none.
          .filter((row) => !pure || row.typeId !== "exec")
          .map((row) => ({
            ...pin(
              memberArgPinId(row.name, CALL_PIN_IDS),
              row.name,
              direction,
              row.typeId === "exec" ? EXEC : pinTypeForVariable(row),
            ),
            ...(direction === "in" ? memberPinUnit(row) : {}),
            // A Pass-By-Reference input takes a writable variable, as Assign Tag's Target does.
            ...(direction === "in" && isByReferenceRow(row) ? { reference: "required" as const } : {}),
          }));
      const inputs = hasExec || pure
        ? sidePins("in")
        : [pin("execIn", "exec", "in", EXEC), ...sidePins("in")];
      const outputs = hasExec || pure
        ? sidePins("out")
        : [pin("execOut", "then", "out", EXEC), ...sidePins("out")];
      let targetIndex = 0;
      while (inputs[targetIndex]?.kind === "exec") targetIndex += 1;
      inputs.splice(targetIndex, 0, ...targetPin);
      return [...inputs, ...outputs];
    },
    codegen: (ctx) => {
      const raw =
        typeof ctx.node.properties.functionName === "string"
          ? ctx.node.properties.functionName
          : "fn";
      const runtime =
        typeof ctx.node.properties.runtime === "string" &&
        ctx.node.properties.runtime.trim()
          ? ctx.node.properties.runtime.trim()
          : "";
      const functionName = runtime || jsIdent(raw);
      const classId =
        typeof ctx.node.properties.classId === "string" &&
        ctx.node.properties.classId.trim()
          ? ctx.node.properties.classId.trim()
          : "Object";
      const targetExpr =
        ctx.node.properties.static === true
          ? JSON.stringify(classId)
          : ctx.input("target");
      const args: string[] = [];
      const references: string[] = [];
      const byReference = new Set(
        memberPinRows(ctx.node.properties).filter(isByReferenceRow).map((row) => row.name),
      );
      for (const pinDef of ctx.node.pins) {
        if (
          pinDef.direction !== "in" ||
          pinDef.kind === "exec" ||
          pinDef.id === "target"
        ) {
          continue;
        }
        args.push(`${objectLiteralKey(pinDef.name)}: ${ctx.input(pinDef.id)}`);
        if (byReference.has(pinDef.name) && ctx.reference) {
          references.push(`${objectLiteralKey(pinDef.name)}: ${ctx.reference(pinDef.id)}`);
        }
      }
      // The function reads and writes these through its Input node; the values above stay for callers that read args.
      if (references.length > 0) args.push(`${BY_REFERENCE_ARGS_KEY}: { ${references.join(", ")} }`);
      const argsArg = args.length > 0 ? `, { ${args.join(", ")} }` : "";
      const invoked = runtime
        ? `ctx.callComponentFunction(${targetExpr}, ${JSON.stringify(runtime)}${argsArg})`
        : `ctx.invokeFunction(${targetExpr}, ${JSON.stringify(functionName)}${argsArg})`;
      const outPins = ctx.node.pins.filter(
        (pinDef) => pinDef.direction === "out" && pinDef.kind === "data",
      );
      // A Pure Call runs once per statement that reads it; its outputs read one result.
      if (isPureCall(ctx.node.properties)) {
        const result = ctx.shared?.(invoked) ?? invoked;
        return Object.fromEntries(outPins.map((pinDef) => [
          pinDef.name,
          `((${result}) ?? {})[${JSON.stringify(pinDef.name)}] ?? ${defaultValueLiteral(pinDef.type)}`,
        ]));
      }
      const latent =
        !runtime && ctx.isLatentFunction?.(classId, functionName) === true;
      if (latent) ctx.requestAsync();
      const call = latent ? `(yield ${invoked})` : invoked;
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
