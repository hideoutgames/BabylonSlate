import type { Effect } from "@babylonjs/core";
import type { MaterialDiagnostic, MaterialOperation } from "@babylonslate/shader-graph";

export function customGlslFunctionName(id: string): string {
  return `custom_${Array.from(id, (char) => char.codePointAt(0)!.toString(16)).join("_")}`;
}

export function materialGlslDiagnostic(message: string, operations: readonly MaterialOperation[], effect?: Pick<Effect, "getVertexShaderSource" | "getFragmentShaderSource"> | null): MaterialDiagnostic {
  const custom = operations.filter((operation) => operation.nodeType === "custom.glsl");
  const anchor = (operation: MaterialOperation) => [...operation.source.callPath, operation.source.nodeId].join("/");
  const diagnostic: MaterialDiagnostic = { code: "material.compile.glsl", message, severity: "error", ...(custom.length === 1 ? { nodeId: anchor(custom[0]!) } : {}) };
  const shaderLine = Number(/ERROR:\s*\d+:(\d+)/.exec(message)?.[1]);
  if (!shaderLine || !effect) return diagnostic;
  const matches: MaterialDiagnostic[] = [];
  for (const [stage, source] of [["vertex", effect.getVertexShaderSource()], ["fragment", effect.getFragmentShaderSource()]] as const) {
    const lines = source.split("\n");
    for (const operation of custom) {
      const marker = lines.findIndex((line) => line.includes(`// CUSTOM_BODY_${customGlslFunctionName(operation.id)}`));
      const line = shaderLine - marker - 1;
      if (marker < 0 || line < 1 || line > String(operation.properties.body ?? "").split("\n").length) continue;
      matches.push({ ...diagnostic, nodeId: anchor(operation), line, stage, message: `${stage === "vertex" ? "Vertex" : "Fragment"} GLSL, line ${line}: ${message}` });
    }
  }
  // Source processors and drivers vary. Never invent an ambiguous source location.
  return matches.length === 1 ? matches[0]! : diagnostic;
}
