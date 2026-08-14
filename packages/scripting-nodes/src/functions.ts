import {
  pin,
  type NodeDefinition,
  EXEC,
  FLOAT,
  BOOL,
  INT,
  STRING,
} from "@babylonslate/scripting";

function pinTypeForMember(typeId: string | undefined) {
  switch (typeId) {
    case "exec":
      return EXEC;
    case "bool":
      return BOOL;
    case "int":
      return INT;
    case "string":
    case "enum":
      return STRING;
    default:
      return FLOAT;
  }
}

function jsIdent(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

export const functionCallNodes: NodeDefinition[] = [
  {
    id: "functions.call",
    title: "Call",
    category: "functions",
    pins: (properties) => {
      const rows = Array.isArray(properties.pins)
        ? (properties.pins as Array<{
            name?: string;
            typeId?: string;
            direction?: string;
          }>)
        : [];
      if (rows.length > 0) {
        return rows.flatMap((row) => {
          if (!row || typeof row.name !== "string" || row.name.length === 0) {
            return [];
          }
          const direction = row.direction === "out" ? "out" : "in";
          return [
            pin(
              row.name,
              row.name,
              direction,
              pinTypeForMember(row.typeId),
            ),
          ];
        });
      }
      return [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
      ];
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
