import type { LogicGraph, GraphNode, GraphPin } from "./ir";
import type { NodeRegistry } from "./node-registry";

/** Bound expression expansion without eagerly evaluating branches or service reads. */
export function createPureExpressions(graph: LogicGraph, registry: NodeRegistry) {
  const declarations: string[] = [];
  const transparent = new Map<string, boolean>();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map(graph.edges.map((edge) => [`${edge.targetNodeId}:${edge.targetPinId}`, edge]));
  function isTransparent(node: GraphNode): boolean {
    if (transparent.has(node.id)) return transparent.get(node.id)!;
    transparent.set(node.id, false);
    const definition = registry.get(node.typeId);
    const result = definition?.pure === true && definition.referentiallyTransparent === true &&
      node.pins.filter((pin) => pin.direction === "in" && pin.kind === "data").every((pin) => {
        const edge = incoming.get(`${node.id}:${pin.id}`);
        if (!edge) return true;
        const source = nodes.get(edge.sourceNodeId);
        return source !== undefined && isTransparent(source);
      });
    transparent.set(node.id, result);
    return result;
  }
  return {
    declarations,
    expression(node: GraphNode, pin: GraphPin, expression: string): string {
      if (expression.length <= 512) return `(${expression})`;
      const name = `_pure_${declarations.length}`;
      // Mutable values preserve the identity/allocation semantics of each read.
      const immutable = ["bool", "int", "float", "string", "enumRef", "classRef", "assetRef"].includes(pin.type.kind);
      if (immutable && isTransparent(node)) {
        declarations.push(`  let ${name}_ready = false, ${name}_value;\n  const ${name} = () => { if (!${name}_ready) { ${name}_value = (${expression}); ${name}_ready = true; } return ${name}_value; };`);
      } else {
        declarations.push(`  const ${name} = () => (${expression});`);
      }
      return `${name}()`;
    },
  };
}
