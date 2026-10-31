import type { MaterialGraphNode } from "./document";
import type { MaterialDiagnostic } from "./validate";

export function isMaterialParameterNode(type: string): boolean {
  return (
    type === "param.float" || type === "param.color" || type === "param.texture"
  );
}

/**
 * Whether a Float or Color parameter is marked Per Instance (`properties.perInstance`): each mesh drawn with the
 * Material can carry its own value, read from an instanced attribute, so actors that vary it still draw together.
 */
export function isPerInstanceParameter(type: string, properties: Readonly<Record<string, unknown>>): boolean {
  return (type === "param.float" || type === "param.color") && properties.perInstance === true;
}

export function materialParameterName(node: MaterialGraphNode): string {
  return typeof node.properties.name === "string"
    ? node.properties.name.trim()
    : "";
}

/** Names share one namespace across Float, Color, and Texture parameters. */
export function validateMaterialParameterNames(
  graph: { nodes: readonly MaterialGraphNode[] },
): MaterialDiagnostic[] {
  const parameters = graph.nodes.filter((node) =>
    isMaterialParameterNode(node.type),
  );
  const counts = new Map<string, number>();
  for (const node of parameters) {
    const name = materialParameterName(node);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return parameters.flatMap((node): MaterialDiagnostic[] => {
    const name = materialParameterName(node);
    if (!name) {
      return [{
        code: "material.parameter.missingName",
        message: "Parameter needs a unique name",
        severity: "error",
        nodeId: node.id,
      }];
    }
    if ((counts.get(name) ?? 0) > 1) {
      return [{
        code: "material.parameter.duplicateName",
        message: `Parameter name "${name}" is already used; choose a unique name`,
        severity: "error",
        nodeId: node.id,
      }];
    }
    return [];
  });
}
