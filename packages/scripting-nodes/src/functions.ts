import {
  pin,
  type NodeDefinition,
  EXEC,
  objectRef,
} from "@babylonslate/scripting";
import {
  CALL_PIN_IDS,
  assignResultFields,
  jsIdent,
  memberArgPinId,
  memberPinRows,
  objectLiteralKey,
  type MemberPinRow,
  pinTypeForVariable,
} from "./member-pins";

export const functionCallNodes: NodeDefinition[] = [
  {
    id: "functions.call",
    implicitSelfTarget: true,
    title: "Call",
    category: "functions",
    declaredPinOrder: true,
    pins: (properties) => {
      const classId =
        typeof properties.classId === "string" && properties.classId.trim()
          ? properties.classId.trim()
          : "BObject";
      const targetPin =
        properties.implicitSelf === true
          ? []
          : [pin("target", "target", "in", objectRef(classId))];
      const rows = memberPinRows(properties).filter(
        (row): row is MemberPinRow & { name: string } =>
          Boolean(row) && typeof row.name === "string" && row.name.length > 0,
      );
      const hasExec = rows.some((row) => row.typeId === "exec");
      // Signature order per side, so reordering in the Inspector moves pins
      // on the Call node too. Target follows any leading exec inputs.
      const sidePins = (direction: "in" | "out") =>
        rows
          .filter((row) => (row.direction === "out" ? "out" : "in") === direction)
          .map((row) =>
            pin(
              memberArgPinId(row.name, CALL_PIN_IDS),
              row.name,
              direction,
              row.typeId === "exec" ? EXEC : pinTypeForVariable(row),
            ),
          );
      const inputs = hasExec
        ? sidePins("in")
        : [pin("execIn", "exec", "in", EXEC), ...sidePins("in")];
      const outputs = hasExec
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
      const classId =
        typeof ctx.node.properties.classId === "string" &&
        ctx.node.properties.classId.trim()
          ? ctx.node.properties.classId.trim()
          : "BObject";
      const targetExpr =
        ctx.node.properties.static === true
          ? JSON.stringify(classId)
          : !targetPin ||
              (!targetConnected && ctx.node.properties.implicitSelf === true)
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
        args.push(`${objectLiteralKey(pinDef.name)}: ${ctx.input(pinDef.id)}`);
      }
      const latent =
        !runtime && ctx.isLatentFunction?.(classId, functionName) === true;
      if (latent) ctx.requestAsync();
      const invoked = runtime
        ? `ctx.callComponentFunction(${targetExpr}, ${JSON.stringify(runtime)}, { ${args.join(", ")} })`
        : `ctx.invokeFunction(${targetExpr}, ${JSON.stringify(functionName)}, { ${args.join(", ")} })`;
      const call = latent ? `await ${invoked}` : invoked;
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
