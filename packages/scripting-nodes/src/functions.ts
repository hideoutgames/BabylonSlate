import {
  pin,
  type NodeDefinition,
  EXEC,
  objectRef,
} from "@babylonslate/scripting";
import {
  jsIdent,
  memberPinRows,
  objectLiteralKey,
  pinTypeForMember,
} from "./member-pins";

export const functionCallNodes: NodeDefinition[] = [
  {
    id: "functions.call",
    title: "Call",
    category: "functions",
    pins: (properties) => {
      const classId =
        typeof properties.classId === "string" && properties.classId.trim()
          ? properties.classId.trim()
          : "BObject";
      const targetPin =
        properties.implicitSelf === true
          ? []
          : [pin("target", "target", "in", objectRef(classId))];
      const rows = memberPinRows(properties);
      const execPins = rows.flatMap((row) => {
        if (!row || typeof row.name !== "string" || row.name.length === 0) {
          return [];
        }
        if (row.typeId !== "exec") return [];
        const direction = row.direction === "out" ? "out" : "in";
        return [pin(row.name, row.name, direction, EXEC)];
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
          if (!row || typeof row.name !== "string" || row.name.length === 0) {
            return [];
          }
          if (row.typeId === "exec") return [];
          const rowDir = row.direction === "out" ? "out" : "in";
          if (rowDir !== direction) return [];
          return [
            pin(
              row.name,
              row.name,
              direction,
              pinTypeForMember(row.typeId, row.typeClassId),
            ),
          ];
        }),
      );
      return [...exec, ...targetPin, ...dataPins];
    },
    codegen: (ctx) => {
      const raw =
        typeof ctx.node.properties.functionName === "string"
          ? ctx.node.properties.functionName
          : "fn";
      const functionName = jsIdent(raw);
      const targetPin = ctx.node.pins.find(
        (entry) => entry.name === "target" && entry.direction === "in",
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
          pinDef.name === "target"
        ) {
          continue;
        }
        args.push(`${objectLiteralKey(pinDef.name)}: ${ctx.input(pinDef.name)}`);
      }
      const call = `ctx.invokeFunction(${targetExpr}, ${JSON.stringify(functionName)}, { ${args.join(", ")} })`;
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
