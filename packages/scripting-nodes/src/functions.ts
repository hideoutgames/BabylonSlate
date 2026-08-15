import {
  pin,
  type NodeDefinition,
  EXEC,
  objectRef,
} from "@babylonslate/scripting";
import {
  jsIdent,
  memberPinRows,
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
            pin(row.name, row.name, direction, pinTypeForMember(row.typeId)),
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
      ctx.emit(`${jsIdent(raw)}(ctx);`);
    },
  },
];
